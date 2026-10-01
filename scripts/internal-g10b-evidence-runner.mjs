import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  assertCleanGitWorktree,
  assertG10bEvidenceOutputRoot,
  collectG10bEvidenceProvenance,
  createG10bEvidenceCleanup,
  createG10bEvidenceResults,
  parseJestCounts,
  writeG10bEvidenceArtifacts,
} from './internal-g10b-evidence.mjs';

const PHASES = Object.freeze([
  Object.freeze({ id: 'unit', command: 'test:g10b:unit', jest: true }),
  Object.freeze({ id: 'topology', command: 'test:g10:fault-topology', jest: false }),
  Object.freeze({ id: 'fault', command: 'test:g10b:fault', jest: true }),
]);

export async function runG10bEvidence({ root, outputRoot, runId = `g10b-${randomUUID().replaceAll('-', '')}`, execute = executeNpm, inspectCleanup = inspectDocker, writeArtifacts = writeG10bEvidenceArtifacts, assertClean = assertCleanGitWorktree, assertOutputRoot = assertG10bEvidenceOutputRoot, collectProvenance = collectG10bEvidenceProvenance } = {}) {
  await assertClean({ root });
  const evidenceRoot = await assertOutputRoot({ root, outputRoot });
  const provenance = await collectProvenance({ root });
  const commands = [];
  let primaryFailure;
  for (const phase of PHASES) {
    let result;
    try { result = await execute(phase.command, root); } catch { result = { exitCode: 1, output: '' }; }
    const parsed = phase.jest ? parseJestCounts(result.output) : { suiteCount: null, testCount: null };
    const exitCode = Number.isInteger(result.exitCode) && result.exitCode >= 0 ? result.exitCode : 1;
    commands.push(Object.freeze({ id: phase.id, exitCode, suiteCount: parsed.suiteCount, testCount: parsed.testCount }));
    if (exitCode !== 0 || (phase.jest && (parsed.suiteCount === null || parsed.testCount === null))) { primaryFailure = new Error(`G10b evidence ${phase.id} failed`); break; }
  }
  while (commands.length < PHASES.length) { const phase = PHASES[commands.length]; commands.push(Object.freeze({ id: phase.id, exitCode: 1, suiteCount: null, testCount: null })); }
  try { await assertClean({ root }); } catch { if (primaryFailure === undefined) primaryFailure = new Error('G10b evidence worktree changed during execution'); }
  let dockerResourcesAbsent = { containers: false, networks: false, volumes: false }; let cleanupFailure;
  try {
    dockerResourcesAbsent = await inspectCleanup();
    if (!isCompleteCleanup(dockerResourcesAbsent)) cleanupFailure = new Error('G10b evidence cleanup failed');
  } catch { cleanupFailure = new Error('G10b evidence cleanup failed'); }
  const terminalFailure = primaryFailure ?? cleanupFailure;
  const results = createG10bEvidenceResults({ status: terminalFailure === undefined ? 'PASS' : 'FAIL', commands });
  const cleanup = createG10bEvidenceCleanup({ status: isCompleteCleanup(dockerResourcesAbsent) ? 'PASS' : 'FAIL', dockerResourcesAbsent });
  let writeFailure;
  try { await writeArtifacts({ root, outputRoot: evidenceRoot, runId, provenance, results, cleanup }); } catch (error) { writeFailure = error; }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (writeFailure !== undefined) throw writeFailure;
  return Object.freeze({ runId, commands: results.commands, cleanup });
}

async function executeNpm(command, root) {
  return await new Promise((resolve) => {
    const child = spawn('npm', ['run', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.once('error', () => resolve({ exitCode: 1, output: '' }));
    child.once('exit', (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

export async function inspectDocker() {
  const run = async (args) => await new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false }); let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.once('error', () => resolve(null)); child.once('exit', (code) => resolve(code === 0 ? output : null));
  });
  const [containers, networks, volumes] = await Promise.all([
    run(['ps', '-a', '--format', '{{.Names}}']),
    run(['network', 'ls', '--format', '{{.Name}}']),
    run(['volume', 'ls', '--format', '{{.Name}}']),
  ]);
  return Object.freeze({
    containers: containers !== null && !hasProjectResource(containers),
    networks: networks !== null && !hasProjectResource(networks),
    volumes: volumes !== null && !hasProjectResource(volumes),
  });
}

function hasProjectResource(output) { return output.split(/\r?\n/u).some((name) => name.startsWith('passhub-g10b-fault-')); }
function isCompleteCleanup(value) { return value !== null && typeof value === 'object' && value.containers === true && value.networks === true && value.volumes === true; }
