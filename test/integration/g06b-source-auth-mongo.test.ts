import type { CommandStartedEvent, Db } from 'mongodb';
import { MongoClient } from 'mongodb';

import { createSourceAuthComposition } from '../../src/composition/internal/index.js';
import {
  ensureG04bSchema,
  type G04bCollections,
  type G04bSourceDocument,
} from '../../src/infrastructure/mongo/g04b-schema.js';

const URI = process.env.G06B_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const PREFIX = process.env.G06B_MONGO_DATABASE_PREFIX ?? `passhub_g06b_jest_${process.pid}`;
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const EXIT_ID = '22222222-2222-4222-8222-222222222222';
const ENTRY_SECRET = 'A'.repeat(43);
const EXIT_SECRET = 'B'.repeat(43);
// Independent literal SHA-256 expectations; integration setup never calls production hashing code.
const ENTRY_DIGEST = '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a';
const EXIT_DIGEST = '412dc46cc9e3cb26f29f7c1415c556349af62904c5d15b0a2d8cfdc5cfa22b34';

let client: MongoClient;
let database: Db;
let collections: G04bCollections;
let sequence = 0;
let commands: CommandStartedEvent[] = [];

function source(
  _id: string,
  credentialAlias: 'entry' | 'exit',
  direction: 'ENTRY' | 'EXIT',
  credentialDigest: string,
  active: boolean,
): G04bSourceDocument {
  return {
    _id,
    credentialAlias,
    direction,
    active,
    credentialDigest,
    incarnation: credentialAlias === 'entry'
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    version: 0,
  };
}

async function seed(entryActive = true, exitActive = true): Promise<void> {
  await collections.sources.insertMany([
    source(ENTRY_ID, 'entry', 'ENTRY', ENTRY_DIGEST, entryActive),
    source(EXIT_ID, 'exit', 'EXIT', EXIT_DIGEST, exitActive),
  ]);
}

function sourceCommands(): CommandStartedEvent[] {
  return commands.filter((event) => event.databaseName === database.databaseName);
}

function assertReadOnlyPrimaryMajority(events: CommandStartedEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.commandName).toBe('find');
    expect(event.command).toMatchObject({
      find: 'sources',
      readConcern: { level: 'majority' },
      projection: { _id: 1, credentialAlias: 1, credentialDigest: 1 },
    });
    expect(event.command.projection).not.toHaveProperty('active');
    expect(event.command.projection).not.toHaveProperty('direction');
    expect(event.command).not.toHaveProperty('txnNumber');
    expect(event.command).not.toHaveProperty('startTransaction');
    expect(event.command).not.toHaveProperty('autocommit');
    expect(event.command).not.toHaveProperty('$readPreference.mode', expect.not.stringMatching(/^primary$/u));
  }
}

beforeAll(async () => {
  client = new MongoClient(URI, {
    monitorCommands: true,
    retryReads: false,
    retryWrites: false,
  });
  client.on('commandStarted', (event) => commands.push(event));
  await client.connect();
  const buildInfo = await client.db('admin').command({ buildInfo: 1 });
  expect(buildInfo.version).toBe('8.0.32');
  const hello = await client.db('admin').command({ hello: 1 });
  expect(hello.setName).toBe('rs0');
  expect(hello.isWritablePrimary).toBe(true);
});

beforeEach(async () => {
  sequence += 1;
  database = client.db(`${PREFIX}_${sequence}`);
  collections = await ensureG04bSchema(database);
  await seed();
  commands = [];
});

afterEach(async () => {
  await database.dropDatabase();
});

afterAll(async () => {
  await client.close();
});

describe('G06b true MongoDB Source authentication composition', () => {
  test('isolated full chain authenticates entry and exit with independent stored digests', async () => {
    const { sourceAuth } = createSourceAuthComposition(collections.sources);
    const entry = await sourceAuth.verifySourceCredential(`entry.${ENTRY_SECRET}`);
    const exit = await sourceAuth.verifySourceCredential(`exit.${EXIT_SECRET}`);
    expect(sourceAuth.facts(entry)).toEqual({ sourceId: ENTRY_ID });
    expect(sourceAuth.facts(exit)).toEqual({ sourceId: EXIT_ID });
    assertReadOnlyPrimaryMajority(sourceCommands());
    expect(sourceCommands().map((event) => event.command.filter)).toEqual([
      { credentialAlias: 'entry' },
      { credentialAlias: 'exit' },
    ]);
  });

  test('wrong and missing credentials remain the same generic authentication failure', async () => {
    const { sourceAuth } = createSourceAuthComposition(collections.sources);
    await expect(sourceAuth.verifySourceCredential(`entry.${'C'.repeat(43)}`)).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_SOURCE_CREDENTIAL' }),
    );
    await collections.sources.deleteOne({ credentialAlias: 'exit' });
    commands = [];
    await expect(sourceAuth.verifySourceCredential(`exit.${EXIT_SECRET}`)).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_SOURCE_CREDENTIAL' }),
    );
    assertReadOnlyPrimaryMajority(sourceCommands());
    expect(sourceCommands()).toHaveLength(1);
    expect(sourceCommands()[0]!.command.filter).toEqual({ credentialAlias: 'exit' });
  });

  test('inactive Mongo Source still authenticates because active is invisible to Auth', async () => {
    await collections.sources.updateMany({}, { $set: { active: false } });
    commands = [];
    const { sourceAuth } = createSourceAuthComposition(collections.sources);
    const entry = await sourceAuth.verifySourceCredential(`entry.${ENTRY_SECRET}`);
    const exit = await sourceAuth.verifySourceCredential(`exit.${EXIT_SECRET}`);
    expect(sourceAuth.facts(entry)).toEqual({ sourceId: ENTRY_ID });
    expect(sourceAuth.facts(exit)).toEqual({ sourceId: EXIT_ID });
    assertReadOnlyPrimaryMajority(sourceCommands());
  });

  test('exact reader projection/filter is read-only with no transaction or driver retry', async () => {
    const { sourceAuth } = createSourceAuthComposition(collections.sources);
    await sourceAuth.verifySourceCredential(`entry.${ENTRY_SECRET}`);
    const observed = sourceCommands();
    expect(observed).toHaveLength(1);
    assertReadOnlyPrimaryMajority(observed);
    expect(observed[0]!.command.filter).toEqual({ credentialAlias: 'entry' });
    expect(observed[0]!.command.projection).toEqual({
      _id: 1,
      credentialAlias: 1,
      credentialDigest: 1,
    });
    expect(observed.map((event) => event.commandName)).not.toEqual(expect.arrayContaining([
      'insert', 'update', 'delete', 'findAndModify', 'commitTransaction', 'abortTransaction',
    ]));
    expect(await collections.sources.countDocuments()).toBe(2);
  });
});
