import { chmod, lstat, mkdtemp, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createRuntimeControlSocketListener,
  RuntimeControlSocketListenerError,
} from '../../src/runtime/internal/runtime-control-socket-listener.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import * as publicApi from '../../src/index.js';
import * as compositionApi from '../../src/composition/index.js';

async function temporaryDirectory(): Promise<string> { return mkdtemp(join(tmpdir(), 'passhub-g10a-control-listener-')); }
const execFileAsync = promisify(execFile);
function options(directory: string): { readonly directory: string; readonly socketPath: string } {
  return Object.freeze({ directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME) });
}
async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
async function staleSocket(path: string): Promise<void> {
  const server = createServer();
  await listen(server, path);
  const moved = `${path}.bound`;
  await rename(path, moved);
  await close(server);
  await rename(moved, path);
  await chmod(path, 0o600);
}
async function wrongOwnerSocket(directory: string, socketPath: string): Promise<void> {
  // A normal unprivileged test process cannot chown a Unix socket.  The
  // project's pinned Node container creates the actual foreign-UID socket;
  // after restoring the host-owned 0700 directory it is safe to exercise the
  // listener's real lstat owner branch without mocks.
  await chmod(directory, 0o777);
  const currentUid = process.getuid?.() ?? 1000;
  const foreignUid = currentUid === 1001 ? 1002 : 1001;
  try {
    await execFileAsync('docker', [
      'run', '--rm', '--user', `${foreignUid}:${foreignUid}`, '-v', `${directory}:/control`,
      'node:24.21.0-bookworm-slim', 'node', '-e',
      "require('node:net').createServer().listen('/control/runtime-control.sock',()=>process.exit(0))",
    ]);
  } finally {
    await chmod(directory, 0o700);
  }
  expect((await lstat(socketPath)).uid).not.toBe(process.getuid?.());
}
async function connectAndEnd(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('error', reject);
    socket.once('end', resolve);
  });
}
async function connect(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}

describe('G10a A11.3a private AF_UNIX control listener lifecycle', () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))); });

  test('is private, creates a 0600 socket, invokes only its transport callback, and closes idempotently', async () => {
    for (const api of [publicApi, compositionApi]) expect(Object.keys(api).filter((key) => /runtime.*control|control.*socket|socket.*listener/iu.test(key))).toEqual([]);
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control');
    let calls = 0;
    const listener = await createRuntimeControlSocketListener({ ...options(directory), onConnection: (socket) => { calls += 1; socket.end(); } });
    const initial = await lstat(listener.socketPath);
    expect(initial.isSocket()).toBe(true);
    expect(initial.uid).toBe(process.getuid?.());
    expect(initial.mode & 0o7777).toBe(0o600);
    await connectAndEnd(listener.socketPath);
    expect(calls).toBe(1);
    await Promise.all([listener.close(), listener.close()]);
    await expect(lstat(listener.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('removes only a verified ECONNREFUSED stale same-owner 0600 socket before listening', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control'); await mkdir(directory, { mode: 0o700 });
    const configured = options(directory);
    await staleSocket(configured.socketPath);
    expect((await lstat(configured.socketPath)).isSocket()).toBe(true);
    const listener = await createRuntimeControlSocketListener(configured);
    const after = await lstat(configured.socketPath);
    expect(after.isSocket()).toBe(true);
    await connect(listener.socketPath);
    await listener.close();
  });

  test('fails closed for active, symlinked, non-socket, and wrong-mode existing paths without deleting them', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control'); await mkdir(directory, { mode: 0o700 });
    const configured = options(directory);
    const active = createServer(); await listen(active, configured.socketPath); await chmod(configured.socketPath, 0o600);
    await expect(createRuntimeControlSocketListener(configured)).rejects.toBeInstanceOf(RuntimeControlSocketListenerError);
    expect((await lstat(configured.socketPath)).isSocket()).toBe(true);
    await close(active);

    await rm(configured.socketPath, { force: true });
    await symlink('/tmp', configured.socketPath);
    await expect(createRuntimeControlSocketListener(configured)).rejects.toBeInstanceOf(RuntimeControlSocketListenerError);
    expect((await lstat(configured.socketPath)).isSymbolicLink()).toBe(true);
    await rm(configured.socketPath);

    await mkdir(configured.socketPath, { mode: 0o700 });
    await expect(createRuntimeControlSocketListener(configured)).rejects.toBeInstanceOf(RuntimeControlSocketListenerError);
    expect((await lstat(configured.socketPath)).isDirectory()).toBe(true);
    await rm(configured.socketPath, { recursive: true });

    await staleSocket(configured.socketPath); await chmod(configured.socketPath, 0o640);
    await expect(createRuntimeControlSocketListener(configured)).rejects.toBeInstanceOf(RuntimeControlSocketListenerError);
    expect((await lstat(configured.socketPath)).mode & 0o7777).toBe(0o640);
  });

  test('fails closed for an actual foreign-UID socket without deleting it', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control'); await mkdir(directory, { mode: 0o700 });
    const configured = options(directory);
    await wrongOwnerSocket(directory, configured.socketPath);
    await expect(createRuntimeControlSocketListener(configured)).rejects.toBeInstanceOf(RuntimeControlSocketListenerError);
    expect((await lstat(configured.socketPath)).isSocket()).toBe(true);
    expect((await lstat(configured.socketPath)).uid).not.toBe(process.getuid?.());
  });

  test('does not remove a pathname replacement on shutdown', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control');
    const listener = await createRuntimeControlSocketListener(options(directory));
    const original = `${listener.socketPath}.original`;
    await rename(listener.socketPath, original);
    await mkdir(listener.socketPath, { mode: 0o700 });
    await listener.close();
    expect((await lstat(listener.socketPath)).isDirectory()).toBe(true);
    expect((await lstat(original)).isSocket()).toBe(true);
  });

  test('rejects malformed listener options before creating a directory', async () => {
    const parent = await temporaryDirectory(); cleanup.push(parent);
    const directory = join(parent, 'control');
    await expect(createRuntimeControlSocketListener({ ...options(directory), unexpected: true } as never)).rejects.toBeInstanceOf(TypeError);
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
