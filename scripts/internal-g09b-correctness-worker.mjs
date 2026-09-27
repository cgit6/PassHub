import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import g04bSchema from '../dist/src/infrastructure/mongo/g04b-schema.js';
import faceSchema from '../dist/src/infrastructure/mongo/g04a-face-index-schema.js';
import persistence from '../dist/src/infrastructure/mongo/g04b-persistence-adapter.js';
import fixtureModule from '../dist/test/perf/g09b-deterministic-fixture.js';

const {
  G04B_EVENT_INDEXES,
  G04B_EVENT_QUALIFICATION_INDEX,
  G04B_EVENT_RECEIVED_INDEX,
  G04B_QUALIFICATION_CREATED_INDEX,
  G04B_QUALIFICATION_INDEXES,
  G04B_QUALIFICATION_INSIDE_INDEX,
  G04B_SOURCE_INDEXES,
  G04B_USER_INDEXES,
  G04B_FACE_SLOTS_COLLECTION,
} = g04bSchema;
const { G04A_FACE_SLOTS_INDEXES } = faceSchema;
const { G04bMongoPersistenceAdapter } = persistence;
const {
  assertG09bDeterministicFixture,
  createG09bDeterministicFixture,
  createG09bFixtureManifest,
  hashFixture,
} = fixtureModule;

const uri = process.env.G09B_MONGO_URI ?? 'mongodb://127.0.0.1:27039/?replicaSet=rs0';
const databaseName = process.env.G09B_MONGO_DATABASE ?? `passhub_g09b_b1_${process.pid}`;
const baseTimeMs = 1_790_467_200_000;
const collectionsByName = {
  qualifications: { name: 'qualifications', expected: G04B_QUALIFICATION_INDEXES },
  faceSlots: { name: G04B_FACE_SLOTS_COLLECTION, expected: G04A_FACE_SLOTS_INDEXES },
  events: { name: 'events', expected: G04B_EVENT_INDEXES },
  users: { name: 'users', expected: G04B_USER_INDEXES },
  sources: { name: 'sources', expected: G04B_SOURCE_INDEXES },
  metadata: { name: 'metadata', expected: [] },
};
const targetIndexNames = new Set([
  G04B_QUALIFICATION_CREATED_INDEX,
  G04B_QUALIFICATION_INSIDE_INDEX,
  G04B_EVENT_RECEIVED_INDEX,
  G04B_EVENT_QUALIFICATION_INDEX,
]);

const phaseDurationsMs = {};
let client;
let database;
let adapter;
let baselineInventory;
let failure;

