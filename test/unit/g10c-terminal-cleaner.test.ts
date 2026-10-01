import type { ClientSession, MongoClient } from 'mongodb';

import {
  attachG10cPostCommitUnknownHandoffSink,
  createG10cPostCommitUnknownHandoffBundle,
  createG10cPostCommitUnknownTerminalCleaner,
  createG10cRetainedOriginalCommitTerminator,
  handoffG10cPostCommitUnknown,
} from '../../src/infrastructure/mongo/internal/g10c-post-commit-unknown-handoff.js';
import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import { createAccessScopeContext } from '../../src/shared/access-scope-context.js';
import {
  beginOperationExecutionRound,
  createOperationBudgetBindingFactory,
  finishOperationExecutionRound,
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
  readonly inTransaction: jest.Mock;
}

function mongoHarness(): MongoHarness {
  const commitTransaction = jest.fn(async () => undefined);
  const abortTransaction = jest.fn(async () => undefined);
  const endSession = jest.fn(async () => undefined);
  const inTransaction = jest.fn(() => false);
  const session = { commitTransaction, abortTransaction, endSession, inTransaction } as unknown as ClientSession;
  return {
    client: { db: jest.fn(() => ({})), startSession: jest.fn(() => session), on: jest.fn() } as unknown as MongoClient,
    session, commitTransaction, abortTransaction, endSession, inTransaction,
  };
}

function scope() {
  return createAccessScopeContext({
    epoch: '11111111-1111-4111-8111-111111111111',
    owner: '22222222-2222-4222-8222-222222222222',
    generation: '33333333-3333-4333-8333-333333333333',
  });
}

