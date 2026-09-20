import type { CommandStartedEvent, Db } from 'mongodb';
import { MongoClient } from 'mongodb';

import { createHumanAuth } from '../../src/auth/application/human-auth.js';
import { HumanAuthError } from '../../src/auth/domain/index.js';
import { MongoHumanAccountReader } from '../../src/auth/infrastructure/mongo-human-account-reader.js';
import { NodeScryptPasswordDeriver } from '../../src/auth/infrastructure/node-scrypt-password-deriver.js';
import { ensureG04bSchema, type G04bCollections, type G04bUserDocument } from '../../src/infrastructure/mongo/g04b-schema.js';

const URI = process.env.G06A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const PREFIX = process.env.G06A_MONGO_DATABASE_PREFIX ?? `passhub_g06a_jest_${process.pid}`;
const NOW = 1_800_000_000;
const JWT_KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const VIEWER_ID = '22222222-2222-4222-8222-222222222222';
const DISABLED_ID = '33333333-3333-4333-8333-333333333333';
const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

let client: MongoClient;
let database: Db;
let collections: G04bCollections;
let sequence = 0;
let commands: CommandStartedEvent[] = [];
let operatorHash: string;
let viewerHash: string;

function user(_id: string, username: string, role: 'OPERATOR' | 'VIEWER', enabled: boolean, passwordHash: string): G04bUserDocument {
  return {
    _id,
    username,
    role,
    enabled,
    passwordSalt: SALT.toString('hex'),
    passwordHash,
    scryptParams: { N: 131072, r: 8, p: 1, keyLength: 64 },
  };
}

async function seed(): Promise<void> {
  await collections.users.insertMany([
    user(OPERATOR_ID, 'operator', 'OPERATOR', true, operatorHash),
    user(VIEWER_ID, 'viewer', 'VIEWER', true, viewerHash),
    user(DISABLED_ID, 'disabled', 'VIEWER', false, viewerHash),
  ]);
}

function auth() {
  return createHumanAuth({
    accountReader: new MongoHumanAccountReader(
      collections.users as unknown as ConstructorParameters<typeof MongoHumanAccountReader>[0],
    ),
    passwordDeriver: new NodeScryptPasswordDeriver(),
    jwtKey: JWT_KEY,
    clock: () => NOW,
  });
}

function authCommands(): CommandStartedEvent[] {
  return commands.filter((event) => event.databaseName === database.databaseName);
}

function expectOnlyMajorityPrimaryFinds(events: CommandStartedEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.commandName).toBe('find');
    expect(event.command).toMatchObject({ find: 'users', readConcern: { level: 'majority' } });
    expect(event.command).not.toHaveProperty('$readPreference.mode', expect.not.stringMatching(/^primary$/u));
  }
}

