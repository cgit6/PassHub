import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const RUN_ID = /^g10b-[a-z0-9-]+$/u;
const FORMAT = 'passhub.g10b.evidence.v1';
const RESULTS_FORMAT = 'passhub.g10b.evidence-results.v1';
const CLEANUP_FORMAT = 'passhub.g10b.evidence-cleanup.v1';
const ARTIFACTS = Object.freeze(['manifest.json', 'results.json', 'cleanup.json']);
const HASH_KEYS = Object.freeze([
  'g10bImplementation', 'g10bUnitTests', 'g10bIntegrationTests',
  'packageJson', 'packageLock', 'tsconfig', 'jestUnit', 'jestFault',
  'evidenceEntry', 'evidenceRunner', 'evidenceCore', 'faultRunner', 'faultOrchestrator', 'topologyCheck', 'topologyInit',
  'compose', 'toxiproxy', 'toolchain', 'fixture', 'inventory',
]);
const COMMAND_IDS = Object.freeze(['unit', 'topology', 'fault']);
const CASES = Object.freeze([
  Object.freeze({ id: 'WRITE_CONFLICT', code: 112, outcome: 'NO_APP_PARTIAL_EFFECT' }),
  Object.freeze({ id: 'DUPLICATE_FACE', code: 11000, outcome: 'NO_APP_PARTIAL_EFFECT' }),
]);

/** The core never accepts a URI, command payload, response, lsid, or body. */
export async function collectG10bEvidenceProvenance({ root, git = runGit } = {}) {
  const workspace = requireDirectory(root, 'root');
  const sourceCommit = await assertCleanGitWorktree({ root: workspace, git });
  const g10bImplementationFiles = [
    'src/access/application/access-scopes.ts',
    'src/access/application/internal/index.ts',
    'src/access/application/internal/operation-budget-binding.ts',
    'src/access/application/internal/precommit-termination-lifecycle.ts',
    'src/access/application/internal/write-operation-coordinator.ts',
    'src/composition/access-composition.ts',
    'src/composition/internal/g07b-admission-handler.ts',
    'src/composition/internal/g08a-management-composition.ts',
    'src/composition/internal/g08b-recognition-composition.ts',
    'src/composition/internal/g10a-admission-runtime-composition.ts',
    'src/composition/internal/g10b-g04b-persistence-wire.ts',
    'src/composition/internal/g10b-management-scope-bridge.ts',
    'src/composition/internal/g10b-operation-bridge.ts',
    'src/composition/internal/source-bound-recognition.ts',
    'src/infrastructure/mongo/g04b-persistence-adapter.ts',
    'src/infrastructure/mongo/internal/g10b-precommit-mongo-terminator.ts',
    'src/infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.ts',
  ];
  const g10bUnitTestFiles = [
    'test/unit/g10b-g04b-persistence-sidecar.test.ts',
    'test/unit/g10b-g07-operation-binding.test.ts',
    'test/unit/g10b-g08-scope-binding.test.ts',
    'test/unit/g10b-operation-bridge.test.ts',
    'test/unit/g10b-operation-budget-binding.test.ts',
    'test/unit/g10b-precommit-mongo-terminator.test.ts',
    'test/unit/g10b-precommit-termination-lifecycle.test.ts',
    'test/unit/g10b-evidence.test.ts',
  ];
  const g10bIntegrationTestFiles = [
    'test/integration/g10b-attached-g04b-fault.test.ts',
    'test/integration/g10b-precommit-mongo-wire-probe.test.ts',
  ];
  const [g10bImplementation, g10bUnitTests, g10bIntegrationTests, packageJson, packageLock, tsconfig, jestUnit, jestFault, evidenceEntry, evidenceRunner, evidenceCore, faultRunner, faultOrchestrator, topologyCheck, topologyInit, compose, toxiproxy, toolchain, fixture] = await Promise.all([
    sha256Files(workspace, g10bImplementationFiles), sha256Files(workspace, g10bUnitTestFiles), sha256Files(workspace, g10bIntegrationTestFiles),
    sha256File(join(workspace, 'package.json')), sha256File(join(workspace, 'package-lock.json')),
    sha256File(join(workspace, 'tsconfig.json')), sha256File(join(workspace, 'jest.g10b.unit.config.cjs')),
    sha256File(join(workspace, 'jest.g10b.fault.config.cjs')), sha256File(join(workspace, 'scripts', 'test-g10b-evidence.mjs')),
    sha256File(join(workspace, 'scripts', 'internal-g10b-evidence-runner.mjs')),
    sha256File(join(workspace, 'scripts', 'internal-g10b-evidence.mjs')), sha256File(join(workspace, 'scripts', 'test-g10b-fault.mjs')),
    sha256File(join(workspace, 'scripts', 'g10-fault-runner.mjs')),
    sha256File(join(workspace, 'scripts', 'check-g10-fault-topology.mjs')), sha256File(join(workspace, 'scripts', 'g10-fault-topology-init.mjs')),
    sha256File(join(workspace, 'infra', 'g10-fault-compose.yml')), sha256File(join(workspace, 'infra', 'g10-fault-toxiproxy.json')),
    sha256File(join(workspace, 'infra', 'toolchain-images.json')), sha256File(join(workspace, 'src', 'infrastructure', 'mongo', 'g04b-fixture.ts')),
  ]);
  const partial = freeze({ g10bImplementation, g10bUnitTests, g10bIntegrationTests, packageJson, packageLock, tsconfig, jestUnit, jestFault, evidenceEntry, evidenceRunner, evidenceCore, faultRunner, faultOrchestrator, topologyCheck, topologyInit, compose, toxiproxy, toolchain, fixture });
  const hashes = freeze({ ...partial, inventory: sha256Canonical(partial) });
  return freeze({ format: FORMAT, sourceCommit, hashes });
}

