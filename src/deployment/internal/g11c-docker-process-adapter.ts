import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CONTAINER_ID = /^[0-9a-f]{12,64}$/u;
const DEFAULT_STOP_TIMEOUT_SECONDS = 30;
const DEFAULT_OBSERVE_TIMEOUT_MS = 30_000;

export interface G11cCommandResult { readonly stdout: string; readonly stderr: string; }
export type G11cCommandRunner = (binary: string, args: readonly string[], timeoutMs: number) => Promise<G11cCommandResult>;

export interface G11cDockerProcessAdapterOptions {
  readonly project: string;
  readonly composeFile: string;
  readonly commandRunner?: G11cCommandRunner;
  readonly observeTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface G11cDockerProcessAdapter {
  readonly requestApiStop: () => Promise<void>;
  readonly awaitApiProcessGone: () => Promise<void>;
  readonly requestMongoStop: () => Promise<void>;
  readonly awaitMongoProcessGone: () => Promise<void>;
  readonly awaitMongoPrimary: () => Promise<void>;
}

interface ContainerIdentity { readonly id: string; readonly pid: number; }
interface ContainerState { readonly Running: boolean; readonly Pid: number; readonly Status: string; readonly Health?: { readonly Status?: string }; }

/**
 * Host-side process lifecycle adapter.  It only uses `compose stop/start`
 * and `docker inspect`; it never removes containers, volumes, databases or
 * collections.  Process disappearance is checked by the original container
 * identity and PID, not inferred from a successful stop command.
 */
export function createG11cDockerProcessAdapter(input: G11cDockerProcessAdapterOptions): G11cDockerProcessAdapter {
  const options = captureOptions(input);
  const run = options.commandRunner ?? defaultRunner;
  let api: ContainerIdentity | undefined;
  let mongo: ContainerIdentity | undefined;
  return Object.freeze({
    requestApiStop: async () => {
      api = await captureContainer(run, options, 'api');
      await compose(run, options, ['stop', '--timeout', String(DEFAULT_STOP_TIMEOUT_SECONDS), 'api']);
    },
    awaitApiProcessGone: async () => {
      if (api === undefined) throw new G11cDockerProcessError('API_IDENTITY_UNAVAILABLE');
      await waitForGone(run, options, 'api', api);
    },
    requestMongoStop: async () => {
      mongo = await captureContainer(run, options, 'mongo');
      await compose(run, options, ['stop', '--timeout', String(DEFAULT_STOP_TIMEOUT_SECONDS), 'mongo']);
    },
    awaitMongoProcessGone: async () => {
      if (mongo === undefined) throw new G11cDockerProcessError('MONGO_IDENTITY_UNAVAILABLE');
      await waitForGone(run, options, 'mongo', mongo);
    },
    awaitMongoPrimary: async () => {
      if (mongo === undefined) throw new G11cDockerProcessError('MONGO_IDENTITY_UNAVAILABLE');
      await compose(run, options, ['start', 'mongo']);
      await waitForPrimary(run, options, 'mongo', mongo.id);
    },
  });
}

export class G11cDockerProcessError extends Error {
  constructor(readonly code: 'API_IDENTITY_UNAVAILABLE' | 'API_PROCESS_NOT_GONE' | 'MONGO_IDENTITY_UNAVAILABLE' | 'MONGO_PROCESS_NOT_GONE' | 'MONGO_PRIMARY_UNAVAILABLE' | 'DOCKER_COMMAND_FAILED') {
    super(code);
    this.name = 'G11cDockerProcessError';
  }
}

async function captureContainer(run: G11cCommandRunner, options: Readonly<G11cDockerProcessAdapterOptions>, service: 'api' | 'mongo'): Promise<ContainerIdentity> {
  let result: G11cCommandResult;
  try { result = await compose(run, options, ['ps', '-q', service]); } catch { throw new G11cDockerProcessError(service === 'api' ? 'API_IDENTITY_UNAVAILABLE' : 'MONGO_IDENTITY_UNAVAILABLE'); }
  const id = result.stdout.trim();
  if (!CONTAINER_ID.test(id) || id.includes('\n')) throw new G11cDockerProcessError(service === 'api' ? 'API_IDENTITY_UNAVAILABLE' : 'MONGO_IDENTITY_UNAVAILABLE');
  const state = await inspect(run, id, service);
  if (!state.Running || !Number.isSafeInteger(state.Pid) || state.Pid <= 0) throw new G11cDockerProcessError(service === 'api' ? 'API_IDENTITY_UNAVAILABLE' : 'MONGO_IDENTITY_UNAVAILABLE');
  return Object.freeze({ id, pid: state.Pid });
}

async function waitForGone(run: G11cCommandRunner, options: Readonly<G11cDockerProcessAdapterOptions>, service: 'api' | 'mongo', identity: ContainerIdentity): Promise<void> {
  const deadline = Date.now() + options.observeTimeoutMs!;
  while (Date.now() <= deadline) {
    const state = await inspect(run, identity.id, service);
    if (!state.Running && state.Pid === 0) return;
    // A container identity alone is not enough: a restarted container can
    // retain the same ID while running a different host process.  Keep
    // observing the captured PID and fail closed if it changes before the
    // original process has disappeared.
    if (state.Running && state.Pid !== identity.pid) {
      throw new G11cDockerProcessError(service === 'api' ? 'API_PROCESS_NOT_GONE' : 'MONGO_PROCESS_NOT_GONE');
    }
    await pause(options.pollIntervalMs!);
  }
  throw new G11cDockerProcessError(service === 'api' ? 'API_PROCESS_NOT_GONE' : 'MONGO_PROCESS_NOT_GONE');
}

async function waitForPrimary(run: G11cCommandRunner, options: Readonly<G11cDockerProcessAdapterOptions>, service: 'mongo', identity: string): Promise<void> {
  const deadline = Date.now() + options.observeTimeoutMs!;
  while (Date.now() <= deadline) {
    const state = await inspect(run, identity, service);
    if (state.Running && state.Health?.Status === 'healthy') return;
    await pause(options.pollIntervalMs!);
  }
  throw new G11cDockerProcessError('MONGO_PRIMARY_UNAVAILABLE');
}

async function inspect(run: G11cCommandRunner, id: string, service: 'api' | 'mongo'): Promise<ContainerState> {
  try {
    const result = await run('docker', ['inspect', '--format={{json .State}}', id], DEFAULT_OBSERVE_TIMEOUT_MS);
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!isContainerState(parsed)) throw new Error();
    return parsed;
  } catch { throw new G11cDockerProcessError(service === 'api' ? 'API_PROCESS_NOT_GONE' : 'MONGO_PROCESS_NOT_GONE'); }
}

