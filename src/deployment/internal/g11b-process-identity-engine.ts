import { Buffer } from 'node:buffer';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { isCanonicalUuidV4 } from './g11b-run-ticket-wire.js';

const PROCESS_IDENTITY_FILE_NAME = 'process-run-id';
const DIRECTORY_MODE = 0o700;
const IDENTITY_MODE = 0o400;
const MAX_IDENTITY_BYTES = 64;

export type ProcessIdentityIntakeFailure =
  | 'RUNTIME_DIRECTORY_UNSAFE'
  | 'PROCESS_IDENTITY_FILE_UNSAFE'
  | 'PROCESS_IDENTITY_INVALID'
  | 'PROCESS_IDENTITY_READ_FAILED';

export class ProcessIdentityIntakeError extends Error {
  constructor(readonly code: ProcessIdentityIntakeFailure) {
    super(code);
    this.name = 'ProcessIdentityIntakeError';
  }
}

type FaultPoint = () => void | Promise<void>;

export interface ProcessIdentityEngineFaults {
  readonly directoryStat?: FaultPoint;
  readonly beforeRead?: FaultPoint;
  readonly identityClose?: FaultPoint;
  readonly directoryClose?: FaultPoint;
}

export interface ProcessIdentityEngineOptions {
  readonly expectedDirectoryOwnerUid?: number;
  readonly expectedIdentityOwnerUid?: number;
  readonly faults?: ProcessIdentityEngineFaults;
}

interface IntakeContext {
  readonly directoryOwnerUid: number;
  readonly identityOwnerUid: number;
  readonly faults: ProcessIdentityEngineFaults;
}

interface OpenDirectory {
  readonly handle: FileHandle;
  readonly info: Stats;
}

/** Shared only by the fixed production facade and dedicated test support. */
export async function readProcessIdentityWithEngine(
  directoryPath: string,
  options: ProcessIdentityEngineOptions = {},
): Promise<string> {
  const euid = currentUid();
  const context: IntakeContext = Object.freeze({
    directoryOwnerUid: options.expectedDirectoryOwnerUid ?? euid,
    identityOwnerUid: options.expectedIdentityOwnerUid ?? euid,
    faults: options.faults ?? {},
  });
  const directory = await openSecureDirectory(
    directoryPath,
    context.directoryOwnerUid,
    context.faults.directoryStat,
  );
  let identity: string | undefined;
  let primary: ProcessIdentityIntakeError | undefined;
  try {
    identity = await readIdentity(directoryPath, directory.info, context);
  } catch (error) {
    primary = sanitize(error);
  }
  const closeFailed = await closeHandle(directory.handle, context.faults.directoryClose);
  if (primary !== undefined) throw primary;
  if (closeFailed || identity === undefined) fail('PROCESS_IDENTITY_READ_FAILED');
  return identity;
}

async function readIdentity(
  directoryPath: string,
  directoryInfo: Stats,
  context: IntakeContext,
): Promise<string> {
  await assertDirectoryPathIdentity(directoryPath, directoryInfo, context.directoryOwnerUid);
  const identityPath = join(directoryPath, PROCESS_IDENTITY_FILE_NAME);
  let listed: Stats;
  try {
    listed = await lstat(identityPath);
    assertSecureIdentity(listed, context.identityOwnerUid);
  } catch (error) {
    if (error instanceof ProcessIdentityIntakeError) throw error;
    fail('PROCESS_IDENTITY_FILE_UNSAFE');
  }

  let handle: FileHandle;
  try {
    handle = await open(
      identityPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    fail('PROCESS_IDENTITY_FILE_UNSAFE');
  }

  let identity: string | undefined;
  let primary: ProcessIdentityIntakeError | undefined;
  try {
    const before = await handle.stat();
    assertSecureIdentity(before, context.identityOwnerUid);
    assertSameFile(listed, before, 'PROCESS_IDENTITY_FILE_UNSAFE');
    await assertIdentityPath(identityPath, before, context.identityOwnerUid);
    await runFault(context.faults.beforeRead);
    const bytes = await readBounded(handle);
    const after = await handle.stat();
    assertSecureIdentity(after, context.identityOwnerUid);
    assertSameFile(before, after, 'PROCESS_IDENTITY_FILE_UNSAFE');
    if (bytes.length !== after.size) fail('PROCESS_IDENTITY_FILE_UNSAFE');
    await assertIdentityPath(identityPath, after, context.identityOwnerUid);
    identity = parseIdentity(bytes);
  } catch (error) {
    primary = sanitize(error);
  }
  const closeFailed = await closeHandle(handle, context.faults.identityClose);
  if (primary !== undefined) throw primary;
  if (closeFailed || identity === undefined) fail('PROCESS_IDENTITY_READ_FAILED');
  return identity;
}

async function openSecureDirectory(
  path: string,
  ownerUid: number,
  directoryStatFault?: FaultPoint,
): Promise<OpenDirectory> {
  let listed: Stats;
  let resolved: string;
  try {
    listed = await lstat(path);
    resolved = await realpath(path);
    assertSecureDirectory(listed, ownerUid);
    if (resolved !== path) fail('RUNTIME_DIRECTORY_UNSAFE');
  } catch (error) {
    if (error instanceof ProcessIdentityIntakeError) throw error;
    fail('RUNTIME_DIRECTORY_UNSAFE');
  }
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    fail('RUNTIME_DIRECTORY_UNSAFE');
  }
  try {
    await runFault(directoryStatFault);
    const opened = await handle.stat();
    assertSecureDirectory(opened, ownerUid);
    assertSameFile(listed, opened, 'RUNTIME_DIRECTORY_UNSAFE');
    return Object.freeze({ handle, info: opened });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw sanitize(error);
  }
}

