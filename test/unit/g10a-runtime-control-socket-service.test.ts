import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeControlSocketService } from '../../src/runtime/internal/runtime-control-socket-service.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { createRuntimeControl, createRuntimeIdentityIssuer, type RuntimeControl } from '../../src/runtime/internal/runtime-control.js';
import * as publicApi from '../../src/index.js';
import * as compositionApi from '../../src/composition/index.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';

function control(awaitObservation: (remainingMs: number) => PromiseLike<void> | void = () => undefined): RuntimeControl {
  return createRuntimeControl({
    epoch,
    run,
    identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
    clock: Object.freeze({ nowMs: () => performance.now() }),
    awaitObservation,
    controlIdFactory: randomUUID,
  });
}

function line(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

async function exchange(socketPath: string, requestLine: Buffer): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('socket exchange timed out')); }, 5_000);
    socket.once('connect', () => socket.end(requestLine));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('close', () => {
      clearTimeout(timer);
      const received = Buffer.concat(chunks);
      try {
        expect(received[received.length - 1]).toBe(0x0a);
        expect(received.indexOf(0x0a)).toBe(received.length - 1);
        resolve(JSON.parse(received.toString('utf8')) as Record<string, unknown>);
      } catch (error) { reject(error); }
    });
  });
}

describe('G10a A11.4 private runtime-control service composition', () => {
  const cleanups: Array<{ readonly parent: string; readonly close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async ({ parent, close }) => {
      await close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }));
  });

  test('wires trusted control, strict AF_UNIX listener, framing, and protocol without public export', async () => {
    for (const api of [publicApi, compositionApi]) {
      expect(Object.keys(api).filter((key) => /runtime.*control.*service|control.*socket/iu.test(key))).toEqual([]);
    }
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    const instance = control();
    const service = await createRuntimeControlSocketService({
      control: instance,
      directory,
      socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
    });
    cleanups.push({ parent, close: () => service.close() });

    await expect(exchange(service.socketPath, line({ v: 'c1', requestControlId: request, command: 'STATUS', epoch, run })))
      .resolves.toMatchObject({ ok: true, command: 'STATUS', outcome: 'STATUS', revision: '0' });
    await expect(exchange(service.socketPath, line({ v: 'c1', requestControlId: request, command: 'HOLD', epoch, run, expectedRevision: '0' })))
      .resolves.toMatchObject({ ok: true, command: 'HOLD', outcome: 'HELD', revision: '1' });
  });

  test('executes STATUS, HOLD, RELEASE, and DRAIN as separate one-request AF_UNIX exchanges', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    const instance = control();
    const service = await createRuntimeControlSocketService({
      control: instance,
      directory,
      socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
    });
    cleanups.push({ parent, close: () => service.close() });

    const status = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: '33333333-3333-4333-8333-433333333333', command: 'STATUS', epoch, run,
    }));
    expect(status).toMatchObject({ ok: true, command: 'STATUS', outcome: 'STATUS', revision: '0', controlId: null });

    const held = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: '44444444-4444-4444-8444-444444444444', command: 'HOLD', epoch, run, expectedRevision: '0',
    }));
    expect(held).toMatchObject({ ok: true, command: 'HOLD', outcome: 'HELD', revision: '1' });
    expect(typeof held.controlId).toBe('string');

    const released = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: '55555555-5555-4555-8555-555555555555', command: 'RELEASE', epoch, run,
      expectedRevision: '1', controlId: held.controlId,
    }));
    expect(released).toMatchObject({ ok: true, command: 'RELEASE', outcome: 'RELEASED', revision: '2', controlId: held.controlId });

    const drained = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: '66666666-6666-4666-8666-666666666666', command: 'DRAIN', epoch, run,
      expectedRevision: '2', timeoutMs: 30_000,
    }));
    expect(drained).toMatchObject({ ok: true, command: 'DRAIN', outcome: 'DRAINED', revision: '3' });
    expect(instance.snapshot()).toMatchObject({ phase: 'MAINTENANCE_HELD', maintenance: { active: true, outcome: 'DRAINED' } });
  });

  test('does not create a processing watchdog or observation for real socket STATUS/HOLD/RELEASE exchanges', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    let observationCalls = 0;
    const instance = control(() => { observationCalls += 1; return Promise.resolve(); });
    const service = await createRuntimeControlSocketService({
      control: instance,
      directory,
      socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
    });
    cleanups.push({ parent, close: () => service.close() });

    const status = await exchange(service.socketPath, line({ v: 'c1', requestControlId: request, command: 'STATUS', epoch, run }));
    expect(status).toMatchObject({ ok: true, command: 'STATUS', outcome: 'STATUS' });
    const held = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: '44444444-4444-4444-8444-444444444444', command: 'HOLD', epoch, run, expectedRevision: '0',
    }));
    expect(held).toMatchObject({ ok: true, command: 'HOLD', outcome: 'HELD' });
    const released = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: '55555555-5555-4555-8555-555555555555', command: 'RELEASE', epoch, run,
      expectedRevision: '1', controlId: held.controlId,
    }));
    expect(released).toMatchObject({ ok: true, command: 'RELEASE', outcome: 'RELEASED' });
    expect(observationCalls).toBe(0);
  });

  test('converts a post-mutation DRAIN watchdog expiry into a cached unavailable terminal without rollback', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    let releaseLateObservation!: () => void;
    const lateObservation = new Promise<void>((resolve) => { releaseLateObservation = resolve; });
    const instance = control(() => lateObservation);
    const issued = instance.acquireIssuedPersistence();
    const service = await createRuntimeControlSocketService({
      control: instance,
      directory,
      socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
    });
    cleanups.push({ parent, close: () => service.close() });
    const drain = { v: 'c1', requestControlId: request, command: 'DRAIN', epoch, run, expectedRevision: '0', timeoutMs: 1 };

    await expect(exchange(service.socketPath, line(drain)))
      .resolves.toEqual({ v: 'c1', requestControlId: request, ok: false, code: 'INTERNAL_UNAVAILABLE' });
    expect(instance.snapshot()).toMatchObject({
      revision: '1',
      phase: 'MAINTENANCE_HELD',
      maintenance: { active: true, outcome: 'INTERNAL_UNAVAILABLE' },
      issuedPersistence: 1,
    });
    // Exact replay must retain the same terminal rather than opening another
    // transition or rolling the maintenance veto back.
    await expect(exchange(service.socketPath, line(drain)))
      .resolves.toEqual({ v: 'c1', requestControlId: request, ok: false, code: 'INTERNAL_UNAVAILABLE' });
    issued.release();
    // The original observation task is deliberately allowed to settle only
    // after the socket watchdog has replied.  It must not replace the cached
    // terminal or mutate the already-established maintenance state.
    releaseLateObservation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(instance.snapshot().maintenance.outcome).toBe('INTERNAL_UNAVAILABLE');
  }, 8_000);
});
