import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, join, relative, resolve, sep } from 'node:path';

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const RUN_ID = /^g10a-[a-z0-9-]+$/u;
const FORMAT = 'passhub.g10a.evidence.v1';
const RESULT_FORMAT = 'passhub.g10a.evidence-results.v1';
const CLEANUP_FORMAT = 'passhub.g10a.evidence-cleanup.v1';
const FIXED_ARTIFACT_NAMES = Object.freeze(['manifest.json', 'results.json', 'cleanup.json']);
const HASH_KEYS = Object.freeze([
  'sourceTree', 'g10aSource', 'g10aTests', 'packageLock', 'runner', 'evidenceHelper',
  'compose', 'toolchain', 'jestUnit', 'jestSocket', 'jestIntegration', 'inventory',
]);
const PROVENANCE_KEYS = Object.freeze(['format', 'sourceCommit', 'hashes', 'toolchain']);
const MANIFEST_KEYS = Object.freeze(['format', 'runId', 'sourceCommit', 'hashes', 'toolchain']);
const RESULTS_KEYS = Object.freeze(['format', 'runId', 'status', 'suite']);
const CLEANUP_KEYS = Object.freeze(['format', 'runId', 'status', 'primaryFailurePrecedence']);

/**
 * Evidence is deliberately a small, closed-schema boundary.  The integration
 * runner may know live connection details and test failures; this module never
 * receives or serializes either of them.
 */
