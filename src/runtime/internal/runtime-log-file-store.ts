import { Buffer } from 'node:buffer';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { TextDecoder, types as nodeTypes } from 'node:util';
import { RuntimeLogSink, type RuntimeLogDriver } from './runtime-log-sink.js';
import { RUNTIME_LOG_MAX_BYTES, validateRuntimeLogRecord } from './runtime-log-schema.js';

/** Private A10.4 filesystem adapter.  It is intentionally not barrel-exported. */
export const RUNTIME_LOG_FILE_NAME = 'runtime.log';
export const RUNTIME_LOG_ARCHIVE_COUNT = 4;
export const RUNTIME_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface RuntimeLogFileStoreOptions {
  readonly directory: string;
}

export interface RuntimeLogFileStoreBundle {
  readonly sink: RuntimeLogSink;
  readonly store: RuntimeLogFileStore | null;
}

/** Internal, already-decoded LOGS_READ input; the control wire is elsewhere. */
export interface RuntimeLogReadOptions {
  readonly operationUUID: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeLogReadResult {
  readonly records: readonly ReturnType<typeof validateRuntimeLogRecord>[];
  readonly truncated: boolean;
}

/** The control adapter maps this closed failure to LOG_READ_UNAVAILABLE. */
export class RuntimeLogReadError extends Error {
  readonly code = 'LOG_READ_UNAVAILABLE' as const;
  constructor() { super('runtime log read is unavailable'); this.name = 'RuntimeLogReadError'; }
}

/** Kept separate so a watchdog can suppress its late response. */
export class RuntimeLogReadAbortedError extends Error {
  readonly code = 'ABORTED' as const;
  constructor() { super('runtime log read was aborted'); this.name = 'RuntimeLogReadAbortedError'; }
}

/**
 * Initializes the closed five-file ring.  All startup faults become a
 * nominal, permanently degraded sink: logs are best effort and cannot alter
 * the application's business/control availability.
 */
export async function createRuntimeLogFileStore(options: RuntimeLogFileStoreOptions): Promise<RuntimeLogFileStoreBundle> {
  try {
    const directory = captureAbsoluteDirectory(options);
    await ensureSecureDirectory(directory);
    const store = new RuntimeLogFileStore(directory);
    await store.validateStartup();
    return Object.freeze({ sink: new RuntimeLogSink(store), store });
  } catch {
    return Object.freeze({ sink: RuntimeLogSink.createInitiallyDegraded(), store: null });
  }
}

export class RuntimeLogFileStore implements RuntimeLogDriver {
  private readonly mutex = new AbortableMutex();
  private failed = false;

  constructor(readonly directory: string) {}

  async write(line: string): Promise<void> {
    if (this.failed) throw new Error('runtime log file store is unavailable');
    const release = await this.mutex.acquire();
    try {
      // A preceding queued callback may have failed after this caller entered
      // `write`.  Re-check inside the serialized callback: a B queued behind
      // failed A must never touch the filesystem.
      if (this.failed) throw new Error('runtime log file store is unavailable');
      await this.appendLine(line);
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      release();
    }
  }

  async validateStartup(): Promise<void> {
    // Initialization mutates the active path when it is missing and validates
    // the five-file ring.  It must therefore share the exact writer/read
    // snapshot mutex: a direct caller cannot race startup against append,
    // rotation, or a snapshot acquisition.
    const release = await this.mutex.acquire();
    try {
      for (const path of this.pathsOldestToActive()) await validateExistingLogFile(path, true);
      if (await exists(this.activePath())) return;
      const handle = await open(this.activePath(), 'wx', FILE_MODE);
      try {
        await handle.chmod(FILE_MODE);
        await assertOpenFileMatchesPath(this.activePath(), handle);
      } finally {
        await handle.close();
      }
    } finally {
      release();
    }
  }

