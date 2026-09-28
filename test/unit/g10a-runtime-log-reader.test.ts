import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_LOG_FILE_NAME,
  RUNTIME_LOG_FILE_MAX_BYTES,
  RuntimeLogReadAbortedError,
  RuntimeLogReadError,
  RuntimeLogFileStore,
  createRuntimeLogFileStore,
} from '../../src/runtime/internal/runtime-log-file-store.js';
import {
  RUNTIME_LOG_SCHEMA_VERSION,
  createRuntimeLogRecord,
  encodeRuntimeLogRecord,
  type RuntimeLogRecord,
} from '../../src/runtime/internal/runtime-log-schema.js';

const ids = Object.freeze({
  epoch: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
  request: '11111111-1111-4111-8111-111111111111',
  one: '55555555-5555-4555-8555-555555555555',
  two: '66666666-6666-4666-8666-666666666666',
} as const);

function record(operationUUID: string | null, second: number): RuntimeLogRecord {
  return createRuntimeLogRecord({
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION,
    timestamp: `2026-09-28T00:00:0${second}.000Z`,
    kind: 'RUNTIME', code: 'OPERATION_REGISTERED', requestUUID: ids.request,
    operationUUID, datasetEpoch: ids.epoch, processRunId: ids.run,
    ownerRef: operationUUID === null ? null : ids.one, route: operationUUID === null ? 'QUERY' : 'RECOGNITION', phase: operationUUID === null ? 'INGRESS' : 'ADMISSION',
    round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
    commandName: null, driverRequestId: null, requestControlId: null, controlId: null, revision: null,
  } as unknown as RuntimeLogRecord);
}

// REQUEST_ACCEPTED is used for non-operation fixture records; it keeps the
// log schema itself—not a hand-made object—as the source of test validity.
function requestRecord(second: number): RuntimeLogRecord {
  return createRuntimeLogRecord({
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION,
    timestamp: `2026-09-28T00:00:0${second}.000Z`, kind: 'RUNTIME', code: 'REQUEST_ACCEPTED',
    requestUUID: ids.request, operationUUID: null, datasetEpoch: ids.epoch, processRunId: ids.run, ownerRef: null,
    route: 'QUERY', phase: 'INGRESS', round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
    commandName: null, driverRequestId: null, requestControlId: null, controlId: null, revision: null,
  });
}

async function directory(): Promise<string> { return mkdtemp(join(tmpdir(), 'passhub-g10a-reader-')); }
async function put(path: string, records: readonly RuntimeLogRecord[]): Promise<void> {
  await writeFile(path, records.map(encodeRuntimeLogRecord).join(''), { mode: 0o600 });
  await chmod(path, 0o600);
}

