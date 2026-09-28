import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeControlSocketListener,
  type RuntimeControlSocketListener,
} from '../../src/runtime/internal/runtime-control-socket-listener.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { createRuntimeControlSocketFramingAdapter } from '../../src/runtime/internal/runtime-control-socket-framing.js';
import { createRuntimeControl, createRuntimeIdentityIssuer, type RuntimeControl } from '../../src/runtime/internal/runtime-control.js';
import * as publicApi from '../../src/index.js';
import * as compositionApi from '../../src/composition/index.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';

function control(): RuntimeControl {
  return createRuntimeControl({
    epoch,
    run,
    identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
    clock: Object.freeze({ nowMs: () => 0 }),
    awaitObservation: () => undefined,
    controlIdFactory: randomUUID,
  });
}

function status(id = request): Buffer {
  return Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: id, command: 'STATUS', epoch, run })}\n`, 'utf8');
}

async function setup(): Promise<{ readonly directory: string; readonly listener: RuntimeControlSocketListener; readonly control: RuntimeControl }> {
  const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-framing-'));
  const directory = join(parent, 'control');
  const instance = control();
  const adapter = createRuntimeControlSocketFramingAdapter(instance);
  const listener = await createRuntimeControlSocketListener({
    directory,
    socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
    onConnection: adapter.onConnection,
  });
  return Object.freeze({ directory: parent, listener, control: instance });
}

interface Exchange { readonly received: Buffer; readonly ended: boolean; readonly errored: boolean; }

async function exchange(path: string, pieces: readonly Buffer[], halfClose = true): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const received: Buffer[] = [];
    let connected = false;
    let ended = false;
    let errored = false;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({ received: Buffer.concat(received), ended, errored }));
    };
    const timer = setTimeout(() => { socket.destroy(); finish(); }, 4_000);
    socket.once('connect', () => {
      connected = true;
      for (const piece of pieces) socket.write(piece);
      if (halfClose) socket.end();
    });
    socket.on('data', (piece: Buffer) => received.push(piece));
    socket.once('end', () => { ended = true; });
    socket.once('error', () => { errored = true; });
    socket.once('close', () => { clearTimeout(timer); finish(); });
    socket.once('connect', () => undefined);
    socket.once('error', (error) => {
      if (!connected) {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(error); }
      }
    });
  });
}

async function open(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

function expectExactlyOneResponseLine(value: Buffer): Record<string, unknown> {
  expect(value.length).toBeGreaterThan(0);
  expect(value.length).toBeLessThanOrEqual(256 * 1024);
  expect(value[value.length - 1]).toBe(0x0a);
  expect(value.indexOf(0x0a)).toBe(value.length - 1);
  return JSON.parse(value.toString('utf8')) as Record<string, unknown>;
}

/**
 * A deliberately tiny transport double.  Real AF_UNIX buffers make a
 * backpressure response far too machine-dependent to assert reliably; this
 * only controls the Socket contract that the framing adapter itself uses.
 */
class ControlledWriteSocket extends EventEmitter {
  public destroyed = false;
  public readonly writes: Buffer[] = [];

  public constructor(
    private readonly writeResult: boolean,
    private readonly callbackResult: 'SUCCESS' | 'ERROR' | 'NEVER',
  ) { super(); }

  public write(line: Buffer, callback: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(line));
    if (this.callbackResult === 'SUCCESS') queueMicrotask(() => callback(null));
    if (this.callbackResult === 'ERROR') queueMicrotask(() => callback(new Error('simulated write failure')));
    return this.writeResult;
  }

  public end(): this { this.emit('end-called'); return this; }

  public destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition did not settle');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('G10a A11.3b AF_UNIX control framing adapter', () => {
  const cleanup: Array<{ readonly directory: string; readonly listener: RuntimeControlSocketListener }> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(async ({ directory, listener }) => {
      await listener.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }));
  });

  test('waits for client EOF, then writes exactly one bounded NDJSON response and closes', async () => {
    for (const api of [publicApi, compositionApi]) {
      expect(Object.keys(api).filter((key) => /socket.*fram|fram.*socket|runtime.*control/iu.test(key))).toEqual([]);
    }
    const fixture = await setup(); cleanup.push(fixture);
    const preEof = await open(fixture.listener.socketPath);
    const early: Buffer[] = [];
    preEof.on('data', (piece: Buffer) => early.push(piece));
    preEof.write(status());
    await new Promise((resolve) => setTimeout(resolve, 50));
    // No EOF means a complete-looking JSON line still has no server response.
    expect(Buffer.concat(early)).toEqual(Buffer.alloc(0));
    preEof.destroy();

    const completed = await exchange(fixture.listener.socketPath, [status()]);
    expect(completed.ended).toBe(true);
    const response = expectExactlyOneResponseLine(completed.received);
    expect(Object.keys(response)).toEqual(['v', 'requestControlId', 'ok', 'command', 'outcome', 'revision', 'controlId', 'snapshot', 'records', 'truncated']);
    expect(response).toMatchObject({
      v: 'c1', requestControlId: request, ok: true, command: 'STATUS', outcome: 'STATUS', revision: '0',
    });
  });

  test('keeps fatal framing distinct from complete-frame JSON/DTO rejection', async () => {
    const fixture = await setup(); cleanup.push(fixture);
    const malformedJson = await exchange(fixture.listener.socketPath, [Buffer.from('{\n', 'utf8')]);
    expect(expectExactlyOneResponseLine(malformedJson.received)).toEqual({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' });

    // This is a syntactically complete frame, rather than a transport error:
    // the canonical ID survives DTO rejection and no RuntimeControl state is
    // changed merely because an extra member was supplied.
    const dtoInvalid = await exchange(fixture.listener.socketPath, [Buffer.from(`${JSON.stringify({
      v: 'c1', requestControlId: request, command: 'STATUS', epoch, run, unexpected: true,
    })}\n`, 'utf8')]);
    expect(expectExactlyOneResponseLine(dtoInvalid.received)).toEqual({
      v: 'c1', requestControlId: request, ok: false, code: 'INVALID_REQUEST',
    });

    for (const invalid of [
      Buffer.from([0xc3, 0x28, 0x0a]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}\n', 'utf8')]),
      Buffer.from('{}', 'utf8'),
      Buffer.from('{}\ntrailing', 'utf8'),
      Buffer.from('{}\n{}\n', 'utf8'),
      Buffer.alloc(4_097, 0x61),
    ]) {
      const result = await exchange(fixture.listener.socketPath, [invalid]);
      expect(result.received).toEqual(Buffer.alloc(0));
    }
    expect(fixture.control.snapshot().revision).toBe('0');
  });

  test('accepts a request split across writes at the exact byte ceiling, then releases the connection slot', async () => {
    const fixture = await setup(); cleanup.push(fixture);
    const minimum = status();
    // JSON whitespace is legal; pad before the final LF so the wire request
    // is exactly 4096 bytes, and split it at a deliberately awkward boundary.
    const padded = Buffer.concat([
      minimum.subarray(0, minimum.length - 1),
      Buffer.alloc(4_096 - minimum.length, 0x20),
      Buffer.from('\n', 'utf8'),
    ]);
    expect(padded.length).toBe(4_096);
    const response = await exchange(fixture.listener.socketPath, [padded.subarray(0, 17), padded.subarray(17)]);
    expect(expectExactlyOneResponseLine(response.received)).toMatchObject({ ok: true, outcome: 'STATUS' });

    // The preceding connection is closed by the adapter, so it must not keep
    // consuming one of the eight acquisition slots.
    const sockets = await Promise.all(Array.from({ length: 8 }, () => open(fixture.listener.socketPath)));
    const ninth = await exchange(fixture.listener.socketPath, [status()]);
    expect(ninth.received).toEqual(Buffer.alloc(0));
    for (const socket of sockets) socket.destroy();
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => socket.once('close', resolve))));
  });

  test('destroys a slow pre-EOF peer after the two-second acquisition limit with no effect', async () => {
    const fixture = await setup(); cleanup.push(fixture);
    const socket = await open(fixture.listener.socketPath);
    socket.write(status());
    const result = await new Promise<Exchange>((resolve) => {
      const received: Buffer[] = [];
      socket.on('data', (piece: Buffer) => received.push(piece));
      socket.once('close', () => resolve(Object.freeze({ received: Buffer.concat(received), ended: false, errored: false })));
    });
    expect(result.received).toEqual(Buffer.alloc(0));
    expect(fixture.control.snapshot().revision).toBe('0');
  }, 5_000);

  test('admits at most eight active pre-EOF sockets; the ninth is transport-only rejected', async () => {
    const fixture = await setup(); cleanup.push(fixture);
    const firstEight = await Promise.all(Array.from({ length: 8 }, () => open(fixture.listener.socketPath)));
    const ninth = await exchange(fixture.listener.socketPath, [status()]);
    expect(ninth.received).toEqual(Buffer.alloc(0));
    for (const socket of firstEight) socket.destroy();
    await Promise.all(firstEight.map((socket) => new Promise<void>((resolve) => socket.once('close', resolve))));
    const after = await exchange(fixture.listener.socketPath, [status()]);
    expect(expectExactlyOneResponseLine(after.received)).toMatchObject({ ok: true, outcome: 'STATUS' });
    expect(fixture.control.snapshot().revision).toBe('0');
  });

  test('destroys immediately when the one response encounters transport backpressure', async () => {
    const socket = new ControlledWriteSocket(false, 'NEVER');
    const adapter = createRuntimeControlSocketFramingAdapter(control());
    adapter.onConnection(socket as unknown as Socket);
    socket.emit('data', status());
    socket.emit('end');
    await waitUntil(() => socket.destroyed, 500);
    expect(socket.writes).toHaveLength(1);
  });

  test('destroys a response whose write completion misses the two-second deadline', async () => {
    const socket = new ControlledWriteSocket(true, 'NEVER');
    const adapter = createRuntimeControlSocketFramingAdapter(control());
    adapter.onConnection(socket as unknown as Socket);
    socket.emit('data', status());
    socket.emit('end');
    await waitUntil(() => socket.writes.length === 1, 500);
    await waitUntil(() => socket.destroyed, 2_500);
  }, 5_000);

  test('destroys when the accepted response write callback reports an error', async () => {
    const socket = new ControlledWriteSocket(true, 'ERROR');
    const adapter = createRuntimeControlSocketFramingAdapter(control());
    adapter.onConnection(socket as unknown as Socket);
    socket.emit('data', status());
    socket.emit('end');
    await waitUntil(() => socket.destroyed, 500);
    expect(socket.writes).toHaveLength(1);
  });
});
