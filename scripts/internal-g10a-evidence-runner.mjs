import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  assertCleanGitWorktree,
  assertG10aEvidenceOutputRoot,
  collectG10aEvidenceProvenance,
  createG10aEvidenceCleanup,
  createG10aEvidenceResults,
  writeG10aEvidenceArtifacts,
} from './internal-g10a-evidence.mjs';

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
} = {}) {
  await assertClean({ root });
  const evidenceRoot = await assertOutputRoot({ root, outputRoot });
  const provenance = await collectProvenance({ root });
  const phaseResults = [];
  let phaseFailure;

  for (const identifier of PHASES) {
    const startedAt = now();
    let commandResult;
    try {
      commandResult = await executeCommand(identifier, root);
    } catch {
      commandResult = { exitCode: 1, stdout: '' };
    }
    const durationMs = safeDuration(now() - startedAt);
    const parsed = parseJestCounts(commandResult?.stdout);
    const exitCode = normalizeExitCode(commandResult?.exitCode);
    phaseResults.push(Object.freeze({ identifier, exitCode, durationMs, suiteCount: parsed.suiteCount, testCount: parsed.testCount }));
    if (exitCode !== 0) {
      phaseFailure = new Error(`${identifier} failed with exit ${exitCode}`);
      break;
    }
  }

  let docker = { dockerContainersAbsent: false, composeContainersAbsent: false, composeNetworksAbsent: false };
  let cleanupFailure;
  try {
    docker = await inspectDocker();
  } catch {
    cleanupFailure = new Error('G10a Docker cleanup verification failed');
  }
  const cleanupPass = docker.dockerContainersAbsent === true && docker.composeContainersAbsent === true && docker.composeNetworksAbsent === true;
  if (!cleanupPass && cleanupFailure === undefined) cleanupFailure = new Error('G10a Docker resources remain after execution');
  const results = createG10aEvidenceResults({ status: phaseFailure === undefined ? 'PASS' : 'FAIL', phases: phaseResults });
  const cleanup = createG10aEvidenceCleanup({ status: cleanupPass ? 'PASS' : 'FAIL', ...docker });
  try {
    await writeArtifacts({ root, outputRoot: evidenceRoot, runId, provenance, results, cleanup });
  } catch {
    if (phaseFailure === undefined && cleanupFailure === undefined) cleanupFailure = new Error('G10a evidence artifact write failed');
  }
  if (phaseFailure !== undefined) throw phaseFailure;
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
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

async function executeNpmCommand(identifier, root) {
  return await new Promise((resolve) => {
    const child = spawn('npm', ['run', identifier], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.once('error', () => resolve({ exitCode: 1, stdout: '' }));
    child.once('exit', (code) => resolve({ exitCode: code ?? 1, stdout }));
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
function createRunId() { return `g10a-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().replaceAll('-', '')}`; }
