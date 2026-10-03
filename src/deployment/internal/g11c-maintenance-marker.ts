import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, join } from 'node:path';
import {
  mintG11cMaintenanceMarker,
  type G11cMaintenanceMarker,
} from './g11c-maintenance-lifecycle-engine.js';

// The host marker directory is bind-mounted read-only into NGINX.  It must
// therefore be traversable by the proxy user; it is not the API's 0700
// private runtime directory.  The marker itself remains owner-only 0600.
const DIRECTORY_MODE = 0o755;
const MARKER_MODE = 0o600;
const MARKER_NAME = 'maintenance';

export interface G11cMaintenanceMarkerAdapter {
  readonly path: string;
  /** Creates or securely adopts the persistent marker; never removes it. */
  readonly acquire: () => Promise<G11cMaintenanceMarker>;
}

export interface G11cMaintenanceMarkerOptions {
  readonly directory: string;
}

/**
 * Host-owned marker adapter used before private drain.  It intentionally has
 * no release method: G11c must keep the public edge fenced through process
 * isolation, recovery and later controlled bootstrap/handoff.  G11e will own
 * the outer controller and lock around this adapter.
 */
export function createG11cMaintenanceMarkerAdapter(input: G11cMaintenanceMarkerOptions): G11cMaintenanceMarkerAdapter {
  const directory = captureDirectory(input);
  const path = join(directory, MARKER_NAME);
  return Object.freeze({ path, acquire: async () => acquireMarker(directory, path) });
}

async function acquireMarker(directory: string, path: string): Promise<G11cMaintenanceMarker> {
  await assertSecureDirectory(directory);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, MARKER_MODE);
    await handle.chmod(MARKER_MODE);
    const info = await handle.stat();
    if (!isSafeMarkerStat(info)) throw new Error('unsafe maintenance marker');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncParentDirectory(directory);
    return mintG11cMaintenanceMarker();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!isEexist(error)) throw new G11cMaintenanceMarkerError('MARKER_ACQUIRE_FAILED');
    try {
      // Re-open the existing marker with O_NOFOLLOW and validate the same
      // descriptor that is adopted, avoiding an lstat-to-use pathname race.
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await existing.stat();
        if (!isSafeMarkerStat(info)) throw new Error('unsafe maintenance marker');
        await syncParentDirectory(directory);
        return mintG11cMaintenanceMarker();
      } finally {
        await existing.close();
      }
    } catch {
      throw new G11cMaintenanceMarkerError('MARKER_ACQUIRE_FAILED');
    }
  }
}

export class G11cMaintenanceMarkerError extends Error {
  constructor(readonly code: 'MARKER_ACQUIRE_FAILED') {
    super(code);
    this.name = 'G11cMaintenanceMarkerError';
  }
}

async function assertSecureDirectory(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()
    || info.uid !== currentUid() || (info.mode & 0o7777) !== DIRECTORY_MODE) {
    throw new G11cMaintenanceMarkerError('MARKER_ACQUIRE_FAILED');
  }
  const resolved = await realpath(directory).catch(() => undefined);
  if (resolved !== directory) throw new G11cMaintenanceMarkerError('MARKER_ACQUIRE_FAILED');
}

function isSafeMarkerStat(info: { readonly isFile: () => boolean; readonly isSymbolicLink: () => boolean; readonly uid: number; readonly mode: number; readonly size: number }): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.uid === currentUid()
    && (info.mode & 0o7777) === MARKER_MODE && info.size === 0;
}

function captureDirectory(input: G11cMaintenanceMarkerOptions): string {
  if (typeof input !== 'object' || input === null || Reflect.ownKeys(input).length !== 1
    || typeof input.directory !== 'string' || !isAbsolute(input.directory) || input.directory.includes('\0')
    || resolve(input.directory) !== input.directory || basename(input.directory) === MARKER_NAME
    || dirname(input.directory) === input.directory) {
    throw new TypeError('invalid G11c maintenance marker directory');
  }
  return input.directory;
}

function currentUid(): number {
  if (process.getuid === undefined) throw new G11cMaintenanceMarkerError('MARKER_ACQUIRE_FAILED');
  return process.getuid();
}

async function syncParentDirectory(directory: string): Promise<void> {
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await parent.sync(); } finally { await parent.close(); }
}

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