async function assertDirectoryPathIdentity(path: string, expected: Stats, ownerUid: number): Promise<void> {
  try {
    const listed = await lstat(path);
    assertSecureDirectory(listed, ownerUid);
    assertSameFile(expected, listed, 'RUNTIME_DIRECTORY_UNSAFE');
    if (await realpath(path) !== path) fail('RUNTIME_DIRECTORY_UNSAFE');
  } catch (error) {
    if (error instanceof ProcessIdentityIntakeError) throw error;
    fail('RUNTIME_DIRECTORY_UNSAFE');
  }
}

async function assertIdentityPath(path: string, expected: Stats, ownerUid: number): Promise<void> {
  try {
    const listed = await lstat(path);
    assertSecureIdentity(listed, ownerUid);
    assertSameFile(expected, listed, 'PROCESS_IDENTITY_FILE_UNSAFE');
  } catch (error) {
    if (error instanceof ProcessIdentityIntakeError) throw error;
    fail('PROCESS_IDENTITY_FILE_UNSAFE');
  }
}

function assertSecureDirectory(info: Stats, ownerUid: number): void {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUid
    || (info.mode & 0o7777) !== DIRECTORY_MODE) fail('RUNTIME_DIRECTORY_UNSAFE');
}

function assertSecureIdentity(info: Stats, ownerUid: number): void {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== ownerUid
    || (info.mode & 0o7777) !== IDENTITY_MODE || info.size < 1 || info.size > MAX_IDENTITY_BYTES) {
    fail('PROCESS_IDENTITY_FILE_UNSAFE');
  }
}

function assertSameFile(expected: Stats, actual: Stats, code: ProcessIdentityIntakeFailure): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) fail(code);
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset < 1 || offset > MAX_IDENTITY_BYTES) fail('PROCESS_IDENTITY_FILE_UNSAFE');
  return bytes.subarray(0, offset);
}

function parseIdentity(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('PROCESS_IDENTITY_INVALID');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('PROCESS_IDENTITY_INVALID');
  }
  if (text.length !== 37 || text[36] !== '\n' || text.slice(0, 36).includes('\n')
    || text.includes('\r') || text.charCodeAt(0) === 0xfeff) fail('PROCESS_IDENTITY_INVALID');
  const identity = text.slice(0, -1);
  if (!isCanonicalUuidV4(identity)) fail('PROCESS_IDENTITY_INVALID');
  return identity;
}

async function closeHandle(handle: FileHandle, fault?: FaultPoint): Promise<boolean> {
  let failed = false;
  try { await handle.close(); } catch { failed = true; }
  try { await runFault(fault); } catch { failed = true; }
  return failed;
}

async function runFault(fault?: FaultPoint): Promise<void> {
  if (fault !== undefined) await fault();
}

function currentUid(): number {
  if (process.platform === 'win32' || process.getuid === undefined) fail('RUNTIME_DIRECTORY_UNSAFE');
  return process.getuid();
}

function sanitize(error: unknown): ProcessIdentityIntakeError {
  return error instanceof ProcessIdentityIntakeError
    ? error
    : new ProcessIdentityIntakeError('PROCESS_IDENTITY_READ_FAILED');
}

function fail(code: ProcessIdentityIntakeFailure): never {
  throw new ProcessIdentityIntakeError(code);
}
