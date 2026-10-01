import type { ClientSession, MongoClient } from 'mongodb';

import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import {
  attachG10bScopedPersistenceBindingResolver,
  createG10bScopedPersistenceExecutionFacade,
  createG10bScopedPersistenceBindingResolver,
} from '../../src/infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.js';
import { attachG10bG04bPersistenceSidecar } from '../../src/composition/internal/g10b-g04b-persistence-wire.js';
import { createAccessScopeContext } from '../../src/shared/access-scope-context.js';
import { OperationBudgetBindingError, createOperationBudgetBindingFactory, type OperationBudgetBinding } from '../../src/access/application/internal/operation-budget-binding.js';
import { createWriteOperationCoordinatorBundle, type WriteOperationContext } from '../../src/access/application/internal/write-operation-coordinator.js';

const SCOPE = () => createAccessScopeContext({
  epoch: '11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
  generation: '33333333-3333-4333-8333-333333333333',
});

interface MongoHarness {
  readonly client: MongoClient;
  readonly startSession: jest.Mock;
  readonly startTransaction: jest.Mock;
  readonly commitTransaction: jest.Mock;
  readonly abortTransaction: jest.Mock;
  readonly endSession: jest.Mock;
}

function mongoHarness(): MongoHarness {
  let transactionActive = false;
  const startTransaction = jest.fn(() => { transactionActive = true; });
  const commitTransaction = jest.fn(async () => { transactionActive = false; });
  const abortTransaction = jest.fn(async () => { transactionActive = false; });
  const endSession = jest.fn(async () => undefined);
  const session = {
    startTransaction,
    commitTransaction,
    inTransaction: jest.fn(() => transactionActive),
    abortTransaction,
    endSession,
  } as unknown as ClientSession;
  const startSession = jest.fn(() => session);
  return {
    client: {
      db: jest.fn(() => ({})),
      startSession,
      on: jest.fn(),
    } as unknown as MongoClient,
    startSession,
    startTransaction,
    commitTransaction,
    abortTransaction,
    endSession,
  };
}

interface MutableBudgetClock {
  value: number;
  nowMs(): number;
}

async function withActiveBinding<T>(work: (binding: OperationBudgetBinding, clock: MutableBudgetClock) => T | Promise<T>): Promise<T> {
  let value!: T;
  let failure: unknown;
  const clock: MutableBudgetClock = { value: 1_000, nowMs(): number { return this.value; } };
  const bundle = createWriteOperationCoordinatorBundle({
    clock,
    executors: {
      managementCreate: async (_input, context: WriteOperationContext, settlement) => {
        try {
          const binding = createOperationBudgetBindingFactory({
            clock,
            assertContinuationEvidence: () => undefined,
            config: { singleCommandMs: 123 },
          }).bind(context);
          value = await work(binding, clock);
          settlement.businessResultPersisted('g10b-sidecar-test');
        } catch (error: unknown) {
          failure = error;
          settlement.knownNoEffect(error);
        }
      },
      managementUpdate: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
      managementRevoke: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
      recognition: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
    },
  });
  await bundle.managementCreate.enqueue(undefined);
  if (failure !== undefined) throw failure;
  return value;
}

