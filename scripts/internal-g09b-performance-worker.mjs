import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { MongoClient } from 'mongodb';
import {
  G09B_MEASURED,
  G09B_NEAREST_RANK_INDICES,
  G09B_WARMUPS,
  assertExplainPairs,
  explainPairKey,
  measureCell,
  measurementPlan,
  publishStagedDirectory,
  prepareTypedReplayCommand,
  sanitizeCommandArtifact,
  summarizeMongoExplain,
} from './internal-g09b-performance-model.mjs';
import g04bSchema from '../dist/src/infrastructure/mongo/g04b-schema.js';
import faceSchema from '../dist/src/infrastructure/mongo/g04a-face-index-schema.js';
import persistence from '../dist/src/infrastructure/mongo/g04b-persistence-adapter.js';
import fixtureModule from '../dist/test/perf/g09b-deterministic-fixture.js';

const {
  G04B_EVENT_INDEXES, G04B_EVENT_QUALIFICATION_INDEX, G04B_EVENT_RECEIVED_INDEX,
  G04B_QUALIFICATION_CREATED_INDEX, G04B_QUALIFICATION_INDEXES, G04B_QUALIFICATION_INSIDE_INDEX,
  G04B_SOURCE_INDEXES, G04B_USER_INDEXES, G04B_FACE_SLOTS_COLLECTION,
} = g04bSchema;
const { G04A_FACE_SLOTS_INDEXES } = faceSchema;
const { G04bMongoPersistenceAdapter } = persistence;
const { createG09bDeterministicFixture, createG09bFixtureManifest, hashFixture } = fixtureModule;

const uri = process.env.G09B_MONGO_URI ?? 'mongodb://127.0.0.1:27039/?replicaSet=rs0';
const databaseName = process.env.G09B_MONGO_DATABASE ?? `passhub_g09b_b2_${process.pid}`;
const runId = process.env.G09B_PERF_RUN_ID ?? `g09b-b2-${process.pid}-${Date.now()}`;
const outputRoot = process.env.G09B_PERF_OUTPUT_ROOT ?? 'output/evidence/g09b';
const finalDirectory = path.resolve(outputRoot, runId);
const stagingDirectory = path.resolve(outputRoot, `.staging-${runId}`);
const baseTimeMs = Date.parse('2026-09-27T00:00:00.000Z');
const collectionsByName = {
  qualifications: { name: 'qualifications', expected: G04B_QUALIFICATION_INDEXES },
  faceSlots: { name: G04B_FACE_SLOTS_COLLECTION, expected: G04A_FACE_SLOTS_INDEXES },
  events: { name: 'events', expected: G04B_EVENT_INDEXES },
  users: { name: 'users', expected: G04B_USER_INDEXES },
  sources: { name: 'sources', expected: G04B_SOURCE_INDEXES },
  metadata: { name: 'metadata', expected: [] },
};
const targetIndexNames = new Set([
  G04B_QUALIFICATION_CREATED_INDEX, G04B_QUALIFICATION_INSIDE_INDEX,
  G04B_EVENT_RECEIVED_INDEX, G04B_EVENT_QUALIFICATION_INDEX,
]);

let measurementClient;
let monitoringClient;
let database;
let monitoringDatabase;
let baselineInventory;
let measurementAdapter;
let monitoringAdapter;
let fixture;
let manifest;
let correctnessCore;
let rawStream;
let failure;

