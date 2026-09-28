import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_LOG_ARCHIVE_COUNT,
  RUNTIME_LOG_FILE_MAX_BYTES,
  RUNTIME_LOG_FILE_NAME,
  createRuntimeLogFileStore,
} from '../../src/runtime/internal/runtime-log-file-store.js';
import {
  RUNTIME_LOG_SCHEMA_VERSION,
  createRuntimeLogRecord,
  encodeRuntimeLogRecord,
  type RuntimeLogRecord,
} from '../../src/runtime/internal/runtime-log-schema.js';
import * as publicApi from '../../src/index.js';
import * as publicCompositionApi from '../../src/composition/index.js';

const ids = {
  request: '11111111-1111-4111-8111-111111111111',
  epoch: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
} as const;

function record(): RuntimeLogRecord {
  return createRuntimeLogRecord({
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION, timestamp: '2026-09-28T00:00:00.000Z', kind: 'RUNTIME', code: 'REQUEST_ACCEPTED',
    requestUUID: ids.request, operationUUID: null, datasetEpoch: ids.epoch, processRunId: ids.run, ownerRef: null,
    route: 'QUERY', phase: 'INGRESS', round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
    commandName: null, driverRequestId: null, requestControlId: null, controlId: null, revision: null,
  });
}

async function temporaryDirectory(): Promise<string> { return mkdtemp(join(tmpdir(), 'passhub-g10a-log-')); }