  /**
   * Captures all five log FDs under the writer/rotation mutex, then performs
   * potentially slow reads without holding it.  A rename or delete after the
   * snapshot cannot change the already-open inode or its captured length.
   */
  async readOperation(options: RuntimeLogReadOptions): Promise<RuntimeLogReadResult> {
    const captured = captureReadOptions(options);
    const snapshots: LogSnapshot[] = [];
    let release: (() => void) | undefined;
    let primaryError: unknown;
    try {
      release = await this.mutex.acquire(captured.signal);
      try {
        throwIfAborted(captured.signal);
        for (const [index, path] of this.pathsOldestToActive().entries()) {
          const optionalArchive = index !== RUNTIME_LOG_ARCHIVE_COUNT;
          const snapshot = await openReadSnapshot(path, optionalArchive);
          if (snapshot !== undefined) snapshots.push(snapshot);
        }
      } finally {
        release();
        release = undefined;
      }

      const selected: ReturnType<typeof validateRuntimeLogRecord>[] = [];
      let matchingCount = 0;
      for (const snapshot of snapshots) {
        throwIfAborted(captured.signal);
        const records = await readSnapshotRecords(snapshot, captured.signal);
        for (const record of records) {
          if (record.operationUUID !== captured.operationUUID) continue;
          matchingCount += 1;
          if (selected.length === captured.limit) selected.shift();
          selected.push(record);
        }
      }
      return Object.freeze({ records: Object.freeze(selected), truncated: matchingCount > captured.limit });
    } catch (error) {
      primaryError = error instanceof RuntimeLogReadAbortedError ? error : new RuntimeLogReadError();
      throw primaryError;
    } finally {
      if (release !== undefined) release();
      const closeFailures = await Promise.all(snapshots.map(async (snapshot) => snapshot.handle.close().then(() => false, () => true)));
      // A close error is an I/O failure too.  Do not conceal it after an
      // otherwise successful read, but preserve an earlier abort/parse error
      // as the primary reason for failure.
      if (primaryError === undefined && closeFailures.some(Boolean)) throw new RuntimeLogReadError();
    }
  }

  private async appendLine(line: string): Promise<void> {
    // RuntimeLogSink normally supplies a schema-produced line, but this is a
    // physical trust boundary too: a direct/future driver caller must not be
    // able to rotate or append a malformed record.  Validate before the
    // rotation decision, because rotation is an observable filesystem change.
    const bytes = validateRuntimeLogLine(line);
    if (await this.requiresRotation(bytes.length)) await this.rotate();
    await appendExactly(this.activePath(), bytes);
  }

  private async requiresRotation(nextBytes: number): Promise<boolean> {
    const handle = await openSecureExistingFile(this.activePath());
    try {
      const info = await handle.stat();
      assertSecureRegular(info);
      return info.size + nextBytes > RUNTIME_LOG_FILE_MAX_BYTES;
    } finally {
      await handle.close();
    }
  }

  private async rotate(): Promise<void> {
    // Validate every input immediately before it may be renamed/deleted.
    // ENOENT archives are intentionally absent, not malformed.
    const oldest = this.archivePath(RUNTIME_LOG_ARCHIVE_COUNT);
    await removeOptionalValidatedArchive(oldest);
    for (let index = RUNTIME_LOG_ARCHIVE_COUNT - 1; index >= 1; index -= 1) {
      const source = this.archivePath(index);
      await renameOptionalValidatedArchive(source, this.archivePath(index + 1));
    }
    // The active file is never optional after healthy initialization.  Check
    // it immediately before the irreversible rename, rather than trusting a
    // startup-time inspection or an exists→act observation.
    const active = await validateExistingLogFile(this.activePath(), false);
    if (active === undefined) throw new Error('active runtime log disappeared');
    await assertPathStillMatches(this.activePath(), active);
    await rename(this.activePath(), this.archivePath(1));
    const handle = await open(this.activePath(), 'wx', FILE_MODE);
    try {
      await handle.chmod(FILE_MODE);
      await assertOpenFileMatchesPath(this.activePath(), handle);
    } finally {
      await handle.close();
    }
  }

  private activePath(): string { return `${this.directory}/${RUNTIME_LOG_FILE_NAME}`; }
  private archivePath(index: number): string { return `${this.activePath()}.${index}`; }
  private pathsOldestToActive(): readonly string[] {
    return Object.freeze([
      this.archivePath(4), this.archivePath(3), this.archivePath(2), this.archivePath(1), this.activePath(),
    ]);
  }
}

function captureAbsoluteDirectory(input: unknown): string {
  if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('runtime log directory');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 1 || keys[0] !== 'directory') throw new TypeError('runtime log directory');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'directory');
  if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') throw new TypeError('runtime log directory');
  const directory = descriptor.value;
  if (!directory.startsWith('/') || directory.length < 2 || directory.includes('\u0000')) throw new TypeError('runtime log directory');
  return directory;
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  let created = false;
  try {
    await lstat(directory);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    try {
      await mkdir(directory, { mode: DIRECTORY_MODE, recursive: false });
      created = true;
    } catch (mkdirError) {
      // A concurrent creator gets the same strict lstat/assert treatment as
      // an already-existing directory, and is never chmodded by us.
      if (!isEexist(mkdirError)) throw mkdirError;
    }
  }
  if (created) {
    // Never chmod a just-created directory by pathname.  Another same-UID
    // process can rename that pathname between mkdir and chmod.  Bind the
    // permission change to an O_NOFOLLOW directory fd instead, then prove
    // that the pathname still names that exact, private inode after close.
    await secureFreshDirectoryByFd(directory);
  }
  const info = await lstat(directory);
  assertSecureDirectory(info);
}

