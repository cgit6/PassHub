import {
  createRuntimeControl,
  createRuntimeIdentityIssuer,
} from '../../src/runtime/internal/runtime-control.js';
import { RuntimeLogSink } from '../../src/runtime/internal/runtime-log-sink.js';
import {
  RUNTIME_LOG_SCHEMA_VERSION,
  createRuntimeLogRecord,
} from '../../src/runtime/internal/runtime-log-schema.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const requestControlId = '33333333-3333-4333-8333-333333333333';
const nextControlId = '44444444-4444-4444-8444-444444444444';
const followingControlId = '66666666-6666-4666-8666-666666666666';

function validRecord() {
  return createRuntimeLogRecord({
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION,
    timestamp: '2026-09-28T00:00:00.000Z',
    kind: 'RUNTIME', code: 'REQUEST_ACCEPTED',
    requestUUID: '55555555-5555-4555-8555-555555555555',
    operationUUID: null, datasetEpoch: epoch, processRunId: run, ownerRef: null,
    route: 'QUERY', phase: 'INGRESS', round: null, group: null,
    budgetRemainingMs: null, budgetRemainingUnits: null, commandName: null,
    driverRequestId: null, requestControlId: null, controlId: null, revision: null,
  });
}

describe('G10a A10.3 runtime log health black-box behavior', () => {
  test('a real driver failure updates only fresh logging snapshots; a cached snapshot and hold semantics remain intact', async () => {
    const sink = new RuntimeLogSink({ write: async () => { throw new Error('intentionally opaque'); } });
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: issuer,
      clock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      controlIdFactory: (() => {
        let calls = 0;
        return () => (calls++ === 0 ? nextControlId : followingControlId);
      })(),
      runtimeLogSink: sink,
    });

    const before = control.snapshot();
    expect(before.logging).toEqual({ status: 'HEALTHY', droppedCount: 0 });
    expect(sink.append(validRecord())).toBe(true);
    await sink.flush();

    // The snapshot object already returned must be a closed, immutable view.
    expect(before.logging).toEqual({ status: 'HEALTHY', droppedCount: 0 });
    expect(Object.isFrozen(before.logging)).toBe(true);

    // The next control mutation still succeeds and receives a fresh health view.
    const held = control.hold({ requestControlId, epoch, run, expectedRevision: '0' });
    expect(held.outcome).toBe('HELD');
    expect(held.revision).toBe('1');
    expect(held.snapshot.logging).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1 });
    expect(control.snapshot().logging).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1 });
  });

  test('forged and proxy log sources are rejected before they can influence a control', () => {
    const options = {
      epoch, run,
      identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
      clock: { nowMs: () => 0 }, awaitObservation: () => undefined,
    } as const;
    const forged = Object.freeze({ snapshot: () => ({ status: 'HEALTHY', droppedCount: 0, waiting: 0, writing: false, closed: false }) });
    expect(() => createRuntimeControl({ ...options, runtimeLogSink: forged as never })).toThrow('runtime log sink is not trusted');

    const real = new RuntimeLogSink({ write: async () => undefined });
    const proxy = new Proxy(real, {});
    expect(() => createRuntimeControl({ ...options, runtimeLogSink: proxy as never })).toThrow('runtime log sink is not trusted');
  });
});