export async function assertCleanGitWorktree({ root, git = runGit } = {}) {
  const workspace = requireDirectory(root, 'root');
  const status = await git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.trim() !== '') throw new Error('G10b evidence requires a clean worktree before execution');
  const commit = (await git(workspace, ['rev-parse', '--verify', 'HEAD'])).trim();
  if (!COMMIT.test(commit)) throw new Error('G10b evidence requires a canonical source commit');
  return commit;
}

export async function assertG10bEvidenceOutputRoot({ root, outputRoot } = {}) {
  const workspace = requireDirectory(root, 'root');
  const evidenceRoot = outputRoot === undefined ? join(workspace, 'output', 'evidence', 'g10b') : outputRoot;
  if (!isAbsolute(evidenceRoot)) throw new TypeError('G10b evidence output root must be absolute');
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(evidenceRoot);
  return evidenceRoot;
}

export function createG10bEvidenceResults({ status, commands } = {}) {
  if (status !== 'PASS' && status !== 'FAIL') throw new TypeError('G10b evidence status is invalid');
  if (!Array.isArray(commands) || commands.length !== COMMAND_IDS.length) throw new TypeError('G10b evidence commands are invalid');
  const normalized = commands.map((command, index) => normalizeCommand(command, COMMAND_IDS[index]));
  if (status === 'PASS' && normalized.some((command) => command.exitCode !== 0)) throw new TypeError('G10b PASS evidence has failed commands');
  return freeze({ format: RESULTS_FORMAT, status, commands: Object.freeze(normalized), cases: CASES });
}

export function createG10bEvidenceCleanup({ status, dockerResourcesAbsent } = {}) {
  if (status !== 'PASS' && status !== 'FAIL' || !plain(dockerResourcesAbsent)) throw new TypeError('G10b evidence cleanup is invalid');
  assertExactKeys(dockerResourcesAbsent, ['containers', 'networks', 'volumes'], 'cleanup resources');
  if (Object.values(dockerResourcesAbsent).some((value) => typeof value !== 'boolean')) throw new TypeError('G10b evidence cleanup is invalid');
  const allAbsent = Object.values(dockerResourcesAbsent).every(Boolean);
  if ((status === 'PASS') !== allAbsent) throw new TypeError('G10b evidence cleanup status is inconsistent');
  return freeze({ format: CLEANUP_FORMAT, status, primaryFailurePrecedence: 'PRESERVED', dockerResourcesAbsent: freeze({ ...dockerResourcesAbsent }) });
}

