import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createG10aRuntimeOwner,
  G10aRuntimeOwnerError,
} from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import * as publicApi from '../../src/index.js';
import * as compositionApi from '../../src/composition/index.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const requestControlId = '33333333-3333-4333-8333-333333333333';

interface Harness {
  readonly parent: string;
  readonly logDirectory: string;
  readonly controlDirectory: string;
  readonly socketPath: string;
}

async function harness(): Promise<Harness> {
  const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-runtime-owner-'));
  const controlDirectory = join(parent, 'control');
  return Object.freeze({
    parent,
    logDirectory: join(parent, 'logs'),
    controlDirectory,
    socketPath: join(controlDirectory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
  });
}

function options(value: Harness, overrides: Record<string, unknown> = {}) {
  return {
    epoch,
    run,
    logDirectory: value.logDirectory,
    controlDirectory: value.controlDirectory,
    controlSocketPath: value.socketPath,
    monotonicClock: Object.freeze({ nowMs: () => performance.now() }),
    awaitObservation: () => undefined,
    ...overrides,
  };
}

async function status(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('status exchange timed out')); }, 2_000);
    socket.once('connect', () => socket.end(Buffer.from(`${JSON.stringify({
      v: 'c1', requestControlId, command: 'STATUS', epoch, run,
    })}\n`, 'utf8')));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); } catch (error) { reject(error); }
    });
  });
}

async function expectSocketAbsent(path: string): Promise<void> {
  await expect(new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('connect', () => { socket.destroy(); reject(new Error('control listener leaked')); });
    socket.once('error', () => { socket.destroy(); resolve(); });
  })).resolves.toBeUndefined();
}

describe('G10a private runtime owner bootstrap', () => {
  const parents: string[] = [];
  afterEach(async () => {
    await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
  });

  test('owns one explicit-path logger/control/socket runtime, exposes only private capabilities, and closes listener before its sink', async () => {
    expect(Object.keys(publicApi).some((key) => /runtime.*owner/iu.test(key))).toBe(false);
    expect(Object.keys(compositionApi).some((key) => /runtime.*owner/iu.test(key))).toBe(false);
    const value = await harness();
    parents.push(value.parent);
    const owner = createG10aRuntimeOwner(options(value));
    const runtime = await owner.start();

    expect(runtime.socketPath).toBe(value.socketPath);
    expect(runtime.loggingAvailable).toBe(true);
    await expect(stat(join(value.logDirectory, 'runtime.log'))).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(status(value.socketPath)).resolves.toMatchObject({ ok: true, command: 'STATUS', outcome: 'STATUS' });
    expect(runtime.runtimeLogSink.snapshot()).toMatchObject({ closed: false, status: 'HEALTHY' });

    await owner.close();
    expect(runtime.runtimeLogSink.snapshot()).toMatchObject({ closed: true });
    await expectSocketAbsent(value.socketPath);
    await expect(owner.close()).resolves.toBeUndefined();
  });

  test('keeps private control available with a nominal degraded logger when the explicit log namespace cannot initialize', async () => {
    const value = await harness();
    parents.push(value.parent);
    const owner = createG10aRuntimeOwner(options(value, { logDirectory: join(value.parent, 'missing-parent', 'logs') }));
    const runtime = await owner.start();

    expect(runtime.loggingAvailable).toBe(false);
    expect(runtime.control.snapshot().logging).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 0 });
    await expect(status(value.socketPath)).resolves.toMatchObject({ ok: true, command: 'STATUS', outcome: 'STATUS' });
    await owner.close();
    await expectSocketAbsent(value.socketPath);
  });

  test('closes its logger after a socket-start failure and never leaves a second listener behind', async () => {
    const firstPaths = await harness();
    const secondPaths = await harness();
    parents.push(firstPaths.parent, secondPaths.parent);
    const first = createG10aRuntimeOwner(options(firstPaths));
    await first.start();
    const blocked = createG10aRuntimeOwner(options(secondPaths, {
      controlDirectory: firstPaths.controlDirectory,
      controlSocketPath: firstPaths.socketPath,
    }));

    await expect(blocked.start()).rejects.toBeInstanceOf(G10aRuntimeOwnerError);
    await expect(blocked.close()).resolves.toBeUndefined();
    await expect(status(firstPaths.socketPath)).resolves.toMatchObject({ ok: true, command: 'STATUS' });

    await first.close();
    await expectSocketAbsent(firstPaths.socketPath);
    // Reusing the exact path after the failed second startup proves that it
    // did not own a hidden listener or leave a stale socket behind.
    const replacement = createG10aRuntimeOwner(options(secondPaths, {
      controlDirectory: firstPaths.controlDirectory,
      controlSocketPath: firstPaths.socketPath,
    }));
    await replacement.start();
    await replacement.close();
  });

  test('rejects implicit/unsafe configuration and cannot be restarted after close', async () => {
    const value = await harness();
    parents.push(value.parent);
    expect(() => createG10aRuntimeOwner(options(value, { logDirectory: 'relative-logs' }) as never)).toThrow(TypeError);
    expect(() => createG10aRuntimeOwner(Object.freeze({ ...options(value), extra: true }) as never)).toThrow(TypeError);

    const owner = createG10aRuntimeOwner(options(value));
    await owner.close();
    await expect(owner.start()).rejects.toBeInstanceOf(G10aRuntimeOwnerError);
    await expectSocketAbsent(value.socketPath);
  });

  test('a close racing the explicit bootstrap leaves neither a listener nor an open sink', async () => {
    const value = await harness();
    parents.push(value.parent);
    const owner = createG10aRuntimeOwner(options(value));

    // Do not await startup before shutdown: this is the only lifecycle path
    // where the listener can be created after close() has already been
    // requested.  The owner must still funnel both through one shutdown.
    const starting = owner.start();
    const closing = owner.close();
    const runtime = await starting;
    await closing;

    expect(runtime.runtimeLogSink.snapshot()).toMatchObject({ closed: true });
    await expectSocketAbsent(value.socketPath);
    await expect(owner.start()).rejects.toBeInstanceOf(G10aRuntimeOwnerError);
  });
});
