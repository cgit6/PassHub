import {
  G10bOperationBridgeError,
  bindG10bOperationBudget,
  bindG10bOperationBudgetOnFirstScopedPersistenceUse,
  readG10bOperationBudgetForScopedPersistence,
  registerG10bAdmissionWorkContext,
  type G10bOperationBridgeErrorCode,
} from '../../src/composition/internal/g10b-operation-bridge.js';
import type { AdmissionWorkContext } from '../../src/composition/internal/g07b-admission-handler.js';
import {
  createOperationBudgetBindingFactory,
  type OperationBudgetBinding,
} from '../../src/access/application/internal/operation-budget-binding.js';
import {
  createWriteOperationCoordinatorBundle,
  type WriteOperationContext,
} from '../../src/access/application/internal/write-operation-coordinator.js';
import {
  createAccessScopeContext,
  retireAccessScopeContext,
} from '../../src/shared/access-scope-context.js';

function admissionContext(context: WriteOperationContext): AdmissionWorkContext {
  const admission = Object.freeze({
    operationId: context.operationId,
    receivedAtMs: context.receivedAtMs,
    sequence: context.sequence,
    runtimeIdentity: null,
  });
  registerG10bAdmissionWorkContext(admission, context);
  return admission;
}

interface LiveBudget {
  readonly admission: AdmissionWorkContext;
  readonly binding: OperationBudgetBinding;
  readonly writeContext: WriteOperationContext;
  close(): Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openLiveBudget(): Promise<LiveBudget> {
  const ready = deferred<Readonly<{
    readonly admission: AdmissionWorkContext;
    readonly binding: OperationBudgetBinding;
    readonly writeContext: WriteOperationContext;
  }>>();
  const release = deferred<void>();
  let rejected: unknown;
  const bundle = createWriteOperationCoordinatorBundle({
    clock: { nowMs: () => 1_000 },
    executors: {
      managementCreate: async (_input, context, settlement) => {
        try {
          const admission = admissionContext(context);
          const binding = createOperationBudgetBindingFactory({
            clock: { nowMs: () => 1_000 },
            assertContinuationEvidence: () => undefined,
          }).bind(context);
          ready.resolve({ admission, binding, writeContext: context });
          await release.promise;
          settlement.businessResultPersisted('bridge-test-complete');
        } catch (error: unknown) {
          rejected = error;
          ready.reject(error);
          settlement.knownNoEffect(error);
        }
      },
      managementUpdate: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
      managementRevoke: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
      recognition: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
    },
  });
  const running = bundle.managementCreate.enqueue(undefined);
  const live = await ready.promise;
  return {
    ...live,
    async close(): Promise<void> {
      release.resolve();
      await running;
      if (rejected !== undefined) throw rejected;
    },
  };
}

async function withLiveBudget<T>(
  work: (admission: AdmissionWorkContext, binding: OperationBudgetBinding) => T | Promise<T>,
): Promise<T> {
  let result!: T;
  let rejected: unknown;
  const bundle = createWriteOperationCoordinatorBundle({
    clock: { nowMs: () => 1_000 },
    executors: {
      managementCreate: async (_input, context, settlement) => {
        try {
          const admission = admissionContext(context);
          const binding = createOperationBudgetBindingFactory({
            clock: { nowMs: () => 1_000 },
            assertContinuationEvidence: () => undefined,
          }).bind(context);
          result = await work(admission, binding);
          settlement.businessResultPersisted('bridge-test-complete');
        } catch (error: unknown) {
          rejected = error;
          settlement.knownNoEffect(error);
        }
      },
      managementUpdate: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
      managementRevoke: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
      recognition: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
    },
  });
  await bundle.managementCreate.enqueue(undefined);
  if (rejected !== undefined) throw rejected;
  return result;
}

function expectBridgeCode(work: () => unknown, code: G10bOperationBridgeErrorCode): void {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(G10bOperationBridgeError);
    expect((error as G10bOperationBridgeError).code).toBe(code);
    return;
  }
  throw new Error(`expected G10bOperationBridgeError ${code}`);
}