async function compose(run: G11cCommandRunner, options: Readonly<G11cDockerProcessAdapterOptions>, args: readonly string[]): Promise<G11cCommandResult> {
  try { return await run('docker', ['compose', '--project-name', options.project, '--file', options.composeFile, ...args], DEFAULT_OBSERVE_TIMEOUT_MS); }
  catch { throw new G11cDockerProcessError('DOCKER_COMMAND_FAILED'); }
}

async function defaultRunner(binary: string, args: readonly string[], timeoutMs: number): Promise<G11cCommandResult> {
  const result = await execFileAsync(binary, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 });
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
}

function isContainerState(value: unknown): value is ContainerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.Running === 'boolean' && typeof state.Pid === 'number' && Number.isSafeInteger(state.Pid)
    && typeof state.Status === 'string'
    && (state.Health === undefined || (typeof state.Health === 'object' && state.Health !== null
      && (typeof (state.Health as Record<string, unknown>).Status === 'string' || (state.Health as Record<string, unknown>).Status === undefined)));
}

function captureOptions(input: G11cDockerProcessAdapterOptions): Readonly<G11cDockerProcessAdapterOptions> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string')
    || typeof input.project !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,62}$/u.test(input.project)
    || typeof input.composeFile !== 'string' || input.composeFile.length === 0 || input.composeFile.includes('\0')
    || (input.observeTimeoutMs !== undefined && (!Number.isSafeInteger(input.observeTimeoutMs) || input.observeTimeoutMs < 1 || input.observeTimeoutMs > 120_000))
    || (input.pollIntervalMs !== undefined && (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 1 || input.pollIntervalMs > 5_000))
    || (input.commandRunner !== undefined && typeof input.commandRunner !== 'function')) throw new TypeError('invalid G11c docker process adapter options');
  return Object.freeze({ ...input, observeTimeoutMs: input.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS, pollIntervalMs: input.pollIntervalMs ?? 100 });
}

function pause(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