export async function writeG10bEvidenceArtifacts({ root, outputRoot, runId, provenance, results, cleanup } = {}) {
  requireDirectory(root, 'root');
  assertRunId(runId); assertProvenance(provenance); assertResults(results); assertCleanup(cleanup);
  const evidenceRoot = await assertG10bEvidenceOutputRoot({ root, outputRoot });
  const finalDirectory = join(evidenceRoot, runId);
  const stagingDirectory = join(evidenceRoot, `.${runId}.staging`);
  if (await exists(finalDirectory) || await exists(stagingDirectory)) throw new Error('G10b evidence runId collision');
  await mkdir(stagingDirectory, { mode: 0o700 });
  try {
    const persistedResults = freeze({ ...results, runId });
    const persistedCleanup = freeze({ ...cleanup, runId });
    assertPersistedResults(persistedResults);
    assertPersistedCleanup(persistedCleanup);
    await Promise.all([
      writePrivateJson(join(stagingDirectory, 'results.json'), persistedResults),
      writePrivateJson(join(stagingDirectory, 'cleanup.json'), persistedCleanup),
    ]);
    const artifacts = await artifactInventory(stagingDirectory);
    const manifest = freeze({
      format: FORMAT, runId, sourceCommit: provenance.sourceCommit, hashes: provenance.hashes, artifacts,
    });
    assertPersistedManifest(manifest);
    await writePrivateJson(join(stagingDirectory, 'manifest.json'), manifest);
    await assertExactArtifacts(stagingDirectory);
    await rename(stagingDirectory, finalDirectory);
    await assertPrivateDirectory(finalDirectory);
    await assertExactArtifacts(finalDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return freeze({ runId, artifactNames: ARTIFACTS });
}

export async function runWithPrimaryFailure({ execute, cleanup } = {}) {
  let primary; let result;
  try { result = await execute(); } catch (error) { primary = error; }
  let cleanupFailure;
  try { await cleanup(); } catch (error) { cleanupFailure = error; }
  if (primary !== undefined) throw primary;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result;
}

export function parseJestCounts(output) {
  const value = typeof output === 'string' ? output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '') : '';
  return freeze({ suiteCount: parseCount(value, 'Test Suites'), testCount: parseCount(value, 'Tests') });
}

export async function sha256File(file) {
  const state = await lstat(file);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error('G10b evidence hash target is invalid');
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function sha256Files(root, paths) {
  const digest = createHash('sha256');
  for (const path of [...paths].sort()) {
    const full = join(root, path);
    digest.update(`F:${path}\0`, 'utf8');
    digest.update(await readFile(full));
  }
  return digest.digest('hex');
}

async function artifactInventory(directory) {
  const records = [];
  for (const name of ARTIFACTS) records.push(freeze({ name, sha256: name === 'manifest.json' ? 'SELF' : await sha256File(join(directory, name)) }));
  return Object.freeze(records);
}

async function writePrivateJson(path, value) { await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function assertPrivateDirectory(path) { const state = await lstat(path); if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.geteuid() || (state.mode & 0o777) !== 0o700) throw new Error('G10b evidence directory must be exact mode 0700'); }
async function assertExactArtifacts(directory) { const names = (await readdir(directory)).sort(); if (names.length !== ARTIFACTS.length || names.some((name, index) => name !== [...ARTIFACTS].sort()[index])) throw new Error('G10b evidence artifact set is not closed'); for (const name of ARTIFACTS) { const path = join(directory, name); const state = await lstat(path); if (!state.isFile() || state.isSymbolicLink() || state.uid !== process.geteuid() || (state.mode & 0o777) !== 0o600) throw new Error('G10b evidence artifact must be exact mode 0600'); const parsed = JSON.parse(await readFile(path, 'utf8')); if (name === 'manifest.json') assertPersistedManifest(parsed); else if (name === 'results.json') assertPersistedResults(parsed); else assertPersistedCleanup(parsed); } }
function assertRunId(value) { if (typeof value !== 'string' || !RUN_ID.test(value) || basename(value) !== value) throw new TypeError('G10b evidence runId is invalid'); }
function assertProvenance(value) { if (!plain(value)) throw new TypeError('G10b evidence provenance is invalid'); assertExactKeys(value, ['format', 'sourceCommit', 'hashes'], 'provenance'); if (value.format !== FORMAT || !COMMIT.test(value.sourceCommit ?? '') || !plain(value.hashes)) throw new TypeError('G10b evidence provenance is invalid'); assertExactKeys(value.hashes, HASH_KEYS, 'hashes'); if (HASH_KEYS.some((key) => !SHA256.test(value.hashes[key] ?? ''))) throw new TypeError('G10b evidence hashes are invalid'); }
function assertResults(value) { if (!plain(value)) throw new TypeError('G10b evidence results are invalid'); assertExactKeys(value, ['format', 'status', 'commands', 'cases'], 'results'); if (value.format !== RESULTS_FORMAT || !Array.isArray(value.commands) || !Array.isArray(value.cases)) throw new TypeError('G10b evidence results are invalid'); createG10bEvidenceResults({ status: value.status, commands: value.commands }); if (JSON.stringify(value.cases) !== JSON.stringify(CASES)) throw new TypeError('G10b evidence cases are invalid'); }
function assertPersistedResults(value) { if (!plain(value)) throw new TypeError('G10b persisted results are invalid'); assertExactKeys(value, ['format', 'status', 'commands', 'cases', 'runId'], 'persisted results'); assertRunId(value.runId); assertResults({ format: value.format, status: value.status, commands: value.commands, cases: value.cases }); }
function assertPersistedManifest(value) { if (!plain(value)) throw new TypeError('G10b persisted manifest is invalid'); assertExactKeys(value, ['format', 'runId', 'sourceCommit', 'hashes', 'artifacts'], 'manifest'); assertRunId(value.runId); assertProvenance({ format: value.format, sourceCommit: value.sourceCommit, hashes: value.hashes }); if (!Array.isArray(value.artifacts) || value.artifacts.length !== ARTIFACTS.length) throw new TypeError('G10b evidence manifest artifacts are invalid'); for (const [index, artifact] of value.artifacts.entries()) { if (!plain(artifact)) throw new TypeError('G10b evidence manifest artifact is invalid'); assertExactKeys(artifact, ['name', 'sha256'], 'manifest artifact'); if (artifact.name !== ARTIFACTS[index] || (artifact.name === 'manifest.json' ? artifact.sha256 !== 'SELF' : !SHA256.test(artifact.sha256 ?? ''))) throw new TypeError('G10b evidence manifest artifact is invalid'); } }
function assertCleanup(value) { if (!plain(value)) throw new TypeError('G10b evidence cleanup is invalid'); assertExactKeys(value, ['format', 'status', 'primaryFailurePrecedence', 'dockerResourcesAbsent'], 'cleanup'); if (value.format !== CLEANUP_FORMAT || value.primaryFailurePrecedence !== 'PRESERVED') throw new TypeError('G10b evidence cleanup is invalid'); createG10bEvidenceCleanup({ status: value.status, dockerResourcesAbsent: value.dockerResourcesAbsent }); }
function assertPersistedCleanup(value) { if (!plain(value)) throw new TypeError('G10b persisted cleanup is invalid'); assertExactKeys(value, ['format', 'status', 'primaryFailurePrecedence', 'dockerResourcesAbsent', 'runId'], 'persisted cleanup'); assertRunId(value.runId); assertCleanup({ format: value.format, status: value.status, primaryFailurePrecedence: value.primaryFailurePrecedence, dockerResourcesAbsent: value.dockerResourcesAbsent }); }
function normalizeCommand(value, id) { if (!plain(value)) throw new TypeError('G10b evidence command is invalid'); assertExactKeys(value, ['id', 'exitCode', 'suiteCount', 'testCount'], 'command'); if (value.id !== id || !Number.isInteger(value.exitCode) || value.exitCode < 0) throw new TypeError('G10b evidence command is invalid'); if (id === 'topology') { if (value.suiteCount !== null || value.testCount !== null) throw new TypeError('G10b topology evidence must have no Jest totals'); } else if (value.exitCode === 0 && id === 'fault' && (value.suiteCount !== 2 || value.testCount !== 3)) throw new TypeError('G10b fault evidence requires exactly two suites and three tests'); else if (value.exitCode === 0 && (!Number.isInteger(value.suiteCount) || value.suiteCount < 1 || !Number.isInteger(value.testCount) || value.testCount < 1)) throw new TypeError('G10b successful Jest evidence requires totals'); else if (value.exitCode !== 0 && !((value.suiteCount === null || Number.isInteger(value.suiteCount)) && (value.testCount === null || Number.isInteger(value.testCount)))) throw new TypeError('G10b failed Jest evidence totals are invalid'); return freeze({ id, exitCode: value.exitCode, suiteCount: value.suiteCount, testCount: value.testCount }); }
function parseCount(output, label) { const match = new RegExp(`^${label}:\\s*(?:\\d+\\s+(?:passed|failed|skipped),\\s*)?(\\d+)\\s+total\\s*$`, 'mu').exec(output); const count = match === null ? null : Number(match[1]); return Number.isSafeInteger(count) && count > 0 ? count : null; }
function sha256Canonical(value) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
function freeze(value) { return Object.freeze(value); }
function plain(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function assertExactKeys(value, expected, label) { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) throw new TypeError(`G10b evidence ${label} keyset is invalid`); }
function requireDirectory(value, label) { if (typeof value !== 'string' || value.length === 0) throw new TypeError(`G10b evidence ${label} is invalid`); return resolve(value); }
async function runGit(root, args) { const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); return (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8' })).stdout; }