describe('G10b operation bridge provenance', () => {
  test('associates one registered frozen admission context with one opaque binding and its first live scope use', async () => {
    await withLiveBudget((admission, binding) => {
      const scope = createAccessScopeContext({ epoch: 'epoch-1', owner: 'owner-1', generation: 'generation-1' });
      bindG10bOperationBudget(admission, binding);

      expect(bindG10bOperationBudgetOnFirstScopedPersistenceUse(admission, scope)).toBe(binding);
      expect(readG10bOperationBudgetForScopedPersistence(admission, scope)).toBe(binding);
    });
  });

  test('rejects a frozen structural copy of the registered admission context', async () => {
    await withLiveBudget((admission, binding) => {
      const copy = Object.freeze({ ...admission }) as AdmissionWorkContext;
      expectBridgeCode(() => bindG10bOperationBudget(copy, binding), 'INVALID_ADMISSION_CONTEXT');
      bindG10bOperationBudget(admission, binding);
    });
  });

  test('rejects forged budget and access-scope capabilities before recording a relationship', async () => {
    await withLiveBudget((admission, binding) => {
      expectBridgeCode(
        () => bindG10bOperationBudget(admission, Object.freeze({}) as OperationBudgetBinding),
        'INVALID_OPERATION_BINDING',
      );
      bindG10bOperationBudget(admission, binding);
      expectBridgeCode(
        () => bindG10bOperationBudgetOnFirstScopedPersistenceUse(admission, Object.freeze({}) as never),
        'INVALID_ACCESS_SCOPE_CONTEXT',
      );
    });
  });

  test('rejects double binding and refuses a retired scope lookup', async () => {
    await withLiveBudget((admission, binding) => {
      const scope = createAccessScopeContext({ epoch: 'epoch-1', owner: 'owner-1', generation: 'generation-1' });
      bindG10bOperationBudget(admission, binding);
      expectBridgeCode(() => bindG10bOperationBudget(admission, binding), 'ADMISSION_ALREADY_BOUND');
      bindG10bOperationBudgetOnFirstScopedPersistenceUse(admission, scope);
      expectBridgeCode(
        () => bindG10bOperationBudgetOnFirstScopedPersistenceUse(admission, scope),
        'ACCESS_SCOPE_ALREADY_BOUND',
      );
      retireAccessScopeContext(scope);
      expectBridgeCode(() => readG10bOperationBudgetForScopedPersistence(admission, scope), 'ACCESS_SCOPE_STALE');
    });
  });

  test('rejects a genuine binding from a different concurrently active write operation', async () => {
    const first = await openLiveBudget();
    const second = await openLiveBudget();
    try {
      expectBridgeCode(
        () => bindG10bOperationBudget(first.admission, second.binding),
        'OPERATION_BINDING_MISOWNED',
      );
      bindG10bOperationBudget(first.admission, first.binding);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('rejects reuse of an otherwise matching binding with a second admission context', async () => {
    const live = await openLiveBudget();
    try {
      const secondAdmission = admissionContext(live.writeContext);
      bindG10bOperationBudget(live.admission, live.binding);
      expectBridgeCode(
        () => bindG10bOperationBudget(secondAdmission, live.binding),
        'OPERATION_BINDING_ALREADY_BOUND',
      );
    } finally {
      await live.close();
    }
  });

  test('rejects a stale binding before it is recorded against an admission', async () => {
    let admission!: AdmissionWorkContext;
    let binding!: OperationBudgetBinding;
    await withLiveBudget((liveAdmission, liveBinding) => {
      admission = liveAdmission;
      binding = liveBinding;
    });
    expectBridgeCode(() => bindG10bOperationBudget(admission, binding), 'OPERATION_BINDING_STALE');
  });

  test('rejects a second distinct scope for one admission and binding', async () => {
    await withLiveBudget((admission, binding) => {
      const first = createAccessScopeContext({ epoch: 'epoch-1', owner: 'owner-1', generation: 'generation-1' });
      const second = createAccessScopeContext({ epoch: 'epoch-2', owner: 'owner-2', generation: 'generation-2' });
      bindG10bOperationBudget(admission, binding);
      bindG10bOperationBudgetOnFirstScopedPersistenceUse(admission, first);
      expectBridgeCode(
        () => bindG10bOperationBudgetOnFirstScopedPersistenceUse(admission, second),
        'ADMISSION_SCOPE_ALREADY_BOUND',
      );
    });
  });

  test('rejects a lookup after the coordinator owner has settled', async () => {
    const scope = createAccessScopeContext({ epoch: 'epoch-1', owner: 'owner-1', generation: 'generation-1' });
    let admission!: AdmissionWorkContext;
    await withLiveBudget((context, binding) => {
      admission = context;
      bindG10bOperationBudget(context, binding);
      bindG10bOperationBudgetOnFirstScopedPersistenceUse(context, scope);
    });
    expectBridgeCode(
      () => readG10bOperationBudgetForScopedPersistence(admission, scope),
      'OPERATION_BINDING_STALE',
    );
  });

  test('rejects a scope lookup from a different registered and budget-bound admission context', async () => {
    const scope = createAccessScopeContext({ epoch: 'epoch-1', owner: 'owner-1', generation: 'generation-1' });
    await withLiveBudget((admission, binding) => {
      bindG10bOperationBudget(admission, binding);
      bindG10bOperationBudgetOnFirstScopedPersistenceUse(admission, scope);
    });
    await withLiveBudget((second, binding) => {
      bindG10bOperationBudget(second, binding);
      expectBridgeCode(
        () => readG10bOperationBudgetForScopedPersistence(second, scope),
        'ACCESS_SCOPE_MISOWNED',
      );
    });
  });
});
