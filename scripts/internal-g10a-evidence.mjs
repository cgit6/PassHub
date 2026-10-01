import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const RUN_ID = /^g10a-[a-z0-9-]+$/u;
const FORMAT = 'passhub.g10a.evidence.v1';
const RESULT_FORMAT = 'passhub.g10a.evidence-results.v1';
const ENVIRONMENT_PROOF_FORMAT = 'passhub.g10a.environment-proof.v1';
const CLEANUP_FORMAT = 'passhub.g10a.evidence-cleanup.v1';
const CATEGORY_NAMES = Object.freeze(['socket', 'rotation', 'control', 'mongo', 'secret']);
const CATEGORY_FORMAT = 'passhub.g10a.evidence-category.v1';
const CATEGORY_VERSION = 'g10a-category-summary-v1';
const MAX_CATEGORY_CASES = 128;
const CATEGORY_CASE_CODES = Object.freeze({
  socket: Object.freeze([
    'G10A_SOCKET_PATH', 'G10A_SOCKET_LISTENER', 'G10A_SOCKET_FRAMING', 'G10A_SOCKET_PROTOCOL',
    'G10A_SOCKET_SERVICE', 'G10A_SOCKET_CLI', 'G10A_SOCKET_WATCHDOG',
  ]),
  rotation: Object.freeze([
    'G10A_ROTATION_FILE_STORE', 'G10A_ROTATION_ARCHIVE', 'G10A_ROTATION_READER',
    'G10A_ROTATION_HEALTH', 'G10A_ROTATION_SINK',
  ]),
  control: Object.freeze([
    'G10A_CONTROL_STATUS', 'G10A_CONTROL_HOLD_RELEASE', 'G10A_CONTROL_DRAIN',
    'G10A_CONTROL_REPLAY', 'G10A_CONTROL_LIVE_COUNTERS', 'G10A_CONTROL_LOG_PRODUCERS',
  ]),
  mongo: Object.freeze([
    'G10A_MONGO_DRIVER_MONITORING', 'G10A_MONGO_HTTP_MANAGEMENT', 'G10A_MONGO_QUERY_DRAIN',
    'G10A_MONGO_RECOGNITION_RETRY',
  ]),
  secret: Object.freeze([
    'G10A_SECRET_LOG_SCHEMA', 'G10A_SECRET_LOG_REDACTION', 'G10A_SECRET_EVIDENCE_BOUNDARY',
    'G10A_SECRET_CONTROL_PROTOCOL',
  ]),
});
const FIXED_ARTIFACT_NAMES = Object.freeze([
  'manifest.json',
  'results.json',
  ...CATEGORY_NAMES.map((name) => `${name}.json`),
  'cleanup.json',
]);
const HASH_KEYS = Object.freeze([
  'sourceTree', 'g10aSource', 'g10aTests', 'packageJson', 'packageLock', 'tsconfig', 'runner', 'executionRunner', 'executionCore', 'environmentProof', 'evidenceHelper',
  'compose', 'toolchain', 'jestUnit', 'jestSocket', 'jestIntegration', 'inventory',
]);
const PROVENANCE_KEYS = Object.freeze(['format', 'sourceCommit', 'hashes', 'toolchain']);
const PROVENANCE_MANIFEST_KEYS = Object.freeze(['format', 'runId', 'sourceCommit', 'hashes', 'toolchain']);
const MANIFEST_KEYS = Object.freeze(['format', 'runId', 'sourceCommit', 'hashes', 'toolchain', 'artifacts']);
const RESULTS_KEYS = Object.freeze(['format', 'runId', 'status', 'phases', 'environment', 'categoryEvidenceStatus']);
const CLEANUP_KEYS = Object.freeze(['format', 'runId', 'status', 'primaryFailurePrecedence', 'dockerContainersAbsent', 'composeContainersAbsent', 'composeNetworksAbsent']);
const PHASE_IDENTIFIERS = Object.freeze(['test:g10a:unit', 'test:g10a:socket', 'test:g10a:integration']);

/**
 * Evidence is deliberately a small, closed-schema boundary.  The integration
 * runner may know live connection details and test failures; this module never
 * receives or serializes either of them.
 */
