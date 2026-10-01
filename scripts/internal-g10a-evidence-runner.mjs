import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  assertCleanGitWorktree,
  assertG10aEvidenceOutputRoot,
  collectG10aEvidenceCategories,
  collectG10aEvidenceProvenance,
  createG10aEvidenceCategories,
  createG10aEvidenceCleanup,
  createG10aEvidenceResults,
  writeG10aEvidenceArtifacts,
} from './internal-g10a-evidence.mjs';
import { parseG10aEnvironmentProofFromOutput } from './internal-g10a-environment-proof.mjs';

const PHASES = Object.freeze(['test:g10a:unit', 'test:g10a:socket', 'test:g10a:integration']);
const PROJECT = 'passhub-g10a';
const NODE_NAME_PREFIX = 'passhub-g10a-node-';

export async function runG10aEvidence({
  root,
  outputRoot,
  now = () => performance.now(),
  runId = createRunId(),
  assertClean = assertCleanGitWorktree,
  assertOutputRoot = assertG10aEvidenceOutputRoot,
  collectProvenance = collectG10aEvidenceProvenance,
  executeCommand = executeNpmCommand,
  inspectDocker = inspectG10aDockerCleanup,
  writeArtifacts = writeG10aEvidenceArtifacts,
  collectCategories = collectG10aEvidenceCategories,
} = {}) {
  await assertClean({ root });
  const evidenceRoot = await assertOutputRoot({ root, outputRoot });
  const provenance = await collectProvenance({ root });
  const phaseResults = [];
  let phaseFailure;
  let environment;

  for (const identifier of PHASES) {
    const startedAt = now();
    let commandResult;
    try {
      commandResult = await executeCommand(identifier, root);
    } catch {
      commandResult = { exitCode: 1, stdout: '' };
    }
    const durationMs = safeDuration(now() - startedAt);
    // npm/Jest can emit its summary on stderr even when the command succeeds.
    // This combined value is parsing-only: neither raw stream is retained in
    // results or passed to the artifact writer. A separating newline prevents
    // fragments from different streams from being mistaken for one summary.
    const commandOutput = combineCommandOutputForParsing(commandResult);
    const parsed = parseJestCounts(commandOutput);
    const exitCode = normalizeExitCode(commandResult?.exitCode);
    // A zero process exit alone is not evidence that a Jest tier actually ran.
    // The private result schema deliberately records both totals, so accepting
    // a missing/garbled summary would let an arbitrary successful command turn
    // into an INCOMPLETE category run. Keep the actual process exit code for
    // provenance, but make the phase itself fail closed.
    if (exitCode === 0 && !hasCompleteJestTotals(parsed)) {
      phaseFailure = new Error(`${identifier} did not emit valid Jest total counts`);
    }
    if (identifier === 'test:g10a:integration') {
      environment = parseG10aEnvironmentProofFromOutput(commandOutput);
      if (exitCode === 0 && environment === undefined && phaseFailure === undefined) {
        phaseFailure = new Error('test:g10a:integration did not emit a valid G10a environment proof');
      }
    }
    phaseResults.push(Object.freeze({ identifier, exitCode, durationMs, suiteCount: parsed.suiteCount, testCount: parsed.testCount }));
    if (exitCode !== 0) {
      phaseFailure = new Error(`${identifier} failed with exit ${exitCode}`);
      break;
    }
    if (phaseFailure !== undefined) break;
  }

  let categories;
  let categoryFailure;
  try {
    categories = createG10aEvidenceCategories(await collectCategories({ phases: Object.freeze([...phaseResults]), environment: environment ?? null }));
  } catch {
    categoryFailure = new Error('G10a evidence category collection failed');
    // This is deliberately constructed locally rather than by a second async
    // collector call.  Once phases have run, an invalid/failed collector must
    // not create a second pre-write failure path: the truthful closed
    // NOT_COLLECTED skeleton still has to reach the private artifact writer.
    categories = createG10aEvidenceCategories();
  }
  const categoryEvidenceStatus = categoryStatus(categories);
  if (categoryEvidenceStatus === 'FAILED' && categoryFailure === undefined) categoryFailure = new Error('G10a evidence category failed');
  if (categoryEvidenceStatus === 'INCOMPLETE' && categoryFailure === undefined) categoryFailure = new Error('G10a evidence categories are incomplete');

  let docker = emptyDockerCleanup();
  let cleanupFailure;
  try {
    const inspected = await inspectDocker();
    if (!isDockerCleanupInspection(inspected)) {
      cleanupFailure = new Error('G10a Docker cleanup verification returned an invalid result');
    } else {
      docker = inspected;
    }
  } catch {
    cleanupFailure = new Error('G10a Docker cleanup verification failed');
  }
  const cleanupPass = docker.dockerContainersAbsent === true && docker.composeContainersAbsent === true && docker.composeNetworksAbsent === true;
  if (!cleanupPass && cleanupFailure === undefined) cleanupFailure = new Error('G10a Docker resources remain after execution');
  const results = createG10aEvidenceResults({
    status: phaseFailure === undefined ? (categoryEvidenceStatus === 'COMPLETE' ? 'PASS' : categoryEvidenceStatus) : 'FAIL',
    phases: phaseResults,
    environment,
    categoryEvidenceStatus,
  });
  const cleanup = createG10aEvidenceCleanup({ status: cleanupPass ? 'PASS' : 'FAIL', ...docker });
  try {
    await writeArtifacts({ root, outputRoot: evidenceRoot, runId, provenance, results, categories, cleanup });
  } catch {
    if (phaseFailure === undefined && cleanupFailure === undefined) cleanupFailure = new Error('G10a evidence artifact write failed');
  }
  if (phaseFailure !== undefined) throw phaseFailure;
  if (categoryFailure !== undefined) throw categoryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return Object.freeze({ runId, phases: results.phases, cleanup });
}