try {
  const started = performance.now();
  client = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, serverSelectionTimeoutMS: 2_000 });
  await client.connect();
  database = client.db(databaseName);
  const buildInfo = await database.client.db('admin').command({ buildInfo: 1 });
  const hello = await database.client.db('admin').command({ hello: 1 });
  if (buildInfo.version !== '8.0.32' || hello.setName !== 'rs0' || hello.isWritablePrimary !== true || !Array.isArray(hello.hosts) || hello.hosts.length !== 1 || hello.hosts[0] !== '127.0.0.1:27039') throw new Error('G09b Mongo readiness contract failed');
  phaseDurationsMs.readiness = performance.now() - started;

  adapter = new G04bMongoPersistenceAdapter(client, databaseName, { nowMs: () => baseTimeMs });
  const schemaStarted = performance.now();
  await adapter.ensureSchema();
  phaseDurationsMs.schema = performance.now() - schemaStarted;

  const fixture = createG09bDeterministicFixture();
  const manifest = createG09bFixtureManifest(fixture);
  const insertStarted = performance.now();
  await insertFixture(database, fixture);
  phaseDurationsMs.insert = performance.now() - insertStarted;
  await adapter.ensureSchema();
  const readback = await readFixture(database);
  assertG09bDeterministicFixture(readback);
  const readbackHash = hashFixture(readback);
  if (readbackHash !== manifest.fixtureHash) throw new Error(`G09b readback hash mismatch: ${readbackHash}`);
  baselineInventory = await readIndexInventory(database);
  assertFullInventory(baselineInventory);

  await dropTargetIndexes(database);
  const beforeInventory = await readIndexInventory(database);
  assertOnlyTargetsMissing(beforeInventory, baselineInventory);
  await clearPlanCaches(database);
  const beforeStarted = performance.now();
  const before = await runOracleCases(adapter, manifest);
  phaseDurationsMs.beforeCorrectness = performance.now() - beforeStarted;

  await restoreTargetIndexes(database);
  const restoredInventory = await readIndexInventory(database);
  assertInventoryEqual(restoredInventory, baselineInventory);
  await clearPlanCaches(database);

  const afterInventory = await readIndexInventory(database);
  assertInventoryEqual(afterInventory, baselineInventory);
  await clearPlanCaches(database);
  const afterStarted = performance.now();
  const after = await runOracleCases(adapter, manifest);
  phaseDurationsMs.afterCorrectness = performance.now() - afterStarted;
  if (stableJson(before) !== stableJson(after)) throw new Error('G09b BEFORE/AFTER query results differ');

  await writeCorrectnessResult({
    fixture,
    fixtureHash: manifest.fixtureHash,
    readbackHash,
    counts: manifest.counts,
    manifest,
    baselineInventory,
    beforeInventory,
    afterInventory,
    before,
    after,
  });

  console.log(JSON.stringify({
    databaseName,
    mongo: { version: buildInfo.version, setName: hello.setName, isWritablePrimary: hello.isWritablePrimary, hosts: hello.hosts },
    fixtureHash: manifest.fixtureHash,
    readbackHash,
    counts: manifest.counts,
    cases: manifest.cases.map((item) => ({ id: item.id, expectedMatchCount: item.expectedMatchCount, firstFetch21: item.firstFetch21Ids.length, nextFetch21: item.nextFetch21Ids.length, hasNext: item.nextPage.hasNext })),
    phaseDurationsMs,
    indexStates: { beforeMissing: [...targetIndexNames], restored: true },
  }, null, 2));
} catch (error) {
  failure = error;
} finally {
  if (database !== undefined && baselineInventory !== undefined) {
    try {
      await restoreTargetIndexes(database);
      const finalInventory = await readIndexInventory(database);
      assertInventoryEqual(finalInventory, baselineInventory);
    } catch (cleanupError) {
      if (failure === undefined) failure = cleanupError;
      else process.stderr.write(`G09b index cleanup also failed: ${formatError(cleanupError)}\n`);
    }
  }
  if (client !== undefined) await client.close().catch((cleanupError) => {
    if (failure === undefined) failure = cleanupError;
    else process.stderr.write(`G09b client cleanup also failed: ${formatError(cleanupError)}\n`);
  });
}
if (failure !== undefined) throw failure;

async function insertFixture(db, fixture) {
  await insertBatches(db.collection('qualifications'), fixture.qualifications);
  await insertBatches(db.collection(G04B_FACE_SLOTS_COLLECTION), fixture.faceSlots);
  await insertBatches(db.collection('events'), fixture.events);
  await insertBatches(db.collection('users'), fixture.users);
  await insertBatches(db.collection('sources'), fixture.sources);
  await db.collection('metadata').insertOne(fixture.metadata);
}

async function insertBatches(collection, values) {
  for (let offset = 0; offset < values.length; offset += 500) await collection.insertMany(values.slice(offset, offset + 500), { ordered: true });
}

async function readFixture(db) {
  const read = async (name) => db.collection(name).find({}).toArray();
  return {
    seed: 'passhub-g09b-v1-20260927',
    baseTimeMs,
    datasetEpoch: (await db.collection('metadata').findOne({ _id: 'system' })).datasetEpoch,
    comparisonReferenceId: (await db.collection('metadata').findOne({ _id: 'system' })).comparisonReferenceId,
    qualifications: await read('qualifications'),
    faceSlots: await read(G04B_FACE_SLOTS_COLLECTION),
    events: await read('events'),
    users: await read('users'),
    sources: await read('sources'),
    metadata: await db.collection('metadata').findOne({ _id: 'system' }),
  };
}

