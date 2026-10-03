import { Buffer } from 'node:buffer';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isCanonicalUuidV4,
  parseRunTicketWire,
  RunTicketWireError,
  type ParsedRunTicket,
} from './g11b-run-ticket-wire.js';

const TICKET_FILE_NAME = 'bootstrap-ticket.json';
const USED_MARKER_PREFIX = '.bootstrap-ticket.used.';
const DIRECTORY_MODE = 0o700;
const TICKET_MODE = 0o400;
const MAX_TICKET_BYTES = 512;
const TOKEN_MINT = Symbol('G11b consumed run-ticket mint');

export type RunTicketIntakeFailure =
  | 'RUNTIME_DIRECTORY_UNSAFE'
  | 'TICKET_NOT_PROVEN'
  | 'TICKET_FILE_UNSAFE'
  | 'TICKET_INVALID'
  | 'PROCESS_BINDING_MISMATCH'
  | 'TICKET_ALREADY_USED'
  | 'CONSUME_UNKNOWN'
  | 'CONSUMED_TICKET_INVALID';

export interface ConsumedRunTicketFacts {
  readonly ticketId: string;
  readonly datasetEpoch: string;
  readonly processRunId: string;
}

/** Opaque nominal authority. Facts are held only in the module-private WeakMap. */
export class ConsumedRunTicket {
  declare private readonly nominalConsumedRunTicket: void;

  constructor(authority: symbol) {
    if (authority !== TOKEN_MINT) throw new RunTicketIntakeError('CONSUMED_TICKET_INVALID');
    Object.freeze(this);
  }
}

const consumedTicketFacts = new WeakMap<ConsumedRunTicket, ConsumedRunTicketFacts>();

/** Private runtime composition reader; structural or foreign tokens fail closed. */
export function readConsumedRunTicketForRuntime(token: ConsumedRunTicket): ConsumedRunTicketFacts {
  const facts = consumedTicketFacts.get(token);
  if (facts === undefined) throw new RunTicketIntakeError('CONSUMED_TICKET_INVALID');
  return facts;
}

export class RunTicketIntakeError extends Error {
  constructor(readonly code: RunTicketIntakeFailure) {
    super(code);
    this.name = 'RunTicketIntakeError';
  }
}

type FaultPoint = () => void | Promise<void>;

export interface RunTicketEngineFaults {
  readonly markerCreate?: FaultPoint;
  readonly markerSync?: FaultPoint;
  readonly markerClose?: FaultPoint;
  readonly directoryFirstSync?: FaultPoint;
  readonly unlink?: FaultPoint;
  readonly directoryFinalSync?: FaultPoint;
  readonly ticketClose?: FaultPoint;
  readonly directoryClose?: FaultPoint;
}

export interface RunTicketEngineOptions {
  readonly faults?: RunTicketEngineFaults;
  readonly expectedDirectoryOwnerUid?: number;
  readonly expectedTicketOwnerUid?: number;
}

/** Shared engine used only by the fixed facade and the dedicated test support. */
export async function consumeRunTicketWithEngine(
  directory: string,
  processRunId: string,
  options: RunTicketEngineOptions = {},
): Promise<ConsumedRunTicket> {
  const context = createContext(options);
  return consumeFromDirectory(
    directory,
    processRunId,
    context,
  );
}

interface IntakeContext {
  readonly euid: number;
  readonly directoryOwnerUid: number;
  readonly ticketOwnerUid: number;
  readonly faults: RunTicketEngineFaults;
}

interface OpenDirectory {
  readonly handle: FileHandle;
  readonly info: Stats;
}

interface ValidatedTicketFile {
  readonly ticket: ParsedRunTicket;
  readonly info: Stats;
}

function createContext(options: RunTicketEngineOptions): IntakeContext {
  const euid = currentUid();
  return Object.freeze({
    euid,
    directoryOwnerUid: options.expectedDirectoryOwnerUid ?? euid,
    ticketOwnerUid: options.expectedTicketOwnerUid ?? euid,
    faults: options.faults ?? {},
  });
}

