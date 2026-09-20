import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createWriteOperationCoordinatorBundle,
  type TrustedWriteExecutor,
  type WriteOperationContext,
  type WriteOperationExecutorChannels,
  type WriteOperationSettlement,
} from '../../src/access/application/internal/write-operation-coordinator.js';

type Executor = TrustedWriteExecutor<string, string>;
type Channels = WriteOperationExecutorChannels<string, string, string, string, string, string, string, string>;

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function channels(overrides: Partial<Channels> = {}): Channels {
  const persisted: Executor = (input, _context, settlement) => {
    settlement.businessResultPersisted(input);
  };
  return {
    managementCreate: persisted,
    managementUpdate: persisted,
    managementRevoke: persisted,
    recognition: persisted,
    ...overrides,
  };
}

function bundle(executors: Channels, nowMs: () => number = () => 1_000) {
  return createWriteOperationCoordinatorBundle({ clock: { nowMs }, executors });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function pendingState<T>(promise: Promise<T>): Promise<'resolved' | 'rejected' | 'pending'> {
  return Promise.race([
    promise.then(() => 'resolved' as const, () => 'rejected' as const),
    Promise.resolve('pending' as const),
  ]);
}

function resolvingThenable(): PromiseLike<void> {
  return {
    then: (onfulfilled, onrejected) => Promise.resolve().then(onfulfilled, onrejected),
  };
}

function rejectingThenable(error: unknown): PromiseLike<void> {
  return {
    then: (onfulfilled, onrejected) => Promise.reject(error).then(onfulfilled, onrejected),
  };
}

describe('G05a synchronous registration and FIFO ordering', () => {
  test('enqueue captures the trusted clock exactly once and defers executor work to a microtask', async () => {
    const events: string[] = [];
    const nowMs = jest.fn(() => {
      events.push('clock');
      return 42;
    });
    const coordinator = bundle(channels({
      managementCreate: (_input, context, settlement) => {
        events.push(`work:${context.receivedAtMs}`);
        settlement.businessResultPersisted('created');
      },
    }), nowMs);

    const result = coordinator.managementCreate.enqueue('input');
    expect(events).toEqual(['clock']);
    expect(nowMs).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toBe('created');
    expect(events).toEqual(['clock', 'work:42']);
  });

  test('all four channels share one queue with strictly monotonic sequence at the same timestamp', async () => {
    const seen: Array<readonly [string, bigint, number]> = [];
    const record = (name: string): Executor => (input, context, settlement) => {
      seen.push([name, context.sequence, context.receivedAtMs]);
      settlement.businessResultPersisted(input);
    };
    const coordinator = bundle(channels({
      managementCreate: record('create'),
      managementUpdate: record('update'),
      managementRevoke: record('revoke'),
      recognition: record('recognition'),
    }), () => 777);

    await Promise.all([
      coordinator.managementCreate.enqueue('a'),
      coordinator.recognition.enqueue('b'),
      coordinator.managementUpdate.enqueue('c'),
      coordinator.managementRevoke.enqueue('d'),
    ]);
    expect(seen).toEqual([
      ['create', 0n, 777],
      ['recognition', 1n, 777],
      ['update', 2n, 777],
      ['revoke', 3n, 777],
    ]);
  });

  test('a slow first operation prevents the second callback from executing at all', async () => {
    const firstExecution = deferred<void>();
    let firstSettlement!: WriteOperationSettlement<string>;
    const second = jest.fn<ReturnType<Executor>, Parameters<Executor>>((_input, _context, settlement) => {
      settlement.businessResultPersisted('second');
    });
    const coordinator = bundle(channels({
      recognition: (_input, _context, settlement) => {
        firstSettlement = settlement;
        return firstExecution.promise;
      },
      managementRevoke: second,
    }));

    const firstResult = coordinator.recognition.enqueue('first');
    const secondResult = coordinator.managementRevoke.enqueue('second');
    await flushMicrotasks();
    expect(second).not.toHaveBeenCalled();
    await expect(pendingState(secondResult)).resolves.toBe('pending');

    firstSettlement.businessResultPersisted('first');
    firstExecution.resolve();
    await expect(firstResult).resolves.toBe('first');
    await expect(secondResult).resolves.toBe('second');
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('separate coordinator bundles have independent queues', async () => {
    const held = deferred<void>();
    let settleHeld!: WriteOperationSettlement<string>;
    const firstBundle = bundle(channels({
      recognition: (_input, _context, settlement) => {
        settleHeld = settlement;
        return held.promise;
      },
    }));
    const secondBundle = bundle(channels());

    const heldResult = firstBundle.recognition.enqueue('held');
    await expect(secondBundle.managementCreate.enqueue('independent')).resolves.toBe('independent');
    settleHeld.businessResultPersisted('held');
    held.resolve();
    await expect(heldResult).resolves.toBe('held');
  });

  test('a clock throw appends nothing and consumes no sequence', async () => {
    let calls = 0;
    const seen: bigint[] = [];
    const clockError = new Error('clock failed');
    const coordinator = bundle(channels({
      managementCreate: (_input, context, settlement) => {
        seen.push(context.sequence);
        settlement.businessResultPersisted('ok');
      },
    }), () => {
      calls += 1;
      if (calls === 1) throw clockError;
      return 9;
    });

    expect(() => coordinator.managementCreate.enqueue('not-appended')).toThrow(clockError);
    await expect(coordinator.managementCreate.enqueue('appended')).resolves.toBe('ok');
    expect(seen).toEqual([0n]);
  });
});

describe('G05a settlements and fail-closed advancement', () => {
  test.each([
    ['PRESTART_REJECTED', (settlement: WriteOperationSettlement<string>, error: Error) => settlement.prestartRejected(error)],
    ['KNOWN_NO_EFFECT', (settlement: WriteOperationSettlement<string>, error: Error) => settlement.knownNoEffect(error)],
  ] as const)('%s rejects with the original error and advances the queue', async (_name, settle) => {
    const original = new Error('original');
    const coordinator = bundle(channels({
      managementCreate: (_input, _context, settlement) => settle(settlement, original),
    }));
    const first = coordinator.managementCreate.enqueue('first');
    const next = coordinator.managementUpdate.enqueue('next');
    await expect(first).rejects.toBe(original);
    await expect(next).resolves.toBe('next');
  });

  test('BUSINESS_RESULT_PERSISTED resolves and advances the queue', async () => {
    const coordinator = bundle(channels());
    await expect(coordinator.managementCreate.enqueue('persisted')).resolves.toBe('persisted');
    await expect(coordinator.recognition.enqueue('next')).resolves.toBe('next');
  });

  test('UNKNOWN_EFFECT rejects with the original error and permanently blocks the next item', async () => {
    const original = new Error('commit unknown');
    const nextExecutor = jest.fn<ReturnType<Executor>, Parameters<Executor>>();
    const coordinator = bundle(channels({
      managementCreate: (_input, _context, settlement) => settlement.unknownEffect(original),
      managementUpdate: nextExecutor,
    }));
    const first = coordinator.managementCreate.enqueue('first');
    const next = coordinator.managementUpdate.enqueue('next');
    await expect(first).rejects.toBe(original);
    await flushMicrotasks();
    expect(nextExecutor).not.toHaveBeenCalled();
    await expect(pendingState(next)).resolves.toBe('pending');
    await expect(coordinator.recognition.enqueue('later')).rejects.toThrow('blocked by unknown effect');
  });

  async function expectUnknownBlock(firstExecutor: Executor, expectedError?: unknown): Promise<void> {
    const nextExecutor = jest.fn<ReturnType<Executor>, Parameters<Executor>>();
    const coordinator = bundle(channels({
      managementCreate: firstExecutor,
      managementUpdate: nextExecutor,
    }));
    const first = coordinator.managementCreate.enqueue('first');
    const next = coordinator.managementUpdate.enqueue('next');
    if (expectedError === undefined) await expect(first).rejects.toBeInstanceOf(Error);
    else await expect(first).rejects.toBe(expectedError);
    await flushMicrotasks();
    expect(nextExecutor).not.toHaveBeenCalled();
    await expect(pendingState(next)).resolves.toBe('pending');
    await expect(coordinator.managementRevoke.enqueue('later')).rejects.toThrow('blocked by unknown effect');
  }

  test('sync throw, async rejection, and rejecting thenable each become unknown and block', async () => {
    const syncError = new Error('sync');
    await expectUnknownBlock(() => { throw syncError; }, syncError);
    const asyncError = new Error('async');
    await expectUnknownBlock(async () => { throw asyncError; }, asyncError);
    const thenableError = new Error('thenable');
    await expectUnknownBlock(() => rejectingThenable(thenableError), thenableError);
  });

  test('executor resolution without settlement, including a thenable, becomes unknown and blocks', async () => {
    await expectUnknownBlock(() => undefined);
    await expectUnknownBlock(() => Promise.resolve());
    await expectUnknownBlock(() => resolvingThenable());
  });

  test('duplicate settlements and every illegal settlement payload become unknown and block', async () => {
    await expectUnknownBlock((_input, _context, settlement) => {
      settlement.businessResultPersisted('first');
      settlement.businessResultPersisted('duplicate');
    });
    await expectUnknownBlock((_input, _context, settlement) => settlement.businessResultPersisted(undefined as never));
    await expectUnknownBlock((_input, _context, settlement) => settlement.prestartRejected(undefined));
    await expectUnknownBlock((_input, _context, settlement) => settlement.knownNoEffect(null));
    await expectUnknownBlock((_input, _context, settlement) => settlement.unknownEffect(undefined));
  });

  test('a settlement candidate followed by executor rejection is unknown and blocks', async () => {
    const lateError = new Error('executor rejected after candidate');
    await expectUnknownBlock((_input, _context, settlement) => {
      settlement.businessResultPersisted('candidate');
      return Promise.reject(lateError);
    }, lateError);
  });

  test('a candidate does not advance while its executor remains pending', async () => {
    const execution = deferred<void>();
    const nextExecutor = jest.fn<ReturnType<Executor>, Parameters<Executor>>((_input, _context, settlement) => {
      settlement.businessResultPersisted('next');
    });
    const coordinator = bundle(channels({
      managementCreate: (_input, _context, settlement) => {
        settlement.businessResultPersisted('candidate');
        return execution.promise;
      },
      managementUpdate: nextExecutor,
    }));
    const first = coordinator.managementCreate.enqueue('first');
    const next = coordinator.managementUpdate.enqueue('next');
    await flushMicrotasks();
    expect(nextExecutor).not.toHaveBeenCalled();
    await expect(pendingState(first)).resolves.toBe('pending');
    execution.resolve();
    await expect(first).resolves.toBe('candidate');
    await expect(next).resolves.toBe('next');
  });

  test('late settlements after finalization cannot change the caller or advance twice', async () => {
    let staleSettlement!: WriteOperationSettlement<string>;
    const order: string[] = [];
    const coordinator = bundle(channels({
      managementCreate: (_input, _context, settlement) => {
        staleSettlement = settlement;
        settlement.businessResultPersisted('canonical');
      },
      managementUpdate: (input, _context, settlement) => {
        order.push(input);
        settlement.businessResultPersisted(input);
      },
    }));
    await expect(coordinator.managementCreate.enqueue('first')).resolves.toBe('canonical');
    staleSettlement.unknownEffect(new Error('too late'));
    staleSettlement.businessResultPersisted('replacement');
    await expect(coordinator.managementUpdate.enqueue('second')).resolves.toBe('second');
    await expect(coordinator.managementUpdate.enqueue('third')).resolves.toBe('third');
    expect(order).toEqual(['second', 'third']);
  });
});

describe('G05a owner, immutable context, and captured construction dependencies', () => {
  test('owner is current only while its operation is running, then becomes stale', async () => {
    const execution = deferred<void>();
    let context!: WriteOperationContext;
    const coordinator = bundle(channels({
      recognition: (_input, receivedContext, settlement) => {
        context = receivedContext;
        context.assertCurrent();
        context.owner.assertCurrent();
        settlement.businessResultPersisted('done');
        return execution.promise;
      },
    }));
    const result = coordinator.recognition.enqueue('input');
    await flushMicrotasks();
    expect(() => context.assertCurrent()).not.toThrow();
    expect(() => context.owner.assertCurrent()).not.toThrow();
    execution.resolve();
    await expect(result).resolves.toBe('done');
    expect(() => context.assertCurrent()).toThrow('not current');
    expect(() => context.owner.assertCurrent()).toThrow('not current');
  });

  test('a prior owner is stale while the next operation is current', async () => {
    let prior!: WriteOperationContext;
    const coordinator = bundle(channels({
      managementCreate: (_input, context, settlement) => {
        prior = context;
        settlement.businessResultPersisted('first');
      },
      managementUpdate: (_input, context, settlement) => {
        expect(() => prior.assertCurrent()).toThrow('not current');
        expect(() => context.assertCurrent()).not.toThrow();
        settlement.businessResultPersisted('second');
      },
    }));
    await expect(coordinator.managementCreate.enqueue('first')).resolves.toBe('first');
    await expect(coordinator.managementUpdate.enqueue('second')).resolves.toBe('second');
  });

  test('operation IDs are unique UUIDs and the context is runtime read-only', async () => {
    const contexts: WriteOperationContext[] = [];
    const inspect: Executor = (input, context, settlement) => {
      contexts.push(context);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.owner)).toBe(true);
      expect(() => {
        (context as unknown as Record<string, unknown>).sequence = 999n;
      }).toThrow(TypeError);
      settlement.businessResultPersisted(input);
    };
    const coordinator = bundle(channels({ managementCreate: inspect, recognition: inspect }));
    await Promise.all([
      coordinator.managementCreate.enqueue('one'),
      coordinator.recognition.enqueue('two'),
    ]);
    expect(contexts).toHaveLength(2);
    expect(new Set(contexts.map(({ operationId }) => operationId)).size).toBe(2);
    for (const { operationId } of contexts) {
      expect(operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    }
  });

  test('post-construction mutation cannot replace captured clock or executor references', async () => {
    const originalClock = jest.fn(() => 55);
    const replacementClock = jest.fn(() => 999);
    const originalExecutor = jest.fn<ReturnType<Executor>, Parameters<Executor>>((_input, context, settlement) => {
      settlement.businessResultPersisted(`original:${context.receivedAtMs}`);
    });
    const replacementExecutor = jest.fn<ReturnType<Executor>, Parameters<Executor>>((_input, _context, settlement) => {
      settlement.businessResultPersisted('replacement');
    });
    const clock = { nowMs: originalClock };
    const executorMap = channels({ managementCreate: originalExecutor });
    const options = { clock, executors: executorMap };
    const coordinator = createWriteOperationCoordinatorBundle(options);

    clock.nowMs = replacementClock;
    (executorMap as { managementCreate: Executor }).managementCreate = replacementExecutor;
    options.clock = { nowMs: replacementClock };
    options.executors = channels({ managementCreate: replacementExecutor });

    await expect(coordinator.managementCreate.enqueue('input')).resolves.toBe('original:55');
    expect(originalClock).toHaveBeenCalledTimes(1);
    expect(originalExecutor).toHaveBeenCalledTimes(1);
    expect(replacementClock).not.toHaveBeenCalled();
    expect(replacementExecutor).not.toHaveBeenCalled();
    expect(() => {
      (coordinator.managementCreate as unknown as Record<string, unknown>).enqueue = replacementExecutor;
    }).toThrow(TypeError);
  });
});

describe('G05a narrow surface and static boundary', () => {
  test('caller receives only four enqueue channels with no settlement or lifecycle controls', () => {
    const coordinator = bundle(channels());
    expect(Object.keys(coordinator).sort()).toEqual([
      'managementCreate',
      'managementRevoke',
      'managementUpdate',
      'recognition',
    ]);
    for (const port of Object.values(coordinator)) {
      expect(Object.keys(port)).toEqual(['enqueue']);
      expect(Object.isFrozen(port)).toBe(true);
    }
    expect(Object.isFrozen(coordinator)).toBe(true);
    expect(coordinator).not.toHaveProperty('read');
    expect(coordinator).not.toHaveProperty('login');
    expect(coordinator).not.toHaveProperty('createExecution');
    expect(coordinator).not.toHaveProperty('release');
    expect(coordinator).not.toHaveProperty('resume');
    expect(coordinator).not.toHaveProperty('cancel');
  });

  test('coordinator is absent from root/application/composition exports and forbidden concerns', async () => {
    const root = process.cwd().endsWith(`${path.sep}dist`) ? path.resolve(process.cwd(), '..') : process.cwd();
    const coordinatorSource = await readFile(
      path.join(root, 'src/access/application/internal/write-operation-coordinator.ts'),
      'utf8',
    );
    for (const barrel of ['src/index.ts', 'src/access/application/index.ts', 'src/composition/index.ts']) {
      await expect(readFile(path.join(root, barrel), 'utf8')).resolves.not.toMatch(/write-operation-coordinator/u);
    }
    expect(coordinatorSource).not.toMatch(/from\s+['"][^'"]*(?:mongo|domain|http|auth)[^'"]*['"]/iu);
    expect(coordinatorSource).not.toMatch(/\b(?:setTimeout|setInterval|EventEmitter|Promise\.all|retry)\b/u);
    expect(coordinatorSource).not.toMatch(/\b(?:G05b|G05c)\b/u);
  });
});