export async function collectG10aEvidenceProvenance({ root, git = runGit } = {}) {
  const workspace = requireAbsoluteDirectory(root, 'root');
  const sourceCommit = await assertCleanGitWorktree({ root: workspace, git });
  const [sourceTree, g10aSource, g10aTests, packageLock, runner, evidenceHelper, compose, toolchain, jestUnit, jestSocket, jestIntegration, images] = await Promise.all([
    sha256Directory(join(workspace, 'src')),
    sha256MatchingFiles(workspace, 'src', isG10aSourcePath),
    sha256MatchingFiles(workspace, 'test', isG10aTestPath),
    sha256File(join(workspace, 'package-lock.json')),
    sha256File(join(workspace, 'scripts', 'test-g10a-integration.mjs')),
    sha256File(join(workspace, 'scripts', 'internal-g10a-evidence.mjs')),
    sha256File(join(workspace, 'infra', 'g04b-mongo-compose.yml')),
    sha256File(join(workspace, 'infra', 'toolchain-images.json')),
    sha256File(join(workspace, 'jest.g10a.unit.config.cjs')),
    sha256File(join(workspace, 'jest.g10a.socket.config.cjs')),
    sha256File(join(workspace, 'jest.g10a.integration.config.cjs')),
    readPinnedImages(workspace),
  ]);
  const unhashedInventory = freezeObject({ sourceTree, g10aSource, g10aTests, packageLock, runner, evidenceHelper, compose, toolchain, jestUnit, jestSocket, jestIntegration });
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

export async function writeG10aEvidenceArtifacts({ root, outputRoot, runId, provenance, resultStatus, cleanupStatus } = {}) {
  const workspace = requireAbsoluteDirectory(root, 'root');
  assertRunId(runId);
  assertProvenance(provenance);
  assertResultStatus(resultStatus);
  assertCleanupStatus(cleanupStatus);

  const evidenceRoot = outputRoot === undefined ? join(workspace, 'output', 'evidence', 'g10a') : requireAbsoluteDirectory(outputRoot, 'outputRoot');
  const finalDirectory = join(evidenceRoot, runId);
  const stagingDirectory = join(evidenceRoot, `.${runId}.staging`);
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(evidenceRoot);
  if (await exists(finalDirectory)) throw new Error('G10a evidence runId collision');
  if (await exists(stagingDirectory)) throw new Error('G10a evidence staging collision');
  await mkdir(stagingDirectory, { mode: 0o700 });
  await assertPrivateDirectory(stagingDirectory);
  let stagingCreated = true;
  try {
    const manifest = freezeObject({ format: FORMAT, runId, sourceCommit: provenance.sourceCommit, hashes: provenance.hashes, toolchain: provenance.toolchain });
    const results = freezeObject({ format: RESULT_FORMAT, runId, status: resultStatus, suite: 'g10a-integration' });
    const cleanup = freezeObject({ format: CLEANUP_FORMAT, runId, status: cleanupStatus, primaryFailurePrecedence: 'PRESERVED' });
    await Promise.all([
      writeManifest(join(stagingDirectory, 'manifest.json'), manifest),
      writeResults(join(stagingDirectory, 'results.json'), results),
      writeCleanup(join(stagingDirectory, 'cleanup.json'), cleanup),
    ]);
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
  if (typeof toolchainNode !== 'string' || !isPinnedImage(toolchainNode)) throw new Error('G10a evidence requires a pinned Node image');
  if (typeof toolchainMongo !== 'string' || !isPinnedImage(toolchainMongo)) throw new Error('G10a evidence requires a pinned Mongo image');
  if (typeof composeMongo !== 'string' || !isPinnedImage(composeMongo) || composeMongo !== toolchainMongo) throw new Error('G10a evidence Mongo pin sources disagree');
  if (typeof runnerNode !== 'string' || !isPinnedImage(runnerNode) || runnerNode !== toolchainNode) throw new Error('G10a evidence Node pin sources disagree');
  return Object.freeze({ nodeImage: toolchainNode, mongoImage: toolchainMongo });
}

function isPinnedImage(value) {
  return /^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/u.test(value);
}

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
  assertManifestShape({ format: FORMAT, runId: 'g10a-provenance', sourceCommit: value?.sourceCommit, hashes: value?.hashes, toolchain: value?.toolchain }, false);
}

function assertManifest(value) {
  assertManifestShape(value, true);
}

function assertManifestShape(value, requiresRunId) {
  assertExactKeys(value, MANIFEST_KEYS, 'manifest');
  if (value.format !== FORMAT || !GIT_COMMIT.test(value.sourceCommit ?? '')) throw new Error('G10a evidence provenance is invalid');
  if (requiresRunId) assertRunId(value.runId);
  else if (value.runId !== 'g10a-provenance') throw new Error('G10a evidence provenance is invalid');
  assertExactKeys(value.hashes, HASH_KEYS, 'manifest hashes');
  for (const key of HASH_KEYS) if (!SHA256.test(value.hashes[key] ?? '')) throw new Error('G10a evidence hash is invalid');
  if (value.hashes.inventory !== sha256CanonicalInventory(Object.fromEntries(HASH_KEYS.filter((key) => key !== 'inventory').map((key) => [key, value.hashes[key]])))) {
    throw new Error('G10a evidence inventory hash is invalid');
  }
  assertExactKeys(value.toolchain, ['nodeImage', 'mongoImage'], 'manifest toolchain');
  if (!isPinnedImage(value.toolchain.nodeImage) || !isPinnedImage(value.toolchain.mongoImage)) throw new Error('G10a evidence toolchain is invalid');
}

function assertResults(value) {
  assertExactKeys(value, RESULTS_KEYS, 'results');
  if (value.format !== RESULT_FORMAT || value.suite !== 'g10a-integration') throw new Error('G10a evidence results are invalid');
  assertRunId(value.runId);
  assertResultStatus(value.status);
}

function assertCleanup(value) {
  assertExactKeys(value, CLEANUP_KEYS, 'cleanup');
  if (value.format !== CLEANUP_FORMAT || value.primaryFailurePrecedence !== 'PRESERVED') throw new Error('G10a evidence cleanup is invalid');
  assertRunId(value.runId);
  assertCleanupStatus(value.status);
}

function assertExactKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`G10a evidence ${label} must be a plain object`);
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) throw new Error(`G10a evidence ${label} has unexpected fields`);
}

function assertResultStatus(value) {
  if (value !== 'PASS' && value !== 'FAIL') throw new Error('G10a evidence result status is invalid');
}

function assertCleanupStatus(value) {
  if (value !== 'PASS' && value !== 'FAIL') throw new Error('G10a evidence cleanup status is invalid');
}

function requireAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a nonempty path`);
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
