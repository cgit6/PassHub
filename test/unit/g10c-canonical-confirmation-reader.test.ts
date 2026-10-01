import type { ClientSession, MongoClient } from 'mongodb';

import {
  createG10cCanonicalConfirmationReader,
} from '../../src/infrastructure/mongo/internal/g10c-canonical-confirmation-reader.js';
import {
  attachG10cPostCommitUnknownHandoffSink,
  createG10cPostCommitUnknownHandoffBundle,
  createG10cRetainedOriginalCommitTerminator,
  handoffG10cPostCommitUnknown,
  prepareG10cRecognitionExpectedImage,
  type G10cRecognitionExpectedImage,
} from '../../src/infrastructure/mongo/internal/g10c-post-commit-unknown-handoff.js';
import { G04bMongoPersistenceAdapter, type G04bCanonicalSnapshot } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
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
}

function mongoHarness(): MongoHarness {
  const commitTransaction = jest.fn(async () => { throw new Error('response lost'); });
  const abortTransaction = jest.fn(async () => undefined);
  const endSession = jest.fn(async () => undefined);
  const session = {
    commitTransaction, abortTransaction, endSession, inTransaction: jest.fn(() => false),
  } as unknown as ClientSession;
  return {
    client: { db: jest.fn(() => ({})), startSession: jest.fn(() => session), on: jest.fn() } as unknown as MongoClient,
    session, commitTransaction, abortTransaction, endSession,
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
          settlement.businessResultPersisted('g10c-canonical-reader-test');
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

function expectedImage(): G10cRecognitionExpectedImage {
  return {
    sourceId: 'source-entry', externalEventId: 'event-1',
    event: {
      direction: 'ENTRY', kind: 'FACE_MATCHED', outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED',
      receivedAtMs: 1_000, qualificationId: 'qualification-1',
      presenceTransition: { from: 'NOT_ENTERED', to: 'INSIDE' },
    },
    qualification: {
      qualificationId: 'qualification-1', incarnation: 'qualification-incarnation-1', version: 4,
      state: {
        validFromMs: 500, validUntilMs: 2_000, presence: 'INSIDE', enteredAtMs: 1_000,
        exitedAtMs: null, revokedAtMs: null, revocationReason: null, expiredTerminalAtMs: null,
      },
    },
    mapping: {
      qualificationId: 'qualification-1', qualificationIncarnation: 'qualification-incarnation-1',
      mappingIncarnation: 'mapping-incarnation-1', version: 9,
    },
    guardVersions: { qr: 7, face: 11 },
  };
}

function snapshot(image: G10cRecognitionExpectedImage): G04bCanonicalSnapshot {
  return {
    event: {
      eventId: 'event-id-generated-by-mongo', sourceId: image.sourceId,
      direction: image.event.direction, kind: image.event.kind, outcome: image.event.outcome,
      reasonCode: image.event.reasonCode, receivedAtMs: image.event.receivedAtMs, recordedAtMs: 1_001,
      qualificationId: image.event.qualificationId, presenceTransition: image.event.presenceTransition,
    },
    qualification: image.qualification, mapping: image.mapping, guardVersions: image.guardVersions,
  };
}

function takeUnknown(
  h: MongoHarness,
  binding: OperationBudgetBinding,
  databaseName: string,
  image?: G10cRecognitionExpectedImage,
) {
  const adapter = new G04bMongoPersistenceAdapter(h.client, databaseName);
  const bundle = createG10cPostCommitUnknownHandoffBundle();
  attachG10cPostCommitUnknownHandoffSink(adapter, bundle.sink);
  const round = beginOperationExecutionRound(binding);
  finishOperationExecutionRound(binding, round);
  const scoped = scope();
  if (image !== undefined) {
    const internal = adapter as unknown as {
      readonly g10cRecognitionExpectedImageCapture: Parameters<typeof prepareG10cRecognitionExpectedImage>[0];
    };
    prepareG10cRecognitionExpectedImage(internal.g10cRecognitionExpectedImageCapture, scoped, image);
  }
  handoffG10cPostCommitUnknown(adapter, scoped, h.session, binding);
  const handoff = bundle.owner.take(bundle.owner.pending()[0]!);
  return { adapter, bundle, handoff };
}

async function advancePastOriginalCommit(
  retained: ReturnType<typeof takeUnknown>,
): Promise<void> {
  const sender = createG10cRetainedOriginalCommitTerminator(retained.bundle.owner, retained.handoff);
  await expect(sender.attemptOriginalCommit()).resolves.toMatchObject({ delivery: 'REJECTED_STILL_UNKNOWN' });
}

describe('G10c canonical confirmation reader', () => {
  test('uses only a due canonical-read action, passes its timeout to a full-snapshot port, and settles an exact image', async () => {
    let now = 1_000;
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const input = expectedImage();
      const retained = takeUnknown(h, binding, 'g10c_canonical_match', input);
      await advancePastOriginalCommit(retained);
      now += 1_000;
      const read = jest.spyOn(retained.adapter, 'readG10cCanonicalSnapshot').mockImplementation(async (sourceId, externalEventId, timeoutMs) => {
        expect({ sourceId, externalEventId, timeoutMs }).toEqual({ sourceId: 'source-entry', externalEventId: 'event-1', timeoutMs: 123 });
        return snapshot(input);
      });
      const verifier = createG10cCanonicalConfirmationReader(retained.bundle.owner, retained.handoff);

      await expect(verifier.confirmCanonicalRead()).resolves.toEqual({ result: 'MATCHED', attempt: 1, timeoutMs: 123 });
      expect(read).toHaveBeenCalledTimes(1);
      expect(h.commitTransaction).toHaveBeenCalledTimes(1);
      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(h.endSession).not.toHaveBeenCalled();
      expect('session' in (verifier as object)).toBe(false);
      expect(() => retained.bundle.owner.admitNextConfirmation(retained.handoff)).toThrow(/already confirmed/i);
    }, () => now);
  });

  test('treats absent, mismatched, and failed reads as inconclusive rather than accepting a bare event', async () => {
    for (const caseName of ['absent', 'mismatch', 'failure'] as const) {
      let now = 1_000;
      await withActiveBinding(async (binding) => {
        const h = mongoHarness();
        const input = expectedImage();
        const retained = takeUnknown(h, binding, `g10c_canonical_${caseName}`, input);
        await advancePastOriginalCommit(retained);
        now += 1_000;
        const wrong = snapshot(input);
        const response = caseName === 'absent' ? null
          : caseName === 'mismatch' ? { ...wrong, guardVersions: { qr: 8, face: 11 } }
            : new Error('primary unavailable');
        const read = jest.spyOn(retained.adapter, 'readG10cCanonicalSnapshot').mockImplementation(async () => {
          if (response instanceof Error) throw response;
          return response;
        });
        const verifier = createG10cCanonicalConfirmationReader(retained.bundle.owner, retained.handoff);
        await expect(verifier.confirmCanonicalRead()).resolves.toEqual({ result: 'INCONCLUSIVE', attempt: 1, timeoutMs: 123 });
        expect(read).toHaveBeenCalledTimes(1);
        now += 2_000;
        expect(retained.bundle.owner.admitNextConfirmation(retained.handoff)).toMatchObject({ kind: 'ORIGINAL_COMMIT', attempt: 2 });
        expect(h.abortTransaction).not.toHaveBeenCalled();
        expect(h.endSession).not.toHaveBeenCalled();
      }, () => now);
    }
  });

  test('cannot skip the original commit, borrow a foreign owner, or mutate the captured expected image', async () => {
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const retained = takeUnknown(h, binding, 'g10c_canonical_owner');
      const read = jest.spyOn(retained.adapter, 'readG10cCanonicalSnapshot');
      const verifier = createG10cCanonicalConfirmationReader(retained.bundle.owner, retained.handoff);
      await expect(verifier.confirmCanonicalRead()).rejects.toThrow(/canonical read is not the current prescribed/i);
      expect(read).not.toHaveBeenCalled();
      expect(h.commitTransaction).not.toHaveBeenCalled();
      // The early canonical worker must not have allocated or settled the
      // ORIGINAL_COMMIT permit.  The retained owner can still obtain it.
      const original = retained.bundle.owner.admitNextConfirmation(retained.handoff);
      expect(original).toMatchObject({ kind: 'ORIGINAL_COMMIT', attempt: 0, timeoutMs: 123 });
      retained.bundle.owner.settleConfirmation(retained.handoff, original, 'STILL_UNKNOWN');

      const foreign = createG10cPostCommitUnknownHandoffBundle();
      expect(() => createG10cCanonicalConfirmationReader(foreign.owner, retained.handoff))
        .toThrow(/owner is foreign/i);
      expect(h.abortTransaction).not.toHaveBeenCalled();
      expect(h.endSession).not.toHaveBeenCalled();
    }, () => 1_000);
  });

  test('missing prepared material fails before canonical admission and cannot consume that turn', async () => {
    let now = 1_000;
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const retained = takeUnknown(h, binding, 'g10c_canonical_missing_material');
      await advancePastOriginalCommit(retained);
      now += 1_000;
      const verifier = createG10cCanonicalConfirmationReader(retained.bundle.owner, retained.handoff);
      await expect(verifier.confirmCanonicalRead()).rejects.toThrow(/material is unavailable/i);
      expect(h.commitTransaction).toHaveBeenCalledTimes(1);
      expect(retained.adapter.readG10cCanonicalSnapshot).toBeDefined();
      const canonical = retained.bundle.owner.admitNextConfirmation(retained.handoff);
      expect(canonical).toMatchObject({ kind: 'CANONICAL_READ', attempt: 1, timeoutMs: 123 });
      retained.bundle.owner.settleConfirmation(retained.handoff, canonical, 'STILL_UNKNOWN');
    }, () => now);
  });

  test('before the one-second canonical delay it neither closes nor consumes, then the same reader can run when due', async () => {
    let now = 1_000;
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const input = expectedImage();
      const retained = takeUnknown(h, binding, 'g10c_canonical_not_due', input);
      await advancePastOriginalCommit(retained);
      now += 999;
      const read = jest.spyOn(retained.adapter, 'readG10cCanonicalSnapshot').mockResolvedValue(snapshot(input));
      const verifier = createG10cCanonicalConfirmationReader(retained.bundle.owner, retained.handoff);
      await expect(verifier.confirmCanonicalRead()).rejects.toThrow(/not.*prescribed/i);
      expect(read).not.toHaveBeenCalled();
      now += 1;
      await expect(verifier.confirmCanonicalRead()).resolves.toMatchObject({ result: 'MATCHED', attempt: 1 });
      expect(read).toHaveBeenCalledTimes(1);
    }, () => now);
  });

  test('freezes the adapter-prepared image before unknown handoff', async () => {
    let now = 1_000;
    await withActiveBinding(async (binding) => {
      const h = mongoHarness();
      const input = expectedImage();
      const retained = takeUnknown(h, binding, 'g10c_canonical_frozen_material', input);
      (input.event as { reasonCode: string }).reasonCode = 'mutated-after-prepare';
      await advancePastOriginalCommit(retained);
      now += 1_000;
      const read = jest.spyOn(retained.adapter, 'readG10cCanonicalSnapshot')
        .mockResolvedValue(snapshot(expectedImage()));
      const verifier = createG10cCanonicalConfirmationReader(retained.bundle.owner, retained.handoff);
      await expect(verifier.confirmCanonicalRead()).resolves.toMatchObject({ result: 'MATCHED' });
      expect(read).toHaveBeenCalledTimes(1);
    }, () => now);
  });
});
