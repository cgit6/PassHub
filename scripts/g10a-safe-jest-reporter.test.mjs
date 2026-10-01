import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import G10aSafeJestReporter from './g10a-safe-jest-reporter.mjs';
import { G10A_EVIDENCE_CASE_MAP } from './internal-g10a-observation-case-map.mjs';

const REPORT_PATH_ENV = 'G10A_SAFE_JEST_REPORT_PATH';
const REPORT_PHASE_ENV = 'G10A_SAFE_JEST_REPORT_PHASE';
const PHASE = 'test:g10a:unit';
const SENSITIVE_MARKER = 'MONGO_URI=super-secret-observation-marker';

test('writes only the closed case-status summary and does not serialize diagnostics', { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'g10a-safe-reporter-'));
  try {
    const output = join(directory, 'summary.json');
    const aggregate = aggregateFor(PHASE, { G10A_CONTROL_DRAIN: 'failed' });
    addUnrelatedAssertion(aggregate);
    await runReporter({ output, aggregate });
    const text = await readFile(output, 'utf8');
    const summary = JSON.parse(text);
    assert.deepEqual(Object.keys(summary).sort(), ['cases', 'format', 'phase']);
    assert.equal(summary.format, 'passhub.g10a.jest-observation.v1');
    assert.equal(summary.phase, PHASE);
    assert.equal(summary.cases.find((entry) => entry.id === 'G10A_CONTROL_DRAIN')?.status, 'FAIL');
    assert.equal(summary.cases.every((entry) => Object.keys(entry).length === 2 && typeof entry.id === 'string' && (entry.status === 'PASS' || entry.status === 'FAIL')), true);
    assert.equal(text.includes(SENSITIVE_MARKER), false);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('treats skipped assertions as FAIL rather than passing them through', { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'g10a-safe-reporter-'));
  try {
    const output = join(directory, 'summary.json');
    await runReporter({ output, aggregate: aggregateFor(PHASE, { G10A_CONTROL_DRAIN: 'pending' }) });
    const summary = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(summary.cases.find((entry) => entry.id === 'G10A_CONTROL_DRAIN')?.status, 'FAIL');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed without writing for missing, duplicate, mismatch, malformed aggregation, and invalid mapped status', { concurrency: false }, async () => {
  for (const mutate of [removeFirstAssertion, duplicateFirstAssertion, mismatchFirstPath, invalidateAggregation, invalidateMappedStatus]) {
    const directory = await mkdtemp(join(tmpdir(), 'g10a-safe-reporter-'));
    try {
      const output = join(directory, 'summary.json');
      const aggregate = aggregateFor(PHASE);
      mutate(aggregate);
      await assert.rejects(runReporter({ output, aggregate }), /G10a safe reporter/u);
      await assert.rejects(stat(output));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function aggregateFor(phase, statuses = {}) {
  const suites = new Map();
  for (const entry of G10A_EVIDENCE_CASE_MAP.filter((candidate) => candidate.phase === phase)) {
    const testFilePath = resolve(process.cwd(), entry.testFilePath);
    const suite = suites.get(testFilePath) ?? { testFilePath, testResults: [] };
    const assertion = { fullName: entry.fullName, status: statuses[entry.id] ?? 'passed' };
    for (const field of ['failureMessages', 'failureDetails', 'console']) {
      Object.defineProperty(assertion, field, { enumerable: true, get: () => { throw new Error(`${field} must remain unread: ${SENSITIVE_MARKER}`); } });
    }
    suite.testResults.push(assertion);
    suites.set(testFilePath, suite);
  }
  return { testResults: [...suites.values()] };
}

async function runReporter({ output, aggregate }) {
  const oldOutput = process.env[REPORT_PATH_ENV];
  const oldPhase = process.env[REPORT_PHASE_ENV];
  process.env[REPORT_PATH_ENV] = output;
  process.env[REPORT_PHASE_ENV] = PHASE;
  try {
    await new G10aSafeJestReporter().onRunComplete(undefined, aggregate);
  } finally {
    if (oldOutput === undefined) delete process.env[REPORT_PATH_ENV]; else process.env[REPORT_PATH_ENV] = oldOutput;
    if (oldPhase === undefined) delete process.env[REPORT_PHASE_ENV]; else process.env[REPORT_PHASE_ENV] = oldPhase;
  }
}

function firstAssertion(aggregate) { return aggregate.testResults[0].testResults[0]; }
function removeFirstAssertion(aggregate) { aggregate.testResults[0].testResults.shift(); }
function addUnrelatedAssertion(aggregate) {
  const assertion = { fullName: 'unrelated G10a assertion' };
  for (const field of ['status', 'failureMessages', 'failureDetails', 'console']) {
    Object.defineProperty(assertion, field, { enumerable: true, get: () => { throw new Error(`${field} must remain unread: ${SENSITIVE_MARKER}`); } });
  }
  aggregate.testResults[0].testResults.push(assertion);
}
function duplicateFirstAssertion(aggregate) {
  const assertion = firstAssertion(aggregate);
  aggregate.testResults[0].testResults.push({ fullName: assertion.fullName, status: assertion.status });
}
function mismatchFirstPath(aggregate) { aggregate.testResults[0].testFilePath = resolve(process.cwd(), 'dist/test/unit/not-mapped.test.js'); }
function invalidateAggregation(aggregate) { aggregate.testResults = {}; }
function invalidateMappedStatus(aggregate) { firstAssertion(aggregate).status = 'unrecognized-jest-status'; }