async function readIndexInventory(db) {
  const inventory = {};
  for (const [key, definition] of Object.entries(collectionsByName)) inventory[key] = (await db.collection(definition.name).listIndexes().toArray()).map(normalizeIndex).sort((left, right) => compareUtf16(left.name, right.name));
  return inventory;
}

function normalizeIndex(index) {
  const actualKeys = new Set(Object.keys(index));
  const allowed = new Set(['v', 'key', 'name', 'unique', 'partialFilterExpression', 'collation']);
  for (const key of actualKeys) if (!allowed.has(key)) throw new Error(`unexpected index option ${key}`);
  return {
    v: index.v,
    name: index.name,
    key: Object.entries(index.key ?? {}),
    unique: index.unique === true,
    partialFilterExpression: index.partialFilterExpression === undefined ? null : stableValue(index.partialFilterExpression),
    collation: index.collation?.locale === 'simple' && Object.keys(index.collation).length === 1 ? null : index.collation === undefined ? null : stableValue(index.collation),
  };
}

function expectedInventory() {
  const result = {};
  for (const [key, definition] of Object.entries(collectionsByName)) result[key] = [{ v: 2, name: '_id_', key: [['_id', 1]], unique: false, partialFilterExpression: null, collation: null }, ...definition.expected.map((index) => normalizeIndex({ ...index, v: 2 }))].sort((left, right) => compareUtf16(left.name, right.name));
  return result;
}

function assertFullInventory(inventory) { assertInventoryEqual(inventory, expectedInventory()); }
function assertInventoryEqual(actual, expected) { if (stableJson(actual) !== stableJson(expected)) throw new Error('G09b index inventory mismatch'); }
function assertOnlyTargetsMissing(actual, baseline) {
  for (const [key, indexes] of Object.entries(baseline)) {
    const actualNames = new Set(actual[key].map((index) => index.name));
    for (const baselineIndex of indexes) {
      if (targetIndexNames.has(baselineIndex.name)) { if (actualNames.has(baselineIndex.name)) throw new Error(`G09b BEFORE index still present ${baselineIndex.name}`); }
      else if (!actualNames.has(baselineIndex.name)) throw new Error(`G09b BEFORE non-target index missing ${baselineIndex.name}`);
    }
    assertInventoryEqual(actual[key].filter((index) => !targetIndexNames.has(index.name)), indexes.filter((index) => !targetIndexNames.has(index.name)));
  }
}

async function dropTargetIndexes(db) {
  await db.collection('qualifications').dropIndex(G04B_QUALIFICATION_CREATED_INDEX);
  await db.collection('qualifications').dropIndex(G04B_QUALIFICATION_INSIDE_INDEX);
  await db.collection('events').dropIndex(G04B_EVENT_RECEIVED_INDEX);
  await db.collection('events').dropIndex(G04B_EVENT_QUALIFICATION_INDEX);
}

async function restoreTargetIndexes(db) {
  const definitions = [...G04B_QUALIFICATION_INDEXES, ...G04B_EVENT_INDEXES].filter((index) => targetIndexNames.has(index.name));
  await db.collection('qualifications').createIndexes(definitions.filter((index) => index.name.startsWith('g04b_qualification_')));
  await db.collection('events').createIndexes(definitions.filter((index) => index.name.startsWith('g04b_event_')));
}

async function clearPlanCaches(db) {
  for (const definition of Object.values(collectionsByName)) await db.command({ planCacheClear: definition.name });
}

async function runOracleCases(queryAdapter, manifest) {
  const result = {};
  for (const item of manifest.cases) {
    const first = await queryCase(queryAdapter, item, null);
    const next = await queryCase(queryAdapter, item, item.after);
    const rowId = (row) => item.collection === 'events' ? row.eventId : row.qualificationId;
    const firstIds = first.map(rowId);
    const nextIds = next.map(rowId);
    if (stableJson(firstIds) !== stableJson(item.firstFetch21Ids) || stableJson(nextIds) !== stableJson(item.nextFetch21Ids)) throw new Error(`G09b oracle mismatch ${item.id}`);
    if (first.length !== 21 || next.length !== 21) throw new Error(`G09b fetchLimit21 mismatch ${item.id}`);
    if (stableJson(first.slice(0, 20).map(rowId)) !== stableJson(item.first20Ids) || stableJson(next.slice(0, 20).map(rowId)) !== stableJson(item.next20Ids)) throw new Error(`G09b visible page mismatch ${item.id}`);
    const combined = [...first.slice(0, 20), ...next.slice(0, 20)].map(rowId);
    if (new Set(combined).size !== combined.length) throw new Error(`G09b page duplicate ${item.id}`);
    result[item.id] = { first, next };
  }
  return result;
}