beforeAll(async () => {
  const deriver = new NodeScryptPasswordDeriver();
  [operatorHash, viewerHash] = await Promise.all([
    deriver.derive('operator-password', SALT).then((value) => Buffer.from(value).toString('hex')),
    deriver.derive('viewer-password', SALT).then((value) => Buffer.from(value).toString('hex')),
  ]);
  client = new MongoClient(URI, { monitorCommands: true, retryReads: false, retryWrites: false });
  client.on('commandStarted', (event) => commands.push(event));
  await client.connect();
  const hello = await client.db('admin').command({ hello: 1 });
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

describe('G06a true MongoDB human authentication', () => {
  test('real scrypt fixtures authenticate exact Operator and Viewer credentials', async () => {
    const capability = auth();
    const operator = await capability.login({ username: 'operator', password: 'operator-password' });
    const viewer = await capability.login({ username: 'viewer', password: 'viewer-password' });
    const operatorPrincipal = await capability.verifyAccessToken(operator.accessToken);
    const viewerPrincipal = await capability.verifyAccessToken(viewer.accessToken);
    expect(capability.facts(operatorPrincipal)).toEqual({ userId: OPERATOR_ID, role: 'OPERATOR' });
    expect(capability.facts(viewerPrincipal)).toEqual({ userId: VIEWER_ID, role: 'VIEWER' });
    expectOnlyMajorityPrimaryFinds(authCommands());
    expect(authCommands().map((event) => event.command.filter)).toEqual([
      { username: 'operator' }, { username: 'viewer' }, { _id: OPERATOR_ID }, { _id: VIEWER_ID },
    ]);
    expect(await collections.users.countDocuments()).toBe(3);
  });

  test('lookup is exact and unknown, wrong, and disabled credentials stay generic', async () => {
    const capability = auth();
    for (const input of [
      { username: 'Operator', password: 'operator-password' },
      { username: 'operator', password: 'wrong-password' },
      { username: 'disabled', password: 'viewer-password' },
    ]) {
      await expect(capability.login(input)).rejects.toEqual(expect.objectContaining<Partial<HumanAuthError>>({
        name: 'HumanAuthError', code: 'INVALID_CREDENTIALS',
      }));
    }
    expectOnlyMajorityPrimaryFinds(authCommands());
    expect(authCommands().map((event) => event.command.filter)).toEqual([
      { username: 'Operator' }, { username: 'operator' }, { username: 'disabled' },
    ]);
    expect(await collections.users.countDocuments()).toBe(3);
  });

  test('each verification rereads Mongo and reflects an immediate role change', async () => {
    const capability = auth();
    const login = await capability.login({ username: 'operator', password: 'operator-password' });
    const first = await capability.verifyAccessToken(login.accessToken);
    expect(capability.facts(first).role).toBe('OPERATOR');
    await collections.users.updateOne({ _id: OPERATOR_ID }, { $set: { role: 'VIEWER' } });
    commands = [];
    const second = await capability.verifyAccessToken(login.accessToken);
    expect(capability.facts(second).role).toBe('VIEWER');
    expectOnlyMajorityPrimaryFinds(authCommands());
    expect(authCommands()).toHaveLength(1);
    expect(authCommands()[0]!.command.filter).toEqual({ _id: OPERATOR_ID });
  });

  test('current disabled and deleted users invalidate an already-issued token', async () => {
    const firstCapability = auth();
    const firstToken = (await firstCapability.login({ username: 'operator', password: 'operator-password' })).accessToken;
    await collections.users.updateOne({ _id: OPERATOR_ID }, { $set: { enabled: false } });
    commands = [];
    await expect(firstCapability.verifyAccessToken(firstToken)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_TOKEN' }));
    expectOnlyMajorityPrimaryFinds(authCommands());

    await collections.users.updateOne({ _id: OPERATOR_ID }, { $set: { enabled: true } });
    const secondCapability = auth();
    const secondToken = (await secondCapability.login({ username: 'operator', password: 'operator-password' })).accessToken;
    await collections.users.deleteOne({ _id: OPERATOR_ID });
    commands = [];
    await expect(secondCapability.verifyAccessToken(secondToken)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_TOKEN' }));
    expectOnlyMajorityPrimaryFinds(authCommands());
  });

  test('reader projections are narrow and authentication performs no write, transaction, or retry command', async () => {
    const capability = auth();
    const login = await capability.login({ username: 'operator', password: 'operator-password' });
    await capability.verifyAccessToken(login.accessToken);
    const observed = authCommands();
    expectOnlyMajorityPrimaryFinds(observed);
    expect(observed[0]!.command.projection).toEqual({ _id: 1, username: 1, role: 1, enabled: 1, passwordSalt: 1, passwordHash: 1, scryptParams: 1 });
    expect(observed[1]!.command.projection).toEqual({ _id: 1, role: 1, enabled: 1 });
    expect(observed.map((event) => event.commandName)).not.toEqual(expect.arrayContaining([
      'insert', 'update', 'delete', 'findAndModify', 'commitTransaction', 'abortTransaction',
    ]));
  });
});
