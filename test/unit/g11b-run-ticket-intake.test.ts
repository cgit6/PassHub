import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  ConsumedRunTicket,
  G11B_RUN_TICKET_DIRECTORY,
  G11B_RUN_TICKET_PATH,
  readConsumedRunTicketForRuntime,
  RunTicketIntakeError,
  type RunTicketIntakeFailure,
} from '../../src/deployment/internal/g11b-run-ticket-intake.js';
import {
  createG11bRunTicketIntakeForFsTest,
  type G11bRunTicketFsTestFaults,
} from '../support/g11b-run-ticket-test-support.js';

const tempDirectories: string[] = [];
const childRegistry = new Map<ChildProcess, Promise<ChildResult>>();

afterEach(async () => {
  await terminateRegisteredChildren();
  for (const directory of tempDirectories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'passhub-g11b-'))) throw new Error('unsafe test cleanup target');
    await rm(directory, { recursive: true, force: true });
  }
});

interface TicketValues {
  readonly v: 'g11b.run-ticket.v1';
  readonly ticketId: string;
  readonly datasetEpoch: string;
  readonly processRunId: string;
}

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'passhub-g11b-'));
  tempDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function ticketValues(): TicketValues {
  return Object.freeze({
    v: 'g11b.run-ticket.v1',
    ticketId: randomUUID(),
    datasetEpoch: randomUUID(),
    processRunId: randomUUID(),
  });
}

function wire(ticket: TicketValues): string { return `${JSON.stringify(ticket)}\n`; }

