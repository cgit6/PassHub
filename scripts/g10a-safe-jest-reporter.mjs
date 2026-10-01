import { dirname, isAbsolute, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { G10A_EVIDENCE_CASE_MAP } from './internal-g10a-observation-case-map.mjs';

const FORMAT = 'passhub.g10a.jest-observation.v1';
const OUTPUT_ENV = 'G10A_SAFE_JEST_REPORT_PATH';
const PHASE_ENV = 'G10A_SAFE_JEST_REPORT_PHASE';
const ALLOWED_PHASES = new Set(['test:g10a:unit', 'test:g10a:socket', 'test:g10a:integration']);
const PASSING_JEST_STATUS = 'passed';
const FAILING_JEST_STATUSES = new Set(['failed', 'pending', 'todo', 'disabled']);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A deliberately information-poor Jest reporter.  The aggregation traversal
 * uses only suite `testFilePath`, assertion `fullName`, and assertion `status`.
 * It never reads diagnostics, console records, raw output, HTTP data, or logs.
 */
export default class G10aSafeJestReporter {
  constructor() {
    this.outputPath = requireOutputPath(process.env[OUTPUT_ENV]);
    this.phase = requirePhase(process.env[PHASE_ENV]);
    this.expectedByObservation = new Map();
    this.expectedByFullName = new Map();
    this.expectedIds = new Set();
    for (const entry of G10A_EVIDENCE_CASE_MAP) {
      if (entry.phase !== this.phase) continue;
      const key = observationKey(resolve(REPOSITORY_ROOT, entry.testFilePath), entry.fullName);
      if (this.expectedByObservation.has(key) || this.expectedByFullName.has(entry.fullName) || this.expectedIds.has(entry.id)) throw new Error('G10a safe reporter map is ambiguous');
      this.expectedByObservation.set(key, entry.id);
      this.expectedByFullName.set(entry.fullName, entry.id);
      this.expectedIds.add(entry.id);
    }
    if (this.expectedIds.size === 0) throw new Error('G10a safe reporter phase has no mapped cases');
  }

  async onRunComplete(_contexts, aggregatedResults) {
    const observed = new Map();
    const suites = readSuites(aggregatedResults);
    for (const suite of suites) {
      const testFilePath = readTestFilePath(suite);
      const assertions = readAssertions(suite);
      for (const assertion of assertions) {
        const fullName = readFullName(assertion);
        const id = this.expectedByObservation.get(observationKey(testFilePath, fullName));
        // The normal G10a tier includes unrelated assertions.  Ignore them
        // without even reading their status/diagnostics.  A known mapped title
        // at an unexpected path is different: it is evidence-map mismatch.
        if (id === undefined) {
          if (this.expectedByFullName.has(fullName)) throw new Error('G10a safe reporter observed a mapped assertion at an unexpected path');
          continue;
        }
        if (observed.has(id)) throw new Error('G10a safe reporter observed a duplicate mapped assertion');
        observed.set(id, normalizeStatus(readStatus(assertion)));
      }
    }
    if (observed.size !== this.expectedIds.size || [...this.expectedIds].some((id) => !observed.has(id))) {
      throw new Error('G10a safe reporter observation is missing a mapped assertion');
    }
    const cases = [...observed].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([id, status]) => ({ id, status }));
    const summary = { format: FORMAT, phase: this.phase, cases };
    await writeFile(this.outputPath, JSON.stringify(summary), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
}

function requireOutputPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('G10a safe reporter requires an absolute temporary output path');
  return value;
}

function requirePhase(value) {
  if (typeof value !== 'string' || !ALLOWED_PHASES.has(value)) throw new Error('G10a safe reporter requires a known G10a phase');
  return value;
}

function readSuites(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.testResults)) throw new Error('G10a safe reporter aggregate is invalid');
  return value.testResults;
}

function readTestFilePath(value) {
  if (value === null || typeof value !== 'object' || typeof value.testFilePath !== 'string') throw new Error('G10a safe reporter suite is invalid');
  return value.testFilePath;
}

function readAssertions(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.testResults)) throw new Error('G10a safe reporter suite assertions are invalid');
  return value.testResults;
}

function readFullName(value) {
  if (value === null || typeof value !== 'object' || typeof value.fullName !== 'string') throw new Error('G10a safe reporter assertion is invalid');
  return value.fullName;
}

function readStatus(value) {
  if (value === null || typeof value !== 'object' || typeof value.status !== 'string') throw new Error('G10a safe reporter assertion is invalid');
  return value.status;
}

function normalizeStatus(status) {
  if (status === PASSING_JEST_STATUS) return 'PASS';
  if (FAILING_JEST_STATUSES.has(status)) return 'FAIL';
  throw new Error('G10a safe reporter assertion status is unknown');
}

function observationKey(testFilePath, fullName) { return `${testFilePath}\u0000${fullName}`; }
