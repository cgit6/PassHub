import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { createRuntimeControl, createRuntimeIdentityIssuer } from '../../src/runtime/internal/runtime-control.js';
import { RuntimeLogSink } from '../../src/runtime/internal/runtime-log-sink.js';
import { validateRuntimeLogRecord, type RuntimeLogRecord } from '../../src/runtime/internal/runtime-log-schema.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const holdRequest = '33333333-3333-4333-8333-333333333333';
const rejectRequest = '44444444-4444-4444-8444-444444444444';
const releaseRequest = '55555555-5555-4555-8555-555555555555';
const drainRequest = '66666666-6666-4666-8666-666666666666';
const runtimeLogKeys = [
  'schemaVersion', 'timestamp', 'kind', 'code', 'requestUUID', 'operationUUID', 'datasetEpoch', 'processRunId', 'ownerRef',
  'route', 'phase', 'round', 'group', 'budgetRemainingMs', 'budgetRemainingUnits', 'commandName', 'driverRequestId',
  'requestControlId', 'controlId', 'revision',
];

async function exchange(socketPath: string, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('control exchange timed out')); }, 2_000);
    socket.once('connect', () => socket.end(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); } catch (error) { reject(error); }
    });
  });
}

function controlRequest(requestControlId: string, command: 'STATUS' | 'HOLD' | 'RELEASE' | 'DRAIN', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 'c1', requestControlId, command, epoch, run, ...extra };
}

async function readRuntimeRecords(logDirectory: string): Promise<readonly RuntimeLogRecord[]> {
  const text = await readFile(join(logDirectory, 'runtime.log'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => {
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== 'object' || raw === null) throw new Error('runtime log line is not an object');
    expect(Object.keys(raw)).toEqual(runtimeLogKeys);
    return validateRuntimeLogRecord(raw);
  });
}