async function putTicket(directory: string, content: string | Uint8Array, mode = 0o400): Promise<void> {
  const path = join(directory, 'bootstrap-ticket.json');
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

async function expectFailure(action: Promise<unknown>, code: RunTicketIntakeFailure): Promise<RunTicketIntakeError> {
  try {
    await action;
    throw new Error('expected run-ticket intake to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RunTicketIntakeError);
    expect((error as RunTicketIntakeError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    return error as RunTicketIntakeError;
  }
}

async function markerEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.startsWith('.bootstrap-ticket.used.'));
}

async function expectRejectedWithoutConsumption(
  directory: string,
  processRunId: string,
  expected: RunTicketIntakeFailure,
  consume = createG11bRunTicketIntakeForFsTest(directory),
): Promise<void> {
  await expectFailure(consume(processRunId), expected);
  expect((await lstat(join(directory, 'bootstrap-ticket.json'))).isFile()).toBe(true);
  expect(await markerEntries(directory)).toEqual([]);
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

async function runChild(directory: string, identityPath: string, mode = 'consume'): Promise<ChildResult> {
  const started = startChild(directory, identityPath, mode);
  await started.spawned;
  return started.result;
}

function startChild(
  directory: string,
  identityPath: string,
  mode = 'consume',
  barrierPath?: string,
  readyPath?: string,
): { readonly child: ChildProcess; readonly spawned: Promise<void>; readonly result: Promise<ChildResult> } {
  const fixture = join(process.cwd(), 'dist/test/fixtures/g11b-run-ticket-child.js');
  const args = [fixture, directory, identityPath, mode];
  if (barrierPath !== undefined && readyPath !== undefined) args.push(barrierPath, readyPath);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const result = new Promise<ChildResult>((resolve) => {
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    let killTimer: NodeJS.Timeout | undefined;
    const termTimer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
    }, 5_000);
    child.once('close', (code, signal) => {
      clearTimeout(termTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      childRegistry.delete(child);
      resolve({ code, signal, output: output.trim() });
    });
  });
  childRegistry.set(child, result);
  return Object.freeze({ child, spawned, result });
}

async function terminateRegisteredChildren(): Promise<void> {
  const entries = [...childRegistry.entries()];
  if (entries.length === 0) return;
  for (const [child] of entries) child.kill('SIGTERM');
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  for (const [child] of entries) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.allSettled(entries.map(([, result]) => result));
}

async function waitForReadyFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  const pending = new Set(paths);
  while (pending.size > 0 && Date.now() < deadline) {
    await Promise.all([...pending].map(async (path) => {
      try {
        await lstat(path);
        pending.delete(path);
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }));
    if (pending.size > 0) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (pending.size > 0) throw new Error('child start barrier was not reached');
}

describe('G11b b1 capability and production boundary', () => {
  test('pins the sole production pathname and has no runtime path source', async () => {
    expect(G11B_RUN_TICKET_DIRECTORY).toBe('/run/passhub/api');
    expect(G11B_RUN_TICKET_PATH).toBe('/run/passhub/api/bootstrap-ticket.json');
    const source = await readFile(join(process.cwd(), 'src/deployment/internal/g11b-run-ticket-intake.ts'), 'utf8');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('process.argv');
    expect(source).not.toContain('export class RunTicketFileIntake');
    expect(source).not.toContain('ForFsTest');
    expect(source).not.toContain('FaultPoint');
    expect(source).toMatch(/consumeCanonicalRunTicket\(processRunId: string\)[\s\S]*consumeRunTicketWithEngine\(G11B_RUN_TICKET_DIRECTORY, processRunId/u);
    const packageModel = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { exports: unknown };
    expect(JSON.stringify(packageModel.exports)).not.toContain('deployment');
  });

  test('production sources cannot import the dedicated test-support adapter', async () => {
    const sourceRoot = join(process.cwd(), 'src');
    const names = await readdir(sourceRoot, { recursive: true });
    const sourceFiles = names.filter((name) => name.endsWith('.ts'));
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const name of sourceFiles) {
      const source = await readFile(join(sourceRoot, name), 'utf8');
      expect(source).not.toContain('g11b-run-ticket-test-support');
      expect(source).not.toMatch(/from\s+['"][^'"]*test\/support/u);
    }
  });

  test('the configurable engine has exactly the production facade and test adapter as importers', async () => {
    // Assemble the basename so this boundary test does not count itself as a
    // source-level reference to the guarded module.
    const guardedModule = ['g11b', 'run', 'ticket', 'engine'].join('-');
    const importers: string[] = [];
    for (const rootName of ['src', 'test']) {
      const root = join(process.cwd(), rootName);
      const names = await readdir(root, { recursive: true });
      for (const name of names.filter((value) => value.endsWith('.ts'))) {
        const source = await readFile(join(root, name), 'utf8');
        if (source.includes(guardedModule)) importers.push(`${rootName}/${name}`);
      }
    }
    expect(importers.sort()).toEqual([
      'src/deployment/internal/g11b-run-ticket-intake.ts',
      'test/support/g11b-run-ticket-test-support.ts',
    ]);
  });

  test('returns an opaque nominal token whose facts exist only in the runtime reader', async () => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const token = await createG11bRunTicketIntakeForFsTest(directory)(ticket.processRunId);
    expect(token).toBeInstanceOf(ConsumedRunTicket);
    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(Object.isFrozen(token)).toBe(true);
    expect(readConsumedRunTicketForRuntime(token)).toEqual({
      ticketId: ticket.ticketId,
      datasetEpoch: ticket.datasetEpoch,
      processRunId: ticket.processRunId,
    });
  });

  test('rejects constructed, structural, and prototype-forged tokens', () => {
    expect(() => new ConsumedRunTicket(Symbol('foreign'))).toThrow(
      expect.objectContaining({ code: 'CONSUMED_TICKET_INVALID' }),
    );
    for (const forged of [{}, Object.create(ConsumedRunTicket.prototype)]) {
      expect(() => readConsumedRunTicketForRuntime(forged as ConsumedRunTicket)).toThrow(
        expect.objectContaining({ code: 'CONSUMED_TICKET_INVALID' }),
      );
    }
  });
});

describe('G11b b1 wire and filesystem validation', () => {
  test('accepts arbitrary valid JSON property order and whitespace', async () => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    const flexible = ` { \t "processRunId" : "${ticket.processRunId}", \t "v":"${ticket.v}", "datasetEpoch" : "${ticket.datasetEpoch}", "ticketId":"${ticket.ticketId}" } \t\n`;
    await putTicket(directory, flexible);
    const token = await createG11bRunTicketIntakeForFsTest(directory)(ticket.processRunId);
    expect(readConsumedRunTicketForRuntime(token).ticketId).toBe(ticket.ticketId);
  });

  test.each([
    ['duplicate literal key', (value: TicketValues) => `{"v":"${value.v}","ticketId":"${value.ticketId}","datasetEpoch":"${value.datasetEpoch}","processRunId":"${value.processRunId}","v":"${value.v}"}\n`],
    ['duplicate escaped key', (value: TicketValues) => `{"v":"${value.v}","ticketId":"${value.ticketId}","ticket\\u0049d":"${value.ticketId}","datasetEpoch":"${value.datasetEpoch}","processRunId":"${value.processRunId}"}\n`],
    ['leading BOM', (value: TicketValues) => `\ufeff${wire(value)}`],
    ['missing LF', (value: TicketValues) => JSON.stringify(value)],
    ['embedded LF', (value: TicketValues) => `{\n${JSON.stringify(value).slice(1)}\n`],
    ['double terminal LF', (value: TicketValues) => `${JSON.stringify(value)}\n\n`],
    ['CRLF', (value: TicketValues) => `${JSON.stringify(value)}\r\n`],
    ['empty file', () => ''],
    ['nonobject root', () => '[]\n'],
    ['scalar root', () => '4\n'],
    ['null root', () => 'null\n'],
    ['wrong version', (value: TicketValues) => `${JSON.stringify({ ...value, v: 'g11b.run-ticket.v2' })}\n`],
    ['wrong field type', (value: TicketValues) => `${JSON.stringify({ ...value, ticketId: 4 })}\n`],
    ['extra field', (value: TicketValues) => `${JSON.stringify({ ...value, extra: true })}\n`],
    ['missing field', (value: TicketValues) => `${JSON.stringify({ v: value.v, ticketId: value.ticketId, datasetEpoch: value.datasetEpoch })}\n`],
  ])('rejects invalid wire without consuming it: %s', async (_label, render) => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, render(ticket));
    const expected = (await lstat(join(directory, 'bootstrap-ticket.json'))).size === 0
      ? 'TICKET_FILE_UNSAFE' as const
      : 'TICKET_INVALID' as const;
    await expectRejectedWithoutConsumption(directory, ticket.processRunId, expected);
  });

  test.each(['ticketId', 'datasetEpoch', 'processRunId'] as const)(
    'rejects an uppercase UUID %s without consumption',
    async (field) => {
      const directory = await privateDirectory();
      const original = ticketValues();
      const ticket = { ...original, [field]: '00000000-0000-4000-8000-00000000000A' };
      await putTicket(directory, `${JSON.stringify(ticket)}\n`);
      await expectRejectedWithoutConsumption(directory, original.processRunId, 'TICKET_INVALID');
    },
  );

  test.each(['ticketId', 'datasetEpoch', 'processRunId'] as const)(
    'rejects a lowercase wrong-version UUID %s without consumption',
    async (field) => {
      const directory = await privateDirectory();
      const original = ticketValues();
      const ticket = { ...original, [field]: '00000000-0000-5000-8000-000000000000' };
      await putTicket(directory, `${JSON.stringify(ticket)}\n`);
      await expectRejectedWithoutConsumption(directory, original.processRunId, 'TICKET_INVALID');
    },
  );

  test('rejects process binding without consumption or secret-bearing errors', async () => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const error = await expectFailure(
      createG11bRunTicketIntakeForFsTest(directory)(randomUUID()),
      'PROCESS_BINDING_MISMATCH',
    );
    expect(error.message).not.toContain(ticket.ticketId);
    expect(error.message).not.toContain(ticket.datasetEpoch);
    expect(error.message).not.toContain(ticket.processRunId);
    expect((await lstat(join(directory, 'bootstrap-ticket.json'))).isFile()).toBe(true);
    expect(await markerEntries(directory)).toEqual([]);
  });

  test('rejects a missing, symlinked, or non-0700 runtime directory', async () => {
    const parent = await privateDirectory();
    const missing = join(parent, 'missing');
    await expectFailure(createG11bRunTicketIntakeForFsTest(missing)(randomUUID()), 'RUNTIME_DIRECTORY_UNSAFE');
    const real = join(parent, 'real');
    const link = join(parent, 'link');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, link, 'dir');
    await expectFailure(createG11bRunTicketIntakeForFsTest(link)(randomUUID()), 'RUNTIME_DIRECTORY_UNSAFE');
    await chmod(real, 0o750);
    await expectFailure(createG11bRunTicketIntakeForFsTest(real)(randomUUID()), 'RUNTIME_DIRECTORY_UNSAFE');
  });

  test('rejects a regular file used as the runtime path without mutation', async () => {
    const parent = await privateDirectory();
    const runtimePath = join(parent, 'runtime-file');
    await writeFile(runtimePath, 'unchanged', { mode: 0o700 });
    await chmod(runtimePath, 0o700);
    await expectFailure(
      createG11bRunTicketIntakeForFsTest(runtimePath)(randomUUID()),
      'RUNTIME_DIRECTORY_UNSAFE',
    );
    expect(await readFile(runtimePath, 'utf8')).toBe('unchanged');
  });

  test('directly proves wrong runtime-directory ownership rejects without mutation', async () => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const differentUid = process.getuid!() === 0 ? 1 : 0;
    const consume = createG11bRunTicketIntakeForFsTest(directory, {
      expectedDirectoryOwnerUid: differentUid,
    });
    await expectRejectedWithoutConsumption(directory, ticket.processRunId, 'RUNTIME_DIRECTORY_UNSAFE', consume);
  });

  test('reports ticket absence as not proven without creating state', async () => {
    const directory = await privateDirectory();
    await expectFailure(createG11bRunTicketIntakeForFsTest(directory)(randomUUID()), 'TICKET_NOT_PROVEN');
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  test('rejects symlink and directory ticket objects', async () => {
    const symlinkDirectory = await privateDirectory();
    const target = join(symlinkDirectory, 'target');
    await writeFile(target, wire(ticketValues()), { mode: 0o400 });
    await symlink(target, join(symlinkDirectory, 'bootstrap-ticket.json'));
    await expectFailure(createG11bRunTicketIntakeForFsTest(symlinkDirectory)(randomUUID()), 'TICKET_FILE_UNSAFE');
    const objectDirectory = await privateDirectory();
    await mkdir(join(objectDirectory, 'bootstrap-ticket.json'), { mode: 0o400 });
    await expectFailure(createG11bRunTicketIntakeForFsTest(objectDirectory)(randomUUID()), 'TICKET_FILE_UNSAFE');
  });

  test('rejects a real FIFO promptly and never blocks opening it', async () => {
    const directory = await privateDirectory();
    const path = join(directory, 'bootstrap-ticket.json');
    expect(spawnSync('mkfifo', [path]).status).toBe(0);
    await chmod(path, 0o400);
    await expectFailure(createG11bRunTicketIntakeForFsTest(directory)(randomUUID()), 'TICKET_FILE_UNSAFE');
  });

  test('rejects a real Unix socket object', async () => {
    const directory = await privateDirectory();
    const path = join(directory, 'bootstrap-ticket.json');
    const server: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o400);
    try {
      await expectFailure(createG11bRunTicketIntakeForFsTest(directory)(randomUUID()), 'TICKET_FILE_UNSAFE');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test.each([0o600, 0o440, 0o000])('rejects ticket mode %s', async (mode) => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket), mode);
    await expectFailure(createG11bRunTicketIntakeForFsTest(directory)(ticket.processRunId), 'TICKET_FILE_UNSAFE');
  });

  test('rejects over-bound and malformed UTF-8 files', async () => {
    const oversized = await privateDirectory();
    await putTicket(oversized, `${'x'.repeat(512)}\n`);
    await expectFailure(createG11bRunTicketIntakeForFsTest(oversized)(randomUUID()), 'TICKET_FILE_UNSAFE');
    const malformed = await privateDirectory();
    await putTicket(malformed, Uint8Array.from([0xc3, 0x28, 0x0a]));
    await expectRejectedWithoutConsumption(malformed, randomUUID(), 'TICKET_INVALID');
  });

  test('directly proves the wrong-owner rejection branch without privileged chown', async () => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const differentUid = process.getuid!() === 0 ? 1 : 0;
    const consume = createG11bRunTicketIntakeForFsTest(directory, { expectedTicketOwnerUid: differentUid });
    await expectRejectedWithoutConsumption(directory, ticket.processRunId, 'TICKET_FILE_UNSAFE', consume);
  });
});

