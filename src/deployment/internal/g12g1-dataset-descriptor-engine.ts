import { Buffer } from 'node:buffer';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { isCanonicalUuidV4 } from './g11b-run-ticket-wire.js';

const DESCRIPTOR_FILE_NAME = 'active-dataset.json';
const DIRECTORY_MODE = 0o700;
const DESCRIPTOR_MODE = 0o400;
const MAX_DESCRIPTOR_BYTES = 512;

export type DatasetDescriptorIntakeFailure =
  | 'DATASET_DESCRIPTOR_DIRECTORY_UNSAFE'
  | 'DATASET_DESCRIPTOR_FILE_UNSAFE'
  | 'DATASET_DESCRIPTOR_INVALID'
  | 'DATASET_DESCRIPTOR_READ_FAILED'
  | 'DATASET_DESCRIPTOR_EPOCH_MISMATCH';

export class DatasetDescriptorIntakeError extends Error {
  constructor(readonly code: DatasetDescriptorIntakeFailure) {
    super(code);
    this.name = 'DatasetDescriptorIntakeError';
  }
}

export type AtlasDatasetSlot = 'BLUE' | 'GREEN';
export type AtlasDatasetName = 'passhub_demo_blue' | 'passhub_demo_green';

export interface AtlasDatasetDescriptor {
  readonly profile: 'ATLAS_MANAGED';
  readonly slot: AtlasDatasetSlot;
  readonly databaseName: AtlasDatasetName;
  readonly datasetEpoch: string;
}

type FaultPoint = () => void | Promise<void>;

export interface DatasetDescriptorEngineFaults {
  readonly directoryStat?: FaultPoint;
  readonly beforeRead?: FaultPoint;
  readonly descriptorClose?: FaultPoint;
  readonly directoryClose?: FaultPoint;
}

export interface DatasetDescriptorEngineOptions {
  readonly expectedDirectoryOwnerUid?: number;
  readonly expectedDescriptorOwnerUid?: number;
  readonly faults?: DatasetDescriptorEngineFaults;
}

interface IntakeContext {
  readonly directoryOwnerUid: bigint;
  readonly descriptorOwnerUid: bigint;
  readonly faults: DatasetDescriptorEngineFaults;
}

interface OpenDirectory {
  readonly handle: FileHandle;
  readonly info: BigIntStats;
}

/** Shared only by the fixed production facade and dedicated test support. */
export async function readDatasetDescriptorWithEngine(
  directoryPath: string,
  options: DatasetDescriptorEngineOptions = {},
): Promise<AtlasDatasetDescriptor> {
  const euid = BigInt(currentUid());
  const context: IntakeContext = Object.freeze({
    directoryOwnerUid: BigInt(options.expectedDirectoryOwnerUid ?? euid),
    descriptorOwnerUid: BigInt(options.expectedDescriptorOwnerUid ?? euid),
    faults: options.faults ?? {},
  });
  const directory = await openSecureDirectory(
    directoryPath,
    context.directoryOwnerUid,
    context.faults.directoryStat,
  );
  let descriptor: AtlasDatasetDescriptor | undefined;
  let primary: DatasetDescriptorIntakeError | undefined;
  try {
    descriptor = await readDescriptor(directoryPath, directory.info, context);
  } catch (error) {
    primary = sanitize(error);
  }
  const closeFailed = await closeHandle(directory.handle, context.faults.directoryClose);
  if (primary !== undefined) throw primary;
  if (closeFailed || descriptor === undefined) fail('DATASET_DESCRIPTOR_READ_FAILED');
  return descriptor;
}

