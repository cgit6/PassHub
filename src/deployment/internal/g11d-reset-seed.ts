import { createHash } from 'node:crypto';

import type { ClientSession, Db, Document, IndexDescription } from 'mongodb';

import { createG04bFixture } from '../../infrastructure/mongo/g04b-fixture.js';
import {
  G04A_FACE_SLOTS_COLLECTION,
  type G04aFaceSlotDocument,
} from '../../infrastructure/mongo/g04a-face-index-schema.js';
import {
  G04B_EVENTS_COLLECTION,
  G04B_MANAGEMENT_RECEIPTS_COLLECTION,
  G04B_METADATA_COLLECTION,
  G04B_QUALIFICATIONS_COLLECTION,
  G04B_SOURCES_COLLECTION,
  G04B_USERS_COLLECTION,
  type G04bEventDocument,
  type G04bManagementReceiptDocument,
  type G04bMetadataDocument,
  type G04bQualificationDocument,
  type G04bSourceDocument,
  type G04bUserDocument,
} from '../../infrastructure/mongo/g04b-schema.js';

/** G11d's destructive scope is an exact, closed allowlist. */
export const G11D_RESET_COLLECTIONS = Object.freeze([
  G04B_QUALIFICATIONS_COLLECTION,
  G04A_FACE_SLOTS_COLLECTION,
  G04B_EVENTS_COLLECTION,
  G04B_USERS_COLLECTION,
  G04B_SOURCES_COLLECTION,
  G04B_METADATA_COLLECTION,
  G04B_MANAGEMENT_RECEIPTS_COLLECTION,
] as const);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STABLE = Object.freeze({
  qualification: '11111111-1111-4111-8111-111111111111',
  qualificationIncarnation: '22222222-2222-4222-8222-222222222222',
  faceSlot: '33333333-3333-4333-8333-333333333333',
  emptyFaceSlot: '44444444-4444-4444-8444-444444444444',
  slotIncarnation: '99999999-9999-4999-8999-999999999999',
  emptySlotIncarnation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceEntry: '55555555-5555-4555-8555-555555555555',
  sourceExit: '66666666-6666-4666-8666-666666666666',
  sourceEntryIncarnation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sourceExitIncarnation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  user: '77777777-7777-4777-8777-777777777777',
  createdBy: '88888888-8888-4888-8888-888888888888',
});

export interface G11dStableSeed {
  readonly qualifications: readonly G04bQualificationDocument[];
  readonly faceSlots: readonly G04aFaceSlotDocument[];
  readonly events: readonly G04bEventDocument[];
  readonly users: readonly G04bUserDocument[];
  readonly sources: readonly G04bSourceDocument[];
  readonly metadata: G04bMetadataDocument;
  readonly managementReceipts: readonly G04bManagementReceiptDocument[];
}

export interface G11dResetSeedResult {
  readonly database: 'passhub_demo';
  readonly previousDatasetEpoch: string;
  readonly datasetEpoch: string;
  readonly deleted: Readonly<Record<(typeof G11D_RESET_COLLECTIONS)[number], number>>;
  readonly inserted: Readonly<Record<(typeof G11D_RESET_COLLECTIONS)[number], number>>;
  readonly indexesPreserved: true;
  readonly untouchedCollectionNames: readonly string[];
  readonly seedFingerprint: string;
}

export function createG11dStableSeed(datasetEpoch: string): G11dStableSeed {
  assertUuid(datasetEpoch, 'dataset epoch');
  const base = createG04bFixture(Date.UTC(2026, 0, 1));
  const qualification = { ...requireOne(base.qualifications), _id: STABLE.qualification, incarnation: STABLE.qualificationIncarnation, createdBy: STABLE.createdBy };
  const faceSlots = [
    { ...requireOne(base.faceSlots), _id: STABLE.faceSlot, qualificationId: STABLE.qualification, qualificationIncarnation: STABLE.qualificationIncarnation, slotIncarnation: STABLE.slotIncarnation },
    { ...requireOne(base.faceSlots, 1), _id: STABLE.emptyFaceSlot, provider: 'DemoFace.empty', subject: 'empty-1', qualificationId: null, qualificationIncarnation: null, slotIncarnation: STABLE.emptySlotIncarnation },
  ] as const;
  const users = [{ ...requireOne(base.users), _id: STABLE.user }] as const;
  const sources = [
    { ...requireOne(base.sources), _id: STABLE.sourceEntry, incarnation: STABLE.sourceEntryIncarnation },
    { ...requireOne(base.sources, 1), _id: STABLE.sourceExit, incarnation: STABLE.sourceExitIncarnation },
  ] as const;
  const metadata = { ...base.metadata, datasetEpoch, writeRunClaim: null } as G04bMetadataDocument;
  return Object.freeze({
    qualifications: Object.freeze([qualification]), faceSlots: Object.freeze(faceSlots), events: Object.freeze([]),
    users: Object.freeze(users), sources: Object.freeze(sources), metadata,
    managementReceipts: Object.freeze([]),
  });
}

/**
 * Reset only the seven G11d collections.  It intentionally requires an
 * already-created compatible database; schema creation, collection drops,
 * volume operations, claims and run-ticket handling belong to other gates.
 */