try {
  assertProvenanceEnvironment();
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.rm(stagingDirectory, { recursive: true, force: true });
  await fs.mkdir(stagingDirectory, { recursive: true });
  await runCorrectnessFirst();
  correctnessCore = JSON.parse(await fs.readFile(path.join(stagingDirectory, 'correctness-core.json'), 'utf8'));
  if (correctnessCore.status !== 'PASS' || correctnessCore.readbackHash !== correctnessCore.fixtureHash) throw new Error('G09b correctness core result is invalid');
  fixture = createG09bDeterministicFixture();
  manifest = createG09bFixtureManifest(fixture);
  measurementClient = new MongoClient(uri, { monitorCommands: false, retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, serverSelectionTimeoutMS: 2_000 });
  monitoringClient = new MongoClient(uri, { monitorCommands: true, retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, serverSelectionTimeoutMS: 2_000 });
  await measurementClient.connect();
  await monitoringClient.connect();
  database = measurementClient.db(databaseName);
  monitoringDatabase = monitoringClient.db(databaseName);
  measurementAdapter = new G04bMongoPersistenceAdapter(measurementClient, databaseName, { nowMs: () => baseTimeMs });
  monitoringAdapter = new G04bMongoPersistenceAdapter(monitoringClient, databaseName, { nowMs: () => baseTimeMs });
  await measurementAdapter.ensureSchema();
  await monitoringAdapter.ensureSchema();
  baselineInventory = await readIndexInventory(database);
  assertFullInventory(baselineInventory);
  rawStream = createWriteStream(path.join(stagingDirectory, 'raw.jsonl'), { encoding: 'utf8' });
  const plan = measurementPlan(manifest.cases);
  const summaries = [];
  const explains = new Map();
  const states = {};

  await dropTargetIndexes(database);
  const beforeInventory = await readIndexInventory(database);
  assertOnlyTargetsMissing(beforeInventory, baselineInventory);
  states.BEFORE = await runState('BEFORE', plan, summaries, explains);
  await restoreTargetIndexes(database);
  const afterInventory = await readIndexInventory(database);
  assertInventoryEqual(afterInventory, baselineInventory);
  states.AFTER = await runState('AFTER', plan, summaries, explains);
  assertExplainPairs(explains, plan);
  await closeStream(rawStream);
  rawStream = undefined;
  await writeEvidence({ plan, summaries, explains, states, beforeInventory, afterInventory, baselineInventory });
  await publishStagedDirectory(stagingDirectory, finalDirectory);
  console.log(JSON.stringify({ runId, outputDirectory: finalDirectory, fixtureHash: manifest.fixtureHash, rawSamples: summaries.reduce((sum, item) => sum + item.measured, 0), explains: explains.size }));
} catch (error) {
  failure = error;
} finally {
  if (rawStream !== undefined) await closeStream(rawStream).catch((error) => { if (failure === undefined) failure = error; });
  if (database !== undefined && baselineInventory !== undefined) {
    try { await restoreTargetIndexes(database); } catch (error) { if (failure === undefined) failure = error; }
  }
  await measurementClient?.close().catch((error) => { if (failure === undefined) failure = error; });
  await monitoringClient?.close().catch((error) => { if (failure === undefined) failure = error; });
  if (failure !== undefined) await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
}
if (failure !== undefined) throw failure;

function assertProvenanceEnvironment() {
  if (process.env.G09B_SOURCE_DIRTY !== '0' || !/^[0-9a-f]{40}$/u.test(process.env.G09B_PERF_SOURCE_COMMIT ?? '') || !/^[0-9a-f]{64}$/u.test(process.env.G09B_PRODUCTION_CODE_HASH ?? '') || !/^[0-9a-f]{64}$/u.test(process.env.G09B_PACKAGE_LOCK_HASH ?? '') || !/^sha256:[0-9a-f]{64}$/u.test(process.env.G09B_IMAGE_DIGEST ?? '')) throw new Error('G09b evidence provenance is not clean or complete');
}

async function runCorrectnessFirst() {
  const child = spawn(process.execPath, ['scripts/internal-g09b-correctness-worker.mjs'], {
    env: { ...process.env, G09B_MONGO_URI: uri, G09B_MONGO_DATABASE: databaseName, G09B_CORRECTNESS_RESULT: path.join(stagingDirectory, 'correctness-core.json') },
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code === null ? 1 : code || (signal === null ? 0 : 1)));
  });
  if (exitCode !== 0) throw new Error(`G09b correctness prerequisite failed with exit ${exitCode}`);
}

