import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeControlSocketService } from '../../src/runtime/internal/runtime-control-socket-service.js';
import { createRuntimeLogFileStore } from '../../src/runtime/internal/runtime-log-file-store.js';
import {
  RUNTIME_LOG_SCHEMA_VERSION,
  createRuntimeLogRecord,
  type RuntimeLogRecord,
} from '../../src/runtime/internal/runtime-log-schema.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { createRuntimeControl, createRuntimeIdentityIssuer, type RuntimeControl } from '../../src/runtime/internal/runtime-control.js';
import * as publicApi from '../../src/index.js';
import * as compositionApi from '../../src/composition/index.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const operation = '77777777-7777-4777-8777-777777777777';

function operationRecord(second: number): RuntimeLogRecord {
  return createRuntimeLogRecord({
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION,
    timestamp: `2026-09-28T00:00:0${second}.000Z`, kind: 'RUNTIME', code: 'OPERATION_REGISTERED',
    requestUUID: '88888888-8888-4888-8888-888888888888', operationUUID: operation,
    datasetEpoch: epoch, processRunId: run, ownerRef: '99999999-9999-4999-8999-999999999999',
    route: 'RECOGNITION', phase: 'ADMISSION', round: null, group: null,
    budgetRemainingMs: null, budgetRemainingUnits: null, commandName: null,
    driverRequestId: null, requestControlId: null, controlId: null, revision: null,
  });
}

