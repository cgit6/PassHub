import type { ClientSession, MongoClient } from 'mongodb';

import { createManagementChangePlan } from '../../src/access/application/internal-plans.js';
import {
  createOperationBudgetBindingFactory,
  type OperationBudgetBinding,
} from '../../src/access/application/internal/operation-budget-binding.js';
import {
  createWriteOperationCoordinatorBundle,
  type WriteOperationContext,
} from '../../src/access/application/internal/write-operation-coordinator.js';
import { createAccessScopeContext } from '../../src/shared/access-scope-context.js';
import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import {
  attachG10bScopedPersistenceBindingResolver,
  createG10bScopedPersistenceBindingResolver,
} from '../../src/infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.js';
import {
  attachG10cPostCommitUnknownHandoffSink,
  createG10cPostCommitUnknownHandoffBundle,
  createG10cRetainedOriginalCommitTerminator,
} from '../../src/infrastructure/mongo/internal/g10c-post-commit-unknown-handoff.js';
import { createG10cCanonicalConfirmationReader } from '../../src/infrastructure/mongo/internal/g10c-canonical-confirmation-reader.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const QUALIFICATION_ID = '33333333-3333-4333-8333-333333333333';
const QUALIFICATION_INCARNATION = '44444444-4444-4444-8444-444444444444';

type ManagementOperation = 'CREATE' | 'UPDATE' | 'REVOKE' | 'EXPIRE';

interface MutableClock {
  value: number;
  nowMs(): number;
}