export async function collectG10aEvidenceProvenance({ root, git = runGit } = {}) {
  const workspace = requireAbsoluteDirectory(root, 'root');
  const sourceCommit = await assertCleanGitWorktree({ root: workspace, git });
  const [sourceTree, g10aSource, g10aTests, packageJson, packageLock, tsconfig, runner, executionRunner, executionCore, environmentProof, evidenceHelper, compose, toolchain, jestUnit, jestSocket, jestIntegration, images] = await Promise.all([
    sha256Directory(join(workspace, 'src')),
    sha256MatchingFiles(workspace, 'src', isG10aSourcePath),
    sha256MatchingFiles(workspace, 'test', isG10aTestPath),
    sha256File(join(workspace, 'package.json')),
    sha256File(join(workspace, 'package-lock.json')),
    sha256File(join(workspace, 'tsconfig.json')),
    sha256File(join(workspace, 'scripts', 'test-g10a-integration.mjs')),
    sha256File(join(workspace, 'scripts', 'test-g10a-evidence.mjs')),
    sha256File(join(workspace, 'scripts', 'internal-g10a-evidence-runner.mjs')),
    sha256File(join(workspace, 'scripts', 'internal-g10a-environment-proof.mjs')),
    sha256File(join(workspace, 'scripts', 'internal-g10a-evidence.mjs')),
    sha256File(join(workspace, 'infra', 'g04b-mongo-compose.yml')),
    sha256File(join(workspace, 'infra', 'toolchain-images.json')),
    sha256File(join(workspace, 'jest.g10a.unit.config.cjs')),
    sha256File(join(workspace, 'jest.g10a.socket.config.cjs')),
    sha256File(join(workspace, 'jest.g10a.integration.config.cjs')),
    readPinnedImages(workspace),
  ]);
  const unhashedInventory = freezeObject({ sourceTree, g10aSource, g10aTests, packageJson, packageLock, tsconfig, runner, executionRunner, executionCore, environmentProof, evidenceHelper, compose, toolchain, jestUnit, jestSocket, jestIntegration });
  const hashes = freezeObject({ ...unhashedInventory, inventory: sha256CanonicalInventory(unhashedInventory) });

  return freezeObject({
    format: FORMAT,
    sourceCommit,
    hashes,
    toolchain: freezeObject(images),
  });
}

export async function assertCleanGitWorktree({ root, git = runGit } = {}) {
  const workspace = requireAbsoluteDirectory(root, 'root');
  const status = await git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.trim() !== '') throw new Error('G10a evidence requires a clean tracked worktree before execution');
  const sourceCommit = (await git(workspace, ['rev-parse', '--verify', 'HEAD'])).trim();
  if (!GIT_COMMIT.test(sourceCommit)) throw new Error('G10a evidence requires a canonical Git commit');
  return sourceCommit;
}

export async function assertG10aEvidenceOutputRoot({ root, outputRoot } = {}) {
  const workspace = requireAbsoluteDirectory(root, 'root');
  const evidenceRoot = outputRoot === undefined ? join(workspace, 'output', 'evidence', 'g10a') : requireAbsoluteDirectory(outputRoot, 'outputRoot');
  await assertPrivateDirectory(evidenceRoot);
  return evidenceRoot;
}