export async function resetAndSeedG11d(database: Db, datasetEpoch: string): Promise<G11dResetSeedResult> {
  if (database.databaseName !== 'passhub_demo') throw new G11dResetSeedError('DATABASE_SCOPE');
  assertUuid(datasetEpoch, 'dataset epoch');
  // The reset operation deliberately has no seed parameter.  A caller cannot
  // smuggle arbitrary documents into a destructive maintenance operation.
  const seed = createG11dStableSeed(datasetEpoch);
  if (seed.metadata.datasetEpoch !== datasetEpoch || seed.metadata.writeRunClaim !== null) throw new G11dResetSeedError('SEED_EPOCH_OR_CLAIM');
  const names = (await database.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name).sort();
  for (const name of G11D_RESET_COLLECTIONS) if (!names.includes(name)) throw new G11dResetSeedError('REQUIRED_COLLECTION_MISSING');
  const untouched = names.filter((name) => !(G11D_RESET_COLLECTIONS as readonly string[]).includes(name));
  const previous = await database.collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' });
  if (previous === null) throw new G11dResetSeedError('METADATA_MISSING');
  if (previous.datasetEpoch === datasetEpoch) throw new G11dResetSeedError('EPOCH_NOT_NEW');
  const indexes = await captureIndexes(database);
  const deleted = emptyCounts();
  const inserted = emptyCounts();
  const session = database.client.startSession();
  try {
    await session.withTransaction(async () => {
      // Re-check the epoch inside the transaction.  This prevents a stale
      // preflight read from deleting a reset committed by another runner.
      const current = await database.collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' }, { session });
      if (current === null) throw new G11dResetSeedError('METADATA_MISSING');
      if (current.datasetEpoch !== previous.datasetEpoch || current.datasetEpoch === datasetEpoch) throw new G11dResetSeedError('EPOCH_NOT_NEW');
      for (const name of G11D_RESET_COLLECTIONS) {
        deleted[name] = (await database.collection(name).deleteMany({}, { session })).deletedCount;
      }
      inserted[G04B_QUALIFICATIONS_COLLECTION] = await insertMany(database, G04B_QUALIFICATIONS_COLLECTION, seed.qualifications, session);
      inserted[G04A_FACE_SLOTS_COLLECTION] = await insertMany(database, G04A_FACE_SLOTS_COLLECTION, seed.faceSlots, session);
      inserted[G04B_EVENTS_COLLECTION] = await insertMany(database, G04B_EVENTS_COLLECTION, seed.events, session);
      inserted[G04B_USERS_COLLECTION] = await insertMany(database, G04B_USERS_COLLECTION, seed.users, session);
      inserted[G04B_SOURCES_COLLECTION] = await insertMany(database, G04B_SOURCES_COLLECTION, seed.sources, session);
      inserted[G04B_METADATA_COLLECTION] = await insertMany(database, G04B_METADATA_COLLECTION, [seed.metadata], session);
      inserted[G04B_MANAGEMENT_RECEIPTS_COLLECTION] = await insertMany(database, G04B_MANAGEMENT_RECEIPTS_COLLECTION, seed.managementReceipts, session);
    });
  } finally {
    await session.endSession();
  }
  const afterIndexes = await captureIndexes(database);
  if (JSON.stringify(indexes) !== JSON.stringify(afterIndexes)) throw new G11dResetSeedError('INDEXES_CHANGED');
  const afterNames = (await database.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name).sort();
  if (JSON.stringify(untouched) !== JSON.stringify(afterNames.filter((name) => !(G11D_RESET_COLLECTIONS as readonly string[]).includes(name)))) throw new G11dResetSeedError('UNTOUCHED_COLLECTION_CHANGED');
  return Object.freeze({ database: 'passhub_demo', previousDatasetEpoch: previous.datasetEpoch, datasetEpoch, deleted, inserted, indexesPreserved: true, untouchedCollectionNames: Object.freeze(untouched), seedFingerprint: fingerprintG11dStableSeed(seed) });
}

export class G11dResetSeedError extends Error {
  constructor(readonly code: 'DATABASE_SCOPE' | 'SEED_EPOCH_OR_CLAIM' | 'REQUIRED_COLLECTION_MISSING' | 'METADATA_MISSING' | 'EPOCH_NOT_NEW' | 'INDEXES_CHANGED' | 'UNTOUCHED_COLLECTION_CHANGED' | 'INVALID_EPOCH') {
    super(code); this.name = 'G11dResetSeedError';
  }
}

async function captureIndexes(database: Db): Promise<Readonly<Record<string, readonly IndexDescription[]>>> {
  const result: Record<string, readonly IndexDescription[]> = {};
  for (const name of G11D_RESET_COLLECTIONS) result[name] = await database.collection(name).listIndexes().toArray();
  return Object.freeze(result);
}

function emptyCounts(): Record<(typeof G11D_RESET_COLLECTIONS)[number], number> {
  return Object.fromEntries(G11D_RESET_COLLECTIONS.map((name) => [name, 0])) as Record<(typeof G11D_RESET_COLLECTIONS)[number], number>;
}

async function insertMany(database: Db, name: string, documents: readonly Document[], session: ClientSession): Promise<number> {
  if (documents.length === 0) return 0;
  return (await database.collection(name).insertMany([...documents], { session })).insertedCount;
}

function assertUuid(value: string, _label: string): void { if (!UUID_V4.test(value)) throw new G11dResetSeedError('INVALID_EPOCH'); }

function requireOne<T>(values: readonly T[], index = 0): T { const value = values[index]; if (value === undefined) throw new Error('stable fixture shape is invalid'); return value; }

export function fingerprintG11dStableSeed(seed: G11dStableSeed): string {
  const canonical = JSON.stringify(seed, (_key, value: unknown) => value instanceof Date ? value.toISOString() : value);
  return createHash('sha256').update(canonical).digest('hex');
}