interface StoredQualification {
  _id: string;
  incarnation: string;
  version: number;
  displayName: string;
  validFrom: Date;
  validUntil: Date;
  createdBy: string;
  qrLookupDigest: string;
  presence: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  enteredAt: Date | null;
  exitedAt: Date | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  expiredTerminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Harness {
  readonly adapter: G04bMongoPersistenceAdapter;
  readonly initialCommit: jest.Mock;
  readonly receiptInsert: jest.Mock;
  readonly qualificationInsert: jest.Mock;
  readonly qualificationUpdate: jest.Mock;
  readonly receipts: Array<Record<string, unknown>>;
}

function scope() {
  return createAccessScopeContext({
    epoch: EPOCH,
    owner: '55555555-5555-4555-8555-555555555555',
    generation: '66666666-6666-4666-8666-666666666666',
  });
}

function existingQualification(): StoredQualification {
  return {
    _id: QUALIFICATION_ID,
    incarnation: QUALIFICATION_INCARNATION,
    version: 4,
    displayName: 'Ada before change',
    validFrom: new Date(1_000),
    validUntil: new Date(9_000),
    createdBy: ACTOR_ID,
    qrLookupDigest: 'a'.repeat(64),
    presence: 'NOT_ENTERED',
    enteredAt: null,
    exitedAt: null,
    revokedAt: null,
    revocationReason: null,
    expiredTerminalAt: null,
    createdAt: new Date(1_000),
    updatedAt: new Date(2_000),
  };
}

/**
 * A command-ordering fake, not a direct call to any private capture seam.
 * It retains transaction writes so the later, real canonical observer can
 * re-read exactly what the original public writer wrote.
 */
function harness(seed: StoredQualification | null): Harness {
  let qualification = seed === null ? null : { ...seed };
  const receipts: Array<Record<string, unknown>> = [];
  const metadata = {
    _id: 'system' as const,
    datasetEpoch: EPOCH,
    slotCount: 0,
    qrGuardVersion: 8,
    faceGuardVersion: 13,
  };
  let initialActive = true;
  const initialCommit = jest.fn(async () => {
    throw Object.assign(new Error('post-send response lost'), {
      errorLabels: ['UnknownTransactionCommitResult'],
    });
  });
  const initialSession = {
    startTransaction: jest.fn(),
    commitTransaction: initialCommit,
    abortTransaction: jest.fn(async () => { initialActive = false; }),
    endSession: jest.fn(async () => undefined),
    inTransaction: jest.fn(() => initialActive),
  } as unknown as ClientSession;
  let observerActive = false;
  const observerSession = {
    startTransaction: jest.fn(() => { observerActive = true; }),
    commitTransaction: jest.fn(async () => { observerActive = false; }),
    abortTransaction: jest.fn(async () => { observerActive = false; }),
    endSession: jest.fn(async () => undefined),
    inTransaction: jest.fn(() => observerActive),
  } as unknown as ClientSession;
  let sessions = 0;

  const qualificationInsert = jest.fn(async (document: StoredQualification) => {
    qualification = { ...document };
    return { acknowledged: true };
  });
  const qualificationUpdate = jest.fn(async (_filter: Record<string, unknown>, update: Record<string, unknown>) => {
    if (qualification === null) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    const set = update.$set as Record<string, unknown> | undefined;
    const increment = update.$inc as Record<string, number> | undefined;
    if (set !== undefined) Object.assign(qualification, set);
    if (increment?.version !== undefined) qualification.version += increment.version;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  const receiptInsert = jest.fn(async (document: Record<string, unknown>) => {
    receipts.push({ ...document });
    return { acknowledged: true };
  });
  const qualificationFindOne = jest.fn(async (filter: Record<string, unknown>) => {
    if (qualification === null) return null;
    for (const [key, value] of Object.entries(filter)) {
      if (qualification[key as keyof StoredQualification] !== value) return null;
    }
    return { ...qualification };
  });
  const metadataFindOne = jest.fn(async () => ({ ...metadata }));
  const metadataUpdateOne = jest.fn(async (_filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const increment = update.$inc as Record<string, number> | undefined;
    if (increment?.qrGuardVersion !== undefined) metadata.qrGuardVersion += increment.qrGuardVersion;
    if (increment?.faceGuardVersion !== undefined) metadata.faceGuardVersion += increment.faceGuardVersion;
    if (increment?.slotCount !== undefined) metadata.slotCount += increment.slotCount;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  const faceSlotsFind = jest.fn(() => {
    const toArray = jest.fn(async () => []);
    return { limit: jest.fn(() => ({ toArray })), toArray };
  });
  const managementReceiptsFindOne = jest.fn(async (filter: Record<string, unknown>) => {
    const receipt = receipts.find((candidate) => candidate._id === filter._id);
    return receipt === undefined ? null : { ...receipt };
  });
  const client = {
    db: jest.fn(() => ({})),
    startSession: jest.fn(() => {
      sessions += 1;
      return sessions === 1 ? initialSession : observerSession;
    }),
    on: jest.fn(),
  } as unknown as MongoClient;
  const adapter = new G04bMongoPersistenceAdapter(client, 'g10c_management_stage_wiring');
  (adapter as unknown as { collections: unknown }).collections = {
    qualifications: { insertOne: qualificationInsert, updateOne: qualificationUpdate, findOne: qualificationFindOne },
    managementReceipts: { insertOne: receiptInsert, findOne: managementReceiptsFindOne },
    metadata: { findOne: metadataFindOne, updateOne: metadataUpdateOne },
    faceSlots: {
      find: faceSlotsFind,
      findOne: jest.fn(async () => null),
      countDocuments: jest.fn(async () => 0),
    },
  };
  return { adapter, initialCommit, receiptInsert, qualificationInsert, qualificationUpdate, receipts };
}

async function withBinding<T>(
  clock: MutableClock,
  work: (binding: OperationBudgetBinding) => Promise<T>,
): Promise<T> {
  let result!: T;
  let failure: unknown;
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
          result = await work(binding);
          settlement.businessResultPersisted('g10c-management-stage-wiring');
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
  return result;
}

function plan(operation: ManagementOperation) {
  if (operation === 'CREATE') {
    return createManagementChangePlan({
      operation, qualificationId: null, displayName: 'Ada created', validFromMs: 2_000, validUntilMs: 12_000,
      faceMapping: null, revocationReason: null, receivedAtMs: 10_000, actorId: ACTOR_ID,
    });
  }
  return createManagementChangePlan({
    operation,
    qualificationId: QUALIFICATION_ID,
    displayName: operation === 'UPDATE' ? 'Ada updated' : null,
    validFromMs: operation === 'UPDATE' ? 2_000 : null,
    validUntilMs: operation === 'UPDATE' ? 12_000 : null,
    faceMapping: operation === 'UPDATE' ? undefined : null,
    revocationReason: operation === 'REVOKE' ? 'visit cancelled' : null,
    receivedAtMs: 10_000,
    actorId: ACTOR_ID,
    expectedQualification: {
      qualificationId: QUALIFICATION_ID,
      incarnation: QUALIFICATION_INCARNATION,
      version: 4,
    },
  });
}

describe('G10c management public writer wiring', () => {
  test.each(['CREATE', 'UPDATE', 'REVOKE', 'EXPIRE'] as const)(
    '%s writes a receipt and captures its post-write material before a response-lost initial commit',
    async (operation) => {
      const clock: MutableClock = { value: 1_000, nowMs(): number { return this.value; } };
      await withBinding(clock, async (binding) => {
        const h = harness(operation === 'CREATE' ? null : existingQualification());
        const handoffs = createG10cPostCommitUnknownHandoffBundle();
        attachG10bScopedPersistenceBindingResolver(
          h.adapter,
          createG10bScopedPersistenceBindingResolver(() => binding),
        );
        attachG10cPostCommitUnknownHandoffSink(h.adapter, handoffs.sink);

        await expect(h.adapter.stageManagementChange(scope(), plan(operation))).rejects.toMatchObject({
          name: 'G04bTransactionError', facts: { kind: 'UNKNOWN_COMMIT_RESULT', stage: 'commit' },
        });

        // The only input to confirmation is the opaque handoff.  In
        // particular, this test does not access either adapter-private image
        // capability or manually install an expected image.
        expect(h.receiptInsert).toHaveBeenCalledTimes(1);
        expect(h.receipts).toHaveLength(1);
        expect(h.initialCommit.mock.invocationCallOrder[0]).toBeGreaterThan(
          h.receiptInsert.mock.invocationCallOrder[0]!,
        );
        expect(h.qualificationInsert.mock.calls.length + h.qualificationUpdate.mock.calls.length).toBe(1);

        const retained = handoffs.owner.take(handoffs.owner.pending()[0]!);
        const original = createG10cRetainedOriginalCommitTerminator(handoffs.owner, retained);
        await expect(original.attemptOriginalCommit()).resolves.toMatchObject({ delivery: 'REJECTED_STILL_UNKNOWN' });

        clock.value += 1_000;
        const confirmation = createG10cCanonicalConfirmationReader(handoffs.owner, retained);
        await expect(confirmation.confirmCanonicalRead()).resolves.toEqual({
          result: 'MATCHED', attempt: 1, timeoutMs: 123,
        });
      });
    },
  );
});