export async function writeG10aEvidenceArtifacts({ root, outputRoot, runId, provenance, results, categories, cleanup } = {}) {
  const workspace = requireAbsoluteDirectory(root, 'root');
  assertRunId(runId);
  assertProvenance(provenance);
  assertResults(results);
  assertCategories(categories);
  assertCleanup(cleanup);
  assertResultsMatchCategories(results, categories);

  const evidenceRoot = await assertG10aEvidenceOutputRoot({ root: workspace, outputRoot });
  const finalDirectory = join(evidenceRoot, runId);
  const stagingDirectory = join(evidenceRoot, `.${runId}.staging`);
  await assertPrivateDirectory(evidenceRoot);
  if (await exists(finalDirectory)) throw new Error('G10a evidence runId collision');
  if (await exists(stagingDirectory)) throw new Error('G10a evidence staging collision');
  await mkdir(stagingDirectory, { mode: 0o700 });
  await assertPrivateDirectory(stagingDirectory);
  let stagingCreated = true;
  try {
    const persistedResults = freezeObject({ ...results, runId });
    const persistedCleanup = freezeObject({ ...cleanup, runId });
    await Promise.all([
      writeResults(join(stagingDirectory, 'results.json'), persistedResults),
      ...CATEGORY_NAMES.map(async (name) => writeCategory(join(stagingDirectory, `${name}.json`), categories[name])),
      writeCleanup(join(stagingDirectory, 'cleanup.json'), persistedCleanup),
    ]);
    const artifacts = await createArtifactInventory(stagingDirectory);
    const manifest = freezeObject({ format: FORMAT, runId, sourceCommit: provenance.sourceCommit, hashes: provenance.hashes, toolchain: provenance.toolchain, artifacts });
    await writeManifest(join(stagingDirectory, 'manifest.json'), manifest);
    await assertExactArtifactDirectory(stagingDirectory);
    if (await exists(finalDirectory)) throw new Error('G10a evidence runId collision');
    try {
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      if (await exists(finalDirectory)) throw new Error('G10a evidence runId collision');
      throw error;
    }
    stagingCreated = false;
    await assertPrivateDirectory(finalDirectory);
    await assertExactArtifactDirectory(finalDirectory);
  } catch (error) {
    if (stagingCreated) await removeOwnedStagingDirectory(stagingDirectory);
    throw error;
  }
  return Object.freeze({ runId, artifactNames: FIXED_ARTIFACT_NAMES });
}

export async function runWithPrimaryFailure({ execute, cleanup } = {}) {
  if (typeof execute !== 'function' || typeof cleanup !== 'function') throw new TypeError('execute and cleanup must be functions');
  let result;
  let primaryFailure;
  try {
    result = await execute();
  } catch (error) {
    primaryFailure = error;
  }
  let cleanupFailure;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result;
}

export async function sha256File(file) {
  const state = await lstat(file);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error('G10a evidence hash target must be a regular file');
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function sha256Directory(directory) {
  const root = resolve(directory);
  const state = await lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('G10a evidence source must be a real directory');
  const digest = createHash('sha256');
  await hashDirectoryEntries(root, root, digest);
  return digest.digest('hex');
}

async function sha256MatchingFiles(root, relativeDirectory, matches) {
  const directory = join(root, relativeDirectory);
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('G10a evidence inventory root must be a real directory');
  const files = [];
  await collectMatchingFiles(directory, directory, matches, files);
  if (files.length === 0) throw new Error('G10a evidence inventory cannot be empty');
  const digest = createHash('sha256');
  files.sort((left, right) => left.relative.localeCompare(right.relative, 'en'));
  for (const file of files) {
    digest.update(`F:${file.relative}\u0000`, 'utf8');
    digest.update(await readFile(file.fullPath));
  }
  return digest.digest('hex');
}

async function collectMatchingFiles(root, directory, matches, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    const state = await lstat(fullPath);
    if (state.isSymbolicLink()) throw new Error('G10a evidence inventory cannot contain symbolic links');
    const normalized = relative(root, fullPath).split(sep).join('/');
    if (state.isDirectory()) await collectMatchingFiles(root, fullPath, matches, files);
    else if (state.isFile() && matches(normalized)) files.push({ relative: normalized, fullPath });
    else if (!state.isFile()) throw new Error('G10a evidence inventory contains an unsupported filesystem entry');
  }
}

function isG10aSourcePath(relativePath) {
  return /^composition\/internal\/g10a-[a-z0-9-]+\.ts$/u.test(relativePath)
    || /^infrastructure\/mongo\/g10a-[a-z0-9-]+\.ts$/u.test(relativePath)
    || /^runtime\/internal\/runtime-[a-z0-9-]+\.ts$/u.test(relativePath);
}

function isG10aTestPath(relativePath) {
  return /^(?:unit|socket|integration)\/g10a-[a-z0-9-]+\.test\.ts$/u.test(relativePath);
}

function sha256CanonicalInventory(hashes) {
  const canonical = HASH_KEYS.filter((key) => key !== 'inventory').map((key) => [key, hashes[key]]);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

async function hashDirectoryEntries(root, directory, digest) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    const state = await lstat(fullPath);
    if (state.isSymbolicLink()) throw new Error('G10a evidence source cannot contain symbolic links');
    const normalized = relative(root, fullPath).split(sep).join('/');
    if (state.isDirectory()) {
      digest.update(`D:${normalized}\u0000`, 'utf8');
      await hashDirectoryEntries(root, fullPath, digest);
    } else if (state.isFile()) {
      digest.update(`F:${normalized}\u0000`, 'utf8');
      digest.update(await readFile(fullPath));
    } else {
      throw new Error('G10a evidence source contains an unsupported filesystem entry');
    }
  }
}