async function secureFreshDirectoryByFd(directory: string): Promise<void> {
  // Capture the inode created by our successful mkdir before opening it.  A
  // replacement between either pathname operation is a startup fault, never
  // a reason to chmod whichever directory happens to be there.
  const expected = await lstat(directory);
  assertFreshDirectory(expected);

  const handle = await open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  let secured: Stats;
  try {
    const opened = await handle.stat();
    assertFreshDirectory(opened);
    assertSameDirectory(expected, opened, 'runtime log directory changed while opening');

    await handle.chmod(DIRECTORY_MODE);
    secured = await handle.stat();
    assertSecureDirectory(secured);
  } finally {
    await handle.close();
  }

  const listed = await lstat(directory);
  assertSecureDirectory(listed);
  assertSameDirectory(secured!, listed, 'runtime log directory changed after chmod');
}

async function removeOptionalValidatedArchive(path: string): Promise<void> {
  try {
    const validated = await validateExistingLogFile(path, false);
    if (validated === undefined) return;
    // `rm`/`rename` operate by path rather than FD.  Perform a second,
    // action-local identity check immediately before that path operation so a
    // same-uid replacement is never accepted on startup-time trust alone.
    await assertPathStillMatches(path, validated);
    await rm(path, { force: false });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

async function renameOptionalValidatedArchive(source: string, target: string): Promise<void> {
  try {
    const validated = await validateExistingLogFile(source, false);
    if (validated === undefined) return;
    await assertPathStillMatches(source, validated);
    await rename(source, target);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

async function validateExistingLogFile(path: string, allowMissing: boolean): Promise<Stats | undefined> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (allowMissing && isEnoent(error)) return undefined;
    throw error;
  }
  assertSecureRegular(before);
  if (before.size > RUNTIME_LOG_FILE_MAX_BYTES) throw new Error('runtime log file is oversized');
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  let after: Stats;
  try {
    await assertOpenFileMatchesPath(path, handle, before);
    bytes = await handle.readFile();
    after = await handle.stat();
    // Metadata may change after the lstat/open identity check.  The FD is
    // still the same inode, but a chmod/chown race must not be accepted as a
    // healthy on-disk record.
    assertSecureRegular(after);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new Error('runtime log file changed while validating');
  } finally {
    await handle.close();
  }
  validateNdjson(bytes);
  return after;
}

async function assertPathStillMatches(path: string, expected: Stats): Promise<void> {
  const current = await lstat(path);
  assertSecureRegular(current);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.size !== expected.size) {
    throw new Error('runtime log path changed before action');
  }
}

async function appendExactly(path: string, bytes: Buffer): Promise<void> {
  const handle = await openSecureExistingFile(path);
  try {
    const info = await handle.stat();
    assertSecureRegular(info);
    if (info.size + bytes.length > RUNTIME_LOG_FILE_MAX_BYTES) throw new Error('rotation race');
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw new Error('partial runtime log write');
      offset += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

async function openSecureExistingFile(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  assertSecureRegular(before);
  const handle = await open(path, fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  try {
    await assertOpenFileMatchesPath(path, handle, before);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertOpenFileMatchesPath(path: string, handle: FileHandle, expected?: Stats): Promise<void> {
  const listed = expected ?? await lstat(path);
  const opened = await handle.stat();
  assertSecureRegular(listed);
  assertSecureRegular(opened);
  if (listed.dev !== opened.dev || listed.ino !== opened.ino) throw new Error('runtime log path changed while opening');
}

function assertSecureDirectory(info: Stats): void {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== effectiveUid() || (info.mode & 0o777) !== DIRECTORY_MODE) throw new Error('unsafe runtime log directory');
}

function assertFreshDirectory(info: Stats): void {
  // mkdir(2) with mode 0700 may only have permissions removed by umask.  Do
  // not chmod a directory that is group/world accessible or foreign-owned.
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== effectiveUid() || (info.mode & 0o077) !== 0) {
    throw new Error('unsafe fresh runtime log directory');
  }
}

function assertSameDirectory(expected: Stats, actual: Stats, message: string): void {
  if (
    expected.dev !== actual.dev || expected.ino !== actual.ino ||
    expected.uid !== actual.uid || expected.mode !== actual.mode
  ) throw new Error(message);
}

function assertSecureRegular(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== effectiveUid() || (info.mode & 0o777) !== FILE_MODE) throw new Error('unsafe runtime log file');
}

function effectiveUid(): number {
  if (typeof process.geteuid !== 'function') throw new Error('effective uid unavailable');
  return process.geteuid();
}

function isEnoent(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'; }
function isEexist(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'; }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (isEnoent(error)) return false; throw error; } }

function validateNdjson(bytes: Buffer): void {
  if (bytes.length === 0) return;
  // Keep a leading BOM visible.  The default decoder strips it, which would
  // silently make an on-disk file differ from the strict one-record write
  // boundary below.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!text.endsWith('\n')) throw new Error('truncated runtime log');
  const lines = text.slice(0, -1).split('\n');
  for (const line of lines) {
    // Reuse the direct-append boundary so startup accepts precisely the same
    // NDJSON form: one closed JSON value followed by one LF, never BOM/CRLF.
    validateRuntimeLogLine(`${line}\n`);
  }
}

/**
 * Validates one caller-provided line before any file mutation.  Buffer.from
 * replaces lone UTF-16 surrogates, so require an exact UTF-8 round trip rather
 * than silently persisting replacement bytes.  A record is exactly one JSON
 * value followed by one LF: CR and embedded LF would create ambiguous NDJSON
 * boundaries.
 */
function validateRuntimeLogLine(input: unknown): Buffer {
  try {
    if (typeof input !== 'string') throw new TypeError('invalid runtime log line');
    const bytes = Buffer.from(input, 'utf8');
    if (
      bytes.length === 0 || bytes.length > RUNTIME_LOG_MAX_BYTES ||
      bytes[bytes.length - 1] !== 0x0a || bytes.toString('utf8') !== input ||
      input.includes('\r') || input.indexOf('\n') !== input.length - 1
    ) throw new TypeError('invalid runtime log line');
    const json = input.slice(0, -1);
    if (json.length === 0) throw new TypeError('invalid runtime log line');
    assertNoDuplicateJsonKeys(json);
    validateRuntimeLogRecord(JSON.parse(json));
    return bytes;
  } catch {
    throw new TypeError('invalid runtime log line');
  }
}

const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const READ_CHUNK_BYTES = 64 * 1024;

interface CapturedReadOptions {
  readonly operationUUID: string;
  readonly limit: number;
  readonly signal: AbortSignal | undefined;
}

interface LogSnapshot {
  readonly handle: FileHandle;
  readonly length: number;
}

function captureReadOptions(input: unknown): CapturedReadOptions {
  if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('runtime log read options');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const own = Reflect.ownKeys(input);
  if (own.some((key) => key !== 'operationUUID' && key !== 'limit' && key !== 'signal') || !Object.hasOwn(descriptors, 'operationUUID')) throw new TypeError('runtime log read options');
  for (const key of own) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('runtime log read options');
  }
  const operationUUID = descriptors.operationUUID?.value;
  const limitValue = descriptors.limit?.value;
  const signal = descriptors.signal?.value;
  if (typeof operationUUID !== 'string' || !canonicalUuidPattern.test(operationUUID)) throw new TypeError('runtime log operation UUID');
  const limit = limitValue === undefined ? 20 : limitValue;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new RangeError('runtime log read limit');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('runtime log read signal');
  return Object.freeze({ operationUUID, limit: limit as number, signal: signal as AbortSignal | undefined });
}

async function openReadSnapshot(path: string, optional: boolean): Promise<LogSnapshot | undefined> {
  let listed: Stats;
  try {
    listed = await lstat(path);
  } catch (error) {
    if (optional && isEnoent(error)) return undefined;
    throw error;
  }
  assertSecureRegular(listed);
  if (listed.size > RUNTIME_LOG_FILE_MAX_BYTES) throw new Error('runtime log file is oversized');
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    await assertOpenFileMatchesPath(path, handle, listed);
    const opened = await handle.stat();
    assertSecureRegular(opened);
    if (opened.dev !== listed.dev || opened.ino !== listed.ino || opened.size !== listed.size || opened.size > RUNTIME_LOG_FILE_MAX_BYTES) {
      throw new Error('runtime log file changed while snapshotting');
    }
    return Object.freeze({ handle, length: opened.size });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function readSnapshotRecords(snapshot: LogSnapshot, signal: AbortSignal | undefined): Promise<readonly ReturnType<typeof validateRuntimeLogRecord>[]> {
  const bytes = Buffer.allocUnsafe(snapshot.length);
  let offset = 0;
  while (offset < bytes.length) {
    throwIfAborted(signal);
    const size = Math.min(READ_CHUNK_BYTES, bytes.length - offset);
    const result = await snapshot.handle.read(bytes, offset, size, offset);
    throwIfAborted(signal);
    if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0) throw new Error('runtime log snapshot became short');
    offset += result.bytesRead;
  }
  return parseRuntimeLogRecords(bytes);
}

function parseRuntimeLogRecords(bytes: Buffer): readonly ReturnType<typeof validateRuntimeLogRecord>[] {
  if (bytes.length === 0) return Object.freeze([]);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!text.endsWith('\n')) throw new Error('truncated runtime log');
  const records: ReturnType<typeof validateRuntimeLogRecord>[] = [];
  for (const line of text.slice(0, -1).split('\n')) {
    const strictLine = `${line}\n`;
    validateRuntimeLogLine(strictLine);
    // validateRuntimeLogLine verifies duplicate keys before JSON.parse.  Keep
    // the canonical validated record rather than returning the parsed graph.
    records.push(validateRuntimeLogRecord(JSON.parse(line)));
  }
  return Object.freeze(records);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new RuntimeLogReadAbortedError();
}

type MutexWaiter = {
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
};

/** FIFO async mutex with cancellable waiters; never exported from the adapter. */
class AbortableMutex {
  private locked = false;
  private readonly waiters: MutexWaiter[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiter: MutexWaiter;
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new RuntimeLogReadAbortedError());
      };
      waiter = { resolve, reject, signal, onAbort };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      // A signal can abort between the first check and listener registration.
      if (signal?.aborted === true) onAbort();
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      for (;;) {
        const next = this.waiters.shift();
        if (next === undefined) { this.locked = false; return; }
        next.signal?.removeEventListener('abort', next.onAbort);
        if (next.signal?.aborted === true) { next.reject(new RuntimeLogReadAbortedError()); continue; }
        next.resolve(this.releaseOnce());
        return;
      }
    };
  }
}

