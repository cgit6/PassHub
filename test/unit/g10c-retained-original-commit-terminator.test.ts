import type { ClientSession, MongoClient } from 'mongodb';

import {
  G10cRetainedOriginalCommitTerminatorError,
  attachG10cPostCommitUnknownHandoffSink,
  createG10cPostCommitUnknownHandoffBundle,
  createG10cRetainedOriginalCommitTerminator,
  handoffG10cPostCommitUnknown,
} from '../../src/infrastructure/mongo/internal/g10c-post-commit-unknown-handoff.js';
import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import { createAccessScopeContext } from '../../src/shared/access-scope-context.js';
import {
  beginOperationExecutionRound,
  createOperationBudgetBindingFactory,
  finishOperationExecutionRound,
  registerTrustedWriteOperationContext,
  type OperationBudgetBinding,
} from '../../src/access/application/internal/operation-budget-binding.js';
import {
  createWriteOperationCoordinatorBundle,
  type WriteOperationContext,
} from '../../src/access/application/internal/write-operation-coordinator.js';

interface MongoHarness {
  readonly client: MongoClient;
  readonly session: ClientSession;
  readonly commitTransaction: jest.Mock;
  readonly abortTransaction: jest.Mock;
  readonly endSession: jest.Mock;
}

function mongoHarness(): MongoHarness {
  const commitTransaction = jest.fn(async () => undefined);
  const abortTransaction = jest.fn(async () => undefined);
  const endSession = jest.fn(async () => undefined);
  const session = {
    commitTransaction,
    abortTransaction,
    endSession,
    inTransaction: jest.fn(() => false),
  } as unknown as ClientSession;
  return {
    client: {
      db: jest.fn(() => ({})), startSession: jest.fn(() => session), on: jest.fn(),
    } as unknown as MongoClient,
    session,
    commitTransaction,
    abortTransaction,
    endSession,
  };
}

