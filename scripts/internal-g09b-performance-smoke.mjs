import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  G09B_MEASURED,
  G09B_NEAREST_RANK_INDICES,
  G09B_RAW_SAMPLE_COUNT,
  G09B_WARMUPS,
  assertExplainPairs,
  explainPairKey,
  measureCell,
  measurementPlan,
  nearestRank,
  parsePerfArgs,
  prepareTypedReplayCommand,
  publishStagedDirectory,
  sanitizeCommandArtifact,
  summarizeMongoExplain,
} from './internal-g09b-performance-model.mjs';

const cases = Array.from({ length: 10 }, (_, index) => ({ id: `case-${index}` }));
const plan = measurementPlan(cases, ['BEFORE', 'AFTER'], 2, 3);
assert.equal(plan.length, 40);
assert.equal(plan.reduce((sum, item) => sum + item.measured, 0), 120);
assert.equal(G09B_RAW_SAMPLE_COUNT, 4_000);
assert.equal(G09B_WARMUPS, 10);
assert.equal(G09B_MEASURED, 100);
assert.deepEqual(parsePerfArgs(['--gate', 'g09b']), { smoke: false });
assert.deepEqual(parsePerfArgs(['--gate', 'g09b', '--smoke']), { smoke: true });
for (const invalid of [[], ['--smoke', '--gate', 'g09b'], ['--gate', 'g09b', '--gate', 'g09b'], ['--gate', 'g09b', '--smoke', '--smoke'], ['--gate', 'other']]) assert.throws(() => parsePerfArgs(invalid), /usage/u);
assert.equal(nearestRank(Array.from({ length: 100 }, (_, index) => index), G09B_NEAREST_RANK_INDICES.p50), 49);
assert.equal(nearestRank(Array.from({ length: 100 }, (_, index) => index), G09B_NEAREST_RANK_INDICES.p95), 94);

let ticks = 0n;
const samples = [];
const cell = await measureCell({
  state: 'BEFORE', caseId: 'case-0', page: 'first', warmups: 2, measured: 3,
  clock: () => (ticks += 7n), query: async () => [{ id: 'row-a' }, { id: 'row-b' }],
  idOf: (row) => row.id, onSample: async (sample) => samples.push(sample),
});
assert.equal(samples.length, 3);
assert.deepEqual(samples.map((sample) => sample.durationNs), [7, 7, 7]);
assert.equal(cell.summary.count, 3);
assert.equal(cell.summary.p50Ns, 7);

const explains = new Map(plan.map((item) => [explainPairKey(item.state, item.caseId, item.page), { command: 'aggregate', state: item.state }]));
for (const [key, value] of explains) explains.set(key, { ...value, captureId: key, captureCount: 1, commandIdentity: 'a'.repeat(64) });
assertExplainPairs(explains, plan);
assert.throws(() => assertExplainPairs(new Map([...explains].slice(0, -1)), plan), /explain count/u);

const cursorExplain = { stages: [{ $cursor: { executionStats: { nReturned: 21, totalKeysExamined: 21, totalDocsExamined: 21, executionTimeMillis: 1, executionStages: { stage: 'LIMIT' } } } }, { $lookup: { from: 'faceSlots', pipeline: [] }, nReturned: 21, totalKeysExamined: 40, totalDocsExamined: 40, collectionScans: 0, indexesUsed: ['_id_'], executionTimeMillisEstimate: 2 }] };
assert.deepEqual(summarizeMongoExplain(cursorExplain, true), { primaryCursor: { stage: 'LIMIT', nReturned: 21, totalKeysExamined: 21, totalDocsExamined: 21, executionTimeMillis: 1 }, lookup: { nReturned: 21, totalKeysExamined: 40, totalDocsExamined: 40, collectionScans: 0, indexesUsed: ['_id_'], executionTimeMillisEstimate: 2 } });
const eventExplain = { executionStats: { nReturned: 21, totalKeysExamined: 21, totalDocsExamined: 21, executionTimeMillis: 1, executionStages: { stage: 'LIMIT' } } };
assert.deepEqual(summarizeMongoExplain(eventExplain, false).lookup, null);
assert.throws(() => summarizeMongoExplain({ stages: [{ $cursor: { executionStats: { executionStages: { stage: 'LIMIT' }, nReturned: 21, totalKeysExamined: 21, totalDocsExamined: 21 } } }] }, true), /stage shape/u);

const typedCommand = { aggregate: 'qualifications', pipeline: [{ $match: { createdAt: new Date('2026-09-27T00:00:00.000Z'), lsid: { nested: true }, operationTime: { nested: true }, $readPreference: { nested: true } } }], cursor: {}, readConcern: { level: 'majority' }, $db: 'secret', lsid: { id: 'secret' } };
const replayCommand = prepareTypedReplayCommand(typedCommand);
const artifactCommand = sanitizeCommandArtifact(replayCommand);
assert(replayCommand.pipeline[0].$match.createdAt instanceof Date);
assert.equal(artifactCommand.pipeline[0].$match.createdAt, '2026-09-27T00:00:00.000Z');
assert.deepEqual(artifactCommand.pipeline[0].$match.lsid, { nested: true });
assert.deepEqual(artifactCommand.pipeline[0].$match.operationTime, { nested: true });
assert.deepEqual(artifactCommand.pipeline[0].$match.$readPreference, { nested: true });
assert.equal(replayCommand.$db, undefined);
assert.equal(artifactCommand.lsid, undefined);
const changedArtifactCommand = sanitizeCommandArtifact(prepareTypedReplayCommand({ ...typedCommand, pipeline: [{ $match: { ...typedCommand.pipeline[0].$match, lsid: { nested: false } } }] }));
assert.notDeepEqual(changedArtifactCommand, artifactCommand);
const artifactIdentity = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
assert.notEqual(artifactIdentity(changedArtifactCommand), artifactIdentity(artifactCommand));

const nextPlan = plan.filter((item) => item.page === 'next');
assert.equal(nextPlan.length, 20);
for (const item of nextPlan) summarizeMongoExplain(item.caseId.startsWith('qualifications') || item.caseId === 'inside-all' ? cursorExplain : eventExplain, item.caseId.startsWith('qualifications') || item.caseId === 'inside-all');
assert.throws(() => summarizeMongoExplain({ executionStats: { nReturned: 20, totalKeysExamined: 1, totalDocsExamined: 1, executionStages: { stage: 'LIMIT' } } }, false), /executionStats fields/u);
assert.throws(() => summarizeMongoExplain({ executionStats: { nReturned: 21, totalKeysExamined: -1, totalDocsExamined: 1, executionStages: { stage: 'LIMIT' } } }, false), /executionStats fields/u);

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'passhub-g09b-perf-smoke-'));
const staging = path.join(root, 'staging');
const final = path.join(root, 'published');
await fs.mkdir(staging);
await fs.writeFile(path.join(staging, 'summary.json'), '{}');
await publishStagedDirectory(staging, final);
assert.equal((await fs.readFile(path.join(final, 'summary.json'), 'utf8')), '{}');
const failedStaging = path.join(root, 'failed-staging');
const failedFinal = path.join(root, 'failed-final');
await fs.mkdir(failedStaging);
await assert.rejects(() => publishStagedDirectory(failedStaging, path.join(root, 'missing', 'final')));
await assert.rejects(() => fs.access(failedStaging));
await assert.rejects(() => fs.access(failedFinal));
await fs.rm(root, { recursive: true, force: true });

console.log('G09b performance contract smoke: sample reduction, percentile, pairing, and atomic publish PASS');