async function queryCase(queryAdapter, item, after) {
  const input = { fetchLimit: 21, after, observedAtMs: baseTimeMs };
  if (item.collection === 'qualifications') return queryAdapter.listQualifications(input);
  if (item.collection === 'inside') return queryAdapter.listInside(input);
  return queryAdapter.listEvents({ ...input, filters: item.filters });
}

async function writeCorrectnessResult(result) {
  const target = process.env.G09B_CORRECTNESS_RESULT;
  if (typeof target !== 'string' || target.length === 0) return;
  const cases = result.manifest.cases.map((item) => {
    const beforeCase = result.before[item.id];
    const afterCase = result.after[item.id];
    const rowId = (row) => item.collection === 'events' ? row.eventId : row.qualificationId;
    const firstFetch21Ids = beforeCase.first.map(rowId);
    const nextFetch21Ids = beforeCase.next.map(rowId);
    const first20Ids = firstFetch21Ids.slice(0, 20);
    const next20Ids = nextFetch21Ids.slice(0, 20);
    const combined = [...first20Ids, ...next20Ids];
    const fixtureRows = item.collection === 'inside'
      ? result.fixture.qualifications.filter((row) => row.presence === 'INSIDE')
      : item.collection === 'qualifications'
        ? result.fixture.qualifications
        : result.fixture.events.filter((row) => (item.filters.qualificationId === null || row.qualificationId === item.filters.qualificationId) && (item.filters.outcome === null || row.outcome === item.filters.outcome) && (item.filters.reasonCode === null || row.reasonCode === item.filters.reasonCode));
    const timeCounts = new Map(fixtureRows.map((row) => [timeForCorrectness(item.collection, row), 0]));
    for (const row of fixtureRows) { const time = timeForCorrectness(item.collection, row); timeCounts.set(time, (timeCounts.get(time) ?? 0) + 1); }
    return {
      id: item.id,
      expectedMatchCount: item.expectedMatchCount,
      first20Ids,
      firstFetch21Ids,
      after: item.after,
      next20Ids,
      nextFetch21Ids,
      nextPage: item.nextPage,
      beforeAfterEqual: stableJson(beforeCase) === stableJson(afterCase),
      tieBucketAtLeast64: Math.max(...timeCounts.values()) >= 64,
      noGap: stableJson(first20Ids) === stableJson(item.first20Ids) && stableJson(next20Ids) === stableJson(item.next20Ids),
      noDuplicate: new Set(combined).size === combined.length,
    };
  });
  const output = {
    status: 'PASS',
    fixtureHash: result.fixtureHash,
    readbackHash: result.readbackHash,
    counts: result.counts,
    cases,
    beforeAfterEqual: cases.every((item) => item.beforeAfterEqual),
    tieBucketsAtLeast64: cases.every((item) => item.tieBucketAtLeast64),
    noPageGaps: cases.every((item) => item.noGap),
    noPageDuplicates: cases.every((item) => item.noDuplicate),
    indexInventories: { baseline: result.baselineInventory, before: result.beforeInventory, after: result.afterInventory },
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function timeForCorrectness(collection, row) { return (collection === 'events' ? row.receivedAt : collection === 'inside' ? row.enteredAt : row.createdAt).getTime(); }

function stableJson(value) { return JSON.stringify(stableValue(value)); }
function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compareUtf16).map((key) => [key, stableValue(value[key])]));
  return value;
}
function compareUtf16(left, right) { for (let index = 0; index < Math.min(left.length, right.length); index += 1) { const difference = left.charCodeAt(index) - right.charCodeAt(index); if (difference !== 0) return difference; } return left.length - right.length; }
function formatError(error) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
