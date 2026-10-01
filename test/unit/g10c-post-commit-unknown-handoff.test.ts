import type { ClientSession, MongoClient } from 'mongodb';

import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import {
  attachG10bScopedPersistenceBindingResolver,
  createG10bScopedPersistenceBindingResolver,
} from '../../src/infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.js';
import {
  attachG10cPostCommitUnknownHandoffSink,
  createG10cPostCommitUnknownHandoffBundle,
  handoffG10cPostCommitUnknown,
} from '../../src/infrastructure/mongo/internal/g10c-post-commit-unknown-handoff.js';
import { createAccessScopeContext } from '../../src/shared/access-scope-context.js';
import {
  createOperationBudgetBindingFactory,
  beginOperationExecutionRound,
  finishOperationExecutionRound,
  registerTrustedWriteOperationContext,
  startOperationPrecommitTermination,
  type OperationBudgetBinding,
} from '../../src/access/application/internal/operation-budget-binding.js';
import { createWriteOperationCoordinatorBundle, type WriteOperationContext } from '../../src/access/application/internal/write-operation-coordinator.js';

const SCOPE = () => createAccessScopeContext({
  epoch: '11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
  generation: '33333333-3333-4333-8333-333333333333',
});

interface MongoHarness {
  readonly client: MongoClient;
  readonly commitTransaction: jest.Mock;
  readonly abortTransaction: jest.Mock;
  readonly endSession: jest.Mock;
}

function mongoHarness(): MongoHarness {
  let active = false;
  const commitTransaction = jest.fn(async () => { active = false; });
  const abortTransaction = jest.fn(async () => { active = false; });
  const endSession = jest.fn(async () => undefined);
  const session = {
    startTransaction: jest.fn(() => { active = true; }),
    commitTransaction,
    inTransaction: jest.fn(() => active),
    abortTransaction,
    endSession,
  } as unknown as ClientSession;
  return {
    client: { db: jest.fn(() => ({})), startSession: jest.fn(() => session), on: jest.fn() } as unknown as MongoClient,
    commitTransaction,
    abortTransaction,
    endSession,
  };
}

