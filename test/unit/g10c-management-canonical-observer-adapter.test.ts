import type { ClientSession, MongoClient } from 'mongodb';

import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';

const RECEIPT = Object.freeze({
  _id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operation: 'UPDATE' as const,
  qualificationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  qualificationIncarnation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', qualificationVersion: 7,
});
const QUALIFICATION = Object.freeze({
  _id: RECEIPT.qualificationId, incarnation: RECEIPT.qualificationIncarnation, version: 7,
  displayName: 'Ada', validFrom: new Date(500), validUntil: new Date(3_000),
  createdBy: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', qrLookupDigest: 'a'.repeat(64),
  presence: 'NOT_ENTERED' as const, enteredAt: null, exitedAt: null, revokedAt: null,
  revocationReason: null, expiredTerminalAt: null, createdAt: new Date(1_000), updatedAt: new Date(2_000),
});

function harness(options: { readonly receipt?: unknown; readonly qualification?: unknown } = {}) {
  let active = true;
  const startTransaction: jest.Mock = jest.fn();
  const commitTransaction: jest.Mock = jest.fn(async () => { active = false; });
  const abortTransaction: jest.Mock = jest.fn(async () => { active = false; });
  const endSession: jest.Mock = jest.fn(async () => undefined);
  const session = {
    startTransaction, commitTransaction, abortTransaction, endSession, inTransaction: jest.fn(() => active),
  } as unknown as ClientSession;
  const receiptsFindOne: jest.Mock = jest.fn(async () => options.receipt === undefined ? RECEIPT : options.receipt);
  const qualificationsFindOne: jest.Mock = jest.fn(async () => options.qualification === undefined ? QUALIFICATION : options.qualification);
  const slotsFind: jest.Mock = jest.fn(() => ({ toArray: jest.fn(async () => []) }));
  const metadataFindOne: jest.Mock = jest.fn(async () => ({ qrGuardVersion: 3, faceGuardVersion: 5 }));
  const client = {
    db: jest.fn(() => ({})), startSession: jest.fn(() => session), on: jest.fn(),
  } as unknown as MongoClient;
  const adapter = new G04bMongoPersistenceAdapter(client, 'g10c_management_canonical_observer');
  (adapter as unknown as { collections: unknown }).collections = {
    managementReceipts: { findOne: receiptsFindOne },
    qualifications: { findOne: qualificationsFindOne },
    faceSlots: { find: slotsFind },
    metadata: { findOne: metadataFindOne },
  };
  return {
    adapter, startTransaction, commitTransaction, abortTransaction, endSession,
    receiptsFindOne, qualificationsFindOne, slotsFind, metadataFindOne,
  };
}

function expectBounded(options: unknown): void {
  expect(options).toMatchObject({ timeoutMS: expect.any(Number) });
  expect((options as { readonly timeoutMS: number }).timeoutMS).toBeGreaterThanOrEqual(1);
  expect((options as { readonly timeoutMS: number }).timeoutMS).toBeLessThanOrEqual(2_000);
}

describe('G10c management canonical Mongo observer', () => {
  test('uses receipt ID as its first immutable anchor, then reads the exact qualification image in one bounded snapshot', async () => {
    const h = harness();
    await expect(h.adapter.readG10cManagementCanonicalSnapshot(RECEIPT._id, 2_000)).resolves.toMatchObject({
      receipt: { operationId: RECEIPT._id, qualificationVersion: 7 }, qualification: { version: 7, displayName: 'Ada' },
    });
    expect(h.startTransaction).toHaveBeenCalledWith({
      readConcern: { level: 'snapshot' }, readPreference: 'primary', writeConcern: { w: 'majority', j: true },
    });
    expect(h.receiptsFindOne).toHaveBeenCalledWith({ _id: RECEIPT._id }, expect.objectContaining({ session: expect.anything() }));
    expectBounded(h.receiptsFindOne.mock.calls[0]![1]);
    expect(h.qualificationsFindOne).toHaveBeenCalledWith({
      _id: RECEIPT.qualificationId,
      incarnation: RECEIPT.qualificationIncarnation,
      version: RECEIPT.qualificationVersion,
    }, expect.objectContaining({ session: expect.anything() }));
    expectBounded(h.qualificationsFindOne.mock.calls[0]![1]);
    expectBounded(h.metadataFindOne.mock.calls[0]![1]);
    expectBounded(h.commitTransaction.mock.calls[0]![0]);
    expect(h.abortTransaction).not.toHaveBeenCalled();
    expect(h.endSession).toHaveBeenCalledTimes(1);
  });

  test('accepts neither an absent receipt nor a receipt whose exact qualification version is absent', async () => {
    const absent = harness({ receipt: null });
    await expect(absent.adapter.readG10cManagementCanonicalSnapshot(RECEIPT._id, 2_000)).resolves.toBeNull();
    expect(absent.qualificationsFindOne).not.toHaveBeenCalled();
    expectBounded(absent.commitTransaction.mock.calls[0]![0]);

    const stale = harness({ qualification: null });
    await expect(stale.adapter.readG10cManagementCanonicalSnapshot(RECEIPT._id, 2_000)).resolves.toBeNull();
    expectBounded(stale.receiptsFindOne.mock.calls[0]![1]);
    expectBounded(stale.qualificationsFindOne.mock.calls[0]![1]);
    expect(stale.metadataFindOne).not.toHaveBeenCalled();
  });
});
