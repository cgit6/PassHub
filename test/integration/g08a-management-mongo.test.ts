import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';

import { createAccessComposition } from '../../src/composition/access-composition.js';
import {
  createVerifiedComparisonPort,
  verifyStartupVectorsAndCreateComparisonCapability,
} from '../../src/access/application/comparison/index.js';
import type { ManagementApplicationError } from '../../src/access/application/management-errors.js';
import {
  G04A_FACE_SLOTS_COLLECTION,
  G04B_METADATA_COLLECTION,
  G04B_QUALIFICATIONS_COLLECTION,
  G04bMongoPersistenceAdapter,
  G04bTransactionError,
  createG04bFixture,
  type G04aFaceSlotDocument,
  type G04bMetadataDocument,
  type G04bQualificationDocument,
} from '../../src/infrastructure/mongo/index.js';
import {
  FIXED_COMPARISON_REFERENCE_ID,
  FIXED_STARTUP_VECTORS,
  FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';

const uri = process.env.G08A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G08A_MONGO_DATABASE_PREFIX ?? `passhub_g08a_${process.pid}`;
const BASE_NOW = 1_800_000_000_000;
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const FACE_SLOT_CAPACITY = 4096;

describe('G08a true MongoDB 8.0.32 replica-set management', () => {
  let client: MongoClient;
  const databases: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    await client.connect();
    const buildInfo = await client.db('admin').command({ buildInfo: 1 });
    const hello = await client.db('admin').command({ hello: 1 });
    expect(buildInfo.version).toBe('8.0.32');
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });

  afterEach(async () => {
    const name = databases.pop();
    if (name !== undefined) await client.db(name).dropDatabase();
  });

  afterAll(async () => {
    await client.close();
  });

  async function setup(label: string) {
    const databaseName = `${databasePrefix}_${label}_${databases.length}`.slice(0, 63);
    databases.push(databaseName);
    const fixture = createG04bFixture(BASE_NOW);
    let serverNow = BASE_NOW;
    const adapter = new G04bMongoPersistenceAdapter(client, databaseName, { nowMs: () => serverNow });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY,
      comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
      vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter,
      recognition: adapter,
      sourceFacts: adapter,
      query: adapter,
      epoch: fixture.datasetEpoch,
      sourceId: fixture.sourceEntryId,
      comparison,
    });
    return {
      database: client.db(databaseName), fixture, adapter, access,
      setServerNow(value: number): void { serverNow = value; },
    };
  }

  test('formal adapter/scope/usecase/composition preserves KEEP/null/set and trusted revoke time', async () => {
    const h = await setup('lifecycle');
    const face = { provider: 'DemoFace.g08a', externalSubjectId: 'subject-one' } as const;
    const created = await h.access.manageQualifications.create({
      displayName: 'Created', validFromMs: BASE_NOW - 1_000, validUntilMs: BASE_NOW + 100_000,
      faceMapping: face, receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
    });
    expect(created.operation).toBe('CREATE');
    if (created.operation !== 'CREATE') throw new Error('create discriminator was not CREATE');
    expect(created.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created).not.toHaveProperty('incarnation');
    expect(created).not.toHaveProperty('version');
    const originalSlot = await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION)
      .findOne({ qualificationId: created.qualificationId });
    expect(originalSlot).not.toBeNull();

    h.setServerNow(BASE_NOW + 20_000);
    const kept = await h.access.manageQualifications.update({
      qualificationId: created.qualificationId,
      displayName: 'KEEP mapping',
      receivedAtMs: BASE_NOW + 10_000,
      actorId: ACTOR_ID,
    });
    expect(kept).toMatchObject({ operation: 'UPDATE', summary: { displayName: 'KEEP mapping', faceBound: true } });
    expect(kept).not.toHaveProperty('qrToken');
    const keptSlot = await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION)
      .findOne({ qualificationId: created.qualificationId });
    expect(keptSlot).toMatchObject({ _id: originalSlot!._id, provider: face.provider, subject: face.externalSubjectId, version: originalSlot!.version });

    const removed = await h.access.manageQualifications.update({
      qualificationId: created.qualificationId,
      faceMapping: null,
      receivedAtMs: BASE_NOW + 11_000,
      actorId: ACTOR_ID,
    });
    expect(removed).toMatchObject({ operation: 'UPDATE', summary: { faceBound: false } });
    expect(await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION)
      .countDocuments({ qualificationId: created.qualificationId })).toBe(0);

    const replacement = { provider: 'DemoFace.g08a', externalSubjectId: 'subject-two' } as const;
    const set = await h.access.manageQualifications.update({
      qualificationId: created.qualificationId,
      faceMapping: replacement,
      receivedAtMs: BASE_NOW + 12_000,
      actorId: ACTOR_ID,
    });
    expect(set).toMatchObject({ operation: 'UPDATE', summary: { faceBound: true } });
    expect(await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION)
      .findOne({ qualificationId: created.qualificationId }))
      .toMatchObject({ provider: replacement.provider, subject: replacement.externalSubjectId });

    h.setServerNow(BASE_NOW + 30_000);
    const revoked = await h.access.manageQualifications.revoke({
      qualificationId: created.qualificationId,
      reason: 'trusted receive time',
      receivedAtMs: BASE_NOW + 13_000,
      actorId: ACTOR_ID,
    });
    expect(revoked).toMatchObject({
      operation: 'REVOKE',
      summary: { revokedAtMs: BASE_NOW + 13_000, updatedAtMs: BASE_NOW + 30_000, faceBound: false },
    });
    expect(revoked).not.toHaveProperty('qrToken');
    const stored = await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
      .findOne({ _id: created.qualificationId });
    expect(stored).toMatchObject({
      revokedAt: new Date(BASE_NOW + 13_000),
      updatedAt: new Date(BASE_NOW + 30_000),
      revocationReason: 'trusted receive time',
    });
    expect(JSON.stringify([kept, removed, set, revoked, stored])).not.toContain(created.qrToken);
  });

  test('not-found and invalid windows fail before any partial qualification state', async () => {
    const h = await setup('validation');
    await expect(h.access.manageQualifications.update({
      qualificationId: randomUUID(), displayName: 'missing', receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
    })).rejects.toMatchObject({ code: 'QUALIFICATION_NOT_FOUND' });
    await expect(h.access.manageQualifications.create({
      displayName: 'equal window', validFromMs: BASE_NOW + 1_000, validUntilMs: BASE_NOW + 1_000,
      faceMapping: null, receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
    })).rejects.toMatchObject({ code: 'VALID_UNTIL_NOT_AFTER_VALID_FROM' });
    await expect(h.access.manageQualifications.create({
      displayName: 'already ended', validFromMs: BASE_NOW - 1_000, validUntilMs: BASE_NOW,
      faceMapping: null, receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
    })).rejects.toMatchObject({ code: 'VALID_UNTIL_NOT_AFTER_RECEIVED_AT' });
    expect(await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).countDocuments({})).toBe(1);
  });

  test.each([
    ['entered', { presence: 'INSIDE', enteredAt: new Date(BASE_NOW), exitedAt: null, revokedAt: null, revocationReason: null, expiredTerminalAt: null }, 'QUALIFICATION_ALREADY_ENTERED'],
    ['used', { presence: 'EXITED', enteredAt: new Date(BASE_NOW - 1_000), exitedAt: new Date(BASE_NOW), revokedAt: null, revocationReason: null, expiredTerminalAt: null }, 'QUALIFICATION_ALREADY_USED'],
    ['revoked', { presence: 'NOT_ENTERED', enteredAt: null, exitedAt: null, revokedAt: new Date(BASE_NOW), revocationReason: 'prior', expiredTerminalAt: null }, 'QUALIFICATION_ALREADY_REVOKED'],
  ] as const)('%s qualification is immutable with no partial write', async (label, state, code) => {
    const h = await setup(`immutable_${label}`);
    await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
      .updateOne({ _id: h.fixture.qualificationId }, { $set: state });
    const before = await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
      .findOne({ _id: h.fixture.qualificationId });
    await expect(h.access.manageQualifications.update({
      qualificationId: h.fixture.qualificationId, displayName: 'must not persist',
      receivedAtMs: BASE_NOW + 1_000, actorId: ACTOR_ID,
    })).rejects.toMatchObject({ code });
    expect(await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
      .findOne({ _id: h.fixture.qualificationId })).toEqual(before);
  });

  test('expired NOT_ENTERED is lazily persisted and releases its Face before returning the conflict', async () => {
    const h = await setup('expiry');
    const receivedAtMs = BASE_NOW + 4_000;
    await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).updateOne(
      { _id: h.fixture.qualificationId },
      { $set: { validUntil: new Date(BASE_NOW + 2_000), updatedAt: new Date(BASE_NOW) } },
    );
    let failure: ManagementApplicationError | null = null;
    try {
      await h.access.manageQualifications.revoke({
        qualificationId: h.fixture.qualificationId, reason: 'too late', receivedAtMs, actorId: ACTOR_ID,
      });
    } catch (error: unknown) {
      failure = error as ManagementApplicationError;
    }
    expect(failure).toMatchObject({ code: 'QUALIFICATION_ALREADY_EXPIRED', effect: 'EXPIRED_TERMINAL_PERSISTED' });
    expect(await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
      .findOne({ _id: h.fixture.qualificationId })).toMatchObject({
        expiredTerminalAt: new Date(receivedAtMs),
        revokedAt: null,
        version: 1,
      });
    expect(await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION)
      .findOne({ _id: h.fixture.faceSlotId })).toMatchObject({ qualificationId: null, qualificationIncarnation: null });
  });

  test('duplicate Face create rolls back qualification and slot atomically; released slot is reusable', async () => {
    const h = await setup('duplicate_reuse');
    const face = { provider: 'DemoFace.duplicate', externalSubjectId: 'same-subject' } as const;
    const first = await h.access.manageQualifications.create({
      displayName: 'first', validFromMs: BASE_NOW, validUntilMs: BASE_NOW + 100_000,
      faceMapping: face, receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
    });
    const beforeQualificationCount = await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).countDocuments({});
    const beforeSlotCount = await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION).countDocuments({});
    await expect(h.access.manageQualifications.create({
      displayName: 'duplicate', validFromMs: BASE_NOW, validUntilMs: BASE_NOW + 100_000,
      faceMapping: face, receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
    })).rejects.toMatchObject({ facts: { kind: 'FACE_SUBJECT_ALREADY_BOUND' } });
    expect(await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).countDocuments({})).toBe(beforeQualificationCount);
    expect(await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION).countDocuments({})).toBe(beforeSlotCount);
    expect(await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION).countDocuments({
      provider: face.provider, subject: face.externalSubjectId, qualificationId: { $type: 'string' },
    })).toBe(1);

    await h.access.manageQualifications.revoke({
      qualificationId: first.qualificationId, reason: 'release', receivedAtMs: BASE_NOW + 1_000, actorId: ACTOR_ID,
    });
    const reused = await h.access.manageQualifications.create({
      displayName: 'reused', validFromMs: BASE_NOW, validUntilMs: BASE_NOW + 100_000,
      faceMapping: face, receivedAtMs: BASE_NOW + 2_000, actorId: ACTOR_ID,
    });
    expect(await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION)
      .findOne({ provider: face.provider, subject: face.externalSubjectId }))
      .toMatchObject({ qualificationId: reused.qualificationId });
    expect(await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION).countDocuments({})).toBe(beforeSlotCount);
  });

  test('stale Face incarnation makes PATCH KEEP fail closed without updating the qualification', async () => {
    const h = await setup('stale_keep');
    const original = await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
      .findOne({ _id: h.fixture.qualificationId });
    await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION).updateOne(
      { _id: h.fixture.faceSlotId },
      { $set: { qualificationIncarnation: randomUUID() } },
    );
    await expect(h.access.manageQualifications.update({
      qualificationId: h.fixture.qualificationId,
      displayName: 'must not update',
      receivedAtMs: BASE_NOW + 1_000,
      actorId: ACTOR_ID,
    })).rejects.toEqual(expect.objectContaining<Partial<G04bTransactionError>>({
      name: 'G04bTransactionError',
      facts: expect.objectContaining({ kind: 'OTHER', stage: 'begin' }),
    }));
    expect(await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
      .findOne({ _id: h.fixture.qualificationId })).toEqual(original);
  });

  test('4095th/4096th/4097th slot boundary stays schema/index/counter consistent and release reuses capacity', async () => {
    const h = await setup('capacity');
    const qualifications = h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION);
    const slots = h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION);
    const metadata = h.database.collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION);
    await slots.deleteOne({ qualificationId: null });
    const additionalQualifications: G04bQualificationDocument[] = [];
    const additionalSlots: G04aFaceSlotDocument[] = [];
    for (let index = 0; index < FACE_SLOT_CAPACITY - 2; index += 1) {
      const qualificationId = randomUUID();
      const incarnation = randomUUID();
      additionalQualifications.push({
        _id: qualificationId,
        incarnation,
        version: 0,
        displayName: `capacity-${index}`,
        validFrom: new Date(BASE_NOW - 1_000),
        validUntil: new Date(BASE_NOW + 100_000),
        createdBy: ACTOR_ID,
        qrLookupDigest: (index + 1).toString(16).padStart(64, '0'),
        presence: 'NOT_ENTERED', enteredAt: null, exitedAt: null,
        revokedAt: null, revocationReason: null, expiredTerminalAt: null,
        createdAt: new Date(BASE_NOW), updatedAt: new Date(BASE_NOW),
      });
      additionalSlots.push({
        _id: randomUUID(), provider: 'CapacityFace', subject: `subject-${index}`,
        qualificationId, qualificationIncarnation: incarnation,
        slotIncarnation: randomUUID(), version: 0,
      });
    }
    await qualifications.insertMany(additionalQualifications);
    await slots.insertMany(additionalSlots);
    await metadata.updateOne({ _id: 'system' }, { $set: { slotCount: FACE_SLOT_CAPACITY - 1 } });
    expect(await slots.countDocuments({})).toBe(4095);

    const edge = await h.access.manageQualifications.create({
      displayName: 'slot 4096', validFromMs: BASE_NOW, validUntilMs: BASE_NOW + 100_000,
      faceMapping: { provider: 'CapacityFace', externalSubjectId: 'subject-4095' },
      receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
    });
    expect(await slots.countDocuments({})).toBe(4096);
    expect(await metadata.findOne({ _id: 'system' })).toMatchObject({ slotCount: 4096 });

    const qualificationCountAtCapacity = await qualifications.countDocuments({});
    await expect(h.access.manageQualifications.create({
      displayName: 'slot 4097 rejected', validFromMs: BASE_NOW, validUntilMs: BASE_NOW + 100_000,
      faceMapping: { provider: 'CapacityFace', externalSubjectId: 'subject-4096' },
      receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
    })).rejects.toMatchObject({ facts: { kind: 'FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED' } });
    expect(await slots.countDocuments({})).toBe(4096);
    expect(await qualifications.countDocuments({})).toBe(qualificationCountAtCapacity);
    expect(await metadata.findOne({ _id: 'system' })).toMatchObject({ slotCount: 4096 });

    await h.access.manageQualifications.revoke({
      qualificationId: edge.qualificationId, reason: 'release at capacity',
      receivedAtMs: BASE_NOW + 1_000, actorId: ACTOR_ID,
    });
    const reused = await h.access.manageQualifications.create({
      displayName: 'reuse empty slot', validFromMs: BASE_NOW, validUntilMs: BASE_NOW + 100_000,
      faceMapping: { provider: 'CapacityFace', externalSubjectId: 'subject-4096' },
      receivedAtMs: BASE_NOW + 2_000, actorId: ACTOR_ID,
    });
    expect(await slots.countDocuments({})).toBe(4096);
    expect(await metadata.findOne({ _id: 'system' })).toMatchObject({ slotCount: 4096 });
    expect(await slots.findOne({ qualificationId: reused.qualificationId })).toMatchObject({
      provider: 'CapacityFace', subject: 'subject-4096',
    });
    const indexes = await slots.listIndexes().toArray();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'g04a_face_subject_unique_v1', unique: true }),
      expect.objectContaining({ name: 'g04a_face_qualification_unique_v1', unique: true }),
    ]));
  }, 60_000);

  test('concurrent management claims for one new Face produce one winner and one fully rolled-back conflict', async () => {
    const h = await setup('concurrent_face');
    const face = { provider: 'DemoFace.concurrent', externalSubjectId: 'one-subject' } as const;
    const beforeQualifications = await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).countDocuments({});
    const results = await Promise.allSettled([
      h.access.manageQualifications.create({
        displayName: 'one', validFromMs: BASE_NOW, validUntilMs: BASE_NOW + 100_000,
        faceMapping: face, receivedAtMs: BASE_NOW, actorId: ACTOR_ID,
      }),
      h.access.manageQualifications.create({
        displayName: 'two', validFromMs: BASE_NOW, validUntilMs: BASE_NOW + 100_000,
        faceMapping: face, receivedAtMs: BASE_NOW + 1, actorId: ACTOR_ID,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).countDocuments({})).toBe(beforeQualifications + 1);
    expect(await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION).countDocuments({
      provider: face.provider, subject: face.externalSubjectId, qualificationId: { $type: 'string' },
    })).toBe(1);
  });
});
