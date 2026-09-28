import { chmod, lstat, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_CONTROL_SOCKET_FILE_NAME,
  RuntimeControlSocketPathError,
  prepareRuntimeControlSocketPath,
} from '../../src/runtime/internal/runtime-control-socket-path.js';
import * as publicApi from '../../src/index.js';
import * as publicCompositionApi from '../../src/composition/index.js';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'passhub-g10a-control-path-'));
}

function options(directory: string): { readonly directory: string; readonly socketPath: string } {
  return Object.freeze({ directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME) });
}

describe('G10a A11.2 private runtime-control socket path', () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))); });

  test('is private and creates only a missing direct child directory at 0700', async () => {
    for (const api of [publicApi, publicCompositionApi]) {
      expect(Object.keys(api).filter((key) => /runtime.*control|control.*socket|socket.*path/iu.test(key))).toEqual([]);
    }
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control');
    const prepared = await prepareRuntimeControlSocketPath(options(directory));
    expect(prepared).toEqual({ directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME) });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect((await lstat(directory)).mode & 0o7777).toBe(0o700);
    await expect(lstat(prepared.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('accepts only an existing same-euid real directory of exact mode 0700', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control');
    await mkdir(directory, { mode: 0o700 });
    await expect(prepareRuntimeControlSocketPath(options(directory))).resolves.toEqual(options(directory));

    await chmod(directory, 0o750);
    await expect(prepareRuntimeControlSocketPath(options(directory))).rejects.toBeInstanceOf(RuntimeControlSocketPathError);
    expect((await lstat(directory)).mode & 0o7777).toBe(0o750);
  });

  test('rejects symlinked control directories and missing or symlinked direct parents without modifying targets', async () => {
    const root = await temporaryDirectory(); cleanup.push(root);
    const target = join(root, 'target'); await mkdir(target, { mode: 0o700 });
    const linked = join(root, 'linked'); await symlink(target, linked);
    await expect(prepareRuntimeControlSocketPath(options(linked))).rejects.toBeInstanceOf(RuntimeControlSocketPathError);
    expect((await lstat(target)).mode & 0o7777).toBe(0o700);

    const absent = join(root, 'missing-parent', 'control');
    await expect(prepareRuntimeControlSocketPath(options(absent))).rejects.toBeInstanceOf(RuntimeControlSocketPathError);
    await expect(lstat(join(root, 'missing-parent'))).rejects.toMatchObject({ code: 'ENOENT' });

    const parentTarget = join(root, 'parent-target'); await mkdir(parentTarget, { mode: 0o700 });
    const parentLink = join(root, 'parent-link'); await symlink(parentTarget, parentLink);
    const viaParentLink = join(parentLink, 'control');
    await expect(prepareRuntimeControlSocketPath(options(viaParentLink))).rejects.toBeInstanceOf(RuntimeControlSocketPathError);
    await expect(lstat(join(parentTarget, 'control'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects relative, traversal, non-direct-child, and non-fixed-basename socket configuration before mutation', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control');
    const candidates: unknown[] = [
      { directory: 'relative', socketPath: '/tmp/runtime-control.sock' },
      { directory, socketPath: join(directory, '..', RUNTIME_CONTROL_SOCKET_FILE_NAME) },
      { directory, socketPath: join(directory, 'child', RUNTIME_CONTROL_SOCKET_FILE_NAME) },
      { directory, socketPath: join(directory, 'different.sock') },
      { directory: `${parent}/./control`, socketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME) },
      { directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME), extra: true },
    ];
    for (const candidate of candidates) {
      await expect(prepareRuntimeControlSocketPath(candidate as never)).rejects.toBeInstanceOf(Error);
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('fails closed under a restrictive umask rather than repairing a path by chmod', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control');
    const originalUmask = process.umask(0o777);
    try {
      await expect(prepareRuntimeControlSocketPath(options(directory))).rejects.toBeInstanceOf(RuntimeControlSocketPathError);
      expect((await lstat(directory)).mode & 0o7777).toBe(0o000);
    } finally {
      process.umask(originalUmask);
    }
  });
});