async function runState(state, plan, summaries, explains) {
  await clearPlanCaches(database);
  const stateSummaries = [];
  for (const item of plan.filter((candidate) => candidate.state === state)) {
    const manifestCase = manifest.cases.find((candidate) => candidate.id === item.caseId);
    if (manifestCase === undefined) throw new Error(`G09b manifest case missing ${item.caseId}`);
    const after = item.page === 'first' ? null : manifestCase.after;
    const capture = await captureAggregateCommand(manifestCase, after, item.state, item.page);
    const explain = await explainAggregate(capture.replayCommand);
    const key = explainPairKey(state, item.caseId, item.page);
    const summary = summarizeMongoExplain(explain, manifestCase.collection !== 'events');
    explains.set(key, { state, caseId: item.caseId, page: item.page, captureId: key, captureCount: capture.captureCount, commandIdentity: capture.commandIdentity, command: capture.artifactCommand, summary, explain: sanitize(explain) });
    const cell = await measureCell({
      state, caseId: item.caseId, page: item.page,
      query: () => queryCase(measurementAdapter, manifestCase, after),
      idOf: (row) => manifestCase.collection === 'events' ? row.eventId : row.qualificationId,
      onSample: async (sample) => rawStream.write(`${JSON.stringify(sample)}\n`),
    });
    summaries.push(cell);
    stateSummaries.push(cell);
  }
  return stateSummaries;
}

async function captureAggregateCommand(item, after, state, page) {
  const commands = [];
  const listener = (event) => { if (event.commandName === 'aggregate' && event.command?.pipeline !== undefined) commands.push(event.command); };
  monitoringClient.on('commandStarted', listener);
  try { await queryCase(monitoringAdapter, item, after); } finally { monitoringClient.off('commandStarted', listener); }
  if (commands.length !== 1) throw new Error(`G09b aggregate capture count for ${state}/${item.id}/${page} was ${commands.length}`);
  const replayCommand = prepareTypedReplayCommand(commands[0]);
  const artifactCommand = sanitizeCommandArtifact(replayCommand);
  return { captureCount: commands.length, replayCommand, artifactCommand, commandIdentity: createHash('sha256').update(canonicalJson(artifactCommand), 'utf8').digest('hex') };
}

async function explainAggregate(command) {
  const explainCommand = { ...command };
  return monitoringDatabase.command({ explain: explainCommand, verbosity: 'executionStats' });
}

async function queryCase(queryAdapter, item, after) {
  const input = { fetchLimit: 21, after, observedAtMs: baseTimeMs };
  if (item.collection === 'qualifications') return queryAdapter.listQualifications(input);
  if (item.collection === 'inside') return queryAdapter.listInside(input);
  return queryAdapter.listEvents({ ...input, filters: item.filters });
}

