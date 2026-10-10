import { MongoClient, type CommandStartedEvent, type Document } from 'mongodb';

import { createVerifiedDatasetVerifier } from '../../src/deployment/internal/g11b-dataset-verification.js';
import { verifyProductionMongoCapabilities } from '../../src/deployment/internal/g12g2-mongo-capability-verification.js';
import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import { createG04bFixture } from '../../src/infrastructure/mongo/g04b-fixture.js';
import {
  assertG12g2LocalIntegrationTarget,
  G12G2_LOCAL_INTEGRATION_URI,
} from '../support/g12g2-local-target-guard.js';

const TARGET = assertG12g2LocalIntegrationTarget(
  process.env.G12G2_MONGO_URI ?? G12G2_LOCAL_INTEGRATION_URI,
  process.env.G12G2_MONGO_DATABASE ?? `passhub_g12g2_${process.pid}`,
);

function canonical(value: unknown): unknown {
  if (value instanceof Date) return Object.freeze({ $date: value.toISOString() });
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

async function datasetSnapshot(client: MongoClient): Promise<unknown> {
  const database = client.db(TARGET.databaseName);
  const collections = (await database.listCollections({}, { nameOnly: false }).toArray())
    .sort((left, right) => left.name.localeCompare(right.name));
  const state = [];
  for (const collection of collections) {
    const indexes = await database.collection(collection.name).listIndexes().toArray();
    indexes.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const documents = await database.collection<Document>(collection.name).find({}).sort({ _id: 1 }).toArray();
    state.push({ collection, indexes, documents });
  }
  return canonical(state);
}

describe('G12g-2 true Local Mongo capability and read-only dataset chain', () => {
  let client: MongoClient;
  const commands: CommandStartedEvent[] = [];

  beforeAll(async () => {
    client = new MongoClient(TARGET.uri, {
      retryReads: false,
      retryWrites: false,
      monitorCommands: true,
      maxAdaptiveRetries: 0,
    });
    client.on('commandStarted', (event) => commands.push(event));
    await client.connect();
    const adapter = new G04bMongoPersistenceAdapter(client, TARGET.databaseName);
    await adapter.ensureSchema();
    await adapter.clearAndSeed(createG04bFixture(1_800_000_000_000));
  });

  afterAll(async () => {
    await client.db(TARGET.databaseName).dropDatabase().catch(() => undefined);
    await client.close();
  });

  test('accepts exact 8.0.32/rs0/single-member/writable Local and reads schema in a real snapshot transaction without mutation', async () => {
    const admin = client.db('admin');
    const buildInfo = await admin.command({ buildInfo: 1 });
    const hello = await admin.command({ hello: 1 });
    expect(buildInfo.version).toBe('8.0.32');
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
    expect(hello.hosts).toEqual(['127.0.0.1:27029']);

    const before = await datasetSnapshot(client);
    const commandOffset = commands.length;
    await verifyProductionMongoCapabilities(client, 'LOCAL_SELF_HOSTED');
    const verifier = createVerifiedDatasetVerifier(client.db(TARGET.databaseName));
    await expect(verifier.verify()).resolves.toBeDefined();
    const after = await datasetSnapshot(client);

    expect(after).toEqual(before);
    const observed = commands.slice(commandOffset);
    expect(observed.filter((event) => event.commandName === 'buildInfo')).toHaveLength(1);
    expect(observed.filter((event) => event.commandName === 'hello')).toHaveLength(1);
    expect(observed.some((event) => event.commandName === 'find'
      && event.command.startTransaction === true
      && event.command.readConcern?.level === 'snapshot')).toBe(true);
    expect(observed.some((event) => event.commandName === 'commitTransaction')).toBe(true);
    expect(observed.some((event) => [
      'insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes', 'drop', 'dropDatabase', 'collMod',
    ].includes(event.commandName))).toBe(false);
  });
});