describe('G10a A10.4 private runtime log file store', () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))); });

  test('is private and initializes a fresh 0700 directory plus a 0600 active file', async () => {
    for (const api of [publicApi, publicCompositionApi]) expect(Object.keys(api).filter((key) => /runtime.*log|log.*store|logger/iu.test(key))).toEqual([]);
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory });
    expect(bundle.store).not.toBeNull();
    expect(bundle.sink.snapshot()).toMatchObject({ status: 'HEALTHY', droppedCount: 0 });
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, RUNTIME_LOG_FILE_NAME))).mode & 0o777).toBe(0o600);
    expect(bundle.sink.append(record())).toBe(true);
    await bundle.sink.flush();
    expect(await readFile(join(directory, RUNTIME_LOG_FILE_NAME), 'utf8')).toBe(encodeRuntimeLogRecord(record()));
  });

  test('fails closed rather than pathname-chmodding a fresh directory it cannot safely acquire by fd', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'umask-denied');
    const originalUmask = process.umask(0o777);
    try {
      const bundle = await createRuntimeLogFileStore({ directory });
      expect(bundle.store).toBeNull();
      expect(bundle.sink.snapshot()).toMatchObject({ status: 'LOGGING_DEGRADED', droppedCount: 0 });
      // The implementation must not repair this by chmod(directory): the
      // fresh path could have been replaced before a pathname chmod.
      expect((await lstat(directory)).mode & 0o777).toBe(0o000);
    } finally {
      process.umask(originalUmask);
    }
  });

  test('fail-closes initialization for unsafe directories, symlink files, malformed/truncated NDJSON, duplicate keys, and invalid UTF-8', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const cases: Array<{ readonly name: string; readonly setup: (directory: string) => Promise<void> }> = [
      { name: 'wrong directory mode', setup: async (directory) => { await mkdirLike(directory); await chmod(directory, 0o755); } },
      { name: 'symlink directory', setup: async (directory) => { const target = `${directory}-target`; await mkdirLike(target); await symlink(target, directory); } },
      { name: 'symlink active', setup: async (directory) => { await mkdirLike(directory); await writeFile(join(directory, 'target'), 'x'); await symlink(join(directory, 'target'), join(directory, RUNTIME_LOG_FILE_NAME)); } },
      { name: 'wrong active mode', setup: async (directory) => { await mkdirLike(directory); await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), encodeRuntimeLogRecord(record()), { mode: 0o600 }); await chmod(join(directory, RUNTIME_LOG_FILE_NAME), 0o644); } },
      { name: 'symlink archive', setup: async (directory) => { await mkdirLike(directory); await writeFile(join(directory, 'target'), 'x'); await symlink(join(directory, 'target'), join(directory, `${RUNTIME_LOG_FILE_NAME}.3`)); } },
      { name: 'truncated', setup: async (directory) => { await mkdirLike(directory); await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), encodeRuntimeLogRecord(record()).trimEnd()); } },
      { name: 'malformed json', setup: async (directory) => { await mkdirLike(directory); await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), '{not-json}\n'); } },
      { name: 'duplicate nested key', setup: async (directory) => { await mkdirLike(directory); const line = encodeRuntimeLogRecord(record()).trimEnd().replace('{', '{"nested":{"x":1,"x":2},'); await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), `${line}\n`); } },
      { name: 'invalid utf8', setup: async (directory) => { await mkdirLike(directory); await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), Buffer.from([0xff, 0x0a])); } },
      { name: 'oversized active', setup: async (directory) => { await mkdirLike(directory); await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), Buffer.alloc(RUNTIME_LOG_FILE_MAX_BYTES + 1, 0x0a), { mode: 0o600 }); } },
    ];
    for (const candidate of cases) {
      const directory = join(parent, candidate.name.replace(/\s/gu, '-'));
      await candidate.setup(directory);
      const before = await snapshotDirectory(directory);
      const bundle = await createRuntimeLogFileStore({ directory });
      expect(bundle.store).toBeNull();
      expect(bundle.sink.snapshot()).toMatchObject({ status: 'LOGGING_DEGRADED', droppedCount: 0 });
      expect(bundle.sink.append(record())).toBe(false);
      expect(await snapshotDirectory(directory)).toEqual(before);
    }
  });

  test('validates pre-existing archives before permitting a healthy startup', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'logs'); await mkdirLike(directory);
    await writeFile(join(directory, `${RUNTIME_LOG_FILE_NAME}.2`), encodeRuntimeLogRecord(record()), { mode: 0o600 });
    await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), encodeRuntimeLogRecord(record()), { mode: 0o600 });
    const healthy = await createRuntimeLogFileStore({ directory });
    expect(healthy.store).not.toBeNull();

    const badDirectory = join(parent, 'bad'); await mkdirLike(badDirectory);
    await writeFile(join(badDirectory, `${RUNTIME_LOG_FILE_NAME}.4`), '{}\n', { mode: 0o600 });
    const degraded = await createRuntimeLogFileStore({ directory: badDirectory });
    expect(degraded.store).toBeNull();
    expect(degraded.sink.snapshot().status).toBe('LOGGING_DEGRADED');
  });

  test('a failed direct store callback blocks a concurrently queued later callback before it writes', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory });
    expect(bundle.store).not.toBeNull();
    const store = bundle.store!;
    // B is valid and enqueued before A settles.  It must re-check the sticky
    // store fault inside the serialized callback rather than append anyway.
    const first = store.write('not-an-NDJSON-line');
    const second = store.write(encodeRuntimeLogRecord(record()));
    await expect(first).rejects.toThrow('invalid runtime log line');
    await expect(second).rejects.toThrow('unavailable');
    expect(await readFile(join(directory, RUNTIME_LOG_FILE_NAME), 'utf8')).toBe('');
  });

  test('validates a direct write as one strict UTF-8 closed NDJSON record before rotation or append', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const valid = encodeRuntimeLogRecord(record());
    const malformed = [
      '{}\n',
      valid.replace('"schemaVersion":"g10a.log.v1"', '"schemaVersion":"g10a.log.v1","schemaVersion":"g10a.log.v1"'),
      `${valid}\n`,
      `${valid.slice(0, -1)}\r\n`,
      valid.trimEnd(),
      '\ud800\n',
    ];

    for (const [index, line] of malformed.entries()) {
      const directory = join(parent, `strict-${index}`);
      const bundle = await createRuntimeLogFileStore({ directory });
      expect(bundle.store).not.toBeNull();
      const repetitions = Math.floor((RUNTIME_LOG_FILE_MAX_BYTES - Buffer.byteLength(valid)) / Buffer.byteLength(valid)) + 1;
      await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), valid.repeat(repetitions), { mode: 0o600 });
      const before = await readFile(join(directory, RUNTIME_LOG_FILE_NAME), 'utf8');

      await expect(bundle.store!.write(line)).rejects.toThrow('invalid runtime log line');
      // A malformed input must be rejected before the rotation decision, so
      // the full active file is untouched and no archive was created.
      expect(await readFile(join(directory, RUNTIME_LOG_FILE_NAME), 'utf8')).toBe(before);
      await expect(lstat(join(directory, `${RUNTIME_LOG_FILE_NAME}.1`))).rejects.toMatchObject({ code: 'ENOENT' });

      // A failed direct callback makes the store unavailable.  The nominal
      // sink therefore degrades when it later observes that driver failure.
      expect(bundle.sink.append(record())).toBe(true);
      await bundle.sink.flush();
      expect(bundle.sink.snapshot()).toMatchObject({ status: 'LOGGING_DEGRADED', droppedCount: 1 });
    }
  });

  test('rejects BOM and CRLF in existing active or archive NDJSON at startup', async () => {
    const valid = encodeRuntimeLogRecord(record());
    const malformed = [
      { name: 'active BOM', file: RUNTIME_LOG_FILE_NAME, content: `\uFEFF${valid}` },
      { name: 'active CRLF', file: RUNTIME_LOG_FILE_NAME, content: valid.replace(/\n$/u, '\r\n') },
      { name: 'archive BOM', file: `${RUNTIME_LOG_FILE_NAME}.1`, content: `\uFEFF${valid}` },
      { name: 'archive CRLF', file: `${RUNTIME_LOG_FILE_NAME}.1`, content: valid.replace(/\n$/u, '\r\n') },
    ];
    for (const fixture of malformed) {
      const parent = await temporaryDirectory(); cleanup.push(parent);
      const directory = join(parent, fixture.name.replaceAll(' ', '-'));
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), fixture.file === RUNTIME_LOG_FILE_NAME ? fixture.content : valid, { mode: 0o600 });
      if (fixture.file !== RUNTIME_LOG_FILE_NAME) await writeFile(join(directory, fixture.file), fixture.content, { mode: 0o600 });
      const bundle = await createRuntimeLogFileStore({ directory });
      expect(bundle.store).toBeNull();
      expect(bundle.sink.snapshot().status).toBe('LOGGING_DEGRADED');
    }
  });

  test('serializes append and rotates archives in bounded newest-first order', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory });
    expect(bundle.store).not.toBeNull();
    // A direct prefill is valid NDJSON and remains below the active size cap.
    // The next append crosses it, proving rotation is pre-append rather than
    // leaving an oversized active file.
    const line = encodeRuntimeLogRecord(record());
    const repetitions = Math.floor((RUNTIME_LOG_FILE_MAX_BYTES - Buffer.byteLength(line)) / Buffer.byteLength(line)) + 1;
    await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), line.repeat(repetitions), { mode: 0o600 });
    expect((await lstat(join(directory, RUNTIME_LOG_FILE_NAME))).size + Buffer.byteLength(line)).toBeGreaterThan(RUNTIME_LOG_FILE_MAX_BYTES);
    expect(bundle.sink.append(record())).toBe(true);
    await bundle.sink.flush();
    expect(bundle.sink.snapshot()).toMatchObject({ status: 'HEALTHY', droppedCount: 0 });
    const active = await readFile(join(directory, RUNTIME_LOG_FILE_NAME), 'utf8');
    const archive = await readFile(join(directory, `${RUNTIME_LOG_FILE_NAME}.1`), 'utf8');
    expect(active).toBe(line);
    expect(Buffer.byteLength(archive, 'utf8')).toBeLessThanOrEqual(RUNTIME_LOG_FILE_MAX_BYTES);
    expect(bundle.sink.snapshot().status).toBe('HEALTHY');
  });

  test('rotates sparse archives in fixed .4 delete, descending rename, active-to-.1 order', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory });
    expect(bundle.store).not.toBeNull();
    const active = encodeRuntimeLogRecord(record());
    const archiveOne = encodeRuntimeLogRecord(recordWithTimestamp('2026-09-28T00:00:01.000Z'));
    const archiveThree = encodeRuntimeLogRecord(recordWithTimestamp('2026-09-28T00:00:03.000Z'));
    const archivedOldest = encodeRuntimeLogRecord(recordWithTimestamp('2026-09-28T00:00:04.000Z'));
    const repetitions = Math.floor((RUNTIME_LOG_FILE_MAX_BYTES - Buffer.byteLength(active)) / Buffer.byteLength(active)) + 1;
    await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), active.repeat(repetitions), { mode: 0o600 });
    await writeFile(join(directory, `${RUNTIME_LOG_FILE_NAME}.1`), archiveOne, { mode: 0o600 });
    await writeFile(join(directory, `${RUNTIME_LOG_FILE_NAME}.3`), archiveThree, { mode: 0o600 });
    await writeFile(join(directory, `${RUNTIME_LOG_FILE_NAME}.${RUNTIME_LOG_ARCHIVE_COUNT}`), archivedOldest, { mode: 0o600 });

    expect(bundle.sink.append(recordWithTimestamp('2026-09-28T00:00:05.000Z'))).toBe(true);
    await bundle.sink.flush();

    expect(await readFile(join(directory, RUNTIME_LOG_FILE_NAME), 'utf8')).toBe(encodeRuntimeLogRecord(recordWithTimestamp('2026-09-28T00:00:05.000Z')));
    expect(await readFile(join(directory, `${RUNTIME_LOG_FILE_NAME}.1`), 'utf8')).toBe(active.repeat(repetitions));
    expect(await readFile(join(directory, `${RUNTIME_LOG_FILE_NAME}.2`), 'utf8')).toBe(archiveOne);
    expect(await readFile(join(directory, `${RUNTIME_LOG_FILE_NAME}.4`), 'utf8')).toBe(archiveThree);
  });

  test('post-startup active-path substitution fails closed without writing through a symlink', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory });
    const target = join(parent, 'must-not-change');
    await writeFile(target, 'safe', { mode: 0o600 });
    await rm(join(directory, RUNTIME_LOG_FILE_NAME));
    await symlink(target, join(directory, RUNTIME_LOG_FILE_NAME));

    expect(bundle.sink.append(record())).toBe(true);
    await bundle.sink.flush();
    expect(bundle.sink.snapshot()).toMatchObject({ status: 'LOGGING_DEGRADED', droppedCount: 1, waiting: 0, writing: false });
    expect(await readFile(target, 'utf8')).toBe('safe');
    expect(bundle.sink.append(record())).toBe(false);
    expect(bundle.sink.snapshot().droppedCount).toBe(2);
  });

  test('rotation-time unsafe archive fails closed before any archive deletion or append', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'logs');
    const bundle = await createRuntimeLogFileStore({ directory });
    const line = encodeRuntimeLogRecord(record());
    const repetitions = Math.floor((RUNTIME_LOG_FILE_MAX_BYTES - Buffer.byteLength(line)) / Buffer.byteLength(line)) + 1;
    await writeFile(join(directory, RUNTIME_LOG_FILE_NAME), line.repeat(repetitions), { mode: 0o600 });
    const target = join(parent, 'archive-target');
    await writeFile(target, 'safe', { mode: 0o600 });
    await symlink(target, join(directory, `${RUNTIME_LOG_FILE_NAME}.4`));

    expect(bundle.sink.append(record())).toBe(true);
    await bundle.sink.flush();
    expect(bundle.sink.snapshot()).toMatchObject({ status: 'LOGGING_DEGRADED', droppedCount: 1 });
    expect(await readFile(target, 'utf8')).toBe('safe');
    expect(await readFile(join(directory, RUNTIME_LOG_FILE_NAME), 'utf8')).toBe(line.repeat(repetitions));
  });
});

function recordWithTimestamp(timestamp: string): RuntimeLogRecord {
  return createRuntimeLogRecord({ ...record(), timestamp });
}

async function mkdirLike(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { mode: 0o700 });
}

async function snapshotDirectory(directory: string): Promise<readonly string[]> {
  const { readdir } = await import('node:fs/promises');
  try { return Object.freeze((await readdir(directory)).sort()); } catch { return Object.freeze([]); }
}