async function consumeFromDirectory(
  directoryPath: string,
  processRunId: string,
  context: IntakeContext,
): Promise<ConsumedRunTicket> {
  if (!isCanonicalUuidV4(processRunId)) throw new RunTicketIntakeError('PROCESS_BINDING_MISMATCH');
  const directory = await openSecureDirectory(directoryPath, context.directoryOwnerUid);
  let facts: ConsumedRunTicketFacts | undefined;
  let primary: RunTicketIntakeError | undefined;
  try {
    const validated = await readAndValidateTicket(directoryPath, directory.info, processRunId, context);
    await claimConsumption(directoryPath, directory, validated, context);
    facts = Object.freeze({
      ticketId: validated.ticket.ticketId,
      datasetEpoch: validated.ticket.datasetEpoch,
      processRunId: validated.ticket.processRunId,
    });
  } catch (error) {
    primary = sanitizeIntakeError(error);
  }

  const closeFailure = await closeHandle(directory.handle, context.faults.directoryClose);
  if (primary !== undefined) throw primary;
  if (closeFailure || facts === undefined) throw new RunTicketIntakeError('CONSUME_UNKNOWN');
  return mintConsumedRunTicket(facts);
}

async function readAndValidateTicket(
  directoryPath: string,
  directory: Stats,
  processRunId: string,
  context: IntakeContext,
): Promise<ValidatedTicketFile> {
  await assertDirectoryPathIdentity(directoryPath, directory, context.directoryOwnerUid);
  const ticketPath = join(directoryPath, TICKET_FILE_NAME);
  await preflightTicketPath(ticketPath, context.ticketOwnerUid);

  let handle: FileHandle;
  try {
    handle = await open(ticketPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new RunTicketIntakeError('TICKET_NOT_PROVEN');
    if (isUnsafeOpenError(error)) throw new RunTicketIntakeError('TICKET_FILE_UNSAFE');
    throw new RunTicketIntakeError('CONSUME_UNKNOWN');
  }

  let validated: ValidatedTicketFile | undefined;
  let primary: RunTicketIntakeError | undefined;
  try {
    const before = await handle.stat();
    assertSecureTicket(before, context.ticketOwnerUid);
    await assertTicketPathIdentity(ticketPath, before, context.ticketOwnerUid);
    const bytes = await readBounded(handle);
    const after = await handle.stat();
    assertSameFile(before, after);
    assertSecureTicket(after, context.ticketOwnerUid);
    if (bytes.length !== after.size) throw new RunTicketIntakeError('TICKET_FILE_UNSAFE');
    validated = Object.freeze({ ticket: parseRunTicketWire(bytes, processRunId), info: after });
  } catch (error) {
    primary = sanitizeIntakeError(error);
  }

  const closeFailure = await closeHandle(handle, context.faults.ticketClose);
  if (primary !== undefined) throw primary;
  if (closeFailure || validated === undefined) throw new RunTicketIntakeError('CONSUME_UNKNOWN');
  return validated;
}

async function claimConsumption(
  directoryPath: string,
  directory: OpenDirectory,
  validated: ValidatedTicketFile,
  context: IntakeContext,
): Promise<void> {
  await assertDirectoryPathIdentity(directoryPath, directory.info, context.directoryOwnerUid);
  const markerPath = join(directoryPath, `${USED_MARKER_PREFIX}${validated.ticket.ticketId}`);
  try {
    await runFault(context.faults.markerCreate);
  } catch {
    throw new RunTicketIntakeError('CONSUME_UNKNOWN');
  }
  let marker: FileHandle;
  try {
    marker = await open(
      markerPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      TICKET_MODE,
    );
  } catch (error) {
    if (isErrno(error, 'EEXIST')) throw new RunTicketIntakeError('TICKET_ALREADY_USED');
    throw new RunTicketIntakeError('CONSUME_UNKNOWN');
  }

  let markerFailure = false;
  try {
    await marker.chmod(TICKET_MODE);
    const markerInfo = await marker.stat();
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.uid !== context.euid
      || (markerInfo.mode & 0o7777) !== TICKET_MODE || markerInfo.size !== 0) {
      throw new Error('unsafe marker');
    }
    await runFault(context.faults.markerSync);
    await marker.sync();
  } catch {
    markerFailure = true;
  }
  const markerCloseFailure = await closeHandle(marker, context.faults.markerClose);
  if (markerFailure || markerCloseFailure) throw new RunTicketIntakeError('CONSUME_UNKNOWN');

  const ticketPath = join(directoryPath, TICKET_FILE_NAME);
  try {
    await runFault(context.faults.directoryFirstSync);
    await directory.handle.sync();
    await assertDirectoryPathIdentity(directoryPath, directory.info, context.directoryOwnerUid);
    const listed = await lstat(ticketPath);
    assertSecureTicket(listed, context.ticketOwnerUid);
    assertSameFile(validated.info, listed);
    await runFault(context.faults.unlink);
    await unlink(ticketPath);
    await runFault(context.faults.directoryFinalSync);
    await directory.handle.sync();
  } catch {
    throw new RunTicketIntakeError('CONSUME_UNKNOWN');
  }
}