describe('G10a A10.5 private runtime log reader', () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))); });

  test('takes an oldest-to-active snapshot, filters one operation, and returns the latest bounded records chronologically', async () => {
    const parent = await directory(); cleanup.push(parent);
    const logDirectory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory: logDirectory });
    expect(bundle.store).not.toBeNull();
    await put(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.4`), [record(ids.one, 0)]);
    await put(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.2`), [requestRecord(1), record(ids.one, 2)]);
    await put(join(logDirectory, RUNTIME_LOG_FILE_NAME), [record(ids.two, 3), record(ids.one, 4)]);

    const result = await bundle.store!.readOperation({ operationUUID: ids.one, limit: 2 });
    expect(result.truncated).toBe(true);
    expect(result.records.map((item) => item.timestamp)).toEqual([
      '2026-09-28T00:00:02.000Z', '2026-09-28T00:00:04.000Z',
    ]);
    expect(result.records.every((item) => item.operationUUID === ids.one)).toBe(true);
  });

  test('uses the default limit, skips absent archives, and represents no match without truncation', async () => {
    const parent = await directory(); cleanup.push(parent);
    const bundle = await createRuntimeLogFileStore({ directory: join(parent, 'logs') });
    expect(bundle.store).not.toBeNull();
    await expect(bundle.store!.readOperation({ operationUUID: ids.one })).resolves.toEqual({ records: [], truncated: false });
  });

  test('returns no partial results when an archive is malformed, unsafe, or the active file vanishes after initialization', async () => {
    const parent = await directory(); cleanup.push(parent);
    const logDirectory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory: logDirectory });
    expect(bundle.store).not.toBeNull();
    await put(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.1`), [record(ids.one, 0)]);
    await writeFile(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.2`), '{bad-json}\n', { mode: 0o600 });
    await chmod(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.2`), 0o600);
    await expect(bundle.store!.readOperation({ operationUUID: ids.one })).rejects.toBeInstanceOf(RuntimeLogReadError);
    await rm(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.2`));
    await rm(join(logDirectory, RUNTIME_LOG_FILE_NAME));
    await expect(bundle.store!.readOperation({ operationUUID: ids.one })).rejects.toBeInstanceOf(RuntimeLogReadError);
  });

  test('releases the mutex after a read failure so a repaired file can be read and appended normally', async () => {
    const parent = await directory(); cleanup.push(parent);
    const logDirectory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory: logDirectory });
    const store = bundle.store!;
    const active = join(logDirectory, RUNTIME_LOG_FILE_NAME);
    await writeFile(active, '{bad-json}\n', { mode: 0o600 });
    await chmod(active, 0o600);
    await expect(store.readOperation({ operationUUID: ids.one })).rejects.toBeInstanceOf(RuntimeLogReadError);
    await put(active, [record(ids.one, 0)]);
    await expect(store.readOperation({ operationUUID: ids.one })).resolves.toMatchObject({ truncated: false });
    await expect(store.write(encodeRuntimeLogRecord(requestRecord(1)))).resolves.toBeUndefined();
  });

  test('serializes direct startup validation before a queued append and read snapshot', async () => {
    const parent = await directory(); cleanup.push(parent);
    const logDirectory = join(parent, 'logs');
    await mkdir(logDirectory, { mode: 0o700 });
    await chmod(logDirectory, 0o700);
    const store = new RuntimeLogFileStore(logDirectory);

    // The first call must own the shared mutex while it creates runtime.log.
    // Without that lock, append may observe a missing active file and poison
    // the store before initialization has finished.
    const startup = store.validateStartup();
    const writer = store.write(encodeRuntimeLogRecord(record(ids.one, 0)));
    const reader = store.readOperation({ operationUUID: ids.one });

    await expect(startup).resolves.toBeUndefined();
    await expect(writer).resolves.toBeUndefined();
    await expect(reader).resolves.toMatchObject({
      truncated: false,
      records: [expect.objectContaining({ operationUUID: ids.one })],
    });
  });

  test('releases the shared mutex when direct startup validation fails', async () => {
    const parent = await directory(); cleanup.push(parent);
    const logDirectory = join(parent, 'logs');
    await mkdir(logDirectory, { mode: 0o700 });
    await chmod(logDirectory, 0o700);
    const active = join(logDirectory, RUNTIME_LOG_FILE_NAME);
    await writeFile(active, '{not-valid-ndjson}\n', { mode: 0o600 });
    await chmod(active, 0o600);
    const store = new RuntimeLogFileStore(logDirectory);

    await expect(store.validateStartup()).rejects.toBeInstanceOf(Error);
    await put(active, [record(ids.one, 0)]);
    await expect(store.readOperation({ operationUUID: ids.one })).resolves.toMatchObject({ truncated: false });
    await expect(store.write(encodeRuntimeLogRecord(requestRecord(1)))).resolves.toBeUndefined();
  });

  test('rejects malformed internal input and a pre-aborted acquisition without changing files', async () => {
    const parent = await directory(); cleanup.push(parent);
    const bundle = await createRuntimeLogFileStore({ directory: join(parent, 'logs') });
    expect(bundle.store).not.toBeNull();
    await expect(bundle.store!.readOperation({ operationUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() })).rejects.toThrow('operation UUID');
    await expect(bundle.store!.readOperation({ operationUUID: ids.one, limit: 0 })).rejects.toThrow('limit');
    const controller = new AbortController(); controller.abort();
    await expect(bundle.store!.readOperation({ operationUUID: ids.one, signal: controller.signal })).rejects.toBeInstanceOf(RuntimeLogReadAbortedError);
  });

  test('an aborted waiter leaves the shared writer/reader mutex usable by the next append', async () => {
    const parent = await directory(); cleanup.push(parent);
    const bundle = await createRuntimeLogFileStore({ directory: join(parent, 'logs') });
    const store = bundle.store!;
    const internals = store as unknown as { appendLine: (line: string) => Promise<void> };
    const original = internals.appendLine.bind(store);
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    internals.appendLine = async () => gate;
    const writer = store.write(encodeRuntimeLogRecord(requestRecord(0)));
    await Promise.resolve();
    const controller = new AbortController();
    const reader = store.readOperation({ operationUUID: ids.one, signal: controller.signal });
    controller.abort();
    await expect(reader).rejects.toBeInstanceOf(RuntimeLogReadAbortedError);
    openGate!();
    await writer;
    internals.appendLine = original;
    await expect(store.write(encodeRuntimeLogRecord(requestRecord(1)))).resolves.toBeUndefined();
  });

  test.each([
    ['UTF-8 BOM', (line: string) => `\uFEFF${line}`],
    ['CRLF', (line: string) => line.replace(/\n$/u, '\r\n')],
    ['missing terminal LF', (line: string) => line.slice(0, -1)],
    ['a malformed later NDJSON record', (line: string) => `${line}{bad-json}\n`],
    ['duplicate top-level key', (line: string) => line.replace('{"schemaVersion"', '{"schemaVersion":"forged","schemaVersion"')],
    ['duplicate nested key', (line: string) => line.replace('"timestamp"', '"timestamp":"forged","timestamp"')],
  ])('rejects %s as a whole-file failure without returning earlier matching records', async (_label, corrupt) => {
    const parent = await directory(); cleanup.push(parent);
    const logDirectory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory: logDirectory });
    expect(bundle.store).not.toBeNull();
    await put(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.1`), [record(ids.one, 0)]);
    await writeFile(join(logDirectory, RUNTIME_LOG_FILE_NAME), corrupt(encodeRuntimeLogRecord(record(ids.one, 1))), { mode: 0o600 });
    await chmod(join(logDirectory, RUNTIME_LOG_FILE_NAME), 0o600);
    await expect(bundle.store!.readOperation({ operationUUID: ids.one })).rejects.toBeInstanceOf(RuntimeLogReadError);
  });

  test('aborts a read after an FD has been captured, closes it, and leaves reader/writer canaries usable', async () => {
    const parent = await directory(); cleanup.push(parent);
    const logDirectory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory: logDirectory });
    const store = bundle.store!;
    await put(join(logDirectory, RUNTIME_LOG_FILE_NAME), [record(ids.one, 0)]);

    // Abort precisely after the reader's first asynchronous FD read returns.
    // This exercises the post-read cancellation path rather than only queue
    // acquisition.  The method is restored before either canary runs.
    const probe = await open(join(logDirectory, RUNTIME_LOG_FILE_NAME), 'r');
    const prototype = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
    await probe.close();
    const originalRead = prototype.read;
    const controller = new AbortController();
    let armed = true;
    prototype.read = async function patchedRead(this: unknown, ...args: unknown[]): Promise<unknown> {
      const result = await originalRead.apply(this, args);
      if (armed) { armed = false; controller.abort(); }
      return result;
    };
    try {
      await expect(store.readOperation({ operationUUID: ids.one, signal: controller.signal })).rejects.toBeInstanceOf(RuntimeLogReadAbortedError);
    } finally {
      prototype.read = originalRead;
    }
    await expect(store.readOperation({ operationUUID: ids.one })).resolves.toMatchObject({ truncated: false });
    await expect(store.write(encodeRuntimeLogRecord(requestRecord(2)))).resolves.toBeUndefined();
  });

  test('keeps the captured pre-rotation FD snapshot while a concurrent append rotates the active path', async () => {
    const parent = await directory(); cleanup.push(parent);
    const logDirectory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory: logDirectory });
    const store = bundle.store!;
    const oldLine = encodeRuntimeLogRecord(record(ids.one, 0));
    // Fill with whole valid lines, close enough to the 10MiB boundary that
    // one normal sink line must rotate rather than append.
    const count = Math.ceil((RUNTIME_LOG_FILE_MAX_BYTES - oldLine.length + 1) / oldLine.length);
    await writeFile(join(logDirectory, RUNTIME_LOG_FILE_NAME), oldLine.repeat(count), { mode: 0o600 });
    await chmod(join(logDirectory, RUNTIME_LOG_FILE_NAME), 0o600);

    const probe = await open(join(logDirectory, RUNTIME_LOG_FILE_NAME), 'r');
    const prototype = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
    await probe.close();
    const originalRead = prototype.read;
    let entered: (() => void) | undefined;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    let resume: (() => void) | undefined;
    const pause = new Promise<void>((resolve) => { resume = resolve; });
    let armed = true;
    prototype.read = async function pausedRead(this: unknown, ...args: unknown[]): Promise<unknown> {
      if (armed) { armed = false; entered!(); await pause; }
      return originalRead.apply(this, args);
    };
    try {
      const reader = store.readOperation({ operationUUID: ids.one });
      await enteredRead;
      await store.write(encodeRuntimeLogRecord(requestRecord(1)));
      resume!();
      await expect(reader).resolves.toMatchObject({ truncated: true, records: expect.arrayContaining([expect.objectContaining({ operationUUID: ids.one })]) });
    } finally {
      prototype.read = originalRead;
    }
  });
});
