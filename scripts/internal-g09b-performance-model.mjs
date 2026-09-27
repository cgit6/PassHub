import fs from 'node:fs/promises';

export const G09B_PERF_STATES = Object.freeze(['BEFORE', 'AFTER']);
export const G09B_WARMUPS = 10;
export const G09B_MEASURED = 100;
export const G09B_RAW_SAMPLE_COUNT = 4_000;
export const G09B_NEAREST_RANK_INDICES = Object.freeze({ p50: 49, p95: 94 });

export function parsePerfArgs(args) {
  const values = Array.isArray(args) ? args.slice() : [];
  if (values.length === 2 && values[0] === '--gate' && values[1] === 'g09b') return Object.freeze({ smoke: false });
  if (values.length === 3 && values[0] === '--gate' && values[1] === 'g09b' && values[2] === '--smoke') return Object.freeze({ smoke: true });
  throw new TypeError('usage: npm run test:perf -- --gate g09b [--smoke]');
}

const DRIVER_ENVELOPE_KEYS = new Set(['$db', 'lsid', '$clusterTime', 'operationTime', '$readPreference']);

export function prepareTypedReplayCommand(command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) throw new TypeError('G09b aggregate command is invalid');
  return Object.fromEntries(Object.entries(command).filter(([key]) => !DRIVER_ENVELOPE_KEYS.has(key)));
}

export function sanitizeCommandArtifact(command) {
  if (command instanceof Date) return command.toISOString();
  if (Array.isArray(command)) return command.map(sanitizeCommandArtifact);
  if (command !== null && typeof command === 'object') return Object.fromEntries(Object.entries(command).map(([key, value]) => [key, sanitizeCommandArtifact(value)]));
  return command;
}

export function measurementPlan(cases, states = G09B_PERF_STATES, warmups = G09B_WARMUPS, measured = G09B_MEASURED) {
  if (!Array.isArray(cases) || cases.length !== 10) throw new TypeError('G09b performance requires exactly 10 cases');
  if (!Array.isArray(states) || states.length !== 2) throw new TypeError('G09b performance requires BEFORE and AFTER');
  if (!Number.isSafeInteger(warmups) || warmups < 0 || !Number.isSafeInteger(measured) || measured < 1) throw new TypeError('G09b performance sample counts are invalid');
  const plan = [];
  for (const state of states) for (const item of cases) for (const page of ['first', 'next']) {
    plan.push(Object.freeze({ state, caseId: item.id, page, warmups, measured }));
  }
  return Object.freeze(plan);
}

export function nearestRank(sortedDurations, index) {
  if (!Array.isArray(sortedDurations) || sortedDurations.length !== G09B_MEASURED) throw new TypeError('G09b nearest-rank requires 100 durations');
  if (index !== 49 && index !== 94) throw new RangeError('G09b nearest-rank index is invalid');
  const values = sortedDurations.slice().sort((left, right) => left - right);
  const value = values[index];
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('G09b duration is invalid');
  return value;
}

export function summarizeDurations(durations) {
  if (!Array.isArray(durations) || durations.length < 1) throw new TypeError('G09b durations are empty');
  const p50Index = durations.length === G09B_MEASURED ? G09B_NEAREST_RANK_INDICES.p50 : Math.ceil(durations.length * 0.50) - 1;
  const p95Index = durations.length === G09B_MEASURED ? G09B_NEAREST_RANK_INDICES.p95 : Math.ceil(durations.length * 0.95) - 1;
  const sorted = durations.slice().sort((left, right) => left - right);
  return Object.freeze({
    count: durations.length,
    p50Ns: sorted[p50Index],
    p95Ns: sorted[p95Index],
    minNs: Math.min(...durations),
    maxNs: Math.max(...durations),
  });
}

export function resultIdentity(rows, idOf) {
  if (!Array.isArray(rows) || typeof idOf !== 'function') throw new TypeError('G09b result identity input is invalid');
  const ids = rows.map((row) => idOf(row));
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) throw new TypeError('G09b result identity contains an invalid id');
  return Object.freeze({ count: rows.length, firstId: ids[0] ?? null, lastId: ids.at(-1) ?? null });
}