async function withActiveBinding<T>(work: (binding: OperationBudgetBinding) => Promise<T> | T): Promise<T> {
  let value!: T;
  let failure: unknown;
  const clock = { nowMs: () => 1_000 };
  const coordinator = createWriteOperationCoordinatorBundle({
    clock,
    executors: {
      managementCreate: async (_input, context: WriteOperationContext, settlement) => {
        try {
          const binding = createOperationBudgetBindingFactory({
            clock, assertContinuationEvidence: () => undefined, config: { singleCommandMs: 123 },
          }).bind(context);
          value = await work(binding);
          settlement.businessResultPersisted('g10c-terminal-cleaner-test');
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
  await coordinator.managementCreate.enqueue(undefined);
  if (failure !== undefined) throw failure;
  return value;
}

function takeRetainedTransaction(h: MongoHarness, binding: OperationBudgetBinding, databaseName: string) {
  const adapter = new G04bMongoPersistenceAdapter(h.client, databaseName);
  const bundle = createG10cPostCommitUnknownHandoffBundle();
  attachG10cPostCommitUnknownHandoffSink(adapter, bundle.sink);
  const scoped = scope();
  const round = beginOperationExecutionRound(binding);
  finishOperationExecutionRound(binding, round);
  const internal = adapter as unknown as {
    readonly transactions: WeakMap<object, object>;
  };
  // This deliberately models the exact post-sender boundary: the round is
  // finished, initial commit has been invoked, and no facade can issue CRUD.
  internal.transactions.set(scoped as object, {
    session: h.session,
    g10bScopedPersistenceBinding: binding,
    g10bExecutionFacade: undefined,
    initialCommitInvoked: true,
    datasetEpoch: '11111111-1111-4111-8111-111111111111',
    sourceFacts: new Map(), sourceGuards: new Map(), qualifications: new Map(), mappings: new Map(),
    recognitionEvent: null, stage: 'commit',
  });
  handoffG10cPostCommitUnknown(adapter, scoped, h.session, binding as never);
  const handoff = bundle.owner.take(bundle.owner.pending()[0]!);
  return { adapter, bundle, handoff, scoped, internal };
}

describe('G10c terminal retained-session cleaner', () => {
  test('cannot be claimed before a genuine confirmed result', async () => {
    await withActiveBinding((binding) => {
      const h = mongoHarness();
      const retained = takeRetainedTransaction(h, binding, 'g10c_terminal_before_confirmation');

      expect(() => createG10cPostCommitUnknownTerminalCleaner(retained.bundle.owner, retained.handoff))
        .toThrow(/no terminal outcome/i);
      expect(h.endSession).not.toHaveBeenCalled();
      expect(h.abortTransaction).not.toHaveBeenCalled();
    });
  });

  test('ends the original session once, without abort, and removes all retained authority after original-commit confirmation', async () => {
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const retained = takeRetainedTransaction(h, binding, 'g10c_terminal_original_confirmed');
      const sender = createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff);

      await expect(sender.attemptOriginalCommit()).resolves.toMatchObject({ delivery: 'COMMIT_CONFIRMED' });
      const cleaner = createG10cPostCommitUnknownTerminalCleaner(retained.bundle.owner, retained.handoff);
      await expect(cleaner.cleanupAfterConfirmedOutcome()).resolves.toBeUndefined();

      expect(h.commitTransaction).toHaveBeenCalledTimes(1);
      expect(h.endSession).toHaveBeenCalledTimes(1);
      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(retained.internal.transactions.get(retained.scoped as object)).toBeUndefined();
      await expect(cleaner.cleanupAfterConfirmedOutcome()).rejects.toThrow(/closed/i);
      expect(() => createG10cPostCommitUnknownTerminalCleaner(retained.bundle.owner, retained.handoff))
        .toThrow(/foreign or forged/i);
      expect(h.endSession).toHaveBeenCalledTimes(1);
    });
  });

  test('rejects a foreign queue owner before it can claim terminal session release', async () => {
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const retained = takeRetainedTransaction(h, binding, 'g10c_terminal_foreign_owner');
      await createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff).attemptOriginalCommit();
      const foreign = createG10cPostCommitUnknownHandoffBundle();

      expect(() => createG10cPostCommitUnknownTerminalCleaner(foreign.owner, retained.handoff))
        .toThrow(/owner is foreign/i);
      expect(h.endSession).not.toHaveBeenCalled();
      expect(h.abortTransaction).not.toHaveBeenCalled();
    });
  });

  test('fails closed rather than aborting or ending a still-active retained transaction', async () => {
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      h.inTransaction.mockReturnValue(true);
      const retained = takeRetainedTransaction(h, binding, 'g10c_terminal_active_session');
      const sender = createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff);
      await sender.attemptOriginalCommit();
      const cleaner = createG10cPostCommitUnknownTerminalCleaner(retained.bundle.owner, retained.handoff);

      await expect(cleaner.cleanupAfterConfirmedOutcome()).rejects.toThrow(/still active/i);
      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(h.endSession).not.toHaveBeenCalled();
      expect(retained.internal.transactions.get(retained.scoped as object)).toBeDefined();
      await expect(cleaner.cleanupAfterConfirmedOutcome()).rejects.toThrow(/closed/i);
      expect(() => createG10cPostCommitUnknownTerminalCleaner(retained.bundle.owner, retained.handoff))
        .toThrow(/foreign or forged/i);
    });
  });

  test('spends the cleaner after a session-close failure: no abort and no second close attempt', async () => {
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      h.endSession.mockRejectedValueOnce(new Error('network close failed'));
      const retained = takeRetainedTransaction(h, binding, 'g10c_terminal_close_failure');
      const sender = createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff);
      await sender.attemptOriginalCommit();
      const cleaner = createG10cPostCommitUnknownTerminalCleaner(retained.bundle.owner, retained.handoff);

      await expect(cleaner.cleanupAfterConfirmedOutcome()).rejects.toThrow(/session release failed/i);
      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(h.endSession).toHaveBeenCalledTimes(1);
      expect(retained.internal.transactions.get(retained.scoped as object)).toBeUndefined();
      await expect(cleaner.cleanupAfterConfirmedOutcome()).rejects.toThrow(/closed/i);
      expect(h.endSession).toHaveBeenCalledTimes(1);
    });
  });
});
