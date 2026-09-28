import { randomUUID } from 'node:crypto';
import { type Stats } from 'node:fs';
import { chmod, lstat, rename, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { types as nodeTypes } from 'node:util';
import {
  prepareRuntimeControlSocketPath,
  RUNTIME_CONTROL_SOCKET_FILE_NAME,
  RuntimeControlSocketPathError,
  type RuntimeControlSocketPathOptions,
} from './runtime-control-socket-path.js';

const SOCKET_MODE = 0o600;
const STALE_PROBE_TIMEOUT_MS = 2_000;

export interface RuntimeControlSocketListenerOptions extends RuntimeControlSocketPathOptions {
  /** Transport-only handoff.  Protocol framing is intentionally a later slice. */
  readonly onConnection?: (socket: Socket) => void;
}

export interface RuntimeControlSocketListener {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** A startup failure for the private AF_UNIX adapter.  It is never public API. */
export class RuntimeControlSocketListenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeControlSocketListenerError';
  }
}

interface Inode {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Owns only AF_UNIX listener lifecycle.  It deliberately has no framing,
 * protocol, control, log, or CLI dependency: a connected socket is handed to
 * an internal callback (or immediately destroyed) by a later adapter.
 *
 * D185 makes the same Unix UID the trusted service principal.  The lstat /
 * inode checks still fail closed for accidental or cross-UID path mistakes;
 * Node pathname APIs cannot make those checks race-proof against that trusted
 * same-UID principal.
 */
export async function createRuntimeControlSocketListener(
  options: RuntimeControlSocketListenerOptions,
): Promise<RuntimeControlSocketListener> {
  const captured = captureOptions(options);
  const prepared = await prepareRuntimeControlSocketPath({
    directory: captured.directory,
    socketPath: captured.socketPath,
  });
  await removeOnlyVerifiedStaleSocket(prepared.socketPath);

  const handler = captured.onConnection ?? ((socket: Socket): void => { socket.destroy(); });
  const server = createServer((socket) => {
    try {
      handler(socket);
    } catch {
      // A later protocol adapter must not be able to crash the listener by
      // throwing from its transport callback.
      socket.destroy();
    }
  });
  let created: Inode | undefined;
  try {
    await listenUnix(server, prepared.socketPath);
    const beforeChmod = await readSecureSocket(prepared.socketPath, false);
    created = inodeOf(beforeChmod);
    await chmod(prepared.socketPath, SOCKET_MODE);
    const verified = await readSecureSocket(prepared.socketPath, true);
    if (!sameInode(created, inodeOf(verified))) throw new RuntimeControlSocketListenerError('created control socket changed during setup');
    return new PrivateRuntimeControlSocketListener(prepared.socketPath, server, created);
  } catch (error) {
    await closeServerPreservingReplacement(server, prepared.socketPath, created).catch(() => undefined);
    if (error instanceof RuntimeControlSocketPathError || error instanceof RuntimeControlSocketListenerError) throw error;
    throw new RuntimeControlSocketListenerError('cannot start control socket');
  }
}

class PrivateRuntimeControlSocketListener implements RuntimeControlSocketListener {
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly socketPath: string,
    private readonly server: Server,
    private readonly created: Inode,
  ) {}

  close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = closeServerPreservingReplacement(this.server, this.socketPath, this.created);
    }
    return this.closePromise;
  }
}

function captureOptions(input: unknown): Readonly<RuntimeControlSocketListenerOptions> {
  if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('runtime control socket listener options');
  const keys = Reflect.ownKeys(input);
  if (keys.length < 2 || keys.length > 3 || !keys.includes('directory') || !keys.includes('socketPath')
    || keys.some((key) => key !== 'directory' && key !== 'socketPath' && key !== 'onConnection')) {
    throw new TypeError('runtime control socket listener options');
  }
  const directory = Object.getOwnPropertyDescriptor(input, 'directory');
  const socketPath = Object.getOwnPropertyDescriptor(input, 'socketPath');
  const onConnection = Object.getOwnPropertyDescriptor(input, 'onConnection');
  if (directory === undefined || socketPath === undefined || !directory.enumerable || !socketPath.enumerable
    || !Object.hasOwn(directory, 'value') || !Object.hasOwn(socketPath, 'value')
    || typeof directory.value !== 'string' || typeof socketPath.value !== 'string'
    || (onConnection !== undefined && (!onConnection.enumerable || !Object.hasOwn(onConnection, 'value')
      || typeof onConnection.value !== 'function' || nodeTypes.isProxy(onConnection.value)))) {
    throw new TypeError('runtime control socket listener options');
  }
  return Object.freeze({
    directory: directory.value,
    socketPath: socketPath.value,
    ...(onConnection === undefined ? {} : { onConnection: onConnection.value as (socket: Socket) => void }),
  });
}