function mintConsumedRunTicket(facts: ConsumedRunTicketFacts): ConsumedRunTicket {
  const token = new ConsumedRunTicket(TOKEN_MINT);
  consumedTicketFacts.set(token, facts);
  return token;
}

async function openSecureDirectory(directory: string, euid: number): Promise<OpenDirectory> {
  let listed: Stats;
  let resolved: string;
  try {
    listed = await lstat(directory);
    resolved = await realpath(directory);
  } catch {
    throw new RunTicketIntakeError('RUNTIME_DIRECTORY_UNSAFE');
  }
  assertSecureDirectory(listed, euid);
  if (resolved !== directory) throw new RunTicketIntakeError('RUNTIME_DIRECTORY_UNSAFE');

  let handle: FileHandle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new RunTicketIntakeError('RUNTIME_DIRECTORY_UNSAFE');
  }
  try {
    const opened = await handle.stat();
    assertSecureDirectory(opened, euid);
    assertSameFile(listed, opened, 'RUNTIME_DIRECTORY_UNSAFE');
    return Object.freeze({ handle, info: opened });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function preflightTicketPath(path: string, ownerUid: number): Promise<void> {
  try {
    assertSecureTicket(await lstat(path), ownerUid);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new RunTicketIntakeError('TICKET_NOT_PROVEN');
    if (error instanceof RunTicketIntakeError) throw error;
    throw new RunTicketIntakeError('CONSUME_UNKNOWN');
  }
}

async function assertDirectoryPathIdentity(path: string, expected: Stats, euid: number): Promise<void> {
  let listed: Stats;
  let resolved: string;
  try {
    listed = await lstat(path);
    resolved = await realpath(path);
  } catch {
    throw new RunTicketIntakeError('RUNTIME_DIRECTORY_UNSAFE');
  }
  assertSecureDirectory(listed, euid);
  assertSameFile(expected, listed, 'RUNTIME_DIRECTORY_UNSAFE');
  if (resolved !== path) throw new RunTicketIntakeError('RUNTIME_DIRECTORY_UNSAFE');
}

async function assertTicketPathIdentity(path: string, expected: Stats, ownerUid: number): Promise<void> {
  let listed: Stats;
  try {
    listed = await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new RunTicketIntakeError('TICKET_NOT_PROVEN');
    throw new RunTicketIntakeError('TICKET_FILE_UNSAFE');
  }
  assertSecureTicket(listed, ownerUid);
  assertSameFile(expected, listed);
}

function assertSecureDirectory(info: Stats, euid: number): void {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== euid
    || (info.mode & 0o7777) !== DIRECTORY_MODE) {
    throw new RunTicketIntakeError('RUNTIME_DIRECTORY_UNSAFE');
  }
}

function assertSecureTicket(info: Stats, ownerUid: number): void {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== ownerUid
    || (info.mode & 0o7777) !== TICKET_MODE || info.size < 1 || info.size > MAX_TICKET_BYTES) {
    throw new RunTicketIntakeError('TICKET_FILE_UNSAFE');
  }
}

function assertSameFile(expected: Stats, actual: Stats, code: RunTicketIntakeFailure = 'TICKET_FILE_UNSAFE'): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw new RunTicketIntakeError(code);
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_TICKET_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset < 1 || offset > MAX_TICKET_BYTES) throw new RunTicketIntakeError('TICKET_FILE_UNSAFE');
  return buffer.subarray(0, offset);
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
  const getuid = process.getuid;
  if (process.platform === 'win32' || getuid === undefined) {
    throw new RunTicketIntakeError('RUNTIME_DIRECTORY_UNSAFE');
  }
  return getuid.call(process);
}

function sanitizeIntakeError(error: unknown): RunTicketIntakeError {
  if (error instanceof RunTicketIntakeError) return error;
  if (error instanceof RunTicketWireError) {
    return new RunTicketIntakeError(error.bindingMismatch ? 'PROCESS_BINDING_MISMATCH' : 'TICKET_INVALID');
  }
  return new RunTicketIntakeError('CONSUME_UNKNOWN');
}

function isUnsafeOpenError(error: unknown): boolean {
  return ['ELOOP', 'EACCES', 'EISDIR', 'ENXIO', 'ENODEV', 'EOPNOTSUPP'].some((code) => isErrno(error, code));
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
