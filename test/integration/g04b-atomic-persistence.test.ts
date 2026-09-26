import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { jest } from '@jest/globals';
import { MongoClient, type Collection, type Document } from 'mongodb';

import { ManagementAccessScope } from '../../src/access/application/access-scopes.js';
import {
  createVerifiedComparisonPort,
  verifyStartupVectorsAndCreateComparisonCapability,
} from '../../src/access/application/comparison/index.js';
import { createAccessComposition } from '../../src/composition/access-composition.js';

import {
  G04A_FACE_QUALIFICATION_INDEX,
  G04A_FACE_SLOTS_COLLECTION,
  G04A_FACE_SLOTS_VALIDATOR,
  G04A_FACE_SUBJECT_INDEX,
  G04B_EVENT_EXTERNAL_INDEX,
  G04B_EVENTS_COLLECTION,
  G04B_EVENTS_VALIDATOR,
  G04B_METADATA_COLLECTION,
  G04B_METADATA_VALIDATOR,
  G04B_QUALIFICATION_QR_INDEX,
  G04B_QUALIFICATIONS_COLLECTION,
  G04B_QUALIFICATIONS_VALIDATOR,
  G04B_SOURCE_ALIAS_INDEX,
  G04B_SOURCES_COLLECTION,
  G04B_SOURCES_VALIDATOR,
  G04B_USER_USERNAME_INDEX,
  G04B_USERS_COLLECTION,
  G04B_USERS_VALIDATOR,
  G04bMongoPersistenceAdapter,
  classifyG04bTransactionError,
  createG04bFixture,
  ensureG04bSchema,
} from '../../src/infrastructure/mongo/index.js';
import {
  FIXED_COMPARISON_REFERENCE_ID,
  FIXED_STARTUP_VECTORS,
  FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';

const uri = process.env.G04B_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G04B_MONGO_DATABASE_PREFIX ?? `passhub_g04b_direct_${process.pid}`;
interface StringIdDocument extends Document { _id: string }
interface LooseDocument extends Document { _id: unknown }

describe('G04b bootstrap fails closed against an existing dataset', () => {
  let client: MongoClient;
  const databases: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(uri, {
      retryReads: false,
      retryWrites: false,
      maxAdaptiveRetries: 0,
    });
    await client.connect();
    const buildInfo = await client.db('admin').command({ buildInfo: 1 });
    const hello = await client.db('admin').command({ hello: 1 });
    expect(buildInfo.version).toBe('8.0.32');
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });

  afterEach(async () => {
    const databaseName = databases.pop();
    if (databaseName !== undefined) await client.db(databaseName).dropDatabase();
  });

  afterAll(async () => {
    await client.close();
  });

  function isolatedDatabase(label: string) {
    const name = `${databasePrefix}_${label}_${databases.length}`.slice(0, 63);
    databases.push(name);
    return client.db(name);
  }

  test('rejects an existing collection whose validator is missing', async () => {
    const database = isolatedDatabase('missing_validator');
    await database.createCollection(G04B_QUALIFICATIONS_COLLECTION);

    await expect(ensureG04bSchema(database)).rejects.toThrow(/validator|schema|bootstrap/i);

    const info = await database
      .listCollections({ name: G04B_QUALIFICATIONS_COLLECTION }, { nameOnly: false })
      .next();
    expect(info?.options?.validator).not.toEqual(G04B_QUALIFICATIONS_VALIDATOR);
  });

  test('rejects existing business data when the system metadata document is missing', async () => {
    const database = isolatedDatabase('missing_metadata');
    const collections = await ensureG04bSchema(database);
    const fixture = createG04bFixture(1_800_000_000_000);
    await collections.qualifications.insertOne(fixture.qualifications[0]!);

    await expect(ensureG04bSchema(database)).rejects.toThrow(/metadata|bootstrap/i);
  });

  test('rejects shape-valid metadata whose independent startup HMAC is corrupt', async () => {
    const database = isolatedDatabase('corrupt_vector');
    const collections = await ensureG04bSchema(database);
    const fixture = createG04bFixture(1_800_000_000_000);
    await collections.metadata.insertOne({
      ...fixture.metadata,
      startupVectors: fixture.metadata.startupVectors.map((vector, index) =>
        index === 0 ? { ...vector, expectedHmacHex: '0'.repeat(64) } : vector,
      ),
    });

    await expect(ensureG04bSchema(database)).rejects.toThrow(/comparison|vector|bootstrap/i);
  });

  test('installs strict validators for all six collections and Mongo rejects invalid shapes with 121', async () => {
    const database = isolatedDatabase('validators');
    await ensureG04bSchema(database);
    const expected = new Map<string, object>([
      [G04B_QUALIFICATIONS_COLLECTION, G04B_QUALIFICATIONS_VALIDATOR],
      [G04A_FACE_SLOTS_COLLECTION, G04A_FACE_SLOTS_VALIDATOR],
      [G04B_EVENTS_COLLECTION, G04B_EVENTS_VALIDATOR],
      [G04B_USERS_COLLECTION, G04B_USERS_VALIDATOR],
      [G04B_SOURCES_COLLECTION, G04B_SOURCES_VALIDATOR],
      [G04B_METADATA_COLLECTION, G04B_METADATA_VALIDATOR],
    ]);

    for (const [name, validator] of expected) {
      const info = await database.listCollections({ name }, { nameOnly: false }).next();
      expect(info?.options).toMatchObject({
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await expect(database.collection<Document>(name).insertOne({ invalid: true })).rejects.toMatchObject({ code: 121 });
    }
  });

  test('installs the required unique and query indexes with exact names', async () => {
    const database = isolatedDatabase('indexes');
    await ensureG04bSchema(database);
    const expected = new Map<string, readonly string[]>([
      [G04B_QUALIFICATIONS_COLLECTION, [G04B_QUALIFICATION_QR_INDEX, 'g04b_qualification_created_v1', 'g04b_qualification_inside_v1']],
      [G04A_FACE_SLOTS_COLLECTION, [G04A_FACE_SUBJECT_INDEX, G04A_FACE_QUALIFICATION_INDEX]],
      [G04B_EVENTS_COLLECTION, [G04B_EVENT_EXTERNAL_INDEX, 'g04b_event_received_v1', 'g04b_event_qualification_received_v1']],
      [G04B_USERS_COLLECTION, [G04B_USER_USERNAME_INDEX]],
      [G04B_SOURCES_COLLECTION, [G04B_SOURCE_ALIAS_INDEX]],
      [G04B_METADATA_COLLECTION, []],
    ]);

    for (const [name, requiredNames] of expected) {
      const indexes = await database.collection(name).listIndexes().toArray();
      const byName = new Map(indexes.map((index) => [index.name, index]));
      expect(byName.has('_id_')).toBe(true);
      for (const requiredName of requiredNames) expect(byName.has(requiredName)).toBe(true);
    }
    expect((await database.collection(G04B_QUALIFICATIONS_COLLECTION).indexExists(G04B_QUALIFICATION_QR_INDEX))).toBe(true);
    expect((await database.collection(G04B_EVENTS_COLLECTION).indexInformation({ full: true })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: G04B_EVENT_EXTERNAL_INDEX, unique: true })]));
  });

  test('management create/update/replace/revoke is atomic, releases first, and returns the QR only once', async () => {
    const database = isolatedDatabase('management');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_000_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(
      verifyStartupVectorsAndCreateComparisonCapability({
        hmacKey: FIXED_TEST_HMAC_KEY,
        comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
        vectors: FIXED_STARTUP_VECTORS,
      }),
    );
    const access = createAccessComposition({
      management: adapter,
      recognition: adapter,
      sourceFacts: adapter,
      query: adapter,
      epoch: fixture.datasetEpoch,
      sourceId: fixture.sourceEntryId,
      comparison,
    });
    const actorId = randomUUID();
    const created = await access.manageQualifications.create({
      displayName: 'Created qualification',
      validFromMs: 1_799_999_000_000,
      validUntilMs: 1_800_010_000_000,
      faceMapping: null,
      receivedAtMs: 1_800_000_000_000,
      actorId,
    });
    expect(created.operation).toBe('CREATE');
    if (created.operation !== 'CREATE') throw new Error('create result discriminator was not CREATE');
    expect(created.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const storedAfterCreate = await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: created.qualificationId });
    expect(storedAfterCreate).toMatchObject({ createdBy: actorId, presence: 'NOT_ENTERED', version: 0 });
    expect(JSON.stringify(storedAfterCreate)).not.toContain(created.qrToken!);

    const firstMapping = { provider: 'DemoFace.new', externalSubjectId: 'subject-new' } as const;
    const updated = await access.manageQualifications.update({
      qualificationId: created.qualificationId,
      displayName: 'Updated qualification',
      validFromMs: 1_799_999_000_000,
      validUntilMs: 1_800_020_000_000,
      faceMapping: firstMapping,
      receivedAtMs: 1_800_000_001_000,
      actorId,
    });
    expect(updated).toMatchObject({ operation: 'UPDATE' });
    expect(updated).not.toHaveProperty('qrToken');
    expect(updated).not.toHaveProperty('incarnation');
    expect(updated).not.toHaveProperty('version');
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ qualificationId: created.qualificationId })).toBe(1);

    const secondMapping = { provider: 'DemoFace.new', externalSubjectId: 'subject-replacement' } as const;
    const replaced = await access.manageQualifications.update({
      qualificationId: created.qualificationId,
      displayName: 'Replaced mapping',
      validFromMs: 1_799_999_000_000,
      validUntilMs: 1_800_030_000_000,
      faceMapping: secondMapping,
      receivedAtMs: 1_800_000_002_000,
      actorId,
    });
    expect(replaced).toMatchObject({ operation: 'UPDATE' });
    expect(replaced).not.toHaveProperty('qrToken');
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ qualificationId: created.qualificationId })).toBe(1);
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ provider: firstMapping.provider, subject: firstMapping.externalSubjectId, qualificationId: { $type: 'string' } })).toBe(0);
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).findOne({ provider: secondMapping.provider, subject: secondMapping.externalSubjectId })).toMatchObject({ qualificationId: created.qualificationId });

    const revoked = await access.manageQualifications.revoke({
      qualificationId: created.qualificationId,
      reason: 'completed test lifecycle',
      receivedAtMs: 1_800_000_003_000,
      actorId,
    });
    expect(revoked).toMatchObject({ operation: 'REVOKE' });
    expect(revoked).not.toHaveProperty('qrToken');
    expect(revoked).not.toHaveProperty('incarnation');
    expect(revoked).not.toHaveProperty('version');
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ qualificationId: created.qualificationId })).toBe(0);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: created.qualificationId })).toMatchObject({
      revokedAt: new Date(1_800_000_003_000),
      revocationReason: 'completed test lifecycle',
      updatedAt: new Date(1_800_000_000_000),
      version: 3,
    });
    expect(await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' })).toMatchObject({ slotCount: 2 });
  });

  test('QR ENTRY and EXIT commit events and presence without persisting the raw token', async () => {
    const database = isolatedDatabase('qr_entry_exit');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY,
      comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
      vectors: FIXED_STARTUP_VECTORS,
    }));
    const compose = (sourceId: string) => createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId, comparison,
    });
    const entry = compose(fixture.sourceEntryId);
    const created = await entry.manageQualifications.create({
      displayName: 'QR lifecycle', validFromMs: 1_799_999_000_000, validUntilMs: 1_800_010_000_000,
      faceMapping: null, receivedAtMs: 1_800_000_000_000, actorId: randomUUID(),
    });
    expect(created.operation).toBe('CREATE');
    if (created.operation !== 'CREATE') throw new Error('create result discriminator was not CREATE');
    expect(created.qrToken).not.toBeNull();
    const entryDecision = await entry.recognizeAttempt.execute({
      input: { kind: 'QR_SCANNED', token: created.qrToken! },
      receivedAtMs: 1_800_000_001_000,
      externalEventId: 'qr-entry-1',
    });
    expect(entryDecision).toMatchObject({ outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED' });
    const exitDecision = await compose(fixture.sourceExitId).recognizeAttempt.execute({
      input: { kind: 'QR_SCANNED', token: created.qrToken! },
      receivedAtMs: 1_800_000_002_000,
      externalEventId: 'qr-exit-1',
    });
    expect(exitDecision).toMatchObject({ outcome: 'ACCEPTED', reasonCode: 'EXIT_RECORDED' });
    expect(await database.collection<Document>(G04B_EVENTS_COLLECTION).countDocuments({ qualificationId: created.qualificationId })).toBe(2);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: created.qualificationId })).toMatchObject({
      presence: 'EXITED', version: 2,
      enteredAt: new Date(1_800_000_001_000), exitedAt: new Date(1_800_000_002_000),
    });
    const persistedDataset = JSON.stringify({
      qualifications: await database.collection(G04B_QUALIFICATIONS_COLLECTION).find({}).toArray(),
      events: await database.collection(G04B_EVENTS_COLLECTION).find({}).toArray(),
      metadata: await database.collection(G04B_METADATA_COLLECTION).find({}).toArray(),
    });
    expect(persistedDataset).not.toContain(created.qrToken!);
  });

  test('Face ENTRY/EXIT and unknown/unmapped/invalid QR rejections save events without allocating slots', async () => {
    const database = isolatedDatabase('recognition_paths');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY,
      comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
      vectors: FIXED_STARTUP_VECTORS,
    }));
    const compose = (sourceId: string) => createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId, comparison,
    });
    const initialSlots = await database.collection(G04A_FACE_SLOTS_COLLECTION).countDocuments({});
    expect(await compose(fixture.sourceEntryId).recognizeAttempt.execute({
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
      receivedAtMs: 1_800_000_001_000, externalEventId: 'face-entry-1',
    })).toMatchObject({ outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED' });
    expect(await compose(fixture.sourceExitId).recognizeAttempt.execute({
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
      receivedAtMs: 1_800_000_002_000, externalEventId: 'face-exit-1',
    })).toMatchObject({ outcome: 'ACCEPTED', reasonCode: 'EXIT_RECORDED', faceMappingEffect: 'RELEASE' });
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ qualificationId: fixture.qualificationId })).toBe(0);

    expect(await compose(fixture.sourceEntryId).recognizeAttempt.execute({
      input: { kind: 'FACE_UNKNOWN' }, receivedAtMs: 1_800_000_003_000, externalEventId: 'face-unknown-1',
    })).toMatchObject({ outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN' });
    expect(await compose(fixture.sourceEntryId).recognizeAttempt.execute({
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'never-mapped' },
      receivedAtMs: 1_800_000_004_000, externalEventId: 'face-unmapped-1',
    })).toMatchObject({ outcome: 'REJECTED', reasonCode: 'FACE_SUBJECT_NOT_MAPPED' });
    expect(await compose(fixture.sourceEntryId).recognizeAttempt.execute({
      input: { kind: 'QR_SCANNED', token: 'valid-shape-but-unknown' },
      receivedAtMs: 1_800_000_005_000, externalEventId: 'qr-invalid-1',
    })).toMatchObject({ outcome: 'REJECTED', reasonCode: 'INVALID_QR_CREDENTIAL' });
    expect(await database.collection(G04A_FACE_SLOTS_COLLECTION).countDocuments({})).toBe(initialSlots);
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({})).toBe(5);
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ outcome: 'REJECTED', qualificationId: null })).toBe(3);
  });

  test('same-ID sequential replay is canonical and a different artifact conflicts without a second effect', async () => {
    const database = isolatedDatabase('sequential_idempotency');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    });
    const command = {
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' } as const,
      receivedAtMs: 1_800_000_001_000,
      externalEventId: 'same-sequential-1',
    };
    const first = await access.recognizeAttempt.execute(command);
    const replay = await access.recognizeAttempt.execute(command);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED' });
    await expect(access.recognizeAttempt.execute({
      input: { kind: 'FACE_UNKNOWN' },
      receivedAtMs: 1_800_000_009_000,
      externalEventId: command.externalEventId,
    })).rejects.toMatchObject({
      name: 'G04bTransactionError',
      facts: { kind: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ sourceId: fixture.sourceEntryId, externalEventId: command.externalEventId })).toBe(1);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId })).toMatchObject({ presence: 'INSIDE', version: 1 });
    expect(await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).findOne({ _id: fixture.sourceEntryId })).toMatchObject({ version: 1 });
    expect(await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' })).toMatchObject({ faceGuardVersion: 1 });
  });

  test('same-ID concurrent race converges to one canonical event while the same ID is independent across sources', async () => {
    const database = isolatedDatabase('concurrent_idempotency');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const compose = (sourceId: string) => createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId, comparison,
    });
    const command = {
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' } as const,
      receivedAtMs: 1_800_000_001_000,
      externalEventId: 'same-race-1',
    };
    const raced = await Promise.allSettled([
      compose(fixture.sourceEntryId).recognizeAttempt.execute(command),
      compose(fixture.sourceEntryId).recognizeAttempt.execute(command),
    ]);
    const fulfilled = raced.filter((result) => result.status === 'fulfilled');
    const rejected = raced.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of fulfilled) expect(result.value).toMatchObject({ outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED' });
    for (const result of rejected) {
      expect(result.reason).toMatchObject({
        name: 'G04bTransactionError',
        facts: { kind: expect.stringMatching(/^(?:WRITE_CONFLICT|UNKNOWN_COMMIT_RESULT)$/u) },
      });
    }
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ sourceId: fixture.sourceEntryId, externalEventId: command.externalEventId })).toBe(1);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId })).toMatchObject({ presence: 'INSIDE', version: 1 });
    expect(await compose(fixture.sourceEntryId).recognizeAttempt.execute(command)).toEqual(fulfilled[0]!.value);
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ sourceId: fixture.sourceEntryId, externalEventId: command.externalEventId })).toBe(1);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId })).toMatchObject({ presence: 'INSIDE', version: 1 });

    expect(await compose(fixture.sourceExitId).recognizeAttempt.execute({ ...command, receivedAtMs: 1_800_000_002_000 })).toMatchObject({
      outcome: 'ACCEPTED', reasonCode: 'EXIT_RECORDED',
    });
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ externalEventId: command.externalEventId })).toBe(2);
    expect(await database.collection(G04B_EVENTS_COLLECTION).distinct('sourceId', { externalEventId: command.externalEventId })).toEqual(
      expect.arrayContaining([fixture.sourceEntryId, fixture.sourceExitId]),
    );
  });

  test('different-event concurrent conflict is typed and the losing transaction rolls back completely', async () => {
    const database = isolatedDatabase('different_event_conflict');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const execute = (externalEventId: string) => createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    }).recognizeAttempt.execute({
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
      receivedAtMs: 1_800_000_001_000,
      externalEventId,
    });
    const raced = await Promise.allSettled([execute('different-a'), execute('different-b')]);
    const fulfilled = raced.filter((result) => result.status === 'fulfilled');
    const rejected = raced.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value).toMatchObject({ outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      name: 'G04bTransactionError',
      facts: { kind: expect.stringMatching(/^(?:WRITE_CONFLICT|UNKNOWN_COMMIT_RESULT)$/u) },
    });
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ externalEventId: { $in: ['different-a', 'different-b'] } })).toBe(1);
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ reasonCode: 'ALREADY_INSIDE' })).toBe(0);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId })).toMatchObject({ presence: 'INSIDE', version: 1 });
    expect(await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).findOne({ _id: fixture.sourceEntryId })).toMatchObject({ version: 1 });
    expect(await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' })).toMatchObject({ faceGuardVersion: 1 });
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ qualificationId: fixture.qualificationId })).toBe(1);
  });

  test.each([
    ['source write', 'update', 0],
    ['qualification write', 'update', 1],
    ['metadata guard write', 'update', 2],
    ['event write', 'insert', 0],
  ] as const)('fault after/before %s rolls the entire recognition transaction back', async (_label, commandName, skip) => {
    const database = isolatedDatabase(`rollback_${commandName}_${skip}`);
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    });
    await client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: skip === 0 ? { times: 1 } : { skip },
      data: { failCommands: [commandName], errorCode: 112 },
    });
    try {
      await expect(access.recognizeAttempt.execute({
        input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
        receivedAtMs: 1_800_000_001_000,
        externalEventId: `fault-${commandName}-${skip}`,
      })).rejects.toMatchObject({ name: 'G04bTransactionError' });
    } finally {
      await client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    }

    const observer = client.startSession();
    try {
      observer.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
      const eventCount = await database.collection(G04B_EVENTS_COLLECTION).countDocuments({}, { session: observer });
      const qualification = await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId }, { session: observer });
      const source = await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).findOne({ _id: fixture.sourceEntryId }, { session: observer });
      const metadata = await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' }, { session: observer });
      const mappingCount = await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ qualificationId: fixture.qualificationId }, { session: observer });
      expect({ eventCount, qualification, source, metadata, mappingCount }).toMatchObject({
        eventCount: 0,
        qualification: { presence: 'NOT_ENTERED', version: 0, enteredAt: null },
        source: { version: 0 },
        metadata: { faceGuardVersion: 0 },
        mappingCount: 1,
      });
      await observer.commitTransaction();
    } finally {
      if (observer.inTransaction()) await observer.abortTransaction();
      await observer.endSession();
    }
  });

  test('canonical lookup returns one coherent redacted snapshot', async () => {
    const database = isolatedDatabase('canonical_snapshot');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    });
    await access.recognizeAttempt.execute({
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
      receivedAtMs: 1_800_000_001_000, externalEventId: 'canonical-1',
    });
    const canonical = await adapter.readCanonicalSnapshot(fixture.sourceEntryId, 'canonical-1');
    expect(canonical).toMatchObject({
      event: { outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED', qualificationId: fixture.qualificationId },
      qualification: { qualificationId: fixture.qualificationId, version: 1, state: { presence: 'INSIDE' } },
      mapping: { qualificationId: fixture.qualificationId, qualificationIncarnation: fixture.qualificationIncarnation },
      guardVersions: { qr: 0, face: 1 },
    });
    const publicShape = JSON.stringify(canonical);
    expect(publicShape).not.toContain('inputHmac');
    expect(publicShape).not.toContain('comparisonReferenceId');
    expect(publicShape).not.toContain('subject-1');
    expect(publicShape).not.toContain('DemoFace');
  });

  test('expired recognition replay preserves RELEASE without a second event or effect', async () => {
    const database = isolatedDatabase('expired_replay');
    const base = createG04bFixture(1_800_000_000_000);
    const fixture = {
      ...base,
      qualifications: [{ ...base.qualifications[0]!, validUntil: new Date(1_799_999_999_000) }],
    };
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    });
    const command = {
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' } as const,
      receivedAtMs: 1_800_000_001_000,
      externalEventId: 'expired-replay-1',
    };
    const first = await access.recognizeAttempt.execute(command);
    const replay = await access.recognizeAttempt.execute(command);
    expect(first).toMatchObject({
      outcome: 'REJECTED', reasonCode: 'QUALIFICATION_EXPIRED',
      qualificationEffect: 'EXPIRE_NOT_ENTERED', faceMappingEffect: 'RELEASE',
    });
    expect(replay).toEqual(first);
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ externalEventId: command.externalEventId })).toBe(1);
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ qualificationId: fixture.qualificationId })).toBe(0);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId })).toMatchObject({
      presence: 'NOT_ENTERED', expiredTerminalAt: new Date(command.receivedAtMs), version: 1,
    });
    expect(await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' })).toMatchObject({ faceGuardVersion: 1 });
  });

  test.each([
    ['revoked ENTRY', 'ENTRY', { presence: 'NOT_ENTERED', enteredAt: null, exitedAt: null, revokedAt: new Date(1_799_999_999_000), revocationReason: 'revoked', expiredTerminalAt: null }, 'QUALIFICATION_REVOKED'],
    ['already inside ENTRY', 'ENTRY', { presence: 'INSIDE', enteredAt: new Date(1_799_999_999_000), exitedAt: null, revokedAt: null, revocationReason: null, expiredTerminalAt: null }, 'ALREADY_INSIDE'],
    ['already used ENTRY', 'ENTRY', { presence: 'EXITED', enteredAt: new Date(1_799_999_998_000), exitedAt: new Date(1_799_999_999_000), revokedAt: null, revocationReason: null, expiredTerminalAt: null }, 'QUALIFICATION_ALREADY_USED'],
    ['not yet valid ENTRY', 'ENTRY', { presence: 'NOT_ENTERED', enteredAt: null, exitedAt: null, revokedAt: null, revocationReason: null, expiredTerminalAt: null, validFrom: new Date(1_800_000_002_000) }, 'QUALIFICATION_NOT_YET_VALID'],
    ['not inside EXIT', 'EXIT', { presence: 'NOT_ENTERED', enteredAt: null, exitedAt: null, revokedAt: null, revocationReason: null, expiredTerminalAt: null }, 'NOT_INSIDE'],
    ['already exited EXIT', 'EXIT', { presence: 'EXITED', enteredAt: new Date(1_799_999_998_000), exitedAt: new Date(1_799_999_999_000), revokedAt: null, revocationReason: null, expiredTerminalAt: null }, 'ALREADY_EXITED'],
  ] as const)('%s persists the exact rejection and freshness writes', async (_label, direction, state, reasonCode) => {
    const database = isolatedDatabase(`rejection_${reasonCode.toLowerCase()}`);
    const base = createG04bFixture(1_800_000_000_000);
    const qualification = { ...base.qualifications[0]!, ...state };
    const fixture = { ...base, qualifications: [qualification] };
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const sourceId = direction === 'ENTRY' ? fixture.sourceEntryId : fixture.sourceExitId;
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId, comparison,
    });
    expect(await access.recognizeAttempt.execute({
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
      receivedAtMs: 1_800_000_001_000, externalEventId: `rejection-${reasonCode.toLowerCase()}`,
    })).toMatchObject({ outcome: 'REJECTED', reasonCode });
    expect(await database.collection(G04B_EVENTS_COLLECTION).findOne({ externalEventId: `rejection-${reasonCode.toLowerCase()}` })).toMatchObject({
      outcome: 'REJECTED', reasonCode, qualificationId: fixture.qualificationId,
    });
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId })).toMatchObject({ version: 1 });
    expect(await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).findOne({ _id: sourceId })).toMatchObject({ version: 1 });
  });

  test('inactive source is audited without touching qualification, while stale mapping incarnation fails with no event', async () => {
    const database = isolatedDatabase('source_mapping_guards');
    const base = createG04bFixture(1_800_000_000_000);
    const inactiveFixture = {
      ...base,
      sources: base.sources.map((source) => source._id === base.sourceEntryId ? { ...source, active: false } : source),
    };
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(inactiveFixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const compose = () => createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: inactiveFixture.datasetEpoch, sourceId: inactiveFixture.sourceEntryId, comparison,
    });
    expect(await compose().recognizeAttempt.execute({
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
      receivedAtMs: 1_800_000_001_000, externalEventId: 'inactive-source-1',
    })).toMatchObject({ outcome: 'REJECTED', reasonCode: 'SOURCE_INACTIVE' });
    expect(await database.collection(G04B_EVENTS_COLLECTION).findOne({ externalEventId: 'inactive-source-1' })).toMatchObject({ qualificationId: null });
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: inactiveFixture.qualificationId })).toMatchObject({ version: 0 });

    const staleFixture = {
      ...base,
      faceSlots: base.faceSlots.map((slot) => slot._id === base.faceSlotId ? { ...slot, qualificationIncarnation: randomUUID() } : slot),
    };
    await adapter.clearAndSeed(staleFixture);
    await expect(compose().recognizeAttempt.execute({
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
      receivedAtMs: 1_800_000_002_000, externalEventId: 'stale-mapping-1',
    })).rejects.toMatchObject({
      name: 'G04bTransactionError',
      facts: { kind: 'OTHER' },
      cause: { name: 'G04bTechnicalError', message: expect.stringMatching(/stale qualification/i) },
    });
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({})).toBe(0);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: staleFixture.qualificationId })).toMatchObject({ version: 0 });
  });

  test('real duplicate event reports the external-event unique index and error classification is stage aware', async () => {
    const database = isolatedDatabase('error_classification');
    const fixture = createG04bFixture(1_800_000_000_000);
    const collections = await ensureG04bSchema(database);
    await collections.metadata.insertOne(fixture.metadata);
    await collections.sources.insertMany([...fixture.sources]);
    const event = {
      _id: randomUUID(), sourceId: fixture.sourceEntryId, externalEventId: 'duplicate-origin-1',
      kind: 'FACE_UNKNOWN' as const, direction: 'ENTRY' as const,
      outcome: 'REJECTED' as const, reasonCode: 'FACE_UNKNOWN',
      receivedAt: new Date(1_800_000_001_000), recordedAt: new Date(1_800_000_002_000),
      qualificationId: null, presenceTransition: null,
      inputHmac: 'a'.repeat(64), comparisonReferenceId: fixture.comparisonReferenceId,
    };
    await collections.events.insertOne(event);
    let duplicate: unknown;
    try {
      await collections.events.insertOne({ ...event, _id: randomUUID() });
    } catch (error: unknown) {
      duplicate = error;
    }
    expect(duplicate).toMatchObject({ code: 11000, keyPattern: { sourceId: 1, externalEventId: 1 } });
    expect(String((duplicate as Error).message)).toContain(G04B_EVENT_EXTERNAL_INDEX);
    expect(classifyG04bTransactionError(duplicate, 'event')).toMatchObject({ kind: 'DUPLICATE_KEY', stage: 'event', code: 11000 });
    expect(classifyG04bTransactionError({ code: 112, errorLabels: ['TransientTransactionError'] }, 'guard')).toMatchObject({ kind: 'WRITE_CONFLICT', code: 112 });
    expect(classifyG04bTransactionError({ code: 121 }, 'event')).toMatchObject({ kind: 'SCHEMA_VALIDATION', code: 121 });
    expect(classifyG04bTransactionError({ code: 251 }, 'abort')).toMatchObject({ kind: 'TRANSACTION_ABORTED', code: 251 });
    expect(classifyG04bTransactionError({ code: 251 }, 'commit')).toMatchObject({ kind: 'UNKNOWN_COMMIT_RESULT', code: 251 });
    expect(classifyG04bTransactionError({ code: 6 }, 'commit')).toMatchObject({ kind: 'UNKNOWN_COMMIT_RESULT', code: 6, labels: [] });
  });

  test('async scope close discards its transaction and permanently rejects retired use', async () => {
    const database = isolatedDatabase('scope_close');
    const fixture = createG04bFixture(1_800_000_000_000);
    const setupAdapter = new G04bMongoPersistenceAdapter(client, database.databaseName);
    await setupAdapter.ensureSchema();
    await setupAdapter.clearAndSeed(fixture);
    const monitoredClient = new MongoClient(uri, {
      retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, monitorCommands: true,
    });
    const commands: string[] = [];
    monitoredClient.on('commandStarted', (event) => commands.push(event.commandName));
    await monitoredClient.connect();
    const adapter = new G04bMongoPersistenceAdapter(monitoredClient, database.databaseName);
    try {
      await adapter.ensureSchema();
      commands.length = 0;
      const scope = new ManagementAccessScope(adapter, { epoch: fixture.datasetEpoch });
      expect(await scope.readQualification(fixture.qualificationId)).toMatchObject({ qualificationId: fixture.qualificationId });
      await scope.closeAsync();
      const afterFirstClose = [...commands];
      await scope.closeAsync();
      await expect(scope.readQualification(fixture.qualificationId)).rejects.toMatchObject({ code: 'SCOPE_CLOSED' });
      expect(commands).toEqual(afterFirstClose);
      expect(commands.filter((name) => name === 'abortTransaction')).toHaveLength(1);
      expect(commands).not.toContain('commitTransaction');
    } finally {
      await adapter.close();
    }
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({})).toBe(0);
    expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId })).toMatchObject({ version: 0 });
  });

  test('missing runtime identity and comparison dependencies fail before a transaction starts', async () => {
    const database = isolatedDatabase('pretransaction_guards');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    });
    const startSession = jest.spyOn(client, 'startSession');
    await expect(access.manageQualifications.create({
      displayName: 'missing actor', validFromMs: 1_799_999_000_000, validUntilMs: 1_800_010_000_000,
      faceMapping: null, receivedAtMs: 1_800_000_000_000,
    } as never)).rejects.toThrow(/actorId/i);
    await expect(access.recognizeAttempt.execute({
      input: { kind: 'FACE_UNKNOWN' }, receivedAtMs: 1_800_000_000_000,
    } as never)).rejects.toThrow(/external event ID/i);
    expect(startSession).not.toHaveBeenCalled();
    startSession.mockRestore();
    expect(() => createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId,
    } as never)).toThrow(/comparison port/i);
  });

  test('adapter source contains no withTransaction, hidden retries, or transaction Promise.all', async () => {
    const source = await readFile('src/infrastructure/mongo/g04b-persistence-adapter.ts', 'utf8');
    expect(source).not.toMatch(/\.withTransaction\s*\(/u);
    expect(source).not.toMatch(/Promise\.all\s*\(/u);
    expect(source).toContain('retryReads: false');
    expect(source).toContain('retryWrites: false');
    expect(source).toContain('maxAdaptiveRetries: 0');
    const composeSource = await readFile('infra/g04b-mongo-compose.yml', 'utf8');
    expect(composeSource).toContain('mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6');
    const runner = await readFile('scripts/test-g04b-integration.mjs', 'utf8');
    expect(runner).toMatch(/finally[\s\S]*down[\s\S]*--volumes[\s\S]*--remove-orphans/u);
    expect(runner).toMatch(/try\s*\{[\s\S]*compose, 'up', '-d'[\s\S]*g04b-init-replica-set\.mjs[\s\S]*\}\s*catch/u);
    expect(runner).toMatch(/catch \(error\)[\s\S]*failure = error[\s\S]*finally/u);
    expect(runner).toMatch(/catch \(cleanupError\)[\s\S]*if \(failure === undefined\)[\s\S]*failure = cleanupError/u);
    expect(runner).toMatch(/if \(failure !== undefined\)[\s\S]*throw failure/u);
    const initializer = await readFile('scripts/g04b-init-replica-set.mjs', 'utf8');
    expect(initializer).toContain('const deadline = Date.now() + 30_000');
    expect(initializer).toMatch(/while \(!initialized && Date\.now\(\) < deadline\)/u);
    expect(initializer).toMatch(/while \(Date\.now\(\) < deadline\)/u);
    expect(initializer).toMatch(/if \(!initialized\)[\s\S]*throw new Error/u);
    expect(initializer).toMatch(/if \(Date\.now\(\) >= deadline\)[\s\S]*throw new Error/u);
    expect(initializer).not.toMatch(/while\s*\(true\)/u);
  });

  test.each([
    ['source', 'update', 0],
    ['qualification', 'update', 1],
    ['mapping release', 'update', 2],
    ['face guard', 'update', 3],
    ['event', 'insert', 0],
  ] as const)('Face EXIT fault at %s write leaves INSIDE and mapping fully intact', async (_label, commandName, skip) => {
    const database = isolatedDatabase(`exit_fault_${commandName}_${skip}`);
    const base = createG04bFixture(1_800_000_000_000);
    const fixture = {
      ...base,
      qualifications: [{
        ...base.qualifications[0]!, presence: 'INSIDE' as const,
        enteredAt: new Date(1_799_999_999_000), exitedAt: null,
      }],
    };
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceExitId, comparison,
    });
    await client.db('admin').command({
      configureFailPoint: 'failCommand', mode: skip === 0 ? { times: 1 } : { skip },
      data: { failCommands: [commandName], errorCode: 112 },
    });
    try {
      await expect(access.recognizeAttempt.execute({
        input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' },
        receivedAtMs: 1_800_000_001_000, externalEventId: `exit-fault-${commandName}-${skip}`,
      })).rejects.toMatchObject({ name: 'G04bTransactionError' });
    } finally {
      await client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
    const observer = client.startSession();
    try {
      observer.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
      expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({}, { session: observer })).toBe(0);
      expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId }, { session: observer })).toMatchObject({
        presence: 'INSIDE', version: 0, exitedAt: null,
      });
      expect(await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).findOne({ _id: fixture.sourceExitId }, { session: observer })).toMatchObject({ version: 0 });
      expect(await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' }, { session: observer })).toMatchObject({ faceGuardVersion: 0 });
      expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).findOne({ qualificationId: fixture.qualificationId }, { session: observer })).toMatchObject({
        qualificationId: fixture.qualificationId, qualificationIncarnation: fixture.qualificationIncarnation, version: 0,
      });
      await observer.commitTransaction();
    } finally {
      if (observer.inTransaction()) await observer.abortTransaction();
      await observer.endSession();
    }
  });

  test.each([
    ['qualification insert', 'insert', 0],
    ['QR guard', 'update', 0],
    ['slot bind', 'update', 1],
    ['Face guard', 'update', 2],
  ] as const)('management CREATE fault at %s write leaves no qualification, token digest, or mapping', async (_label, commandName, skip) => {
    const database = isolatedDatabase(`create_fault_${commandName}_${skip}`);
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    });
    await client.db('admin').command({
      configureFailPoint: 'failCommand', mode: skip === 0 ? { times: 1 } : { skip },
      data: { failCommands: [commandName], errorCode: 112 },
    });
    try {
      await expect(access.manageQualifications.create({
        displayName: 'must roll back', validFromMs: 1_799_999_000_000, validUntilMs: 1_800_010_000_000,
        faceMapping: { provider: 'DemoFace.new', externalSubjectId: 'rollback-subject' },
        receivedAtMs: 1_800_000_001_000, actorId: randomUUID(),
      })).rejects.toMatchObject({ name: 'G04bTransactionError' });
    } finally {
      await client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
    const observer = client.startSession();
    try {
      observer.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
      expect(await database.collection(G04B_QUALIFICATIONS_COLLECTION).countDocuments({}, { session: observer })).toBe(1);
      expect(await database.collection(G04B_QUALIFICATIONS_COLLECTION).countDocuments({ displayName: 'must roll back' }, { session: observer })).toBe(0);
      expect(await database.collection(G04A_FACE_SLOTS_COLLECTION).countDocuments({ provider: 'DemoFace.new', subject: 'rollback-subject' }, { session: observer })).toBe(0);
      expect(await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' }, { session: observer })).toMatchObject({
        qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 2,
      });
      await observer.commitTransaction();
    } finally {
      if (observer.inTransaction()) await observer.abortTransaction();
      await observer.endSession();
    }
  });

  test.each([
    ['missing comparison fields', { omitComparison: true, comparisonReferenceId: null, inputHmac: null }],
    ['mixed comparison reference', { omitComparison: false, comparisonReferenceId: '22222222-2222-4222-8222-222222222222', inputHmac: 'a'.repeat(64) }],
    ['corrupt comparison digest', { omitComparison: false, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, inputHmac: 'not-lower-hex' }],
  ] as const)('bootstrap rejects existing events with %s', async (_label, corruption) => {
    const database = isolatedDatabase(`existing_${corruption.omitComparison ? 'missing' : 'mixed'}`);
    const fixture = createG04bFixture(1_800_000_000_000);
    const collections = await ensureG04bSchema(database);
    await collections.metadata.insertOne(fixture.metadata);
    await collections.sources.insertMany([...fixture.sources]);
    const legacyEvent: Record<string, unknown> = {
      _id: randomUUID(), sourceId: fixture.sourceEntryId, externalEventId: 'legacy-event-1',
      kind: 'FACE_UNKNOWN', direction: 'ENTRY', outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN',
      receivedAt: new Date(1_800_000_001_000), recordedAt: new Date(1_800_000_002_000),
      qualificationId: null, presenceTransition: null,
    };
    if (!corruption.omitComparison) {
      legacyEvent.inputHmac = corruption.inputHmac;
      legacyEvent.comparisonReferenceId = corruption.comparisonReferenceId;
    }
    await database.collection(G04B_EVENTS_COLLECTION).insertOne(legacyEvent, { bypassDocumentValidation: true });

    await expect(ensureG04bSchema(database)).rejects.toThrow(/existing|comparison|mixed|missing|bootstrap/i);
  });

  test.each([
    ['dropped required collection', async (database: ReturnType<MongoClient['db']>) => database.collection(G04B_EVENTS_COLLECTION).drop()],
    ['missing required index', async (database: ReturnType<MongoClient['db']>) => database.collection(G04B_EVENTS_COLLECTION).dropIndex(G04B_EVENT_EXTERNAL_INDEX)],
    ['same-name index with wrong key', async (database: ReturnType<MongoClient['db']>) => {
      await database.collection(G04B_EVENTS_COLLECTION).dropIndex(G04B_EVENT_EXTERNAL_INDEX);
      await database.collection(G04B_EVENTS_COLLECTION).createIndex({ externalEventId: 1 }, { name: G04B_EVENT_EXTERNAL_INDEX, unique: true });
    }],
    ['unauthorized extra index', async (database: ReturnType<MongoClient['db']>) => {
      await database.collection(G04B_METADATA_COLLECTION).createIndex({ datasetEpoch: 1 }, { name: 'unauthorized_extra' });
    }],
  ] as const)('bootstrap rejects %s instead of healing catalog state', async (_label, corruptCatalog) => {
    const database = isolatedDatabase(`catalog_${_label.replaceAll(' ', '_')}`);
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName);
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    await corruptCatalog(database);
    await expect(ensureG04bSchema(database)).rejects.toThrow(/missing|required|index|incomplete|incompatible|extra/i);
  });

  test.each([
    'source active',
    'source version',
    'source direction',
    'qualification state',
    'current mapping',
  ] as const)('same-ID replay remains canonical after %s changes, while a different artifact conflicts', async (mutation) => {
    const database = isolatedDatabase(`canonical_after_${mutation.replaceAll(' ', '_')}`);
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = () => createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    });
    const command = {
      input: { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1' } as const,
      receivedAtMs: 1_800_000_001_000, externalEventId: `canonical-after-${mutation.replaceAll(' ', '-')}`,
    };
    const canonicalDecision = await access().recognizeAttempt.execute(command);
    expect(canonicalDecision).toMatchObject({ outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED' });

    if (mutation === 'source active') {
      await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).updateOne(
        { _id: fixture.sourceEntryId }, { $set: { active: false }, $inc: { version: 1 } },
      );
    } else if (mutation === 'source version') {
      await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).updateOne(
        { _id: fixture.sourceEntryId }, { $inc: { version: 7 } },
      );
    } else if (mutation === 'source direction') {
      await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).deleteOne({ _id: fixture.sourceExitId });
      await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).updateOne(
        { _id: fixture.sourceEntryId }, { $set: { credentialAlias: 'exit', direction: 'EXIT' }, $inc: { version: 1 } },
      );
    } else if (mutation === 'qualification state') {
      await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).updateOne(
        { _id: fixture.qualificationId },
        { $set: { presence: 'EXITED', exitedAt: new Date(1_800_000_003_000) }, $inc: { version: 7 } },
      );
    } else {
      await database.collection<StringIdDocument>(G04A_FACE_SLOTS_COLLECTION).updateOne(
        { _id: fixture.faceSlotId },
        { $set: { qualificationId: null, qualificationIncarnation: null }, $inc: { version: 1 } },
      );
    }

    expect(await access().recognizeAttempt.execute(command)).toEqual(canonicalDecision);
    const beforeConflict = {
      source: await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).findOne({ _id: fixture.sourceEntryId }),
      qualification: await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId }),
      slots: await database.collection<StringIdDocument>(G04A_FACE_SLOTS_COLLECTION).find({}).sort({ _id: 1 }).toArray(),
    };
    await expect(access().recognizeAttempt.execute({
      input: { kind: 'FACE_UNKNOWN' }, receivedAtMs: 1_800_000_009_000, externalEventId: command.externalEventId,
    })).rejects.toMatchObject({ name: 'G04bTransactionError', facts: { kind: 'IDEMPOTENCY_CONFLICT' } });
    expect(await database.collection(G04B_EVENTS_COLLECTION).countDocuments({ sourceId: fixture.sourceEntryId, externalEventId: command.externalEventId })).toBe(1);
    expect({
      source: await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).findOne({ _id: fixture.sourceEntryId }),
      qualification: await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: fixture.qualificationId }),
      slots: await database.collection<StringIdDocument>(G04A_FACE_SLOTS_COLLECTION).find({}).sort({ _id: 1 }).toArray(),
    }).toEqual(beforeConflict);
  });

  test('malformed UUIDs are rejected with code 121 and legacy malformed UUID rows fail startup', async () => {
    const database = isolatedDatabase('malformed_uuid');
    const fixture = createG04bFixture(1_800_000_000_000);
    const collections = await ensureG04bSchema(database);
    const invalidDocuments = [
      [collections.qualifications, { ...fixture.qualifications[0]!, _id: 'not-a-uuid' }],
      [collections.faceSlots, { ...fixture.faceSlots[0]!, slotIncarnation: 'not-a-uuid' }],
      [collections.events, {
        _id: 'not-a-uuid', sourceId: fixture.sourceEntryId, externalEventId: 'bad-uuid-event',
        kind: 'FACE_UNKNOWN', direction: 'ENTRY', outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN',
        receivedAt: new Date(), recordedAt: new Date(), qualificationId: null, presenceTransition: null,
        inputHmac: 'a'.repeat(64), comparisonReferenceId: fixture.comparisonReferenceId,
      }],
      [collections.users, { ...fixture.users[0]!, _id: 'not-a-uuid' }],
      [collections.sources, { ...fixture.sources[0]!, incarnation: 'not-a-uuid' }],
      [collections.metadata, { ...fixture.metadata, datasetEpoch: 'not-a-uuid' }],
    ] as const;
    for (const [collection, document] of invalidDocuments) {
      await expect((collection as unknown as Collection<LooseDocument>).insertOne(document as LooseDocument)).rejects.toMatchObject({ code: 121 });
    }
    await collections.metadata.insertOne(fixture.metadata);
    await database.collection<LooseDocument>(G04B_USERS_COLLECTION).insertOne(
      { ...fixture.users[0]!, _id: 'legacy-not-a-uuid', username: 'legacy-invalid' },
      { bypassDocumentValidation: true },
    );
    await expect(ensureG04bSchema(database)).rejects.toThrow(/existing users row violates its schema/i);
    expect(await database.collection<LooseDocument>(G04B_USERS_COLLECTION).countDocuments({ username: 'legacy-invalid' })).toBe(1);
  });

  test.each([
    'orphan face slot',
    'wrong qualification incarnation',
    'slotCount mismatch',
    'Event source-direction mismatch',
  ] as const)('bootstrap rejects %s and does not repair it', async (corruption) => {
    const database = isolatedDatabase(`cross_${corruption.replaceAll(' ', '_')}`);
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName);
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    if (corruption === 'orphan face slot') {
      await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).deleteOne({ _id: fixture.qualificationId });
    } else if (corruption === 'wrong qualification incarnation') {
      await database.collection<StringIdDocument>(G04A_FACE_SLOTS_COLLECTION).updateOne(
        { _id: fixture.faceSlotId }, { $set: { qualificationIncarnation: randomUUID() } },
      );
    } else if (corruption === 'slotCount mismatch') {
      await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).updateOne({ _id: 'system' }, { $set: { slotCount: 3 } });
    } else {
      await database.collection<LooseDocument>(G04B_EVENTS_COLLECTION).insertOne({
        _id: randomUUID(), sourceId: fixture.sourceEntryId, externalEventId: 'wrong-event-direction',
        kind: 'FACE_UNKNOWN', direction: 'EXIT', outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN',
        receivedAt: new Date(1_800_000_001_000), recordedAt: new Date(1_800_000_002_000),
        qualificationId: null, presenceTransition: null,
        inputHmac: 'a'.repeat(64), comparisonReferenceId: fixture.comparisonReferenceId,
      });
    }
    const before = {
      qualifications: await database.collection(G04B_QUALIFICATIONS_COLLECTION).find({}).toArray(),
      slots: await database.collection(G04A_FACE_SLOTS_COLLECTION).find({}).toArray(),
      events: await database.collection(G04B_EVENTS_COLLECTION).find({}).toArray(),
      metadata: await database.collection(G04B_METADATA_COLLECTION).find({}).toArray(),
    };
    await expect(ensureG04bSchema(database)).rejects.toThrow(/orphan|incarnation|slotCount|source|missing qualification/i);
    expect({
      qualifications: await database.collection(G04B_QUALIFICATIONS_COLLECTION).find({}).toArray(),
      slots: await database.collection(G04A_FACE_SLOTS_COLLECTION).find({}).toArray(),
      events: await database.collection(G04B_EVENTS_COLLECTION).find({}).toArray(),
      metadata: await database.collection(G04B_METADATA_COLLECTION).find({}).toArray(),
    }).toEqual(before);
  });

  test.each([true, false])('bootstrap accepts a matching %s source regardless of active state', async (active) => {
    const database = isolatedDatabase(`matching_source_${active}`);
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName);
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    await database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).updateOne(
      { _id: fixture.sourceEntryId }, { $set: { active } },
    );
    await database.collection<LooseDocument>(G04B_EVENTS_COLLECTION).insertOne({
      _id: randomUUID(), sourceId: fixture.sourceEntryId, externalEventId: `matching-source-${active}`,
      kind: 'FACE_UNKNOWN', direction: 'ENTRY', outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN',
      receivedAt: new Date(1_800_000_001_000), recordedAt: new Date(1_800_000_002_000),
      qualificationId: null, presenceTransition: null,
      inputHmac: 'a'.repeat(64), comparisonReferenceId: fixture.comparisonReferenceId,
    });
    await expect(ensureG04bSchema(database)).resolves.toBeDefined();
  });

  test('first Face bind and concurrent unmapped recognition/bind serialize without partial state', async () => {
    const database = isolatedDatabase('first_bind_race');
    const fixture = createG04bFixture(1_800_000_000_000);
    const adapter = new G04bMongoPersistenceAdapter(client, database.databaseName, { nowMs: () => 1_800_000_005_000 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const access = createAccessComposition({
      management: adapter, recognition: adapter, sourceFacts: adapter, query: adapter,
      epoch: fixture.datasetEpoch, sourceId: fixture.sourceEntryId, comparison,
    });
    const actorId = randomUUID();
    const first = await access.manageQualifications.create({
      displayName: 'first face bind', validFromMs: 1_799_999_000_000, validUntilMs: 1_800_010_000_000,
      faceMapping: { provider: 'DemoFace.first', externalSubjectId: 'first-subject' },
      receivedAtMs: 1_800_000_000_000, actorId,
    });
    const firstStored = await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION)
      .findOne({ _id: first.qualificationId });
    expect(firstStored).not.toBeNull();
    expect(await database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).findOne({
      provider: 'DemoFace.first', subject: 'first-subject',
    })).toMatchObject({ qualificationId: first.qualificationId, qualificationIncarnation: firstStored!.incarnation });

    const target = { provider: 'DemoFace.race', externalSubjectId: 'race-subject' } as const;
    const [bindResult, recognitionResult] = await Promise.allSettled([
      access.manageQualifications.create({
        displayName: 'race face bind', validFromMs: 1_799_999_000_000, validUntilMs: 1_800_010_000_000,
        faceMapping: target, receivedAtMs: 1_800_000_001_000, actorId,
      }),
      access.recognizeAttempt.execute({
        input: { kind: 'FACE_MATCHED', provider: target.provider, externalSubjectId: target.externalSubjectId },
        receivedAtMs: 1_800_000_001_000, externalEventId: 'unmapped-bind-race-1',
      }),
    ]);
    for (const result of [bindResult, recognitionResult]) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({
          name: 'G04bTransactionError',
          facts: { kind: expect.stringMatching(/^(?:WRITE_CONFLICT|UNKNOWN_COMMIT_RESULT)$/u) },
        });
      }
    }
    expect([bindResult, recognitionResult].some((result) => result.status === 'fulfilled')).toBe(true);

    const raceQualification = await database.collection(G04B_QUALIFICATIONS_COLLECTION).findOne({ displayName: 'race face bind' });
    const raceSlots = await database.collection(G04A_FACE_SLOTS_COLLECTION).find({ provider: target.provider, subject: target.externalSubjectId }).toArray();
    const raceEvents = await database.collection(G04B_EVENTS_COLLECTION).find({ externalEventId: 'unmapped-bind-race-1' }).toArray();
    expect(raceSlots.length).toBeLessThanOrEqual(1);
    expect(raceEvents.length).toBeLessThanOrEqual(1);
    if (raceQualification === null) {
      expect(raceSlots).toHaveLength(0);
      expect(raceEvents).toHaveLength(1);
      expect(raceEvents[0]).toMatchObject({ outcome: 'REJECTED', reasonCode: 'FACE_SUBJECT_NOT_MAPPED', qualificationId: null });
    } else {
      expect(raceSlots).toHaveLength(1);
      expect(raceSlots[0]).toMatchObject({
        qualificationId: raceQualification._id,
        qualificationIncarnation: raceQualification.incarnation,
      });
      if (raceEvents.length === 1) {
        expect(raceEvents[0]?.reasonCode).toMatch(/^(?:FACE_SUBJECT_NOT_MAPPED|ENTRY_GRANTED)$/u);
      }
    }
    const metadata = await database.collection<StringIdDocument>(G04B_METADATA_COLLECTION).findOne({ _id: 'system' });
    expect(metadata?.slotCount).toBe(await database.collection(G04A_FACE_SLOTS_COLLECTION).countDocuments({}));
    for (const slot of await database.collection(G04A_FACE_SLOTS_COLLECTION).find({ qualificationId: { $type: 'string' } }).toArray()) {
      expect(await database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).countDocuments({
        _id: slot.qualificationId,
        incarnation: slot.qualificationIncarnation,
      })).toBe(1);
    }
  });
});