async function removeOnlyVerifiedStaleSocket(socketPath: string): Promise<void> {
  const existing = await lstatOptional(socketPath);
  if (existing === undefined) return;
  const original = assertSecureSocket(existing, true);
  const probe = await probeSocket(socketPath);
  if (probe !== 'REFUSED') throw new RuntimeControlSocketListenerError('control socket is already active');
  const afterProbe = await lstatOptional(socketPath);
  if (afterProbe === undefined) throw new RuntimeControlSocketListenerError('stale control socket disappeared');
  const current = assertSecureSocket(afterProbe, true);
  if (!sameInode(original, current)) throw new RuntimeControlSocketListenerError('stale control socket changed during probe');
  try {
    // D185 explicitly scopes this pathname action to a trusted same-UID
    // service principal.  A second lstat makes accidental replacements fail
    // closed before this mutation.
    const beforeUnlink = await lstatOptional(socketPath);
    if (beforeUnlink === undefined || !sameInode(current, assertSecureSocket(beforeUnlink, true))) {
      throw new RuntimeControlSocketListenerError('stale control socket changed before removal');
    }
    await unlink(socketPath);
  } catch (error) {
    if (error instanceof RuntimeControlSocketListenerError) throw error;
    throw new RuntimeControlSocketListenerError('cannot remove stale control socket');
  }
}

async function probeSocket(socketPath: string): Promise<'REFUSED' | 'ACTIVE'> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => settle(() => reject(new RuntimeControlSocketListenerError('control socket probe timed out'))), STALE_PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle(() => { clearTimeout(timer); resolve('ACTIVE'); }));
    socket.once('error', (error: NodeJS.ErrnoException) => settle(() => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED') resolve('REFUSED');
      else reject(new RuntimeControlSocketListenerError('control socket probe failed'));
    }));
  });
}

async function listenUnix(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (): void => { cleanup(); reject(new RuntimeControlSocketListenerError('cannot listen on control socket')); };
    const onListening = (): void => { cleanup(); resolve(); };
    const cleanup = (): void => { server.off('error', onError); server.off('listening', onListening); };
    server.once('error', onError);
    server.once('listening', onListening);
    try { server.listen(socketPath); } catch (error) { cleanup(); reject(error); }
  });
}

async function closeServerPreservingReplacement(server: Server, socketPath: string, created: Inode | undefined): Promise<void> {
  // Node automatically unlinks a Unix socket path in Server.close().  If the
  // pathname was replaced, temporarily move that replacement aside so close
  // cannot erase it; restore it afterwards.  Under D185 this is a reliable
  // lifecycle guard against accidental replacement, not a same-UID attacker
  // defense claim.
  const current = await lstatOptional(socketPath);
  const preservePath = current !== undefined && (created === undefined || !sameInode(inodeOf(current), created))
    ? await moveAside(socketPath)
    : undefined;
  let closeError: unknown;
  try {
    await closeServer(server);
  } catch (error) {
    closeError = error;
  }
  let restoreError: unknown;
  if (preservePath !== undefined) {
    try { await rename(preservePath, socketPath); } catch (error) { restoreError = error; }
  }
  if (closeError !== undefined || restoreError !== undefined) throw new RuntimeControlSocketListenerError('cannot close control socket');
}

async function moveAside(socketPath: string): Promise<string> {
  const directory = dirname(socketPath);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = join(directory, `.${RUNTIME_CONTROL_SOCKET_FILE_NAME}.${randomUUID()}.preserve`);
    if (await lstatOptional(candidate) !== undefined) continue;
    await rename(socketPath, candidate);
    return candidate;
  }
  throw new RuntimeControlSocketListenerError('cannot preserve replacement control socket');
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    } catch (error) { reject(error); }
  });
}

async function readSecureSocket(socketPath: string, requireMode: boolean): Promise<Stats> {
  const info = await lstatOptional(socketPath);
  if (info === undefined) throw new RuntimeControlSocketListenerError('control socket disappeared');
  assertSecureSocket(info, requireMode);
  return info;
}

function assertSecureSocket(info: Stats, requireMode: boolean): Inode {
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== currentUid() || (requireMode && (info.mode & 0o7777) !== SOCKET_MODE)) {
    throw new RuntimeControlSocketListenerError('control socket is unsafe');
  }
  return inodeOf(info);
}

function currentUid(): number {
  if (process.platform === 'win32' || process.getuid === undefined) throw new RuntimeControlSocketListenerError('AF_UNIX control socket requires Unix');
  return process.getuid();
}

function inodeOf(info: Stats): Inode { return Object.freeze({ dev: info.dev, ino: info.ino }); }
function sameInode(left: Inode, right: Inode): boolean { return left.dev === right.dev && left.ino === right.ino; }

async function lstatOptional(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new RuntimeControlSocketListenerError('cannot inspect control socket path');
  }
}
