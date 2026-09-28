import { type Stats } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';

/**
 * Fixed private control-socket name.  Keeping this constant out of any public
 * barrel prevents callers from treating the control channel as an API.
 */
export const RUNTIME_CONTROL_SOCKET_FILE_NAME = 'runtime-control.sock';
const DIRECTORY_MODE = 0o700;

export interface RuntimeControlSocketPathOptions {
  readonly directory: string;
  readonly socketPath: string;
}

export interface RuntimeControlSocketPath {
  readonly directory: string;
  readonly socketPath: string;
}

/**
 * Preflights only the filesystem namespace owned by the future AF_UNIX
 * adapter.  It deliberately neither opens a network listener nor unlinks an
 * existing socket; A11.3 owns those behaviours.
 *
 * The directory is accepted only as an exact, real absolute path.  If absent,
 * only its already-real direct parent may be used to create it.  This keeps
 * setup non-recursive and makes any unsafe path a startup error rather than a
 * repair attempt against an attacker-selected pathname.
 */
export async function prepareRuntimeControlSocketPath(
  options: RuntimeControlSocketPathOptions,
): Promise<RuntimeControlSocketPath> {
  assertUnixRuntime();
  const captured = captureOptions(options);
  assertConfiguredPaths(captured);

  let directoryExists = true;
  try {
    await lstat(captured.directory);
  } catch (error) {
    if (!isEnoent(error)) throw new RuntimeControlSocketPathError('control directory is unavailable');
    directoryExists = false;
  }

  if (!directoryExists) {
    await assertRealExistingParent(dirname(captured.directory));
    try {
      // `recursive: false` is intentional: a configured control directory
      // never gets to create or repair any ancestor.
      await mkdir(captured.directory, { mode: DIRECTORY_MODE, recursive: false });
    } catch (error) {
      // A competing creator is allowed only to the extent that the resulting
      // object passes the same strict final validation below.
      if (!isEexist(error)) throw new RuntimeControlSocketPathError('cannot create control directory');
    }
  }

  await assertSecureControlDirectory(captured.directory);
  return Object.freeze({ directory: captured.directory, socketPath: captured.socketPath });
}

export class RuntimeControlSocketPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeControlSocketPathError';
  }
}

function captureOptions(input: unknown): Readonly<RuntimeControlSocketPathOptions> {
  if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('runtime control socket options');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('directory') || !keys.includes('socketPath')) {
    throw new TypeError('runtime control socket options');
  }
  const directory = Object.getOwnPropertyDescriptor(input, 'directory');
  const socketPath = Object.getOwnPropertyDescriptor(input, 'socketPath');
  if (directory === undefined || socketPath === undefined || !directory.enumerable || !socketPath.enumerable
    || !Object.hasOwn(directory, 'value') || !Object.hasOwn(socketPath, 'value')
    || typeof directory.value !== 'string' || typeof socketPath.value !== 'string') {
    throw new TypeError('runtime control socket options');
  }
  return Object.freeze({ directory: directory.value, socketPath: socketPath.value });
}

function assertConfiguredPaths(options: RuntimeControlSocketPathOptions): void {
  const { directory, socketPath } = options;
  if (!isAbsolute(directory) || !isAbsolute(socketPath) || directory.includes('\0') || socketPath.includes('\0')) {
    throw new RuntimeControlSocketPathError('control paths must be absolute');
  }
  // Requiring canonical lexical paths prevents a caller from hiding a parent
  // traversal behind a path that happens to resolve to the right directory.
  if (resolve(directory) !== directory || resolve(socketPath) !== socketPath) {
    throw new RuntimeControlSocketPathError('control paths must be canonical');
  }
  if (dirname(socketPath) !== directory || resolve(dirname(socketPath)) !== directory
    || basename(socketPath) !== RUNTIME_CONTROL_SOCKET_FILE_NAME) {
    throw new RuntimeControlSocketPathError('socket path must be the fixed direct child');
  }
}

async function assertRealExistingParent(parent: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(parent);
  } catch {
    throw new RuntimeControlSocketPathError('control directory parent is unavailable');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RuntimeControlSocketPathError('control directory parent is not a real directory');
  }
  let resolved: string;
  try {
    resolved = await realpath(parent);
  } catch {
    throw new RuntimeControlSocketPathError('control directory parent cannot be resolved');
  }
  if (resolved !== parent) throw new RuntimeControlSocketPathError('control directory parent is not real');
}

async function assertSecureControlDirectory(directory: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(directory);
  } catch {
    throw new RuntimeControlSocketPathError('control directory is unavailable');
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid()
    || (info.mode & 0o7777) !== DIRECTORY_MODE) {
    throw new RuntimeControlSocketPathError('control directory is unsafe');
  }
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch {
    throw new RuntimeControlSocketPathError('control directory cannot be resolved');
  }
  if (resolved !== directory) throw new RuntimeControlSocketPathError('control directory is not real');
}

function assertUnixRuntime(): void {
  void currentUid();
}

function currentUid(): number {
  const getuid = process.getuid;
  if (process.platform === 'win32' || getuid === undefined) {
    throw new RuntimeControlSocketPathError('AF_UNIX control path requires Unix');
  }
  return getuid.call(process);
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