describe('G10a D184 control log producers', () => {
  const parents: string[] = [];
  afterEach(async () => { await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true }))); });

  test('writes only attributable protocol control lifecycle records to the real runtime.log and never duplicates an exact replay', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-control-log-'));
    parents.push(parent);
    const logDirectory = join(parent, 'logs');
    const controlDirectory = join(parent, 'control');
    const socketPath = join(controlDirectory, RUNTIME_CONTROL_SOCKET_FILE_NAME);
    const owner = createG10aRuntimeOwner({
      epoch, run, logDirectory, controlDirectory, controlSocketPath: socketPath,
      monotonicClock: Object.freeze({ nowMs: () => performance.now() }), awaitObservation: () => undefined,
    });
    const runtime = await owner.start();
    try {
      await expect(exchange(socketPath, controlRequest('77777777-7777-4777-8777-777777777777', 'STATUS'))).resolves.toMatchObject({ ok: true, outcome: 'STATUS' });
      await expect(exchange(socketPath, { ...controlRequest('88888888-8888-4888-8888-888888888888', 'HOLD', { expectedRevision: '0' }), extra: true }))
        .resolves.toEqual({ v: 'c1', requestControlId: '88888888-8888-4888-8888-888888888888', ok: false, code: 'INVALID_REQUEST' });
      const held = await exchange(socketPath, controlRequest(holdRequest, 'HOLD', { expectedRevision: '0' }));
      const holdControlId = held.controlId as string;
      expect(held).toMatchObject({ ok: true, outcome: 'HELD', revision: '1' });
      await expect(exchange(socketPath, controlRequest(holdRequest, 'HOLD', { expectedRevision: '0' }))).resolves.toEqual(held);
      await expect(exchange(socketPath, controlRequest(rejectRequest, 'HOLD', { expectedRevision: '1' })))
        .resolves.toEqual({ v: 'c1', requestControlId: rejectRequest, ok: false, code: 'MANUAL_HOLD_EXISTS' });
      const released = await exchange(socketPath, controlRequest(releaseRequest, 'RELEASE', { expectedRevision: '1', controlId: holdControlId }));
      expect(released).toMatchObject({ ok: true, outcome: 'RELEASED', revision: '2', controlId: holdControlId });
      await runtime.runtimeLogSink.flush();
      expect((await readRuntimeRecords(logDirectory)).filter((record) => record.code === 'RELEASE_ACKNOWLEDGED')).toHaveLength(1);
      await expect(exchange(socketPath, controlRequest(releaseRequest, 'RELEASE', { expectedRevision: '1', controlId: holdControlId }))).resolves.toEqual(released);
      await runtime.runtimeLogSink.flush();
      expect((await readRuntimeRecords(logDirectory)).filter((record) => record.code === 'RELEASE_ACKNOWLEDGED')).toHaveLength(1);
      const drained = await exchange(socketPath, controlRequest(drainRequest, 'DRAIN', { expectedRevision: '2', timeoutMs: 10 }));
      expect(drained).toMatchObject({ ok: true, outcome: 'DRAINED', revision: '3' });
      await runtime.runtimeLogSink.flush();
      expect((await readRuntimeRecords(logDirectory)).filter((record) => record.code === 'DRAIN_STARTED' || record.code === 'DRAINED')).toHaveLength(2);
      await expect(exchange(socketPath, controlRequest(drainRequest, 'DRAIN', { expectedRevision: '2', timeoutMs: 10 }))).resolves.toEqual(drained);
      await runtime.runtimeLogSink.flush();
      expect((await readRuntimeRecords(logDirectory)).filter((record) => record.code === 'DRAIN_STARTED' || record.code === 'DRAINED')).toHaveLength(2);

      const records = await readRuntimeRecords(logDirectory);
      expect(records.map((record) => record.code)).toEqual([
        'HOLD_ACKNOWLEDGED', 'CONTROL_REJECTED', 'RELEASE_ACKNOWLEDGED', 'DRAIN_STARTED', 'DRAINED',
      ]);
      expect(records.map(({ timestamp, ...record }) => record)).toEqual([
        expect.objectContaining({ kind: 'CONTROL', route: 'CONTROL', phase: 'CONTROL', requestControlId: holdRequest, controlId: holdControlId, revision: '1', requestUUID: null, operationUUID: null, ownerRef: null, round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null, commandName: null, driverRequestId: null }),
        expect.objectContaining({ kind: 'CONTROL', route: 'CONTROL', phase: 'CONTROL', requestControlId: rejectRequest, controlId: null, revision: '1', requestUUID: null, operationUUID: null, ownerRef: null, round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null, commandName: null, driverRequestId: null }),
        expect.objectContaining({ kind: 'CONTROL', route: 'CONTROL', phase: 'CONTROL', requestControlId: releaseRequest, controlId: holdControlId, revision: '2' }),
        expect.objectContaining({ kind: 'CONTROL', route: 'CONTROL', phase: 'CONTROL', requestControlId: drainRequest, controlId: drained.controlId, revision: '3' }),
        expect.objectContaining({ kind: 'CONTROL', route: 'CONTROL', phase: 'CONTROL', requestControlId: drainRequest, controlId: drained.controlId, revision: '3' }),
      ]);
      for (const record of records) expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    } finally {
      await owner.close();
    }
  });

  test('a failing best-effort sink cannot change control results or their replay', async () => {
    const sink = new RuntimeLogSink({ write: async () => { throw new Error('write failure'); } });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
      clock: Object.freeze({ nowMs: () => 0 }), awaitObservation: () => undefined, runtimeLogSink: sink,
    });
    const held = control.hold({ requestControlId: holdRequest, epoch, run, expectedRevision: '0' });
    expect(held).toMatchObject({ outcome: 'HELD', revision: '1' });
    expect(control.hold({ requestControlId: holdRequest, epoch, run, expectedRevision: '0' })).toBe(held);
    await sink.flush();
    expect(sink.snapshot()).toMatchObject({ status: 'LOGGING_DEGRADED', droppedCount: 1 });
    expect(control.snapshot()).toMatchObject({ revision: '1', phase: 'MANUAL_HOLD', logging: { status: 'LOGGING_DEGRADED', droppedCount: 1 } });
  });

  test('a true socket DRAIN with an outstanding persistence lease writes DRAIN_NOT_DRAINED once and replays without a second pair', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-control-not-drained-'));
    parents.push(parent);
    const logDirectory = join(parent, 'logs');
    const controlDirectory = join(parent, 'control');
    const socketPath = join(controlDirectory, RUNTIME_CONTROL_SOCKET_FILE_NAME);
    let now = 0;
    const owner = createG10aRuntimeOwner({
      epoch, run, logDirectory, controlDirectory, controlSocketPath: socketPath,
      monotonicClock: Object.freeze({ nowMs: () => now }), awaitObservation: () => { now = 2; },
    });
    const runtime = await owner.start();
    const lease = runtime.control.acquireIssuedPersistence();
    try {
      const result = await exchange(socketPath, controlRequest(drainRequest, 'DRAIN', { expectedRevision: '0', timeoutMs: 1 }));
      expect(result).toMatchObject({ ok: true, outcome: 'NOT_DRAINED', revision: '1' });
      await runtime.runtimeLogSink.flush();
      expect((await readRuntimeRecords(logDirectory)).map((record) => record.code)).toEqual(['DRAIN_STARTED', 'DRAIN_NOT_DRAINED']);
      await expect(exchange(socketPath, controlRequest(drainRequest, 'DRAIN', { expectedRevision: '0', timeoutMs: 1 }))).resolves.toEqual(result);
      await runtime.runtimeLogSink.flush();
      expect((await readRuntimeRecords(logDirectory)).map((record) => record.code)).toEqual(['DRAIN_STARTED', 'DRAIN_NOT_DRAINED']);
    } finally {
      lease.release();
      await owner.close();
    }
  });

  test('records the schema-specific DRAIN_NOT_DRAINED terminal when its accepted drain reaches its deadline', async () => {
    const lines: string[] = [];
    let now = 0;
    const sink = new RuntimeLogSink({ write: async (line) => { lines.push(line); } });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
      clock: Object.freeze({ nowMs: () => now }), awaitObservation: () => { now = 2; }, runtimeLogSink: sink,
    });
    const lease = control.acquireIssuedPersistence();
    const result = await control.drain({ requestControlId: drainRequest, epoch, run, expectedRevision: '0', timeoutMs: 1 });
    expect(result).toMatchObject({ outcome: 'NOT_DRAINED', revision: '1' });
    lease.release();
    await sink.flush();
    expect(lines.map((line) => (JSON.parse(line) as RuntimeLogRecord).code)).toEqual(['DRAIN_STARTED', 'DRAIN_NOT_DRAINED']);
  });

  test('keeps an accepted INTERNAL_UNAVAILABLE drain at DRAIN_STARTED because the closed schema has no truthful terminal code', async () => {
    const lines: string[] = [];
    const sink = new RuntimeLogSink({ write: async (line) => { lines.push(line); } });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
      clock: Object.freeze({ nowMs: () => 0 }), awaitObservation: () => undefined, runtimeLogSink: sink,
    });
    control.bindMaintenanceReadySettlement(() => { throw new Error('injected lifecycle failure'); });
    await expect(control.drain({ requestControlId: drainRequest, epoch, run, expectedRevision: '0', timeoutMs: 1 }))
      .resolves.toMatchObject({ outcome: 'INTERNAL_UNAVAILABLE', revision: '1' });
    await sink.flush();
    expect(lines.map((line) => (JSON.parse(line) as RuntimeLogRecord).code)).toEqual(['DRAIN_STARTED']);
  });
});
