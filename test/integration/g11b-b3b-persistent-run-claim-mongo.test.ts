import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EJSON } from 'bson';
import {
  MongoClient,
  type CommandStartedEvent,
  type Db,
} from 'mongodb';

import { createVerifiedDatasetVerifier } from '../../src/deployment/internal/g11b-dataset-verification.js';
import { createPersistentRunClaimer } from '../../src/deployment/internal/g11b-persistent-run-claim.js';
import { createG11bRunTicketIntakeForFsTest } from '../support/g11b-run-ticket-test-support.js';
import {
  G04B_METADATA_COLLECTION,
  createG04bFixture,
  ensureG04bSchema,
  type G04bMetadataDocument,
} from '../../src/infrastructure/mongo/index.js';

const uri = process.env.G11B_B3B_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const prefix = process.env.G11B_B3B_MONGO_DATABASE_PREFIX ?? `passhub_g11b_b3b_${process.pid}`;

describe('G11b-b3b fixed Mongo persistent claim', () => {
  let client: MongoClient;
  let cleanupClient: MongoClient;
  const commands: CommandStartedEvent[] = [];
  const databaseNames: string[] = [];
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(uri, {
      retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, monitorCommands: true,
    });
    cleanupClient = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    client.on('commandStarted', (event) => commands.push(event));
    await Promise.all([client.connect(), cleanupClient.connect()]);
  });

  afterEach(async () => {
    commands.length = 0;
    const databaseName = databaseNames.pop();
    if (databaseName !== undefined) await cleanupClient.db(databaseName).dropDatabase();
    for (const directory of temporaryDirectories.splice(0)) {
      if (!directory.startsWith(join(tmpdir(), 'passhub-b3b-integration-'))) throw new Error('unsafe cleanup');
      await rm(directory, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await Promise.all([client.close(), cleanupClient.close()]);
  });

  function database(label: string): Db {
    const name = `${prefix}_${label}_${databaseNames.length}`.slice(0, 63);
    databaseNames.push(name);
    return client.db(name);
  }

  async function seed(db: Db) {
    const fixture = createG04bFixture(1_800_000_000_000);
    const collections = await ensureG04bSchema(db);
    await collections.qualifications.insertMany([...fixture.qualifications]);
    await collections.faceSlots.insertMany([...fixture.faceSlots]);
    await collections.users.insertMany([...fixture.users]);
    await collections.sources.insertMany([...fixture.sources]);
    await collections.metadata.insertOne(fixture.metadata);
    return fixture;
  }

  async function ticket(epoch: string, runId: string) {
    const directory = await mkdtemp(join(tmpdir(), 'passhub-b3b-integration-'));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const path = join(directory, 'bootstrap-ticket.json');
    await writeFile(path, `${JSON.stringify({
      v: 'g11b.run-ticket.v1', ticketId: randomUUID(), datasetEpoch: epoch, processRunId: runId,
    })}\n`, { mode: 0o400 });
    await chmod(path, 0o400);
    return createG11bRunTicketIntakeForFsTest(directory)(runId);
  }

  async function fingerprint(db: Db): Promise<string> {
    const inventory = [];
    for (const info of (await cleanupClient.db(db.databaseName).listCollections({}, { nameOnly: false }).toArray())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const collection = cleanupClient.db(db.databaseName).collection(info.name);
      inventory.push({
        name: info.name,
        type: info.type,
        options: info.options,
        indexes: (await collection.listIndexes().toArray())
          .sort((left, right) => String(left.name).localeCompare(String(right.name))),
        documents: await collection.find({}).sort({ _id: 1 }).toArray(),
      });
    }
    return EJSON.stringify(inventory, { relaxed: false });
  }

  function claimCommands(db: Db): CommandStartedEvent[] {
    const observed = [...commands];
    commands.length = 0;
    expect(observed.length).toBeGreaterThan(0);
    for (const event of observed) {
      expect(event.databaseName).toBe(db.databaseName);
      expect(event.command.$db).toBe(db.databaseName);
      expect(['findAndModify', 'find']).toContain(event.commandName);
    }
    const mutating = observed.filter((event) => event.commandName !== 'find');
    expect(mutating).toHaveLength(1);
    expect(mutating[0]?.commandName).toBe('findAndModify');
    return observed;
  }

  function expectCasWire(event: CommandStartedEvent, epoch: string, runId: string): void {
    expect(Reflect.ownKeys(event.command).sort()).toEqual([
      '$clusterTime', '$db', 'findAndModify', 'lsid', 'maxTimeMS', 'new', 'query', 'remove', 'update', 'upsert',
      'writeConcern',
    ]);
    expect(event.command).toMatchObject({
      findAndModify: 'metadata',
      query: { _id: 'system', kind: 'system', datasetEpoch: epoch, writeRunClaim: null },
      update: [{ $set: { writeRunClaim: { runId: { $literal: runId }, claimedAt: '$$NOW' } } }],
      remove: false,
      new: true,
      upsert: false,
      writeConcern: { w: 'majority', j: true },
    });
    // Driver 7.6's CSOT sends the positive remainder after elapsed client work.
    expect(Number.isInteger(event.command.maxTimeMS)).toBe(true);
    expect(event.command.maxTimeMS).toBeGreaterThanOrEqual(1);
    expect(event.command.maxTimeMS).toBeLessThanOrEqual(2000);
    expect(event.command).not.toHaveProperty('txnNumber');
    for (const forbidden of ['projection', 'comment', 'bypassDocumentValidation', 'autocommit', 'startTransaction']) {
      expect(event.command).not.toHaveProperty(forbidden);
    }
  }

  function expectClassificationWire(event: CommandStartedEvent): void {
    expect(Reflect.ownKeys(event.command).sort()).toEqual([
      '$clusterTime', '$db', 'filter', 'find', 'limit', 'lsid', 'maxTimeMS', 'readConcern', 'singleBatch',
    ]);
    expect(event.command).toMatchObject({
      find: 'metadata',
      filter: { _id: 'system' },
      limit: 1,
      singleBatch: true,
      readConcern: { level: 'majority' },
    });
    // The production option remains exactly 2000ms; wire maxTimeMS is its CSOT remainder.
    expect(Number.isInteger(event.command.maxTimeMS)).toBe(true);
    expect(event.command.maxTimeMS).toBeGreaterThanOrEqual(1);
    expect(event.command.maxTimeMS).toBeLessThanOrEqual(2000);
    expect(event.command).not.toHaveProperty('txnNumber');
    for (const forbidden of ['projection', 'comment', 'txnNumber', 'autocommit', 'startTransaction']) {
      expect(event.command).not.toHaveProperty(forbidden);
    }
  }

  async function prepared(db: Db, processRunId = randomUUID()) {
    const fixture = await seed(db);
    const verifier = createVerifiedDatasetVerifier(db);
    const verified = await verifier.verify();
    const consumed = await ticket(fixture.datasetEpoch, processRunId);
    const claimer = createPersistentRunClaimer(db, verifier);
    return { fixture, verifier, verified, consumed, claimer, processRunId };
  }

  test('fresh metadata claims once with server time and changes only writeRunClaim', async () => {
    const db = database('fresh');
    const ctx = await prepared(db);
    const beforeFingerprint = await fingerprint(db);
    const beforeMetadata = await cleanupClient.db(db.databaseName)
      .collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION)
      .findOne({ _id: 'system' });
    commands.length = 0;
    const beforeTime = Date.now();
    const outcome = await ctx.claimer.claimOnce(ctx.verified, ctx.consumed);
    const afterTime = Date.now();
    const observed = claimCommands(db);
    expect(outcome).toMatchObject({ status: 'CLAIMED' });
    expect(observed).toHaveLength(1);
    expectCasWire(observed[0]!, ctx.fixture.datasetEpoch, ctx.processRunId);

    const afterMetadata = await cleanupClient.db(db.databaseName)
      .collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION)
      .findOne({ _id: 'system' });
    expect(afterMetadata?.writeRunClaim).toMatchObject({ runId: ctx.processRunId });
    const claimedAt = (afterMetadata?.writeRunClaim as { claimedAt: Date }).claimedAt;
    expect(claimedAt).toBeInstanceOf(Date);
    expect(Number.isFinite(claimedAt.getTime())).toBe(true);
    expect(claimedAt.getTime()).toBeGreaterThanOrEqual(beforeTime - 100);
    expect(claimedAt.getTime()).toBeLessThanOrEqual(afterTime + 100);
    expect({ ...afterMetadata, writeRunClaim: null }).toEqual(beforeMetadata);
    const normalizedAfter = (await fingerprint(db)).replace(
      EJSON.stringify(afterMetadata?.writeRunClaim, { relaxed: false }),
      EJSON.stringify(null, { relaxed: false }),
    );
    expect(normalizedAfter).toBe(beforeFingerprint);
  });

  test.each([
    ['preheld other run', false],
    ['preheld same run', true],
  ])('%s returns CLAIM_HELD after one CAS and one majority read', async (label, sameRun) => {
    const db = database(label.replaceAll(' ', '_'));
    const fixture = await seed(db);
    const processRunId = randomUUID();
    const heldRunId = sameRun ? processRunId : randomUUID();
    await db.collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION).updateOne(
      { _id: 'system' },
      { $set: { writeRunClaim: { runId: heldRunId, claimedAt: new Date(1_800_000_000_500) } } },
    );
    const verifier = createVerifiedDatasetVerifier(db);
    const verified = await verifier.verify();
    const consumed = await ticket(fixture.datasetEpoch, processRunId);
    const claimer = createPersistentRunClaimer(db, verifier);
    const before = await fingerprint(db);
    commands.length = 0;
    await expect(claimer.claimOnce(verified, consumed)).resolves.toEqual({ status: 'CLAIM_HELD' });
    const observed = claimCommands(db);
    expect(observed).toHaveLength(2);
    expectCasWire(observed[0]!, fixture.datasetEpoch, processRunId);
    expectClassificationWire(observed[1]!);
    expect(await fingerprint(db)).toBe(before);
  });

  test('epoch changed after verification returns EPOCH_MISMATCH without repair', async () => {
    const db = database('epoch_mismatch');
    const ctx = await prepared(db);
    const newEpoch = randomUUID();
    await db.collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION)
      .updateOne({ _id: 'system' }, { $set: { datasetEpoch: newEpoch } });
    const before = await fingerprint(db);
    commands.length = 0;
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.consumed)).resolves.toEqual({ status: 'EPOCH_MISMATCH' });
    const observed = claimCommands(db);
    expect(observed).toHaveLength(2);
    expectCasWire(observed[0]!, ctx.fixture.datasetEpoch, ctx.processRunId);
    expectClassificationWire(observed[1]!);
    expect(await fingerprint(db)).toBe(before);
  });

  test('metadata removed after verification returns METADATA_MISSING_OR_INVALID without repair', async () => {
    const db = database('missing');
    const ctx = await prepared(db);
    await db.collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION).deleteOne({ _id: 'system' });
    const before = await fingerprint(db);
    commands.length = 0;
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.consumed)).resolves
      .toEqual({ status: 'METADATA_MISSING_OR_INVALID' });
    const observed = claimCommands(db);
    expect(observed).toHaveLength(2);
    expectCasWire(observed[0]!, ctx.fixture.datasetEpoch, ctx.processRunId);
    expectClassificationWire(observed[1]!);
    expect(await fingerprint(db)).toBe(before);
  });

  test('malformed metadata after verification returns METADATA_MISSING_OR_INVALID without repair', async () => {
    const db = database('malformed');
    const ctx = await prepared(db);
    await db.command({
      update: G04B_METADATA_COLLECTION,
      updates: [{ q: { _id: 'system' }, u: { $set: { kind: 'malformed' } } }],
      bypassDocumentValidation: true,
    });
    const before = await fingerprint(db);
    commands.length = 0;
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.consumed)).resolves
      .toEqual({ status: 'METADATA_MISSING_OR_INVALID' });
    const observed = claimCommands(db);
    expect(observed).toHaveLength(2);
    expectCasWire(observed[0]!, ctx.fixture.datasetEpoch, ctx.processRunId);
    expectClassificationWire(observed[1]!);
    expect(await fingerprint(db)).toBe(before);
  });
});