async function writeEvidence({ plan, summaries, explains, states, beforeInventory, afterInventory, baselineInventory: inventory }) {
  const config = { seed: manifest.seed, warmups: G09B_WARMUPS, measured: G09B_MEASURED, nearestRankIndices: G09B_NEAREST_RANK_INDICES, rawSampleCount: summaries.reduce((sum, item) => sum + item.measured, 0), states: ['BEFORE', 'AFTER'], cases: 10, pagesPerCase: 2, adapter: 'G04bMongoPersistenceAdapter', hint: false, allowDiskUse: false };
  const buildInfo = await database.client.db('admin').command({ buildInfo: 1 });
  const hello = await database.client.db('admin').command({ hello: 1 });
  const environment = { node: process.version, npm: readNpmVersion(), os: { platform: os.platform(), release: os.release(), arch: os.arch(), cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem() }, mongo: { version: buildInfo.version, setName: hello.setName, isWritablePrimary: hello.isWritablePrimary, hosts: hello.hosts }, databaseName, sourceCommit: process.env.G09B_PERF_SOURCE_COMMIT ?? null, sourceDirty: process.env.G09B_SOURCE_DIRTY === '1', productionCodeHash: process.env.G09B_PRODUCTION_CODE_HASH ?? null, packageLockHash: process.env.G09B_PACKAGE_LOCK_HASH ?? null, imageDigest: process.env.G09B_IMAGE_DIGEST ?? null, runId };
  const seedBank = { seed: manifest.seed, fixtureHash: manifest.fixtureHash, baseTimeMs };
  await fs.writeFile(path.join(stagingDirectory, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(stagingDirectory, 'seed-bank.json'), JSON.stringify(seedBank, null, 2));
  await fs.writeFile(path.join(stagingDirectory, 'config.json'), JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(stagingDirectory, 'environment.json'), JSON.stringify(environment, null, 2));
  await fs.writeFile(path.join(stagingDirectory, 'correctness-core.json'), `${JSON.stringify(correctnessCore, null, 2)}\n`);
  await fs.writeFile(path.join(stagingDirectory, 'correctness.json'), JSON.stringify({ ...correctnessCore, performanceIndexInventories: { baseline: inventory, before: beforeInventory, after: afterInventory }, measuredStates: Object.fromEntries(Object.entries(states).map(([key, value]) => [key, value.map((item) => ({ caseId: item.caseId, page: item.page, measured: item.measured }))])) }, null, 2));
  await fs.writeFile(path.join(stagingDirectory, 'summary.json'), JSON.stringify({ status: 'PASS', fixtureHash: manifest.fixtureHash, rawSamples: summaries.length * G09B_MEASURED, cells: summaries, note: 'BEFORE runs before AFTER; cache/order bias is reported by raw state separation; no outlier was removed.' }, null, 2));
  const explainDirectory = path.join(stagingDirectory, 'explains');
  await fs.mkdir(explainDirectory, { recursive: true });
  const explainLines = [...explains.values()].map((value) => JSON.stringify({ state: value.state, caseId: value.caseId, page: value.page, summary: value.summary }));
  await fs.writeFile(path.join(stagingDirectory, 'explain-summary.json'), JSON.stringify({ count: explains.size, entries: [...explains.values()].map(({ state, caseId, page, captureId, captureCount, commandIdentity, summary }) => ({ state, caseId, page, captureId, captureCount, commandIdentity, summary })) }, null, 2));
  await fs.writeFile(path.join(stagingDirectory, 'explains.jsonl'), `${explainLines.join('\n')}\n`);
  for (const [key, value] of explains) await fs.writeFile(path.join(explainDirectory, `${key.replaceAll('/', '__')}.json`), `${JSON.stringify(value, null, 2)}\n`);
  const artifacts = await artifactHashes(stagingDirectory);
  await fs.writeFile(path.join(stagingDirectory, 'manifest.json'), `${JSON.stringify({ format: 'g09b-b2-evidence-v1', runId, sourceCommit: environment.sourceCommit, sourceDirty: environment.sourceDirty, productionCodeHash: environment.productionCodeHash, packageLockHash: environment.packageLockHash, fixtureHash: manifest.fixtureHash, configHash: artifacts['config.json'], seedHash: artifacts['seed-bank.json'], artifacts }, null, 2)}\n`);
}

function readNpmVersion() { try { return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(); } catch { throw new Error('G09b npm version unavailable'); } }
async function artifactHashes(root) {
  const files = [];
  async function visit(directory) {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => compareUtf16(left.name, right.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name !== 'manifest.json') files.push([path.relative(root, full).split(path.sep).join('/'), await sha256File(full)]);
    }
  }
  await visit(root);
  return Object.fromEntries(files);
}
async function sha256File(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
function canonicalJson(value) { return JSON.stringify(stableValue(value)); }

async function readIndexInventory(db) {
  const inventory = {};
  for (const [key, definition] of Object.entries(collectionsByName)) inventory[key] = (await db.collection(definition.name).listIndexes().toArray()).map(normalizeIndex).sort((left, right) => compareUtf16(left.name, right.name));
  return inventory;
}
function normalizeIndex(index) {
  return { v: index.v, name: index.name, key: Object.entries(index.key ?? {}), unique: index.unique === true, partialFilterExpression: index.partialFilterExpression === undefined ? null : stableValue(index.partialFilterExpression), collation: index.collation?.locale === 'simple' && Object.keys(index.collation).length === 1 ? null : index.collation === undefined ? null : stableValue(index.collation) };
}
function expectedInventory() {
  const result = {};
  for (const [key, definition] of Object.entries(collectionsByName)) result[key] = [{ v: 2, name: '_id_', key: [['_id', 1]], unique: false, partialFilterExpression: null, collation: null }, ...definition.expected.map((index) => normalizeIndex({ ...index, v: 2 }))].sort((left, right) => compareUtf16(left.name, right.name));
  return result;
}
function assertFullInventory(inventory) { assertInventoryEqual(inventory, expectedInventory()); }
function assertInventoryEqual(actual, expected) { if (stableJson(actual) !== stableJson(expected)) throw new Error('G09b performance index inventory mismatch'); }
function assertOnlyTargetsMissing(actual, baseline) {
  for (const [key, indexes] of Object.entries(baseline)) {
    const actualNames = new Set(actual[key].map((index) => index.name));
    for (const baselineIndex of indexes) {
      if (targetIndexNames.has(baselineIndex.name)) {
        if (actualNames.has(baselineIndex.name)) throw new Error(`G09b target index still present ${baselineIndex.name}`);
      } else if (!actualNames.has(baselineIndex.name)) throw new Error(`G09b non-target index missing ${baselineIndex.name}`);
    }
    const actualNonTargets = actual[key].filter((index) => !targetIndexNames.has(index.name));
    const baselineNonTargets = indexes.filter((index) => !targetIndexNames.has(index.name));
    assertInventoryEqual(actualNonTargets, baselineNonTargets);
  }
}
async function dropTargetIndexes(db) { await db.collection('qualifications').dropIndex(G04B_QUALIFICATION_CREATED_INDEX); await db.collection('qualifications').dropIndex(G04B_QUALIFICATION_INSIDE_INDEX); await db.collection('events').dropIndex(G04B_EVENT_RECEIVED_INDEX); await db.collection('events').dropIndex(G04B_EVENT_QUALIFICATION_INDEX); }
async function restoreTargetIndexes(db) { const definitions = [...G04B_QUALIFICATION_INDEXES, ...G04B_EVENT_INDEXES].filter((index) => targetIndexNames.has(index.name)); await db.collection('qualifications').createIndexes(definitions.filter((index) => index.name.startsWith('g04b_qualification_'))); await db.collection('events').createIndexes(definitions.filter((index) => index.name.startsWith('g04b_event_'))); }
async function clearPlanCaches(db) { for (const definition of Object.values(collectionsByName)) await db.command({ planCacheClear: definition.name }); }
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function stableValue(value) { if (value instanceof Date) return value.toISOString(); if (Array.isArray(value)) return value.map(stableValue); if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compareUtf16).map((key) => [key, stableValue(value[key])])); return value; }
function compareUtf16(left, right) { for (let index = 0; index < Math.min(left.length, right.length); index += 1) { const difference = left.charCodeAt(index) - right.charCodeAt(index); if (difference !== 0) return difference; } return left.length - right.length; }
function sanitize(value) { if (value instanceof Date) return value.toISOString(); if (Array.isArray(value)) return value.map(sanitize); if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['lsid', '$clusterTime', 'operationTime', '$db', '$readPreference'].includes(key)).map(([key, child]) => [key, sanitize(child)])); return value; }
function closeStream(stream) { return new Promise((resolve, reject) => { stream.once('error', reject); stream.end(resolve); }); }