/** JSON.parse silently overwrites duplicates.  The reader/startup contract may not. */
function assertNoDuplicateJsonKeys(text: string): void {
  let offset = 0;
  const space = (): void => { while (/\s/u.test(text[offset] ?? '')) offset += 1; };
  const value = (): void => {
    space(); const first = text[offset];
    if (first === '{') { object(); return; }
    if (first === '[') { array(); return; }
    if (first === '"') { string(); return; }
    const start = offset;
    while (offset < text.length && !/[\s,\]\}]/u.test(text[offset] ?? '')) offset += 1;
    if (start === offset) throw new Error('invalid JSON');
  };
  const string = (): string => {
    if (text[offset] !== '"') throw new Error('invalid JSON');
    const start = offset; offset += 1; let escaped = false;
    while (offset < text.length) {
      const char = text[offset++]!;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
      if (char < ' ') throw new Error('invalid JSON');
    }
    throw new Error('invalid JSON');
  };
  const object = (): void => {
    offset += 1; space(); const seen = new Set<string>();
    if (text[offset] === '}') { offset += 1; return; }
    for (;;) {
      space(); const key = string(); if (seen.has(key)) throw new Error('duplicate JSON key'); seen.add(key);
      space(); if (text[offset++] !== ':') throw new Error('invalid JSON'); value(); space();
      if (text[offset] === '}') { offset += 1; return; }
      if (text[offset++] !== ',') throw new Error('invalid JSON');
    }
  };
  const array = (): void => {
    offset += 1; space(); if (text[offset] === ']') { offset += 1; return; }
    for (;;) { value(); space(); if (text[offset] === ']') { offset += 1; return; } if (text[offset++] !== ',') throw new Error('invalid JSON'); }
  };
  value(); space(); if (offset !== text.length) throw new Error('invalid JSON');
}