async function withActiveBinding<T>(work: (binding: OperationBudgetBinding) => T | Promise<T>): Promise<T> {
  let value!: T;
  let failure: unknown;
  const clock = { nowMs: () => 1_000 };
  const bundle = createWriteOperationCoordinatorBundle({
    clock,
    executors: {
      managementCreate: async (_input, context: WriteOperationContext, settlement) => {
        try {
          const binding = createOperationBudgetBindingFactory({
            clock, assertContinuationEvidence: () => undefined, config: { singleCommandMs: 123 },
          }).bind(context);
          value = await work(binding);
          settlement.businessResultPersisted('g10c-handoff-test');
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

function attachBoundAdapter(adapter: G04bMongoPersistenceAdapter, binding: OperationBudgetBinding): void {
  attachG10bScopedPersistenceBindingResolver(
    adapter,
    createG10bScopedPersistenceBindingResolver(() => binding),
  );
  (adapter as unknown as { collections: unknown }).collections = {
    faceSlots: { find: jest.fn(() => ({ limit: jest.fn(() => ({ toArray: jest.fn(async () => []) })) })) },
  };
}

describe('G10c post-initial-commit unknown handoff seam', () => {
  test('rejects foreign or duplicate adapter attachments', () => {
    const h = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(h.client, 'g10c_handoff_attach');
    const first = createG10cPostCommitUnknownHandoffBundle();
    const second = createG10cPostCommitUnknownHandoffBundle();

    expect(() => attachG10cPostCommitUnknownHandoffSink(
      Object.freeze({}) as G04bMongoPersistenceAdapter,
      first.sink,
    )).toThrow(/concrete G04b Mongo persistence adapter/i);
    expect(() => attachG10cPostCommitUnknownHandoffSink(adapter, Object.freeze({}) as never)).toThrow(/sink is foreign/i);
    attachG10cPostCommitUnknownHandoffSink(adapter, first.sink);
    expect(() => attachG10cPostCommitUnknownHandoffSink(adapter, second.sink)).toThrow(/already attached/i);
  });

  test('retains one opaque, owner-fenced handoff after an unknown initial commit without cleanup', async () => {
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const commitFailure = new Error('response lost after commit sender');
      h.commitTransaction.mockImplementation(async () => { throw commitFailure; });
      const adapter = new G04bMongoPersistenceAdapter(h.client, 'g10c_handoff_unknown');
      const bundle = createG10cPostCommitUnknownHandoffBundle();
      const foreign = createG10cPostCommitUnknownHandoffBundle();
      attachBoundAdapter(adapter, binding);
      attachG10cPostCommitUnknownHandoffSink(adapter, bundle.sink);
      const scope = SCOPE();
      await adapter.readMapping(scope, 'qualification-1');
      const internal = adapter as unknown as {
        readonly transactions: WeakMap<object, object>;
        commit(context: object, transaction: object): Promise<void>;
      };
      const state = internal.transactions.get(scope as object);

      await expect(internal.commit(scope as object, state!)).rejects.toMatchObject({
        name: 'G04bTransactionError', cause: commitFailure,
        facts: { kind: 'UNKNOWN_COMMIT_RESULT', stage: 'commit' },
      });
      expect(h.commitTransaction).toHaveBeenCalledTimes(1);
      expect(h.commitTransaction).toHaveBeenCalledWith({ timeoutMS: 123 });
      const [handoff] = bundle.owner.pending();
      expect(handoff).toBeDefined();
      expect(Object.isFrozen(handoff!)).toBe(true);
      expect(Reflect.ownKeys(handoff!)).toEqual([]);
      expect('session' in (handoff! as object)).toBe(false);
      expect('executeCrud' in (handoff! as object)).toBe(false);
      expect(foreign.owner.pending()).toEqual([]);
      expect(() => foreign.owner.take(handoff!)).toThrow(/foreign or stale/i);
      expect(bundle.owner.take(handoff!)).toBe(handoff);
      expect(bundle.owner.pending()).toEqual([]);
      expect(() => bundle.owner.take(handoff!)).toThrow(/foreign or stale/i);

      // A second adapter attempt for the same retained transaction cannot mint
      // another claim or issue a second initial commit.
      await expect(internal.commit(scope as object, state!)).rejects.toThrow(/already retained/i);
      expect(h.commitTransaction).toHaveBeenCalledTimes(1);

      // The handoff atomically sealed this original binding as COMMIT_UNKNOWN:
      // it cannot later be diverted into G10b's precommit-abort path.
      expect(() => startOperationPrecommitTermination(binding)).toThrow(/precommit termination is unavailable/i);

      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(h.endSession).not.toHaveBeenCalled();
      expect(internal.transactions.get(scope as object)).toBe(state);
    });
  });

  test('does not retain a normal initial commit and preserves its established session cleanup', async () => {
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const adapter = new G04bMongoPersistenceAdapter(h.client, 'g10c_handoff_normal');
      const bundle = createG10cPostCommitUnknownHandoffBundle();
      attachBoundAdapter(adapter, binding);
      attachG10cPostCommitUnknownHandoffSink(adapter, bundle.sink);
      const scope = SCOPE();
      await adapter.readMapping(scope, 'qualification-1');
      const internal = adapter as unknown as {
        readonly transactions: WeakMap<object, object>;
        commit(context: object, transaction: object): Promise<void>;
      };
      const state = internal.transactions.get(scope as object);

      await expect(internal.commit(scope as object, state!)).resolves.toBeUndefined();
      expect(bundle.owner.pending()).toEqual([]);
      expect(h.commitTransaction).toHaveBeenCalledWith({ timeoutMS: 123 });
      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(h.endSession).toHaveBeenCalledTimes(1);
      expect(internal.transactions.get(scope as object)).toBeUndefined();
    });
  });

  test('rejects an opaque handoff claim once its original operation owner is stale', () => {
    const h = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(h.client, 'g10c_handoff_owner_stale');
    const bundle = createG10cPostCommitUnknownHandoffBundle();
    attachG10cPostCommitUnknownHandoffSink(adapter, bundle.sink);
    let current = true;
    const assertCurrent = (): void => {
      if (!current) throw new Error('owner is stale');
    };
    const owner = Object.freeze({ assertCurrent });
    const context = Object.freeze({
      operationId: '44444444-4444-4444-8444-444444444444',
      receivedAtMs: 1_000,
      sequence: 1n,
      owner,
      assertCurrent,
    });
    registerTrustedWriteOperationContext(context);
    const binding = createOperationBudgetBindingFactory({
      clock: { nowMs: () => 1_000 }, assertContinuationEvidence: () => undefined,
    }).bind(context);
    const round = beginOperationExecutionRound(binding);
    finishOperationExecutionRound(binding, round);
    const scope = SCOPE();
    handoffG10cPostCommitUnknown(adapter, scope, {} as ClientSession, binding);
    const [handoff] = bundle.owner.pending();
    current = false;

    expect(() => bundle.owner.take(handoff!)).toThrow(expect.objectContaining({ code: 'OWNER_STALE' }));
    expect(bundle.owner.pending()).toEqual([handoff]);
    expect(h.commitTransaction).not.toHaveBeenCalled();
    expect(h.abortTransaction).not.toHaveBeenCalled();
    expect(h.endSession).not.toHaveBeenCalled();
  });
});