async function withActiveBinding<T>(
  work: (binding: OperationBudgetBinding) => T | Promise<T>,
  nowMs: () => number,
): Promise<T> {
  let value!: T;
  let failure: unknown;
  const clock = { nowMs };
  const bundle = createWriteOperationCoordinatorBundle({
    clock,
    executors: {
      managementCreate: async (_input, context: WriteOperationContext, settlement) => {
        try {
          const binding = createOperationBudgetBindingFactory({
            clock, assertContinuationEvidence: () => undefined, config: { singleCommandMs: 123 },
          }).bind(context);
          value = await work(binding);
          settlement.businessResultPersisted('g10c-retained-original-commit-test');
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

function scope() {
  return createAccessScopeContext({
    epoch: '11111111-1111-4111-8111-111111111111',
    owner: '22222222-2222-4222-8222-222222222222',
    generation: '33333333-3333-4333-8333-333333333333',
  });
}

function takeUnknownHandoff(h: MongoHarness, binding: OperationBudgetBinding, databaseName: string) {
  const adapter = new G04bMongoPersistenceAdapter(h.client, databaseName);
  const bundle = createG10cPostCommitUnknownHandoffBundle();
  attachG10cPostCommitUnknownHandoffSink(adapter, bundle.sink);
  const round = beginOperationExecutionRound(binding);
  finishOperationExecutionRound(binding, round);
  handoffG10cPostCommitUnknown(adapter, scope(),
    h.session, binding);
  const handoff = bundle.owner.take(bundle.owner.pending()[0]!);
  return { bundle, handoff };
}

describe('G10c retained original-commit terminator', () => {
  test('sends exactly the ledger-prescribed original commit and terminally confirms a resolved driver command', async () => {
    await withActiveBinding((binding) => {
      const h = mongoHarness();
      const retained = takeUnknownHandoff(h, binding, 'g10c_original_commit_ack');
      const terminator = createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff);

      return (async () => {
        await expect(terminator.attemptOriginalCommit()).resolves.toEqual({
          delivery: 'COMMIT_CONFIRMED', attempt: 0, timeoutMs: 123,
        });
        expect(h.commitTransaction).toHaveBeenCalledTimes(1);
        expect(h.commitTransaction).toHaveBeenCalledWith({ timeoutMS: 123 });
        expect(h.abortTransaction).not.toHaveBeenCalled();
        expect(h.endSession).not.toHaveBeenCalled();

        expect(() => retained.bundle.owner.admitNextConfirmation(retained.handoff))
          .toThrow(/already confirmed/i);
      })();
    }, () => 1_000);
  });

  test('settles a transport rejection as still unknown, then permits the delayed canonical read', async () => {
    let now = 1_000;
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      h.commitTransaction.mockRejectedValueOnce(new Error('connection dropped'));
      const retained = takeUnknownHandoff(h, binding, 'g10c_original_commit_rejected');
      const terminator = createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff);

      await expect(terminator.attemptOriginalCommit()).resolves.toEqual({
        delivery: 'REJECTED_STILL_UNKNOWN', attempt: 0, timeoutMs: 123,
      });
      expect(h.commitTransaction).toHaveBeenCalledTimes(1);
      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(h.endSession).not.toHaveBeenCalled();
      now += 1_000;
      const canonicalRead = retained.bundle.owner.admitNextConfirmation(retained.handoff);
      expect(canonicalRead).toMatchObject({ kind: 'CANONICAL_READ', attempt: 1, timeoutMs: 123 });
      retained.bundle.owner.settleConfirmation(retained.handoff, canonicalRead, 'CANONICAL_RESULT');
    }, () => now);
  });

  test('is a one-shot initial sender and leaves no later confirmation action after a resolved commit', async () => {
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const retained = takeUnknownHandoff(h, binding, 'g10c_original_commit_once');
      const terminator = createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff);

      await terminator.attemptOriginalCommit();
      await expect(terminator.attemptOriginalCommit()).rejects.toMatchObject<Partial<G10cRetainedOriginalCommitTerminatorError>>({
        code: 'TERMINATOR_CLOSED',
      });
      expect(() => createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff))
        .toThrow(expect.objectContaining({ code: 'TERMINATOR_NOT_INITIAL' }));
      expect(h.commitTransaction).toHaveBeenCalledTimes(1);
      expect(() => retained.bundle.owner.admitNextConfirmation(retained.handoff)).toThrow(/already confirmed/i);
    }, () => 1_000);
  });

  test('does not misclassify a post-send ownership settlement failure as a transport rejection', async () => {
    const h = mongoHarness();
    let current = true;
    const assertCurrent = (): void => {
      if (!current) throw new Error('owner became stale');
    };
    const owner = Object.freeze({ assertCurrent });
    const context = Object.freeze({
      operationId: '66666666-6666-4666-8666-666666666666',
      receivedAtMs: 1_000,
      sequence: 1n,
      owner,
      assertCurrent,
    });
    registerTrustedWriteOperationContext(context);
    const binding = createOperationBudgetBindingFactory({
      clock: { nowMs: () => 1_000 }, assertContinuationEvidence: () => undefined,
      config: { singleCommandMs: 123 },
    }).bind(context);
    const retained = takeUnknownHandoff(h, binding, 'g10c_original_commit_settlement_failure');
    const terminator = createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff);
    h.commitTransaction.mockImplementation(async () => { current = false; });

    await expect(terminator.attemptOriginalCommit()).rejects.toMatchObject({ code: 'OWNER_STALE' });
    expect(h.commitTransaction).toHaveBeenCalledTimes(1);
    expect(h.abortTransaction).not.toHaveBeenCalled();
    expect(h.endSession).not.toHaveBeenCalled();
  });

  test('rejects a foreign owner before it can obtain the retained session', async () => {
    await withActiveBinding((binding) => {
      const h = mongoHarness();
      const retained = takeUnknownHandoff(h, binding, 'g10c_original_commit_foreign');
      const foreign = createG10cPostCommitUnknownHandoffBundle();

      expect(() => createG10cRetainedOriginalCommitTerminator(foreign.owner, retained.handoff))
        .toThrow(/owner is foreign/i);
      expect(h.commitTransaction).not.toHaveBeenCalled();
      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(h.endSession).not.toHaveBeenCalled();
    }, () => 1_000);
  });
});