async function readDescriptor(
  directoryPath: string,
  directoryInfo: BigIntStats,
  context: IntakeContext,
): Promise<AtlasDatasetDescriptor> {
  await assertDirectoryPathIdentity(directoryPath, directoryInfo, context.directoryOwnerUid);
  const descriptorPath = join(directoryPath, DESCRIPTOR_FILE_NAME);
  let listed: BigIntStats;
  try {
    listed = await lstat(descriptorPath, { bigint: true });
    assertSecureDescriptor(listed, context.descriptorOwnerUid);
  } catch (error) {
    if (error instanceof DatasetDescriptorIntakeError) throw error;
    fail('DATASET_DESCRIPTOR_FILE_UNSAFE');
  }

  let handle: FileHandle;
  try {
    handle = await open(
      descriptorPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    fail('DATASET_DESCRIPTOR_FILE_UNSAFE');
  }

  let descriptor: AtlasDatasetDescriptor | undefined;
  let primary: DatasetDescriptorIntakeError | undefined;
  try {
    const before = await handle.stat({ bigint: true });
    assertSecureDescriptor(before, context.descriptorOwnerUid);
    assertSameFile(listed, before, 'DATASET_DESCRIPTOR_FILE_UNSAFE');
    await assertDescriptorPath(descriptorPath, before, context.descriptorOwnerUid);
    const firstBytes = await readBounded(handle);
    const stableBeforeFault = await handle.stat({ bigint: true });
    assertSecureDescriptor(stableBeforeFault, context.descriptorOwnerUid);
    assertUnchangedDescriptor(before, stableBeforeFault);
    await assertDescriptorPath(descriptorPath, stableBeforeFault, context.descriptorOwnerUid);
    await runFault(context.faults.beforeRead);
    const bytes = await readBounded(handle);
    const after = await handle.stat({ bigint: true });
    assertSecureDescriptor(after, context.descriptorOwnerUid);
    assertUnchangedDescriptor(before, after);
    if (!firstBytes.equals(bytes) || BigInt(bytes.length) !== after.size) fail('DATASET_DESCRIPTOR_FILE_UNSAFE');
    await assertDescriptorPath(descriptorPath, after, context.descriptorOwnerUid);
    descriptor = parseDescriptor(bytes);
  } catch (error) {
    primary = sanitize(error);
  }
  const closeFailed = await closeHandle(handle, context.faults.descriptorClose);
  if (primary !== undefined) throw primary;
  if (closeFailed || descriptor === undefined) fail('DATASET_DESCRIPTOR_READ_FAILED');
  return descriptor;
}

async function openSecureDirectory(
  path: string,
  ownerUid: bigint,
  directoryStatFault?: FaultPoint,
): Promise<OpenDirectory> {
  let listed: BigIntStats;
  let resolved: string;
  try {
    listed = await lstat(path, { bigint: true });
    resolved = await realpath(path);
    assertSecureDirectory(listed, ownerUid);
    if (resolved !== path) fail('DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
  } catch (error) {
    if (error instanceof DatasetDescriptorIntakeError) throw error;
    fail('DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
  }
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    fail('DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
  }
  try {
    await runFault(directoryStatFault);
    const opened = await handle.stat({ bigint: true });
    assertSecureDirectory(opened, ownerUid);
    assertSameFile(listed, opened, 'DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
    return Object.freeze({ handle, info: opened });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw sanitize(error);
  }
}

async function assertDirectoryPathIdentity(path: string, expected: BigIntStats, ownerUid: bigint): Promise<void> {
  try {
    const listed = await lstat(path, { bigint: true });
    assertSecureDirectory(listed, ownerUid);
    assertSameFile(expected, listed, 'DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
    if (await realpath(path) !== path) fail('DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
  } catch (error) {
    if (error instanceof DatasetDescriptorIntakeError) throw error;
    fail('DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
  }
}

async function assertDescriptorPath(path: string, expected: BigIntStats, ownerUid: bigint): Promise<void> {
  try {
    const listed = await lstat(path, { bigint: true });
    assertSecureDescriptor(listed, ownerUid);
    assertSameFile(expected, listed, 'DATASET_DESCRIPTOR_FILE_UNSAFE');
  } catch (error) {
    if (error instanceof DatasetDescriptorIntakeError) throw error;
    fail('DATASET_DESCRIPTOR_FILE_UNSAFE');
  }
}

function assertSecureDirectory(info: BigIntStats, ownerUid: bigint): void {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUid
    || (info.mode & 0o7777n) !== BigInt(DIRECTORY_MODE)) fail('DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
}

function assertSecureDescriptor(info: BigIntStats, ownerUid: bigint): void {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== ownerUid
    || (info.mode & 0o7777n) !== BigInt(DESCRIPTOR_MODE)
    || info.size < 1n || info.size > BigInt(MAX_DESCRIPTOR_BYTES)) {
    fail('DATASET_DESCRIPTOR_FILE_UNSAFE');
  }
}

function assertSameFile(expected: BigIntStats, actual: BigIntStats, code: DatasetDescriptorIntakeFailure): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) fail(code);
}

function assertUnchangedDescriptor(expected: BigIntStats, actual: BigIntStats): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.mode !== actual.mode
    || expected.nlink !== actual.nlink || expected.uid !== actual.uid || expected.gid !== actual.gid
    || expected.rdev !== actual.rdev || expected.size !== actual.size || expected.blksize !== actual.blksize
    || expected.blocks !== actual.blocks || expected.mtimeNs !== actual.mtimeNs
    || expected.ctimeNs !== actual.ctimeNs || expected.birthtimeNs !== actual.birthtimeNs) {
    fail('DATASET_DESCRIPTOR_FILE_UNSAFE');
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset < 1 || offset > MAX_DESCRIPTOR_BYTES) fail('DATASET_DESCRIPTOR_FILE_UNSAFE');
  return bytes.subarray(0, offset);
}

function parseDescriptor(bytes: Buffer): AtlasDatasetDescriptor {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('DATASET_DESCRIPTOR_INVALID');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('DATASET_DESCRIPTOR_INVALID');
  }
  if (text.length < 2 || text.charCodeAt(0) === 0xfeff || text.includes('\0') || text.includes('\r')
    || text.at(-1) !== '\n' || text.slice(0, -1).includes('\n')) fail('DATASET_DESCRIPTOR_INVALID');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    fail('DATASET_DESCRIPTOR_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('DATASET_DESCRIPTOR_INVALID');
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || keys[0] !== 'profile' || keys[1] !== 'slot'
    || keys[2] !== 'databaseName' || keys[3] !== 'datasetEpoch') fail('DATASET_DESCRIPTOR_INVALID');
  if (record.profile !== 'ATLAS_MANAGED' || (record.slot !== 'BLUE' && record.slot !== 'GREEN')
    || typeof record.databaseName !== 'string' || typeof record.datasetEpoch !== 'string'
    || !isCanonicalUuidV4(record.datasetEpoch)) fail('DATASET_DESCRIPTOR_INVALID');
  const expectedDatabase = record.slot === 'BLUE' ? 'passhub_demo_blue' : 'passhub_demo_green';
  if (record.databaseName !== expectedDatabase) fail('DATASET_DESCRIPTOR_INVALID');
  const descriptor: AtlasDatasetDescriptor = Object.freeze({
    profile: 'ATLAS_MANAGED',
    slot: record.slot,
    databaseName: expectedDatabase,
    datasetEpoch: record.datasetEpoch,
  });
  if (`${JSON.stringify(descriptor)}\n` !== text) fail('DATASET_DESCRIPTOR_INVALID');
  return descriptor;
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
  if (process.platform === 'win32' || process.getuid === undefined) fail('DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');
  return process.getuid();
}

function sanitize(error: unknown): DatasetDescriptorIntakeError {
  return error instanceof DatasetDescriptorIntakeError
    ? error
    : new DatasetDescriptorIntakeError('DATASET_DESCRIPTOR_READ_FAILED');
}

function fail(code: DatasetDescriptorIntakeFailure): never {
  throw new DatasetDescriptorIntakeError(code);
}