describe('G11b b1 one-use lifecycle and fault closure', () => {
  test('persists a private marker, removes pending, and rejects reconstructed replay', async () => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    await createG11bRunTicketIntakeForFsTest(directory)(ticket.processRunId);
    const markers = await markerEntries(directory);
    expect(markers).toHaveLength(1);
    const marker = await lstat(join(directory, markers[0]!));
    expect(marker.isFile()).toBe(true);
    expect(marker.size).toBe(0);
    expect(marker.uid).toBe(process.getuid!());
    expect(marker.mode & 0o7777).toBe(0o400);
    await putTicket(directory, wire(ticket));
    await expectFailure(createG11bRunTicketIntakeForFsTest(directory)(ticket.processRunId), 'TICKET_ALREADY_USED');
    expect((await lstat(join(directory, 'bootstrap-ticket.json'))).isFile()).toBe(true);
  });

  test.each([
    ['markerCreate', false, true],
    ['markerSync', true, true],
    ['markerClose', true, true],
    ['directoryFirstSync', true, true],
    ['unlink', true, true],
    ['directoryFinalSync', true, false],
    ['ticketClose', false, true],
    ['directoryClose', true, false],
  ] as const)('%s failure returns capability0 and preserves fail-closed state', async (point, markerExpected, pendingExpected) => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const faults: G11bRunTicketFsTestFaults = { [point]: () => { throw new Error('injected'); } };
    await expectFailure(
      createG11bRunTicketIntakeForFsTest(directory, { faults })(ticket.processRunId),
      'CONSUME_UNKNOWN',
    );
    expect((await markerEntries(directory)).length).toBe(markerExpected ? 1 : 0);
    const pending = lstat(join(directory, 'bootstrap-ticket.json'));
    if (pendingExpected) await expect(pending).resolves.toBeDefined();
    else await expect(pending).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('cleanup close failures do not mask the primary validation error', async () => {
    const directory = await privateDirectory();
    const ticket = ticketValues();
    await putTicket(directory, '{}\n');
    const fail = (): never => { throw new Error('injected close failure'); };
    await expectRejectedWithoutConsumption(
      directory,
      ticket.processRunId,
      'TICKET_INVALID',
      createG11bRunTicketIntakeForFsTest(directory, { faults: { ticketClose: fail, directoryClose: fail } }),
    );
  });

  test('true child-process contenders produce exactly one capability winner and closed loser codes', async () => {
    const root = await privateDirectory();
    const directory = join(root, 'runtime');
    await mkdir(directory, { mode: 0o700 });
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const identityPath = join(root, 'process-id');
    await writeFile(identityPath, `${ticket.processRunId}\n`, { mode: 0o400 });
    const barrierPath = join(root, 'start-barrier');
    const readyPaths = Array.from({ length: 12 }, (_value, index) => join(root, `ready-${index}`));
    const contenders = readyPaths.map(
      (readyPath) => startChild(directory, identityPath, 'consume', barrierPath, readyPath),
    );
    await Promise.all(contenders.map((contender) => contender.spawned));
    await waitForReadyFiles(readyPaths);
    expect(await Promise.all(readyPaths.map(async (path) => (await lstat(path)).isFile()))).toEqual(
      Array.from({ length: 12 }, () => true),
    );
    await writeFile(barrierPath, '', { mode: 0o400, flag: 'wx' });
    const results = await Promise.all(contenders.map((contender) => contender.result));
    const winners = results.filter((result) => result.output === 'CONSUMED');
    expect(winners).toEqual([{ code: 0, signal: null, output: 'CONSUMED' }]);
    const losers = results.filter((result) => result.output !== 'CONSUMED');
    expect(losers).toHaveLength(11);
    for (const loser of losers) {
      expect(loser.code).toBe(1);
      expect(loser.signal).toBeNull();
      expect(['TICKET_ALREADY_USED', 'TICKET_NOT_PROVEN']).toContain(loser.output);
      expect(loser.output).not.toBe('CONSUME_UNKNOWN');
    }
    expect(await markerEntries(directory)).toHaveLength(1);
    await expect(lstat(join(directory, 'bootstrap-ticket.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(childRegistry.size).toBe(0);
  });

  test('a normal child consume remains used across a fresh-process replay', async () => {
    const root = await privateDirectory();
    const directory = join(root, 'runtime');
    await mkdir(directory, { mode: 0o700 });
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const identityPath = join(root, 'process-id');
    await writeFile(identityPath, `${ticket.processRunId}\n`, { mode: 0o400 });
    const first = await runChild(directory, identityPath);
    expect(first).toMatchObject({ code: 0, signal: null, output: 'CONSUMED' });
    await putTicket(directory, wire(ticket));
    const restarted = await runChild(directory, identityPath);
    expect(restarted).toMatchObject({ code: 1, signal: null, output: 'TICKET_ALREADY_USED' });
    expect((await lstat(join(directory, 'bootstrap-ticket.json'))).isFile()).toBe(true);
  });

  test('a true process crash after durable marker leaves pending+used and restart rejects it', async () => {
    const root = await privateDirectory();
    const directory = join(root, 'runtime');
    await mkdir(directory, { mode: 0o700 });
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const identityPath = join(root, 'process-id');
    await writeFile(identityPath, `${ticket.processRunId}\n`, { mode: 0o400 });
    const crashed = await runChild(directory, identityPath, 'crash-after-marker');
    expect(crashed.signal).toBe('SIGKILL');
    expect(crashed.output).toBe('');
    expect((await lstat(join(directory, 'bootstrap-ticket.json'))).isFile()).toBe(true);
    expect(await markerEntries(directory)).toHaveLength(1);
    const restarted = await runChild(directory, identityPath);
    expect(restarted.code).toBe(1);
    expect(restarted.output).toBe('TICKET_ALREADY_USED');
    expect((await lstat(join(directory, 'bootstrap-ticket.json'))).isFile()).toBe(true);
  });

  test('a pre-existing pending+used crash state rejects in a fresh child process', async () => {
    const root = await privateDirectory();
    const directory = join(root, 'runtime');
    await mkdir(directory, { mode: 0o700 });
    const ticket = ticketValues();
    await putTicket(directory, wire(ticket));
    const markerPath = join(directory, `.bootstrap-ticket.used.${ticket.ticketId}`);
    const marker = await open(markerPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o400);
    await marker.close();
    await chmod(markerPath, 0o400);
    const identityPath = join(root, 'process-id');
    await writeFile(identityPath, `${ticket.processRunId}\n`, { mode: 0o400 });
    const result = await runChild(directory, identityPath);
    expect(result.code).toBe(1);
    expect(result.output).toBe('TICKET_ALREADY_USED');
    expect((await lstat(join(directory, 'bootstrap-ticket.json'))).isFile()).toBe(true);
  });
});
