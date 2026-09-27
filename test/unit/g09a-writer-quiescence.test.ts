import {
  createWriteOperationCoordinatorBundle,
  type TrustedWriteExecutor,
  type WriteOperationLifecycleObserver,
  type WriteOperationRegistrationReceipt,
} from '../../src/access/application/internal/write-operation-coordinator.js';
import { createWriterQuiescence } from '../../src/composition/internal/index.js';

const receipt = (operationId: string): WriteOperationRegistrationReceipt => Object.freeze({
  operationId, receivedAtMs: 1_000, registeredAtMonotonicMs: 2, sequence: 0n,
});

const persisted: TrustedWriteExecutor<string, string> = (input, _context, settlement) => {
  settlement.businessResultPersisted(input);
};

function executors(recognition: TrustedWriteExecutor<string, string> = persisted) {
  return { managementCreate: persisted, managementUpdate: persisted, managementRevoke: persisted, recognition };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('G09a writer quiescence lease', () => {
  test.each(['PROVISIONAL', 'QUEUED', 'RUNNING', 'BLOCKED', 'UNKNOWN'] as const)(
    '%s writer state makes read acquisition TECHNICAL_BUSY',
    (state) => {
      const q = createWriterQuiescence({ clock: { nowMs: () => 10 } });
      const value = receipt(`writer-${state}`);
      q.lifecycle.registered(value);
      if (state === 'QUEUED' || state === 'RUNNING') q.lifecycle.queued(value);
      if (state === 'RUNNING') q.lifecycle.started(value);
      if (state === 'BLOCKED') q.lifecycle.blocked(value);
      if (state === 'UNKNOWN') q.lifecycle.settled(value, 'UNKNOWN_EFFECT');
      expect(q.acquireReadObservationLease()).toEqual({ kind: 'TECHNICAL_BUSY' });
    },
  );

  test('registering during clock acquisition rolls back the tentative lease and returns busy', () => {
    let q!: ReturnType<typeof createWriterQuiescence>;
    const writer = receipt('clock-race');
    const wake = jest.fn();
    q = createWriterQuiescence({
      clock: { nowMs: () => { q.lifecycle.registered(writer); return 123; } },
      onLeaseReleased: wake,
    });
    expect(q.acquireReadObservationLease()).toEqual({ kind: 'TECHNICAL_BUSY' });
    expect(q.canStartWriter()).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);
    q.lifecycle.settled(writer, 'KNOWN_NO_EFFECT');
  });

  test.each([new Error('clock failed'), Number.NaN, 1.5])(
    'clock failure/invalid value %# rolls the lease back and wakes the coordinator',
    (value) => {
      const wake = jest.fn();
      let calls = 0;
      const q = createWriterQuiescence({
        clock: { nowMs: () => { calls += 1; if (calls === 1) { if (value instanceof Error) throw value; return value; } return 77; } },
        onLeaseReleased: wake,
      });
      expect(() => q.acquireReadObservationLease()).toThrow();
      expect(q.canStartWriter()).toBe(true);
      expect(wake).toHaveBeenCalledTimes(1);
      const acquired = q.acquireReadObservationLease();
      expect(acquired.kind).toBe('ACQUIRED');
      if (acquired.kind === 'ACQUIRED') acquired.lease.release();
    },
  );

  test('a read lease permits synchronous registration but prevents start until release wakes drain', async () => {
    const q = createWriterQuiescence({ clock: { nowMs: () => 44 } });
    const started = jest.fn();
    const observer: WriteOperationLifecycleObserver = {
      registered: q.lifecycle.registered.bind(q.lifecycle),
      queued: q.lifecycle.queued.bind(q.lifecycle),
      started: (value) => { q.lifecycle.started(value); started(); },
      blocked: q.lifecycle.blocked.bind(q.lifecycle),
      settled: ({ receipt: value, disposition }) => q.lifecycle.settled(value, disposition),
    };
    const coordinator = createWriteOperationCoordinatorBundle({
      clock: { nowMs: () => 55 }, lifecycleObserver: observer,
      startGate: q.canStartWriter, executors: executors(),
    });
    q.bindCoordinatorWake(coordinator.wake);
    const acquired = q.acquireReadObservationLease();
    if (acquired.kind !== 'ACQUIRED') throw new Error('expected lease');
    const completion = coordinator.recognition.enqueue('done');
    await flush();
    expect(started).not.toHaveBeenCalled();
    expect(q.acquireReadObservationLease()).toEqual({ kind: 'TECHNICAL_BUSY' });
    acquired.lease.release();
    await expect(completion).resolves.toBe('done');
    expect(started).toHaveBeenCalledTimes(1);
    expect(() => acquired.lease.release()).toThrow(/already released/i);
  });

  test('lease release wake throwing is contained and lease still becomes reusable', () => {
    const q = createWriterQuiescence({ clock: { nowMs: () => 1 }, onLeaseReleased: () => { throw new Error('wake'); } });
    const first = q.acquireReadObservationLease();
    if (first.kind !== 'ACQUIRED') throw new Error('expected lease');
    expect(() => first.lease.release()).not.toThrow();
    const second = q.acquireReadObservationLease();
    expect(second.kind).toBe('ACQUIRED');
  });
});