async function readPinnedImages(root) {
  const [toolchainText, composeText, runnerText] = await Promise.all([
    readFile(join(root, 'infra', 'toolchain-images.json'), 'utf8'),
    readFile(join(root, 'infra', 'g04b-mongo-compose.yml'), 'utf8'),
    readFile(join(root, 'scripts', 'test-g10a-integration.mjs'), 'utf8'),
  ]);
  const toolchain = JSON.parse(toolchainText);
  const toolchainNode = toolchain?.images?.node;
  const toolchainMongo = toolchain?.images?.mongo;
  const composeMongo = /^\s*image:\s*([^\s]+)\s*$/mu.exec(composeText)?.[1];
  const runnerNode = /^const nodeImage = '([^']+)';$/mu.exec(runnerText)?.[1];
  if (typeof toolchainNode !== 'string' || !isNodeImage(toolchainNode)) throw new Error('G10a evidence requires Node 24.21.0 bookworm-slim');
  if (typeof toolchainMongo !== 'string' || !isMongoImage(toolchainMongo)) throw new Error('G10a evidence requires Mongo 8.0.32 noble');
  if (typeof composeMongo !== 'string' || !isMongoImage(composeMongo) || composeMongo !== toolchainMongo) throw new Error('G10a evidence Mongo pin sources disagree');
  if (typeof runnerNode !== 'string' || !isNodeImage(runnerNode) || runnerNode !== toolchainNode) throw new Error('G10a evidence Node pin sources disagree');
  return Object.freeze({ nodeImage: toolchainNode, mongoImage: toolchainMongo });
}

function isNodeImage(value) { return /^node:24\.21\.0-bookworm-slim@sha256:[a-f0-9]{64}$/u.test(value); }
function isMongoImage(value) { return /^mongo:8\.0\.32-noble@sha256:[a-f0-9]{64}$/u.test(value); }

async function writeManifest(file, value) {
  assertManifest(value);
  await writeClosedJson(file, value);
}

async function writeResults(file, value) {
  assertResults(value);
  await writeClosedJson(file, value);
}

async function writeCleanup(file, value) {
  assertCleanup(value);
  await writeClosedJson(file, value);
}

async function writeCategory(file, value) {
  assertCategory(value);
  await writeClosedJson(file, value);
}

async function writeClosedJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function assertPrivateDirectory(directory) {
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.geteuid() || (state.mode & 0o777) !== 0o700) throw new Error('G10a evidence directory must be same-euid and exactly mode 0700');
}

async function assertExactArtifactDirectory(directory) {
  const names = (await readdir(directory)).sort();
  const expectedNames = [...FIXED_ARTIFACT_NAMES].sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw new Error('G10a evidence artifact set is not closed');
  }
  for (const name of names) {
    const state = await lstat(join(directory, name));
    if (!state.isFile() || state.isSymbolicLink() || state.uid !== process.geteuid() || (state.mode & 0o777) !== 0o600) throw new Error('G10a evidence artifact must be same-euid and exactly mode 0600');
  }
}

function assertRunId(value) {
  if (typeof value !== 'string' || !RUN_ID.test(value) || basename(value) !== value) throw new Error('G10a evidence runId is invalid');
}

function assertProvenance(value) {
  assertExactKeys(value, PROVENANCE_KEYS, 'provenance');
  assertManifestShape({ format: FORMAT, runId: 'g10a-provenance', sourceCommit: value?.sourceCommit, hashes: value?.hashes, toolchain: value?.toolchain }, false, false);
}

function assertManifest(value) {
  assertManifestShape(value, true);
}