export async function measureCell({ state, caseId, page, query, clock = process.hrtime.bigint, warmups = G09B_WARMUPS, measured = G09B_MEASURED, idOf, onSample }) {
  if (typeof query !== 'function' || typeof idOf !== 'function' || typeof onSample !== 'function') throw new TypeError('G09b measurement hooks are invalid');
  for (let index = 0; index < warmups; index += 1) await query();
  const durations = [];
  let identity = null;
  for (let iteration = 0; iteration < measured; iteration += 1) {
    const started = clock();
    const rows = await query();
    const durationNsBigInt = clock() - started;
    if (typeof durationNsBigInt !== 'bigint' || durationNsBigInt < 0n || durationNsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('G09b duration is invalid');
    const durationNs = Number(durationNsBigInt);
    identity = resultIdentity(rows, idOf);
    durations.push(durationNs);
    await onSample(Object.freeze({ state, caseId, page, iteration, durationNs, result: identity }));
  }
  return Object.freeze({ state, caseId, page, warmups, measured, summary: summarizeDurations(durations) });
}

export function explainPairKey(state, caseId, page) {
  if (state !== 'BEFORE' && state !== 'AFTER') throw new TypeError('G09b explain state is invalid');
  if (typeof caseId !== 'string' || caseId.length === 0 || (page !== 'first' && page !== 'next')) throw new TypeError('G09b explain key is invalid');
  return `${state}/${caseId}/${page}`;
}

export function assertExplainPairs(explains, plan) {
  if (!(explains instanceof Map)) throw new TypeError('G09b explains must be a Map');
  const expected = new Set(plan.map((item) => explainPairKey(item.state, item.caseId, item.page)));
  if (explains.size !== expected.size) throw new Error('G09b explain count is invalid');
  const commandIdentities = new Set();
  for (const key of expected) {
    if (!explains.has(key)) throw new Error(`G09b explain is missing ${key}`);
    const value = explains.get(key);
    if (value?.captureId !== key || value?.captureCount !== 1 || !/^[0-9a-f]{64}$/u.test(value.commandIdentity ?? '')) throw new Error(`G09b explain capture provenance is invalid ${key}`);
    if (commandIdentities.has(`${value.captureId}:${value.commandIdentity}`)) throw new Error(`G09b explain capture is duplicated ${key}`);
    commandIdentities.add(`${value.captureId}:${value.commandIdentity}`);
  }
  for (const key of explains.keys()) if (!expected.has(key)) throw new Error(`G09b explain is unexpected ${key}`);
}

export function summarizeMongoExplain(explain, expectsLookup) {
  if (explain === null || typeof explain !== 'object') throw new TypeError('G09b explain is not an object');
  const stages = explain.stages;
  let primary;
  let lookup = null;
  if (Array.isArray(stages)) {
    const cursorStages = stages.filter((stage) => stage !== null && typeof stage === 'object' && stage.$cursor !== undefined);
    const lookupStages = stages.filter((stage) => stage !== null && typeof stage === 'object' && stage.$lookup !== undefined);
    if (cursorStages.length !== 1 || lookupStages.length !== (expectsLookup ? 1 : 0)) throw new Error('G09b explain stage shape is invalid');
    const cursor = cursorStages[0].$cursor;
    primary = executionStatsSummary(cursor?.executionStats, 'cursor');
    if (expectsLookup) lookup = lookupStatsSummary(lookupStages[0]);
  } else {
    if (expectsLookup || explain.executionStats === undefined) throw new Error('G09b explain execution shape is invalid');
    primary = executionStatsSummary(explain.executionStats, 'top-level');
  }
  return Object.freeze({ primaryCursor: primary, lookup });
}

function executionStatsSummary(stats, label) {
  if (stats === null || typeof stats !== 'object' || stats.executionStages === null || typeof stats.executionStages !== 'object') throw new Error(`G09b ${label} executionStats is invalid`);
  const stage = stats.executionStages.stage;
  if (typeof stage !== 'string' || stats.nReturned !== 21 || !Number.isSafeInteger(stats.totalKeysExamined) || stats.totalKeysExamined < 0 || !Number.isSafeInteger(stats.totalDocsExamined) || stats.totalDocsExamined < 0) throw new Error(`G09b ${label} executionStats fields are invalid`);
  return Object.freeze({ stage, nReturned: stats.nReturned, totalKeysExamined: stats.totalKeysExamined, totalDocsExamined: stats.totalDocsExamined, executionTimeMillis: Number.isSafeInteger(stats.executionTimeMillis) ? stats.executionTimeMillis : null });
}

function lookupStatsSummary(lookup) {
  if (lookup === null || typeof lookup !== 'object' || lookup.nReturned !== 21 || !Number.isSafeInteger(lookup.totalKeysExamined) || lookup.totalKeysExamined < 0 || !Number.isSafeInteger(lookup.totalDocsExamined) || lookup.totalDocsExamined < 0 || !Number.isSafeInteger(lookup.collectionScans) || lookup.collectionScans < 0 || !Array.isArray(lookup.indexesUsed) || lookup.indexesUsed.some((value) => typeof value !== 'string')) throw new Error('G09b lookup explain stats are invalid');
  return Object.freeze({ nReturned: lookup.nReturned, totalKeysExamined: lookup.totalKeysExamined, totalDocsExamined: lookup.totalDocsExamined, collectionScans: lookup.collectionScans, indexesUsed: Object.freeze(lookup.indexesUsed.slice()), executionTimeMillisEstimate: Number.isSafeInteger(lookup.executionTimeMillisEstimate) ? lookup.executionTimeMillisEstimate : null });
}

export async function publishStagedDirectory(stagingDirectory, finalDirectory, fsLike = fs) {
  try {
    await fsLike.rename(stagingDirectory, finalDirectory);
  } catch (error) {
    await fsLike.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
