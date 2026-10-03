import {
  createG11cMaintenanceLifecycle,
  mintG11cMaintenanceMarker,
  type G11cDrainOutcome,
} from '../../src/deployment/internal/g11c-maintenance-lifecycle-engine.js';

describe('G11c maintenance lifecycle sequencing', () => {
  test('rejects an invalid drain timeout before invoking any effect', () => {
    const lifecycle = createG11cMaintenanceLifecycle();
    const input = {
      acquirePersistentMarker: async () => { throw new Error('must not run'); },
      drainPrivateRuntime: async () => 'DRAINED' as const,
      requestApiStop: async () => undefined, awaitApiProcessGone: async () => undefined,
      requestMongoStop: async () => undefined, awaitMongoProcessGone: async () => undefined,
      awaitMongoPrimary: async () => undefined, verifyNoLateWork: async () => undefined,
    };
    expect(() => lifecycle.run(input, 30_001)).toThrow(RangeError);
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'NEW', marker: null, drain: null, failure: null });
  });

  test('marker acquisition failure stops before drain and leaves no false process claims', async () => {
    const calls = {
      acquirePersistentMarker: jest.fn(async () => { throw new Error('marker unavailable'); }),
      drainPrivateRuntime: jest.fn(async () => 'DRAINED' as const),
      requestApiStop: jest.fn(async () => undefined), awaitApiProcessGone: jest.fn(async () => undefined),
      requestMongoStop: jest.fn(async () => undefined), awaitMongoProcessGone: jest.fn(async () => undefined),
      awaitMongoPrimary: jest.fn(async () => undefined), verifyNoLateWork: jest.fn(async () => undefined),
    };
    const result = await createG11cMaintenanceLifecycle().run(calls, 30_000);
    expect(result).toMatchObject({ phase: 'FAILED', failure: 'MARKER_ACQUIRE_FAILED', marker: null });
    expect(calls.drainPrivateRuntime).not.toHaveBeenCalled();
    expect(calls.requestApiStop).not.toHaveBeenCalled();
  });

  test('all later phases execute in order after a real opaque marker is acquired', async () => {
    const order: string[] = [];
    const calls = {
      acquirePersistentMarker: jest.fn(async () => { order.push('MARKER'); return mintG11cMaintenanceMarker(); }),
      drainPrivateRuntime: jest.fn(async () => { order.push('DRAIN'); return 'DRAINED' as const; }),
      requestApiStop: jest.fn(async () => { order.push('API_STOP'); }),
      awaitApiProcessGone: jest.fn(async () => { order.push('API_GONE'); }),
      requestMongoStop: jest.fn(async () => { order.push('MONGO_STOP'); }),
      awaitMongoProcessGone: jest.fn(async () => { order.push('MONGO_GONE'); }),
      awaitMongoPrimary: jest.fn(async () => { order.push('MONGO_PRIMARY'); }),
      verifyNoLateWork: jest.fn(async () => { order.push('NO_LATE'); }),
    };
    const result = await createG11cMaintenanceLifecycle().run(calls, 1_000);
    expect(result).toMatchObject({ phase: 'NO_LATE_WORK_VERIFIED', failure: null, drain: 'DRAINED' });
    expect(order).toEqual(['MARKER', 'DRAIN', 'API_STOP', 'API_GONE', 'MONGO_STOP', 'MONGO_GONE', 'MONGO_PRIMARY', 'NO_LATE']);
    expect(calls.drainPrivateRuntime).toHaveBeenCalledWith(1_000);
  });

  test('a drain timeout is recorded and process isolation still runs, but result cannot pass', async () => {
    const order: string[] = [];
    const calls = {
      acquirePersistentMarker: async () => mintG11cMaintenanceMarker(),
      drainPrivateRuntime: async () => { order.push('DRAIN'); return 'NOT_DRAINED' as const; },
      requestApiStop: async () => { order.push('API_STOP'); }, awaitApiProcessGone: async () => { order.push('API_GONE'); },
      requestMongoStop: async () => { order.push('MONGO_STOP'); }, awaitMongoProcessGone: async () => { order.push('MONGO_GONE'); },
      awaitMongoPrimary: async () => { order.push('MONGO_PRIMARY'); }, verifyNoLateWork: async () => { order.push('NO_LATE'); },
    };
    const result = await createG11cMaintenanceLifecycle().run(calls, 30_000);
    expect(result).toMatchObject({ phase: 'NO_LATE_WORK_VERIFIED', failure: 'DRAIN_UNAVAILABLE', drain: 'NOT_DRAINED' });
    expect(order).toEqual(['DRAIN', 'API_STOP', 'API_GONE', 'MONGO_STOP', 'MONGO_GONE', 'MONGO_PRIMARY', 'NO_LATE']);
  });

  test('a drain transport throw becomes INTERNAL_UNAVAILABLE and still isolates both processes', async () => {
    const order: string[] = [];
    const calls = {
      acquirePersistentMarker: async () => mintG11cMaintenanceMarker(),
      drainPrivateRuntime: async () => { order.push('DRAIN'); throw new Error('socket unavailable'); },
      requestApiStop: async () => { order.push('API_STOP'); }, awaitApiProcessGone: async () => { order.push('API_GONE'); },
      requestMongoStop: async () => { order.push('MONGO_STOP'); }, awaitMongoProcessGone: async () => { order.push('MONGO_GONE'); },
      awaitMongoPrimary: async () => { order.push('MONGO_PRIMARY'); }, verifyNoLateWork: async () => { order.push('NO_LATE'); },
    };
    const result = await createG11cMaintenanceLifecycle().run(calls, 1_000);
    expect(result).toMatchObject({ phase: 'NO_LATE_WORK_VERIFIED', drain: 'INTERNAL_UNAVAILABLE', failure: 'DRAIN_UNAVAILABLE' });
    expect(order).toEqual(['DRAIN', 'API_STOP', 'API_GONE', 'MONGO_STOP', 'MONGO_GONE', 'MONGO_PRIMARY', 'NO_LATE']);
  });

  test('process disappearance, not stop request, advances each isolation phase', async () => {
    let lifecycle!: ReturnType<typeof createG11cMaintenanceLifecycle>;
    let apiStopPhase!: string;
    let apiGonePhase!: string;
    let mongoStopPhase!: string;
    let mongoGonePhase!: string;
    const calls = {
      acquirePersistentMarker: async () => mintG11cMaintenanceMarker(),
      drainPrivateRuntime: async () => 'DRAINED' as const,
      requestApiStop: async () => { apiStopPhase = lifecycle.snapshot().phase; },
      awaitApiProcessGone: async () => { apiGonePhase = lifecycle.snapshot().phase; },
      requestMongoStop: async () => { mongoStopPhase = lifecycle.snapshot().phase; },
      awaitMongoProcessGone: async () => { mongoGonePhase = lifecycle.snapshot().phase; },
      awaitMongoPrimary: async () => undefined, verifyNoLateWork: async () => undefined,
    };
    lifecycle = createG11cMaintenanceLifecycle();
    await lifecycle.run(calls, 1_000);
    expect(apiStopPhase).toBe('API_STOPPING');
    expect(apiGonePhase).toBe('API_DISAPPEARANCE_WAITING');
    expect(mongoStopPhase).toBe('MONGO_STOPPING');
    expect(mongoGonePhase).toBe('MONGO_DISAPPEARANCE_WAITING');
    expect(lifecycle.snapshot().phase).toBe('NO_LATE_WORK_VERIFIED');
  });

  test.each([
    ['API stop', 'API_STOP', 'API_STOP_FAILED'],
    ['API disappearance', 'API_GONE', 'API_DISAPPEARANCE_UNCONFIRMED'],
    ['Mongo stop', 'MONGO_STOP', 'MONGO_STOP_FAILED'],
    ['Mongo disappearance', 'MONGO_GONE', 'MONGO_DISAPPEARANCE_UNCONFIRMED'],
    ['Mongo recovery', 'MONGO_PRIMARY', 'MONGO_RECOVERY_FAILED'],
    ['no-late-work', 'NO_LATE', 'NO_LATE_WORK_UNCONFIRMED'],
  ])('%s failure prevents every later phase', async (_label, failingStep, expected) => {
    const order: string[] = [];
    const fail = (step: string) => async () => { order.push(step); if (step === failingStep) throw new Error('failure'); };
    const calls = {
      acquirePersistentMarker: async () => mintG11cMaintenanceMarker(),
      drainPrivateRuntime: fail('DRAIN') as unknown as () => Promise<G11cDrainOutcome>,
      requestApiStop: fail('API_STOP'), awaitApiProcessGone: fail('API_GONE'), requestMongoStop: fail('MONGO_STOP'),
      awaitMongoProcessGone: fail('MONGO_GONE'), awaitMongoPrimary: fail('MONGO_PRIMARY'), verifyNoLateWork: fail('NO_LATE'),
    };
    // Replace the ordinary drain failure fixture with a successful drain.
    calls.drainPrivateRuntime = async () => { order.push('DRAIN'); return 'DRAINED'; };
    const result = await createG11cMaintenanceLifecycle().run(calls, 1_000);
    expect(result.failure).toBe(expected);
    const index = order.indexOf(failingStep);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(order.slice(index + 1)).toEqual([]);
  });

  test('run is one-shot and a concurrent caller observes the same result', async () => {
    let resolveMarker!: (marker: ReturnType<typeof mintG11cMaintenanceMarker>) => void;
    const markerPromise = new Promise<ReturnType<typeof mintG11cMaintenanceMarker>>((resolve) => { resolveMarker = resolve; });
    const calls = {
      acquirePersistentMarker: async () => markerPromise,
      drainPrivateRuntime: async () => 'DRAINED' as const, requestApiStop: async () => undefined,
      awaitApiProcessGone: async () => undefined, requestMongoStop: async () => undefined,
      awaitMongoProcessGone: async () => undefined, awaitMongoPrimary: async () => undefined,
      verifyNoLateWork: async () => undefined,
    };
    const lifecycle = createG11cMaintenanceLifecycle();
    const first = lifecycle.run(calls, 1_000);
    const second = lifecycle.run(calls, 1_000);
    expect(first).toBe(second);
    resolveMarker(mintG11cMaintenanceMarker());
    await expect(first).resolves.toMatchObject({ phase: 'NO_LATE_WORK_VERIFIED' });
    expect(lifecycle.snapshot().phase).toBe('NO_LATE_WORK_VERIFIED');
  });

  test('synchronous adapter re-entry observes the already-published run promise', async () => {
    let lifecycle!: ReturnType<typeof createG11cMaintenanceLifecycle>;
    let nested!: Promise<unknown>;
    const calls = {
      acquirePersistentMarker: async () => {
        nested = lifecycle.run({
          acquirePersistentMarker: async () => mintG11cMaintenanceMarker(),
          drainPrivateRuntime: async () => 'DRAINED' as const, requestApiStop: async () => undefined,
          awaitApiProcessGone: async () => undefined, requestMongoStop: async () => undefined,
          awaitMongoProcessGone: async () => undefined, awaitMongoPrimary: async () => undefined,
          verifyNoLateWork: async () => undefined,
        }, 1_000);
        return mintG11cMaintenanceMarker();
      },
      drainPrivateRuntime: async () => 'DRAINED' as const, requestApiStop: async () => undefined,
      awaitApiProcessGone: async () => undefined, requestMongoStop: async () => undefined,
      awaitMongoProcessGone: async () => undefined, awaitMongoPrimary: async () => undefined,
      verifyNoLateWork: async () => undefined,
    };
    lifecycle = createG11cMaintenanceLifecycle();
    const first = lifecycle.run(calls, 1_000);
    expect(nested).toBe(first);
    await expect(first).resolves.toMatchObject({ phase: 'NO_LATE_WORK_VERIFIED' });
  });
});