function assertManifestShape(value, requiresRunId, requiresArtifactInventory = true) {
  assertExactKeys(value, requiresArtifactInventory ? MANIFEST_KEYS : PROVENANCE_MANIFEST_KEYS, 'manifest');
  if (value.format !== FORMAT || !GIT_COMMIT.test(value.sourceCommit ?? '')) throw new Error('G10a evidence provenance is invalid');
  if (requiresRunId) assertRunId(value.runId);
  else if (value.runId !== 'g10a-provenance') throw new Error('G10a evidence provenance is invalid');
  assertExactKeys(value.hashes, HASH_KEYS, 'manifest hashes');
  for (const key of HASH_KEYS) if (!SHA256.test(value.hashes[key] ?? '')) throw new Error('G10a evidence hash is invalid');
  if (value.hashes.inventory !== sha256CanonicalInventory(Object.fromEntries(HASH_KEYS.filter((key) => key !== 'inventory').map((key) => [key, value.hashes[key]])))) {
    throw new Error('G10a evidence inventory hash is invalid');
  }
  assertExactKeys(value.toolchain, ['nodeImage', 'mongoImage'], 'manifest toolchain');
  if (!isNodeImage(value.toolchain.nodeImage) || !isMongoImage(value.toolchain.mongoImage)) throw new Error('G10a evidence toolchain is invalid');
  if (requiresArtifactInventory) assertArtifactInventory(value.artifacts);
}

export function createG10aEvidenceResults({ status, phases, environment = null, categoryEvidenceStatus } = {}) {
  const result = freezeObject({ format: RESULT_FORMAT, runId: 'g10a-provenance', status, phases, environment, categoryEvidenceStatus });
  assertResults(result, false);
  return result;
}

/**
 * A category artifact is deliberately unable to contain command output, a
 * control request/response, raw log lines, paths, or secret-bearing values.
 * `NOT_COLLECTED` is a first-class state so a passing broad Jest phase cannot
 * be mistaken for completed category evidence.
 */
export function createG10aEvidenceCategory({ category, status, cases = [] } = {}) {
  const normalizedCases = cases.map((entry) => freezeObject({ id: entry?.id, status: entry?.status }));
  const passedCaseCount = normalizedCases.filter((entry) => entry.status === 'PASS').length;
  const failedCaseCount = normalizedCases.filter((entry) => entry.status === 'FAIL').length;
  const summaryHash = status === 'NOT_COLLECTED' ? null : sha256CanonicalCategory(category, normalizedCases);
  const value = freezeObject({ format: CATEGORY_FORMAT, version: CATEGORY_VERSION, category, status, cases: Object.freeze(normalizedCases), passedCaseCount, failedCaseCount, summaryHash });
  assertCategory(value);
  return value;
}

export function createG10aEvidenceCategories(input = {}) {
  const categories = {};
  for (const category of CATEGORY_NAMES) {
    const supplied = input[category];
    categories[category] = supplied === undefined
      ? createG10aEvidenceCategory({ category, status: 'NOT_COLLECTED' })
      : createG10aEvidenceCategory({ category, status: supplied?.status, cases: supplied?.cases });
  }
  const value = freezeObject(categories);
  assertCategories(value);
  return value;
}

/**
 * The generic phase runner intentionally has no knowledge of individual test
 * case IDs.  Until a category-specific collector is supplied, it emits a
 * truthful incomplete skeleton rather than inferring coverage from stdout.
 */
export async function collectG10aEvidenceCategories() {
  return createG10aEvidenceCategories();
}

export function createG10aEvidenceCleanup({ status, dockerContainersAbsent, composeContainersAbsent, composeNetworksAbsent } = {}) {
  const cleanup = freezeObject({ format: CLEANUP_FORMAT, runId: 'g10a-provenance', status, primaryFailurePrecedence: 'PRESERVED', dockerContainersAbsent, composeContainersAbsent, composeNetworksAbsent });
  assertCleanup(cleanup, false);
  return cleanup;
}