describe('G09a fail-closed writer hooks and gate', () => {
  test.each(['registered', 'queued', 'started', 'startGate'] as const)(
    '%s throw blocks the coordinator permanently and later work never executes',
    async (phase) => {
      const work = jest.fn<ReturnType<TrustedWriteExecutor<string, string>>, Parameters<TrustedWriteExecutor<string, string>>>(persisted);
      const failure = new Error(`${phase} failure`);
      const observer: WriteOperationLifecycleObserver = {
        ...(phase === 'registered' ? { registered: () => { throw failure; } } : {}),
        ...(phase === 'queued' ? { queued: () => { throw failure; } } : {}),
        ...(phase === 'started' ? { started: () => { throw failure; } } : {}),
        settled: () => undefined,
      };
      const coordinator = createWriteOperationCoordinatorBundle({
        clock: { nowMs: () => 1 }, lifecycleObserver: observer,
        ...(phase === 'startGate' ? { startGate: () => { throw failure; } } : {}),
        executors: executors(work),
      });
      await expect(coordinator.recognition.enqueue('one')).rejects.toBe(failure);
      await expect(coordinator.recognition.enqueue('two')).rejects.toThrow(/blocked/i);
      expect(work).not.toHaveBeenCalled();
    },
  );

  test.each(['registered', 'queued', 'started', 'startGate'] as const)(
    '%s thenable is synchronously rejected, observed, and permanently blocks later work',
    async (phase) => {
      const work = jest.fn<ReturnType<TrustedWriteExecutor<string, string>>, Parameters<TrustedWriteExecutor<string, string>>>(persisted);
      const thenable = Promise.reject(new Error('async hook rejection'));
      const observer: WriteOperationLifecycleObserver = {
        ...(phase === 'registered' ? { registered: (() => thenable) as never } : {}),
        ...(phase === 'queued' ? { queued: (() => thenable) as never } : {}),
        ...(phase === 'started' ? { started: (() => thenable) as never } : {}),
        settled: () => undefined,
      };
      const coordinator = createWriteOperationCoordinatorBundle({
        clock: { nowMs: () => 1 }, lifecycleObserver: observer,
        ...(phase === 'startGate' ? { startGate: (() => thenable) as never } : {}),
        executors: executors(work),
      });
      await expect(coordinator.recognition.enqueue('one')).rejects.toThrow(/synchronous/i);
      await flush();
      await expect(coordinator.recognition.enqueue('two')).rejects.toThrow(/blocked/i);
      expect(work).not.toHaveBeenCalled();
    },
  );
});
