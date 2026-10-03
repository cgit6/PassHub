import { EJSON } from 'bson';
import {
  MongoClient,
  type CommandStartedEvent,
  type Db,
  type Document,
} from 'mongodb';

import {
  G04A_FACE_SLOTS_COLLECTION,
  G04B_EVENTS_COLLECTION,
  G04B_METADATA_COLLECTION,
  G04B_QUALIFICATIONS_COLLECTION,
  createG04bFixture,
  ensureG04bSchema,
} from '../../src/infrastructure/mongo/index.js';
import { inspectExistingG04bSchemaReadOnly } from '../../src/infrastructure/mongo/g04b-schema.js';

const uri = process.env.G04B_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const prefix = process.env.G04B_MONGO_DATABASE_PREFIX ?? `passhub_g04b_readonly_${process.pid}`;
const allowedInspectionCommands = new Set([
  'listcollections', 'listindexes', 'find', 'aggregate', 'getmore', 'killcursors',
  'committransaction', 'aborttransaction', 'endsessions',
]);

describe('G11b-b2a read-only existing G04b schema inspection', () => {
  let client: MongoClient;
  let monitoredClient: MongoClient;
  let commands: CommandStartedEvent[];
  let lastObserved: CommandStartedEvent[];
  const databaseNames: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    monitoredClient = new MongoClient(uri, {
      retryReads: false,
      retryWrites: false,
      maxAdaptiveRetries: 0,
      monitorCommands: true,
    });
    commands = [];
    lastObserved = [];
    monitoredClient.on('commandStarted', (event) => commands.push(event));
    await Promise.all([client.connect(), monitoredClient.connect()]);
  });

  afterEach(async () => {
    commands.length = 0;
    const name = databaseNames.pop();
    if (name !== undefined) await client.db(name).dropDatabase();
  });

  afterAll(async () => {
    await Promise.all([client.close(), monitoredClient.close()]);
  });

  function database(label: string): Db {
    const name = `${prefix}_${label}_${databaseNames.length}`.slice(0, 63);
    databaseNames.push(name);
    return client.db(name);
  }

  async function seedValid(db: Db): Promise<ReturnType<typeof createG04bFixture>> {
    const fixture = createG04bFixture(1_800_000_000_000);
    const collections = await ensureG04bSchema(db);
    await collections.qualifications.insertMany([...fixture.qualifications]);
    await collections.faceSlots.insertMany([...fixture.faceSlots]);
    await collections.users.insertMany([...fixture.users]);
    await collections.sources.insertMany([...fixture.sources]);
    await collections.metadata.insertOne(fixture.metadata);
    return fixture;
  }

  async function fingerprint(db: Db): Promise<string> {
    const collections = await db.listCollections({}, { nameOnly: false }).toArray();
    const inventory = [];
    for (const info of collections.sort((left, right) => left.name.localeCompare(right.name))) {
      const collection = db.collection(info.name);
      const indexes = await collection.listIndexes().toArray();
      const documents = await collection.find({}).sort({ _id: 1 }).toArray();
      inventory.push({
        name: info.name,
        type: info.type,
        options: info.options,
        indexes: indexes.sort((left, right) => String(left.name).localeCompare(String(right.name))),
        documents,
      });
    }
    return EJSON.stringify(inventory, { relaxed: false });
  }

  async function inspectWithoutMutation(db: Db): Promise<unknown> {
    const before = await fingerprint(db);
    commands.length = 0;
    let value: unknown;
    let failure: unknown;
    try {
      value = await inspectExistingG04bSchemaReadOnly(monitoredClient.db(db.databaseName));
    } catch (error) {
      failure = error;
    }
    const observed = [...commands];
    lastObserved = observed;
    commands.length = 0;
    const after = await fingerprint(db);
    expect(after).toBe(before);
    expect(observed.length).toBeGreaterThan(0);
    for (const event of observed) {
      const commandName = event.commandName.toLowerCase();
      expect(allowedInspectionCommands).toContain(commandName);
      if (['committransaction', 'aborttransaction', 'endsessions'].includes(commandName)) {
        expect(['admin', db.databaseName]).toContain(event.databaseName);
        expect(['admin', db.databaseName]).toContain(event.command.$db);
      } else {
        expect(event.databaseName).toBe(db.databaseName);
        expect(event.command.$db).toBe(db.databaseName);
      }
      if (commandName === 'aggregate') {
        const pipeline = event.command.pipeline as readonly Document[] | undefined;
        expect(Array.isArray(pipeline)).toBe(true);
        expect(EJSON.stringify(pipeline)).not.toMatch(/"\$(?:out|merge)"/u);
      }
    }
    if (failure !== undefined) throw failure;
    return value;
  }

  test('valid exact existing schema passes and returns a frozen detached metadata copy', async () => {
    const db = database('valid');
    const fixture = await seedValid(db);
    const sentinel = db.collection<{ _id: string; untouched: boolean }>('unrelatedSentinel');
    await db.createCollection('unrelatedSentinel');
    await sentinel.createIndex({ untouched: 1 }, { name: 'sentinel_index' });
    await sentinel.insertOne({ _id: 'sentinel', untouched: true });
    const metadata = await inspectWithoutMutation(db) as Document;
    expect(metadata).toMatchObject({ _id: 'system', datasetEpoch: fixture.datasetEpoch, writeRunClaim: null });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.startupVectors)).toBe(true);
    expect(Object.isFrozen(metadata.startupVectors[0])).toBe(true);
    expect(metadata).not.toHaveProperty('collection');
    expect(EJSON.stringify(lastObserved.map((event) => event.command))).not.toContain('unrelatedSentinel');
    expect(await sentinel.findOne({ _id: 'sentinel' })).toEqual({ _id: 'sentinel', untouched: true });
    expect((await sentinel.listIndexes().toArray()).map((index) => index.name).sort()).toEqual(['_id_', 'sentinel_index']);
  });

  test('valid non-null write claim returns exact detached claim facts without mutating persistence', async () => {
    const db = database('valid_claim');
    await seedValid(db);
    const runId = '22222222-2222-4222-8222-222222222222';
    const claimedAt = new Date('2027-01-02T03:04:05.678Z');
    await db.collection<{ _id: string }>(G04B_METADATA_COLLECTION).updateOne(
      { _id: 'system' },
      { $set: { writeRunClaim: { runId, claimedAt } } },
    );

    const metadata = await inspectWithoutMutation(db) as Document;
    expect(metadata.writeRunClaim).toEqual({ runId, claimedAt });
    expect(metadata.writeRunClaim.claimedAt).toBeInstanceOf(Date);
    expect(metadata.writeRunClaim.claimedAt).not.toBe(claimedAt);

    metadata.writeRunClaim.claimedAt.setTime(0);
    const persisted = await db.collection<{ _id: string; writeRunClaim: { runId: string; claimedAt: Date } }>(
      G04B_METADATA_COLLECTION,
    ).findOne({ _id: 'system' });
    expect(persisted?.writeRunClaim).toEqual({ runId, claimedAt });
    expect(persisted?.writeRunClaim.claimedAt.getTime()).toBe(claimedAt.getTime());
  });

  test('empty database rejects without creating a database or collection', async () => {
    const db = database('empty');
    await expect(inspectWithoutMutation(db)).rejects.toThrow(/missing|required collection/i);
    expect(await db.listCollections().toArray()).toEqual([]);
    const databaseNamesAfter = (await client.db('admin').admin().listDatabases()).databases.map((entry) => entry.name);
    expect(databaseNamesAfter).not.toContain(db.databaseName);
  });

  test('one missing collection rejects without repair', async () => {
    const db = database('missing');
    await seedValid(db);
    await db.collection(G04B_EVENTS_COLLECTION).drop();
    await expect(inspectWithoutMutation(db)).rejects.toThrow(/missing|required collection/i);
    expect((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name)).not.toContain(G04B_EVENTS_COLLECTION);
  });

  test('incompatible validator rejects without collMod repair', async () => {
    const db = database('validator');
    await seedValid(db);
    await db.command({ collMod: G04B_QUALIFICATIONS_COLLECTION, validator: {} });
    await expect(inspectWithoutMutation(db)).rejects.toThrow(/validator|schema|options/i);
  });

  test('unauthorized metadata secondary index rejects without index repair', async () => {
    const db = database('index');
    await seedValid(db);
    await db.collection(G04B_METADATA_COLLECTION).createIndex({ datasetEpoch: 1 }, { name: 'unauthorized' });
    await expect(inspectWithoutMutation(db)).rejects.toThrow(/index|extra|incompatible/i);
  });

  test('shape-valid incompatible startup metadata rejects', async () => {
    const db = database('metadata');
    await seedValid(db);
    await db.collection<{ _id: string }>(G04B_METADATA_COLLECTION).updateOne(
      { _id: 'system' },
      { $set: { 'startupVectors.0.expectedHmacHex': '0'.repeat(64) } },
    );
    await expect(inspectWithoutMutation(db)).rejects.toThrow(/startup|vector|HMAC|incompatible/i);
  });

  test('missing metadata/system rejects without inserting it', async () => {
    const db = database('missing_metadata');
    await seedValid(db);
    await db.collection<{ _id: string }>(G04B_METADATA_COLLECTION).deleteOne({ _id: 'system' });
    await expect(inspectWithoutMutation(db)).rejects.toThrow(/metadata\/system|required/i);
    expect(await db.collection(G04B_METADATA_COLLECTION).countDocuments()).toBe(0);
  });

  test('legacy reference-integrity violation rejects', async () => {
    const db = database('integrity');
    await seedValid(db);
    await db.collection<Document>(G04A_FACE_SLOTS_COLLECTION).updateOne(
      { qualificationId: { $type: 'string' } },
      { $set: { qualificationId: '00000000-0000-4000-8000-000000000000' } },
    );
    await expect(inspectWithoutMutation(db)).rejects.toThrow(/orphan|qualification|integrity/i);
  });

  test('existing ensure fresh bootstrap behavior still provisions the seven collections', async () => {
    const db = database('ensure_regression');
    await expect(ensureG04bSchema(db)).resolves.toBeDefined();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name).sort();
    expect(names).toEqual([
      'events', 'faceSlots', 'managementReceipts', 'metadata', 'qualifications', 'sources', 'users',
    ]);
  });
});