function assertResults(value, requiresRunId = true) {
  assertExactKeys(value, RESULTS_KEYS, 'results');
  if (value.format !== RESULT_FORMAT) throw new Error('G10a evidence results are invalid');
  if (requiresRunId) assertRunId(value.runId);
  else if (value.runId !== 'g10a-provenance') throw new Error('G10a evidence results are invalid');
  assertResultStatus(value.status);
  if (value.categoryEvidenceStatus !== 'COMPLETE' && value.categoryEvidenceStatus !== 'INCOMPLETE' && value.categoryEvidenceStatus !== 'FAILED') throw new Error('G10a evidence category status is invalid');
  if (!Array.isArray(value.phases) || value.phases.length === 0 || value.phases.length > PHASE_IDENTIFIERS.length) throw new Error('G10a evidence results are invalid');
  for (let index = 0; index < value.phases.length; index += 1) {
    const phase = value.phases[index];
    assertExactKeys(phase, ['identifier', 'exitCode', 'durationMs', 'suiteCount', 'testCount'], 'phase');
    if (phase.identifier !== PHASE_IDENTIFIERS[index] || !Number.isInteger(phase.exitCode) || phase.exitCode < 0 || !Number.isSafeInteger(phase.durationMs) || phase.durationMs < 0 || !isCount(phase.suiteCount) || !isCount(phase.testCount)) throw new Error('G10a evidence results are invalid');
  }
  const completePhases = value.phases.length === PHASE_IDENTIFIERS.length && value.phases.every((phase) => phase.exitCode === 0 && phase.suiteCount !== null && phase.testCount !== null);
  if (value.status === 'PASS' && (!completePhases || value.categoryEvidenceStatus !== 'COMPLETE')) throw new Error('G10a evidence PASS results are incomplete');
  if (value.status === 'INCOMPLETE' && (!completePhases || value.categoryEvidenceStatus !== 'INCOMPLETE')) throw new Error('G10a evidence INCOMPLETE results are invalid');
  if (value.status === 'FAILED' && (!completePhases || value.categoryEvidenceStatus !== 'FAILED')) throw new Error('G10a evidence FAILED results are invalid');
  if (value.status === 'FAIL' && !value.phases.some((phase) => phase.exitCode !== 0) && value.environment !== null) throw new Error('G10a evidence FAIL results require a failed phase or missing environment proof');
  if (value.status === 'PASS' || value.status === 'INCOMPLETE' || value.status === 'FAILED') assertEnvironmentProof(value.environment);
  else if (value.environment !== null) assertEnvironmentProof(value.environment);
}

function assertCategories(value) {
  assertExactKeys(value, CATEGORY_NAMES, 'categories');
  for (const category of CATEGORY_NAMES) {
    assertCategory(value[category]);
    if (value[category].category !== category) throw new Error('G10a evidence category name is invalid');
  }
}

function assertCategory(value) {
  assertExactKeys(value, ['format', 'version', 'category', 'status', 'cases', 'passedCaseCount', 'failedCaseCount', 'summaryHash'], 'category');
  if (value.format !== CATEGORY_FORMAT || value.version !== CATEGORY_VERSION || !CATEGORY_NAMES.includes(value.category)) throw new Error('G10a evidence category is invalid');
  if (value.status !== 'NOT_COLLECTED' && value.status !== 'PASS' && value.status !== 'FAIL') throw new Error('G10a evidence category status is invalid');
  if (!Array.isArray(value.cases) || value.cases.length > MAX_CATEGORY_CASES || !Number.isSafeInteger(value.passedCaseCount) || value.passedCaseCount < 0 || !Number.isSafeInteger(value.failedCaseCount) || value.failedCaseCount < 0) throw new Error('G10a evidence category is invalid');
  const identifiers = new Set();
  for (const entry of value.cases) {
    assertExactKeys(entry, ['id', 'status'], 'category case');
    if (typeof entry.id !== 'string' || !CATEGORY_CASE_CODES[value.category].includes(entry.id) || identifiers.has(entry.id) || (entry.status !== 'PASS' && entry.status !== 'FAIL')) throw new Error('G10a evidence category case is invalid');
    identifiers.add(entry.id);
  }
  const passed = value.cases.filter((entry) => entry.status === 'PASS').length;
  const failed = value.cases.filter((entry) => entry.status === 'FAIL').length;
  if (value.passedCaseCount !== passed || value.failedCaseCount !== failed) throw new Error('G10a evidence category counts are invalid');
  if (value.status === 'NOT_COLLECTED' && (value.cases.length !== 0 || value.summaryHash !== null)) throw new Error('G10a evidence uncollected category is invalid');
  if (value.status === 'PASS' && (value.cases.length === 0 || failed !== 0 || !SHA256.test(value.summaryHash ?? ''))) throw new Error('G10a evidence PASS category is invalid');
  if (value.status === 'FAIL' && (value.cases.length === 0 || failed === 0 || !SHA256.test(value.summaryHash ?? ''))) throw new Error('G10a evidence FAIL category is invalid');
  if (value.summaryHash !== null && value.summaryHash !== sha256CanonicalCategory(value.category, value.cases)) throw new Error('G10a evidence category hash is invalid');
}