export function parseJestCounts(output) {
  if (typeof output !== 'string') return Object.freeze({ suiteCount: null, testCount: null });
  const stripped = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
  return Object.freeze({
    suiteCount: parseJestCount(stripped, 'Test Suites'),
    testCount: parseJestCount(stripped, 'Tests'),
  });
}

function parseJestCount(output, label) {
  const match = new RegExp(`^${label}:\\s*(?:\\d+\\s+(?:passed|failed|skipped),\\s*)?(\\d+)\\s+total\\s*$`, 'mu').exec(output);
  if (match === null) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

async function executeNpmCommand(identifier, root) {
  return await new Promise((resolve) => {
    const child = spawn('npm', ['run', identifier], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', () => resolve({ exitCode: 1, stdout: '', stderr: '' }));
    child.once('exit', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function inspectG10aDockerCleanup() {
  const [named, composeContainers, composeNetworks] = await Promise.all([
    dockerList(['ps', '-aq', '--filter', `name=^/${NODE_NAME_PREFIX}`]),
    dockerList(['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`]),
    dockerList(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]),
  ]);
  return Object.freeze({
    dockerContainersAbsent: named === '',
    composeContainersAbsent: composeContainers === '',
    composeNetworksAbsent: composeNetworks === '',
  });
}

async function dockerList(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.once('error', () => reject(new Error('Docker cleanup verification could not start')));
    child.once('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error('Docker cleanup verification failed')));
  });
}

function normalizeExitCode(value) { return Number.isInteger(value) && value >= 0 ? value : 1; }
function safeDuration(value) { return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
function hasCompleteJestTotals({ suiteCount, testCount }) { return Number.isSafeInteger(suiteCount) && suiteCount > 0 && Number.isSafeInteger(testCount) && testCount > 0; }
function combineCommandOutputForParsing(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  return `${stdout}\n${stderr}`;
}
function createRunId() { return `g10a-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().replaceAll('-', '')}`; }
function emptyDockerCleanup() { return { dockerContainersAbsent: false, composeContainersAbsent: false, composeNetworksAbsent: false }; }
function isDockerCleanupInspection(value) {
  return value !== null && typeof value === 'object'
    && typeof value.dockerContainersAbsent === 'boolean'
    && typeof value.composeContainersAbsent === 'boolean'
    && typeof value.composeNetworksAbsent === 'boolean';
}
function categoryStatus(categories) {
  const statuses = Object.values(categories).map((category) => category.status);
  if (statuses.includes('FAIL')) return 'FAILED';
  return statuses.every((status) => status === 'PASS') ? 'COMPLETE' : 'INCOMPLETE';
}
