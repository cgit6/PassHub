import type { ClientSession, MongoClient } from 'mongodb';

import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';

const EVENT = Object.freeze({
  _id: 'event-1', sourceId: 'source-1', externalEventId: 'external-1', kind: 'FACE_MATCHED', direction: 'ENTRY',
  outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED', receivedAt: new Date(1_000), recordedAt: new Date(1_001),
  qualificationId: null, presenceTransition: null, inputHmac: 'a'.repeat(64), comparisonReferenceId: '11111111-1111-4111-8111-111111111111',
});

function harness(options: { readonly event?: unknown; readonly failure?: Error } = {}) {
  let active = true;
  const startTransaction: jest.Mock = jest.fn();
  const commitTransaction: jest.Mock = jest.fn(async () => { active = false; });
  const abortTransaction: jest.Mock = jest.fn(async () => { active = false; });
  const endSession: jest.Mock = jest.fn(async () => undefined);
  const session = {
    startTransaction,
    commitTransaction,
    abortTransaction,
    endSession,
    inTransaction: jest.fn(() => active),
  } as unknown as ClientSession;
  const eventsFindOne: jest.Mock = jest.fn(async () => {
    if (options.failure !== undefined) throw options.failure;
    return options.event === undefined ? EVENT : options.event;
  });
  const qualificationsFindOne: jest.Mock = jest.fn(async () => null);
  const slotsFind: jest.Mock = jest.fn(() => ({ toArray: jest.fn(async () => []) }));
  const metadataFindOne: jest.Mock = jest.fn(async () => ({ qrGuardVersion: 7, faceGuardVersion: 11 }));
  const client = {
    db: jest.fn(() => ({})), startSession: jest.fn(() => session), on: jest.fn(),
  } as unknown as MongoClient;
  const adapter = new G04bMongoPersistenceAdapter(client, 'g10c_canonical_observer');
  (adapter as unknown as { collections: unknown }).collections = {
    events: { findOne: eventsFindOne },
    qualifications: { findOne: qualificationsFindOne },
    faceSlots: { find: slotsFind },
    metadata: { findOne: metadataFindOne },
  };
  return { adapter, startTransaction, commitTransaction, abortTransaction, endSession, eventsFindOne, qualificationsFindOne, slotsFind, metadataFindOne };
}

function expectBounded(options: unknown): void {
  expect(options).toMatchObject({ timeoutMS: expect.any(Number) });
  expect((options as { readonly timeoutMS: number }).timeoutMS).toBeGreaterThanOrEqual(1);
  expect((options as { readonly timeoutMS: number }).timeoutMS).toBeLessThanOrEqual(2_000);
}

describe('G10c concrete canonical Mongo observer', () => {
  test('uses one primary snapshot transaction with majority+j and a shrinking bounded timeout on every command', async () => {
    const h = harness();
    await expect(h.adapter.readG10cCanonicalSnapshot('source-1', 'external-1', 2_000)).resolves.toMatchObject({
      event: { sourceId: 'source-1', kind: 'FACE_MATCHED' }, guardVersions: { qr: 7, face: 11 },
    });
    expect(h.startTransaction).toHaveBeenCalledWith({
      readConcern: { level: 'snapshot' }, readPreference: 'primary', writeConcern: { w: 'majority', j: true },
    });
    expect(h.eventsFindOne.mock.calls[0]![1]).toMatchObject({ session: expect.anything() });
    expectBounded(h.eventsFindOne.mock.calls[0]![1]);
    expect(h.metadataFindOne.mock.calls[0]![1]).toMatchObject({ session: expect.anything() });
    expectBounded(h.metadataFindOne.mock.calls[0]![1]);
    expectBounded(h.commitTransaction.mock.calls[0]![0]);
    expect(h.qualificationsFindOne).not.toHaveBeenCalled();
    expect(h.slotsFind).not.toHaveBeenCalled();
    expect(h.abortTransaction).not.toHaveBeenCalled();
    expect(h.endSession).toHaveBeenCalledTimes(1);
  });

  test('commits a null Event observation under the same bounded transaction', async () => {
    const h = harness({ event: null });
    await expect(h.adapter.readG10cCanonicalSnapshot('source-1', 'absent', 2_000)).resolves.toBeNull();
    expectBounded(h.eventsFindOne.mock.calls[0]![1]);
    expectBounded(h.commitTransaction.mock.calls[0]![0]);
    expect(h.qualificationsFindOne).not.toHaveBeenCalled();
    expect(h.metadataFindOne).not.toHaveBeenCalled();
    expect(h.endSession).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed budgets and bounds observer cleanup after a read failure', async () => {
    const h = harness({ failure: new Error('observer read failed') });
    await expect(h.adapter.readG10cCanonicalSnapshot('source-1', 'external-1', 0)).rejects.toThrow(/1 to 2000ms/i);
    await expect(h.adapter.readG10cCanonicalSnapshot('source-1', 'external-1', 2_000)).rejects.toThrow(/observer read failed/i);
    expectBounded(h.eventsFindOne.mock.calls[0]![1]);
    expectBounded(h.abortTransaction.mock.calls[0]![0]);
    expect(h.endSession).toHaveBeenCalledTimes(1);
  });
});
