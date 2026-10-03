import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { runRuntimeControlCli } from '../../runtime/internal/runtime-control-cli.js';
import type { G11cDrainOutcome } from './g11c-maintenance-lifecycle-engine.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface G11cPrivateDrainAdapter {
  readonly drain: (timeoutMs: number) => Promise<G11cDrainOutcome>;
}

export interface G11cPrivateDrainOptions {
  readonly socketPath: string;
  readonly epoch: string;
  readonly run: string;
}

/**
 * Production-private bridge to the already existing G10a AF_UNIX control
 * protocol.  STATUS is read first to obtain the current revision, then one
 * DRAIN is submitted.  Transport/protocol uncertainty is deliberately mapped
 * to INTERNAL_UNAVAILABLE; the lifecycle owner keeps the public marker closed
 * and proceeds to process isolation.
 */
export function createG11cPrivateDrainAdapter(input: G11cPrivateDrainOptions): G11cPrivateDrainAdapter {
  const options = captureOptions(input);
  return Object.freeze({
    drain: async (timeoutMs: number): Promise<G11cDrainOutcome> => {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return 'INTERNAL_UNAVAILABLE';
      const status = await request(options.socketPath, {
        v: 'c1', requestControlId: randomUUID(), command: 'STATUS', epoch: options.epoch, run: options.run,
      });
      if (status === null || status.ok !== true || status.command !== 'STATUS' || status.snapshot === null || status.snapshot === undefined
        || status.snapshot.epoch !== options.epoch || status.snapshot.run !== options.run
        || status.snapshot.revision !== status.revision) return 'INTERNAL_UNAVAILABLE';
      const response = await request(options.socketPath, {
        v: 'c1', requestControlId: randomUUID(), command: 'DRAIN', epoch: options.epoch, run: options.run,
        expectedRevision: status.revision, timeoutMs,
      });
      if (response === null) return 'INTERNAL_UNAVAILABLE';
      if (response.ok !== true || response.command !== 'DRAIN' || response.snapshot === null
        || response.snapshot === undefined || response.snapshot.epoch !== options.epoch || response.snapshot.run !== options.run
        || !/^(?:0|[1-9][0-9]*)$/u.test(response.revision ?? '')
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(response.controlId ?? '')
        || response.snapshot.revision !== response.revision
        || response.snapshot.maintenance?.active !== true
        || response.snapshot.maintenance.controlId !== response.controlId
        || response.snapshot.maintenance.outcome !== response.outcome) return 'INTERNAL_UNAVAILABLE';
      if (response.outcome !== 'DRAINED' && response.outcome !== 'NOT_DRAINED') return 'INTERNAL_UNAVAILABLE';
      if (response.outcome === 'DRAINED'
        && (response.snapshot.issuedPersistence !== 0 || response.snapshot.activeQueryReads !== 0)) return 'INTERNAL_UNAVAILABLE';
      return response.outcome;
    },
  });
}

interface ControlResponse {
  readonly ok: boolean;
  readonly command?: string;
  readonly outcome?: string;
  readonly revision?: string;
  readonly controlId?: string | null;
  readonly snapshot?: {
    readonly epoch?: unknown;
    readonly run?: unknown;
    readonly revision?: unknown;
    readonly issuedPersistence?: unknown;
    readonly activeQueryReads?: unknown;
    readonly maintenance?: { readonly active?: unknown; readonly controlId?: unknown; readonly outcome?: unknown } | null;
  } | null;
}

async function request(socketPath: string, body: Readonly<Record<string, unknown>>): Promise<ControlResponse | null> {
  const stdout: Buffer[] = [];
  const stdin = Readable.from([Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')]);
  const output = new Writable({ write(chunk: Buffer | string, _encoding, callback) { stdout.push(Buffer.from(chunk)); callback(); } });
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    const exitCode = await runRuntimeControlCli(socketPath, { stdin, stdout: output, stderr });
    if (exitCode !== 0) return null;
    const wire = Buffer.concat(stdout);
    if (wire.length === 0 || wire[wire.length - 1] !== 0x0a || wire.indexOf(0x0a) !== wire.length - 1) return null;
    const parsed: unknown = JSON.parse(wire.subarray(0, wire.length - 1).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || typeof (parsed as { readonly ok?: unknown }).ok !== 'boolean') return null;
    return parsed as ControlResponse;
  } catch {
    return null;
  }
}

function captureOptions(input: G11cPrivateDrainOptions): Readonly<G11cPrivateDrainOptions> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Reflect.ownKeys(input).length !== 3
    || typeof input.socketPath !== 'string' || typeof input.epoch !== 'string' || typeof input.run !== 'string'
    || !uuid.test(input.epoch) || !uuid.test(input.run) || input.socketPath.length === 0 || input.socketPath.includes('\0')) {
    throw new TypeError('invalid G11c private drain options');
  }
  return Object.freeze({ socketPath: input.socketPath, epoch: input.epoch, run: input.run });
}