function sha256CanonicalCategory(category, cases) {
  return createHash('sha256').update(JSON.stringify([CATEGORY_VERSION, category, cases.map((entry) => [entry.id, entry.status])]), 'utf8').digest('hex');
}

function categoryEvidenceStatus(categories) {
  if (CATEGORY_NAMES.some((category) => categories[category].status === 'FAIL')) return 'FAILED';
  return CATEGORY_NAMES.every((category) => categories[category].status === 'PASS') ? 'COMPLETE' : 'INCOMPLETE';
}

function assertResultsMatchCategories(results, categories) {
  if (results.categoryEvidenceStatus !== categoryEvidenceStatus(categories)) throw new Error('G10a evidence result/category completeness mismatch');
}

async function createArtifactInventory(directory) {
  const inventory = [];
  for (const name of FIXED_ARTIFACT_NAMES) {
    if (name === 'manifest.json') inventory.push(freezeObject({ name, sha256: 'SELF' }));
    else inventory.push(freezeObject({ name, sha256: await sha256File(join(directory, name)) }));
  }
  return Object.freeze(inventory);
}

function assertArtifactInventory(value) {
  if (!Array.isArray(value) || value.length !== FIXED_ARTIFACT_NAMES.length) throw new Error('G10a evidence artifact inventory is invalid');
  for (let index = 0; index < FIXED_ARTIFACT_NAMES.length; index += 1) {
    const entry = value[index];
    assertExactKeys(entry, ['name', 'sha256'], 'artifact inventory entry');
    if (entry.name !== FIXED_ARTIFACT_NAMES[index] || (entry.name === 'manifest.json' ? entry.sha256 !== 'SELF' : !SHA256.test(entry.sha256 ?? ''))) throw new Error('G10a evidence artifact inventory is invalid');
  }
}

function assertEnvironmentProof(value) {
  assertExactKeys(value, ['format', 'nodeVersion', 'mongoVersion', 'replicaSet', 'writablePrimary'], 'environment proof');
  if (value.format !== ENVIRONMENT_PROOF_FORMAT || value.nodeVersion !== '24.21.0' || value.mongoVersion !== '8.0.32' || value.replicaSet !== 'rs0' || value.writablePrimary !== true) throw new Error('G10a evidence environment proof is invalid');
}

function isCount(value) { return value === null || (Number.isSafeInteger(value) && value >= 0); }

function assertCleanup(value, requiresRunId = true) {
  assertExactKeys(value, CLEANUP_KEYS, 'cleanup');
  if (value.format !== CLEANUP_FORMAT || value.primaryFailurePrecedence !== 'PRESERVED') throw new Error('G10a evidence cleanup is invalid');
  if (requiresRunId) assertRunId(value.runId);
  else if (value.runId !== 'g10a-provenance') throw new Error('G10a evidence cleanup is invalid');
  assertCleanupStatus(value.status);
  for (const valueToCheck of [value.dockerContainersAbsent, value.composeContainersAbsent, value.composeNetworksAbsent]) if (typeof valueToCheck !== 'boolean') throw new Error('G10a evidence cleanup is invalid');
  const allAbsent = value.dockerContainersAbsent && value.composeContainersAbsent && value.composeNetworksAbsent;
  if ((value.status === 'PASS') !== allAbsent) throw new Error('G10a evidence cleanup status does not match outcomes');
}

function assertExactKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`G10a evidence ${label} must be a plain object`);
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) throw new Error(`G10a evidence ${label} has unexpected fields`);
}

function assertResultStatus(value) {
  if (value !== 'PASS' && value !== 'FAIL' && value !== 'INCOMPLETE' && value !== 'FAILED') throw new Error('G10a evidence result status is invalid');
}

function assertCleanupStatus(value) {
  if (value !== 'PASS' && value !== 'FAIL') throw new Error('G10a evidence cleanup status is invalid');
}

function requireAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  return resolve(value);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwnedStagingDirectory(directory) {
  await assertPrivateDirectory(directory);
  await rm(directory, { recursive: true, force: true });
}

async function runGit(root, args) {
  const result = await execFile('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.stdout;
}

function freezeObject(value) {
  return Object.freeze(value);
}