describe('G10b G04b scoped-persistence sidecar', () => {
  test('keeps an unattached concrete adapter on the legacy session path', async () => {
    const harness = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_legacy');

    await expect(adapter.readSourceFacts(SCOPE(), 'source-1')).rejects.toMatchObject({
      name: 'G04bTransactionError',
    });

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startTransaction).toHaveBeenCalledTimes(1);
    expect(() => attachG10bScopedPersistenceBindingResolver(
      adapter,
      createG10bScopedPersistenceBindingResolver(() => Object.freeze({})),
    )).toThrow(/before a G04b scoped transaction begins/i);
  });

  test('fails an attached but unbound composition scope before allocating a Mongo session', async () => {
    const harness = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_unbound');
    attachG10bG04bPersistenceSidecar(adapter);

    await expect(adapter.readSourceFacts(SCOPE(), 'source-1')).rejects.toMatchObject({
      name: 'G10bOperationBridgeError',
      code: 'ACCESS_SCOPE_NOT_BOUND',
    });

    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.startTransaction).not.toHaveBeenCalled();
  });

  test('accepts one branded resolver for a concrete adapter and rejects foreign or repeated attachment', () => {
    const harness = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_once');
    const resolver = createG10bScopedPersistenceBindingResolver(() => Object.freeze({}));

    expect(() => attachG10bScopedPersistenceBindingResolver(
      Object.freeze({}) as G04bMongoPersistenceAdapter,
      resolver,
    )).toThrow(/concrete G04b Mongo persistence adapter/i);
    expect(() => attachG10bScopedPersistenceBindingResolver(
      adapter,
      Object.freeze({}) as never,
    )).toThrow(/resolver is foreign/i);
    attachG10bScopedPersistenceBindingResolver(adapter, resolver);
    expect(() => attachG10bScopedPersistenceBindingResolver(adapter, resolver)).toThrow(
      /already attached/i,
    );
  });

  test('creates one private active round that forwards the exact admitted timeout to CRUD and initial commit', async () => {
    await withActiveBinding(async (binding) => {
      const facade = createG10bScopedPersistenceExecutionFacade(binding);
      expect(facade).toBeDefined();
      const commands: Array<Readonly<{ kind: string; timeoutMs: number }>> = [];

      await expect(facade!.executeCrud((command) => {
        commands.push(command);
        return 'crud-result';
      })).resolves.toBe('crud-result');
      await expect(facade!.executeInitialCommit((command) => {
        commands.push(command);
        return 'commit-result';
      })).resolves.toBe('commit-result');

      expect(commands).toEqual([
        { kind: 'CRUD', timeoutMs: 123 },
        { kind: 'INITIAL_COMMIT', timeoutMs: 123 },
      ]);
      facade!.finish();
      await expect(facade!.executeCrud(() => undefined)).rejects.toThrow(/no longer active/i);
    });
  });

  test('wraps transaction cursor CRUD and the one initial commit with exact admitted driver timeouts', async () => {
    await withActiveBinding(async (binding) => {
      const harness = mongoHarness();
      const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_crud');
      const toArray = jest.fn(async () => []);
      const limit = jest.fn(() => ({ toArray }));
      const find = jest.fn(() => ({ limit }));
      const findOne = jest.fn(async (..._args: unknown[]) => ({ _id: 'source-1', direction: 'ENTRY', active: true, incarnation: 'source-incarnation', version: 0 }));
      const faceSlotFindOne = jest.fn(async (..._args: unknown[]) => null);
      const insertOne = jest.fn(async (..._args: unknown[]) => ({ acknowledged: true }));
      const updateOne = jest.fn(async (..._args: unknown[]) => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }));
      const countDocuments = jest.fn(async (..._args: unknown[]) => 0);
      const metadataFindOne = jest.fn(async (..._args: unknown[]) => ({
        _id: 'system', datasetEpoch: '11111111-1111-4111-8111-111111111111', slotCount: 0,
      }));
      (adapter as unknown as { collections: unknown }).collections = {
        faceSlots: { find, findOne: faceSlotFindOne, insertOne, countDocuments },
        sources: { findOne },
        metadata: { findOne: metadataFindOne, updateOne },
      };
      attachG10bScopedPersistenceBindingResolver(
        adapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );
      const scope = SCOPE();

      await expect(adapter.readSourceFacts(scope, 'source-1')).resolves.toEqual({ sourceId: 'source-1', direction: 'ENTRY', active: true });
      await expect(adapter.readMapping(scope, 'qualification-1')).resolves.toBeNull();

      expect(find).toHaveBeenCalledWith(
        { qualificationId: { $eq: 'qualification-1', $type: 'string' } },
        expect.objectContaining({ session: expect.anything(), timeoutMS: 123 }),
      );
      expect(limit).toHaveBeenCalledWith(2);
      expect(toArray).toHaveBeenCalledTimes(1);
      const state = (adapter as unknown as {
        readonly transactions: WeakMap<object, object>;
        commit(context: object, transaction: object): Promise<void>;
      }).transactions.get(scope as object);
      expect(state).toBeDefined();
      const internal = adapter as unknown as {
        commit(context: object, transaction: object): Promise<void>;
        bindNewFace(transaction: object, qualificationId: string, qualificationIncarnation: string, mapping: { provider: string; externalSubjectId: string }): Promise<void>;
        bumpGuard(transaction: object, guard: 'qr' | 'face'): Promise<void>;
        ensureSlotCount(transaction: object): Promise<void>;
      };
      await internal.bindNewFace(state!, 'qualification-1', 'qualification-incarnation', {
        provider: 'provider-1', externalSubjectId: 'subject-1',
      });
      await internal.bumpGuard(state!, 'qr');
      await internal.ensureSlotCount(state!);
      for (const options of [
        findOne.mock.calls[0]?.[1],
        insertOne.mock.calls[0]?.[1],
        updateOne.mock.calls[1]?.[2],
        countDocuments.mock.calls[0]?.[1],
      ]) {
        expect(options).toEqual(expect.objectContaining({ session: expect.anything(), timeoutMS: 123 }));
      }
      await internal.commit(scope as object, state!);
      expect(harness.commitTransaction).toHaveBeenCalledTimes(1);
      expect(harness.commitTransaction).toHaveBeenCalledWith({ timeoutMS: 123 });
      expect((state as { readonly initialCommitInvoked: boolean }).initialCommitInvoked).toBe(true);
    });
  });

  test('settles rejected CRUD so its active round can finish and a fresh facade can begin', async () => {
    await withActiveBinding(async (binding) => {
      const facade = createG10bScopedPersistenceExecutionFacade(binding);
      const failure = new Error('CRUD send failed');
      await expect(facade!.executeCrud(() => Promise.reject(failure))).rejects.toBe(failure);
      expect(() => facade!.finish()).not.toThrow();

      const recovery = createG10bScopedPersistenceExecutionFacade(binding);
      expect(recovery).toBeDefined();
      recovery!.finish();
    });
  });

  test('settles rejected initial commit so its active round can finish and a fresh facade can begin', async () => {
    await withActiveBinding(async (binding) => {
      const facade = createG10bScopedPersistenceExecutionFacade(binding);
      const failure = new Error('initial commit send failed');
      await expect(facade!.executeInitialCommit(() => Promise.reject(failure))).rejects.toBe(failure);
      expect(() => facade!.finish()).not.toThrow();

      const recovery = createG10bScopedPersistenceExecutionFacade(binding);
      expect(recovery).toBeDefined();
      recovery!.finish();
    });
  });

  test('seals the facade before binding-owned precommit admission and permits one 2s abort authority callback', async () => {
    await withActiveBinding(async (binding) => {
      const facade = createG10bScopedPersistenceExecutionFacade(binding);
      const authority = facade!.beginPrecommitTermination();
      await expect(facade!.executeCrud(() => undefined)).rejects.toThrow(/no longer active/i);

      const commands: Array<Readonly<{ timeoutMs: number; attempt: number }>> = [];
      await expect(authority.abortOnce((command) => { commands.push(command); })).resolves.toBe('NO_EFFECT_CONFIRMED');
      expect(commands).toEqual([{ timeoutMs: 2_000, attempt: 0 }]);
      await expect(authority.abortOnce(() => undefined)).rejects.toThrow(/already invoked/i);
      authority.terminate('NO_EFFECT_CONFIRMED');
    });
  });

  test('uses binding-owned precommit authority for attached fail and discard without a raw abort fallback', async () => {
    await withActiveBinding(async (binding) => {
      const failureHarness = mongoHarness();
      const failingAdapter = new G04bMongoPersistenceAdapter(failureHarness.client, 'g10b_sidecar_precommit_fail');
      (failingAdapter as unknown as { collections: unknown }).collections = {
        sources: { findOne: jest.fn(async () => { throw new Error('read failed'); }) },
      };
      attachG10bScopedPersistenceBindingResolver(
        failingAdapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );

      await expect(failingAdapter.readSourceFacts(SCOPE(), 'source-1')).rejects.toMatchObject({ name: 'G04bTransactionError' });
      expect(failureHarness.abortTransaction).toHaveBeenCalledTimes(1);
      expect(failureHarness.abortTransaction).toHaveBeenCalledWith({ timeoutMS: 2_000 });
      expect(failureHarness.endSession).toHaveBeenCalledTimes(1);

      // The previous original write's binding is terminal. Use a distinct
      // active binding to prove the discard path itself owns the same group.
    });

    await withActiveBinding(async (binding) => {
      const discardHarness = mongoHarness();
      const adapter = new G04bMongoPersistenceAdapter(discardHarness.client, 'g10b_sidecar_precommit_discard');
      (adapter as unknown as { collections: unknown }).collections = {
        sources: { findOne: jest.fn(async () => ({ _id: 'source-1', direction: 'ENTRY', active: true, incarnation: 'source-incarnation', version: 0 })) },
      };
      attachG10bScopedPersistenceBindingResolver(
        adapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );
      const scope = SCOPE();
      await adapter.readSourceFacts(scope, 'source-1');
      await adapter.discard(scope);
      await adapter.discard(scope);

      expect(discardHarness.abortTransaction).toHaveBeenCalledTimes(1);
      expect(discardHarness.abortTransaction).toHaveBeenCalledWith({ timeoutMS: 2_000 });
      expect(discardHarness.endSession).toHaveBeenCalledTimes(1);
    });
  });

  test('holds an attached transaction at the G10c boundary after initial commit invocation', async () => {
    await withActiveBinding(async (binding) => {
      const harness = mongoHarness();
      const commitFailure = new Error('initial commit failed');
      harness.commitTransaction.mockImplementation(async () => { throw commitFailure; });
      const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_initial_commit_hold');
      const toArray = jest.fn(async () => []);
      (adapter as unknown as { collections: unknown }).collections = {
        faceSlots: { find: jest.fn(() => ({ limit: jest.fn(() => ({ toArray })) })) },
      };
      attachG10bScopedPersistenceBindingResolver(
        adapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );
      const scope = SCOPE();
      await adapter.readMapping(scope, 'qualification-1');
      const internal = adapter as unknown as {
        readonly transactions: WeakMap<object, object>;
        commit(context: object, transaction: object): Promise<void>;
      };
      const state = internal.transactions.get(scope as object);
      await expect(internal.commit(scope as object, state!)).rejects.toMatchObject({
        name: 'G04bTransactionError', cause: commitFailure,
      });
      expect((state as { readonly initialCommitInvoked: boolean }).initialCommitInvoked).toBe(true);
      await adapter.discard(scope);

      expect(harness.abortTransaction).not.toHaveBeenCalled();
      expect(harness.endSession).not.toHaveBeenCalled();
      expect(internal.transactions.get(scope as object)).toBe(state);
    });
  });

  test('routes a deadline-rejected initial commit admission through one attached precommit abort', async () => {
    await withActiveBinding(async (binding, clock) => {
      const harness = mongoHarness();
      const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_initial_deadline');
      const toArray = jest.fn(async () => []);
      (adapter as unknown as { collections: unknown }).collections = {
        faceSlots: { find: jest.fn(() => ({ limit: jest.fn(() => ({ toArray })) })) },
      };
      attachG10bScopedPersistenceBindingResolver(
        adapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );
      const scope = SCOPE();
      await adapter.readMapping(scope, 'qualification-1');
      // The first CRUD started execution at 1,000; 16,000 is beyond the
      // fixed 15s execution deadline, so initial sender admission is denied.
      clock.value = 16_000;
      const internal = adapter as unknown as {
        readonly transactions: WeakMap<object, object>;
        commit(context: object, transaction: object): Promise<void>;
      };
      const state = internal.transactions.get(scope as object);

      await expect(internal.commit(scope as object, state!)).rejects.toMatchObject({ name: 'G04bTransactionError' });
      expect(harness.commitTransaction).not.toHaveBeenCalled();
      expect(harness.abortTransaction).toHaveBeenCalledTimes(1);
      expect(harness.abortTransaction).toHaveBeenCalledWith({ timeoutMS: 2_000 });
      expect(harness.endSession).toHaveBeenCalledTimes(1);
      expect(internal.transactions.get(scope as object)).toBeUndefined();
    });
  });

  test('keeps a genuinely stale binding held before the initial sender, with no abort or endSession', async () => {
    const harness = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_initial_genuine_owner_stale');
    const toArray = jest.fn(async () => []);
    (adapter as unknown as { collections: unknown }).collections = {
      faceSlots: { find: jest.fn(() => ({ limit: jest.fn(() => ({ toArray })) })) },
    };
    let scope!: ReturnType<typeof SCOPE>;
    let state!: object;
    const internal = adapter as unknown as {
      readonly transactions: WeakMap<object, object>;
      commit(context: object, transaction: object): Promise<void>;
    };

    await withActiveBinding(async (binding) => {
      attachG10bScopedPersistenceBindingResolver(
        adapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );
      scope = SCOPE();
      await adapter.readMapping(scope, 'qualification-1');
      state = internal.transactions.get(scope as object)!;
    });

    // The coordinator has now settled, so this is the genuine captured
    // binding's owner fence—not a synthetic facade rejection.
    await expect(internal.commit(scope as object, state)).rejects.toMatchObject({ name: 'G04bTransactionError' });
    expect(harness.commitTransaction).not.toHaveBeenCalled();
    expect(harness.abortTransaction).not.toHaveBeenCalled();
    expect(harness.endSession).not.toHaveBeenCalled();
    expect(internal.transactions.get(scope as object)).toBe(state);
  });

  test('routes a synthetic pre-sender adapter facade rejection through authority cleanup before any sender call', async () => {
    await withActiveBinding(async (binding) => {
      const harness = mongoHarness();
      const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_initial_owner_stale');
      const toArray = jest.fn(async () => []);
      (adapter as unknown as { collections: unknown }).collections = {
        faceSlots: { find: jest.fn(() => ({ limit: jest.fn(() => ({ toArray })) })) },
      };
      attachG10bScopedPersistenceBindingResolver(
        adapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );
      const scope = SCOPE();
      await adapter.readMapping(scope, 'qualification-1');
      const internal = adapter as unknown as {
        readonly transactions: WeakMap<object, object>;
        commit(context: object, transaction: object): Promise<void>;
      };
      const state = internal.transactions.get(scope as object) as {
        g10bExecutionFacade: unknown;
      };
      const staleOwner = new OperationBudgetBindingError('OWNER_STALE', 'owner became stale before initial sender');
      const authority = {
        abortOnce: async (send: (context: { readonly timeoutMs: number; readonly attempt: number }) => Promise<void> | void) => {
          await send({ timeoutMs: 2_000, attempt: 0 });
          return 'NO_EFFECT_CONFIRMED' as const;
        },
        terminate: () => undefined,
      };
      state.g10bExecutionFacade = {
        executeCrud: async () => undefined,
        executeInitialCommit: async () => { throw staleOwner; },
        finish: () => undefined,
        beginPrecommitTermination: () => authority,
      };

      await expect(internal.commit(scope as object, state)).rejects.toMatchObject({
        name: 'G04bTransactionError', cause: staleOwner,
      });
      expect(harness.commitTransaction).not.toHaveBeenCalled();
      expect(harness.abortTransaction).toHaveBeenCalledTimes(1);
      expect(harness.abortTransaction).toHaveBeenCalledWith({ timeoutMS: 2_000 });
      expect(harness.endSession).toHaveBeenCalledTimes(1);
      expect(internal.transactions.get(scope as object)).toBeUndefined();
    });
  });

  test('finishes the active round when sidecar-attached session allocation throws', async () => {
    await withActiveBinding(async (binding) => {
      const allocationFailure = new Error('session allocation failed');
      const adapter = new G04bMongoPersistenceAdapter({
        db: jest.fn(() => ({})),
        on: jest.fn(),
        startSession: jest.fn(() => { throw allocationFailure; }),
      } as unknown as MongoClient, 'g10b_sidecar_start_session_failure');
      attachG10bScopedPersistenceBindingResolver(
        adapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );

      await expect(adapter.readSourceFacts(SCOPE(), 'source-1')).rejects.toBe(allocationFailure);

      // A leaked first round would reject this second facade as ROUND_ACTIVE.
      const recovery = createG10bScopedPersistenceExecutionFacade(binding);
      expect(recovery).toBeDefined();
      recovery!.finish();
    });
  });

  test('finishes the active round when transaction start throws after session allocation', async () => {
    await withActiveBinding(async (binding) => {
      const harness = mongoHarness();
      const transactionFailure = new Error('transaction start failed');
      harness.startTransaction.mockImplementation(() => { throw transactionFailure; });
      const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_start_transaction_failure');
      attachG10bScopedPersistenceBindingResolver(
        adapter,
        createG10bScopedPersistenceBindingResolver(() => binding),
      );

      await expect(adapter.readSourceFacts(SCOPE(), 'source-1')).rejects.toMatchObject({
        name: 'G04bTransactionError',
        cause: transactionFailure,
      });

      const recovery = createG10bScopedPersistenceExecutionFacade(binding);
      expect(recovery).toBeDefined();
      recovery!.finish();
    });
  });
});