function control(
  awaitObservation: (remainingMs: number) => PromiseLike<void> | void = () => undefined,
  nowMs: () => number = () => performance.now(),
): RuntimeControl {
  return createRuntimeControl({
    epoch,
    run,
    identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
    clock: Object.freeze({ nowMs }),
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
    // Freeze the *business* monotonic clock.  This test is specifically about
    // the transport's post-mutation watchdog; a real 1ms business deadline
    // races the event loop when the unit tier is parallel and can legitimately
    // yield NOT_DRAINED before that watchdog fires.  Keeping the business
    // clock at zero makes this a deterministic watchdog-only scenario.
    const instance = control(() => lateObservation, () => 0);
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

  test('serves LOGS_READ through the injected private reader, without epoch/run or replay state', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    const logs = await createRuntimeLogFileStore({ directory: join(parent, 'logs') });
    expect(logs.store).not.toBeNull();
    for (const second of [1, 2, 3]) expect(logs.sink.append(operationRecord(second))).toBe(true);
    await logs.sink.flush();
    const instance = control();
    const service = await createRuntimeControlSocketService({
      control: instance, directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME), logReader: logs.store!,
    });
    cleanups.push({ parent, close: () => service.close() });

    const response = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation, limit: 2,
    }));
    expect(response).toMatchObject({
      v: 'c1', requestControlId: request, ok: true, command: 'LOGS_READ', outcome: 'LOGS_READ',
      revision: '0', controlId: null, snapshot: null, truncated: true,
    });
    expect(response.records).toEqual([
      expect.objectContaining({ timestamp: '2026-09-28T00:00:02.000Z', operationUUID: operation }),
      expect.objectContaining({ timestamp: '2026-09-28T00:00:03.000Z', operationUUID: operation }),
    ]);
    // LOGS_READ does not consume a control replay slot or change revision.
    expect(instance.snapshot().revision).toBe('0');
    const defaulted = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', command: 'LOGS_READ', operationUUID: operation,
    }));
    expect(defaulted).toMatchObject({ ok: true, outcome: 'LOGS_READ', truncated: false });
    expect(defaulted.records).toHaveLength(3);
  });

  test('maps missing or failed readers to LOG_READ_UNAVAILABLE with no partial result', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    const missing = await createRuntimeControlSocketService({
      control: control(), directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
    });
    cleanups.push({ parent, close: () => missing.close() });
    const payload = { v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation };
    await expect(exchange(missing.socketPath, line(payload))).resolves.toEqual({
      v: 'c1', requestControlId: request, ok: false, code: 'LOG_READ_UNAVAILABLE',
    });
    await missing.close();

    const secondParent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const secondDirectory = join(secondParent, 'control');
    const failing = await createRuntimeControlSocketService({
      control: control(), directory: secondDirectory, socketPath: join(secondDirectory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
      logReader: { readOperation: async () => { throw new Error('disk unavailable'); } },
    });
    cleanups.push({ parent: secondParent, close: () => failing.close() });
    await expect(exchange(failing.socketPath, line(payload))).resolves.toEqual({
      v: 'c1', requestControlId: request, ok: false, code: 'LOG_READ_UNAVAILABLE',
    });
  });

  test('fails closed when a private reader returns malformed or cross-operation records, without a partial result', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    const malformed = await createRuntimeControlSocketService({
      control: control(), directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
      logReader: { readOperation: async () => ({ records: [{ operationUUID: operation } as RuntimeLogRecord], truncated: false }) },
    });
    cleanups.push({ parent, close: () => malformed.close() });
    const payload = { v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation };
    await expect(exchange(malformed.socketPath, line(payload))).resolves.toEqual({
      v: 'c1', requestControlId: request, ok: false, code: 'LOG_READ_UNAVAILABLE',
    });
    await malformed.close();

    const otherParent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const otherDirectory = join(otherParent, 'control');
    const crossOperation = await createRuntimeControlSocketService({
      control: control(), directory: otherDirectory, socketPath: join(otherDirectory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
      logReader: { readOperation: async () => ({ records: [operationRecord(1), {
        ...operationRecord(2), operationUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownerRef: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }], truncated: false }) },
    });
    cleanups.push({ parent: otherParent, close: () => crossOperation.close() });
    await expect(exchange(crossOperation.socketPath, line(payload))).resolves.toEqual({
      v: 'c1', requestControlId: request, ok: false, code: 'LOG_READ_UNAVAILABLE',
    });
  });

  test('returns only LOG_READ_UNAVAILABLE at the real socket when a later log record is a hostile Proxy', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    // The first record is valid on purpose: a bad later record must not let
    // the transport serialize a partial LOGS_READ success.  The Proxy's get
    // trap would throw if the protocol tried to inspect/serialize it; the
    // capture boundary must reject the proxy itself first.
    const hostileRecord = new Proxy(operationRecord(2), {
      get: () => { throw new Error('hostile runtime-log getter'); },
    });
    const service = await createRuntimeControlSocketService({
      control: control(), directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
      logReader: {
        readOperation: async () => ({
          records: [operationRecord(1), hostileRecord as unknown as RuntimeLogRecord],
          truncated: false,
        }),
      },
    });
    cleanups.push({ parent, close: () => service.close() });

    await expect(exchange(service.socketPath, line({
      v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation,
    }))).resolves.toEqual({
      v: 'c1', requestControlId: request, ok: false, code: 'LOG_READ_UNAVAILABLE',
    });
  });

  test('fails closed at the real socket when a reader returns a non-capturable result graph', async () => {
    const payload = { v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation };
    const accessor = {} as { readonly records?: readonly RuntimeLogRecord[]; readonly truncated: boolean };
    Object.defineProperty(accessor, 'records', { enumerable: true, get: () => [operationRecord(1)] });
    Object.defineProperty(accessor, 'truncated', { enumerable: true, value: false });
    const inherited = Object.create({ records: [operationRecord(1)], truncated: false }) as object;
    const sparse = [operationRecord(1), ,] as readonly RuntimeLogRecord[];
    const proxy = new Proxy({ records: [operationRecord(1)], truncated: false }, {});
    const proxyArray = new Proxy([operationRecord(1)], {});
    const extra = { records: [operationRecord(1)], truncated: false, unexpected: true };
    const invalidResults: readonly unknown[] = [extra, accessor, inherited, { records: sparse, truncated: false }, proxy, { records: proxyArray, truncated: false }];

    for (const [index, result] of invalidResults.entries()) {
      const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
      const directory = join(parent, 'control');
      const service = await createRuntimeControlSocketService({
        control: control(), directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
        logReader: { readOperation: async () => result as { readonly records: readonly RuntimeLogRecord[]; readonly truncated: boolean } },
      });
      cleanups.push({ parent, close: () => service.close() });
      await expect(exchange(service.socketPath, line({ ...payload, requestControlId: `33333333-3333-4333-8333-43333333333${index}` })))
        .resolves.toEqual({
          v: 'c1', requestControlId: `33333333-3333-4333-8333-43333333333${index}`, ok: false, code: 'LOG_READ_UNAVAILABLE',
        });
    }
  });

  test('requires the closed LOGS_READ wire shape and keeps epoch/run outside that command', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    const service = await createRuntimeControlSocketService({
      control: control(), directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
    });
    cleanups.push({ parent, close: () => service.close() });
    for (const payload of [
      { v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation, epoch, run },
      { v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation, limit: 0 },
      { v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    ]) {
      await expect(exchange(service.socketPath, line(payload))).resolves.toEqual({
        v: 'c1', requestControlId: request, ok: false, code: 'INVALID_REQUEST',
      });
    }
  });

  test('captures LOGS_READ revision at dispatch even if a later control mutation completes first', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    let started!: () => void;
    const startedRead = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: { readonly records: readonly RuntimeLogRecord[]; readonly truncated: boolean }) => void;
    const pendingRead = new Promise<{ readonly records: readonly RuntimeLogRecord[]; readonly truncated: boolean }>((resolve) => { finish = resolve; });
    const instance = control();
    const service = await createRuntimeControlSocketService({
      control: instance, directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
      logReader: { readOperation: async () => { started(); return pendingRead; } },
    });
    cleanups.push({ parent, close: () => service.close() });

    const logsResponse = exchange(service.socketPath, line({
      v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation,
    }));
    await startedRead;
    const held = await exchange(service.socketPath, line({
      v: 'c1', requestControlId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', command: 'HOLD', epoch, run, expectedRevision: '0',
    }));
    expect(held).toMatchObject({ ok: true, outcome: 'HELD', revision: '1' });
    finish({ records: [], truncated: false });
    await expect(logsResponse).resolves.toMatchObject({ ok: true, outcome: 'LOGS_READ', revision: '0', records: [] });
  });

  test('aborts a controllable LOGS_READ after the two-second processing watchdog without a late response', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    let aborted = false;
    const service = await createRuntimeControlSocketService({
      control: control(), directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
      logReader: {
        readOperation: ({ signal }) => new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
          // Deliberately never resolve first: the watchdog owns completion.
          void resolve;
        }),
      },
    });
    cleanups.push({ parent, close: () => service.close() });
    await expect(exchange(service.socketPath, line({
      v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation,
    }))).resolves.toEqual({ v: 'c1', requestControlId: request, ok: false, code: 'LOG_READ_UNAVAILABLE' });
    expect(aborted).toBe(true);
  }, 6_000);

  test('returns the watchdog terminal even when an injected reader ignores abort, and ignores its late settlement', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-service-'));
    const directory = join(parent, 'control');
    let finish!: (value: { readonly records: readonly RuntimeLogRecord[]; readonly truncated: boolean }) => void;
    const late = new Promise<{ readonly records: readonly RuntimeLogRecord[]; readonly truncated: boolean }>((resolve) => { finish = resolve; });
    const service = await createRuntimeControlSocketService({
      control: control(), directory, socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
      logReader: { readOperation: async () => late },
    });
    cleanups.push({ parent, close: () => service.close() });
    await expect(exchange(service.socketPath, line({
      v: 'c1', requestControlId: request, command: 'LOGS_READ', operationUUID: operation,
    }))).resolves.toEqual({ v: 'c1', requestControlId: request, ok: false, code: 'LOG_READ_UNAVAILABLE' });
    // The transport has already written and closed its sole response.  A late
    // reader completion is observed but cannot emit another response.
    finish({ records: [], truncated: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }, 6_000);
});
