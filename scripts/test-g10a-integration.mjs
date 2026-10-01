import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { collectG10aEnvironmentProof, writeG10aEnvironmentProof } from './internal-g10a-environment-proof.mjs';

const composeFile = 'infra/g04b-mongo-compose.yml';
const projectName = 'passhub-g10a';
const nodeImage = 'node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
const uri = process.env.G10A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G10A_MONGO_DATABASE_PREFIX ?? `passhub_g10a_jest_${process.pid}`;
const compose = ['compose', '--project-name', projectName, '-f', composeFile];
const workspace = process.cwd();
const nodeContainerName = `passhub-g10a-node-${process.pid}-${randomUUID().replaceAll('-', '')}`;
const totalDeadlineMs = 300_000;
const cleanupDeadlineMs = 30_000;
const startedAt = performance.now();

if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') throw new Error('G10a integration requires Unix UID/GID');
const uid = process.getuid();
const gid = process.getgid();
const scratch = await mkdtemp(join(tmpdir(), 'passhub-g10a-integration-'));
await mkdir(join(scratch, 'home'), { mode: 0o700 });
await mkdir(join(scratch, 'npm-cache'), { mode: 0o700 });

let primaryFailure;
let environmentProof;
try {
  await run('docker', [...compose, 'up', '-d'], process.env, remainingMs());
  await run('node', ['scripts/g04b-init-replica-set.mjs'], { ...process.env, G04B_MONGO_URI: uri }, remainingMs());
  environmentProof = await collectG10aEnvironmentProof({
    captureCommand: async (command, args) => await runCaptured(command, args, process.env, remainingMs()),
    nodeImage,
    compose,
  });
  await run('docker', [
    'run', '--rm', '--name', nodeContainerName, '--network', 'host', '--user', `${uid}:${gid}`,
    '-v', `${workspace}:/workspace`, '-v', `${scratch}:/tmp/passhub-g10a`, '-w', '/workspace',
    '-e', `G10A_MONGO_URI=${uri}`, '-e', `G10A_MONGO_DATABASE_PREFIX=${databasePrefix}`,
    '-e', 'HOME=/tmp/passhub-g10a/home', '-e', 'NPM_CONFIG_CACHE=/tmp/passhub-g10a/npm-cache',
    nodeImage, 'sh', '-lc',
    'node --version && npm --version && npm run clean && npm run build && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.g10a.integration.config.cjs --runInBand',
  ], process.env, remainingMs());
  await assertOwnedTree(join(workspace, 'dist'), uid, gid);
} catch (error) {
  primaryFailure = error;
} finally {
  const cleanupStartedAt = performance.now();
  const cleanupRemainingMs = () => {
    const remaining = Math.floor(cleanupDeadlineMs - (performance.now() - cleanupStartedAt));
    if (remaining <= 0) throw new Error(`G10a cleanup exceeded its ${cleanupDeadlineMs}ms deadline`);
    return remaining;
  };
  const recordCleanupFailure = (label, error) => {
    if (primaryFailure === undefined) primaryFailure = error;
    else process.stderr.write(`G10a ${label} cleanup also failed: ${String(error)}\n`);
  };
  try {
    await removeNamedContainer(cleanupRemainingMs());
  } catch (cleanupError) {
    recordCleanupFailure('node-container', cleanupError);
  }
  try {
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans'], process.env, cleanupRemainingMs());
  } catch (cleanupError) {
    recordCleanupFailure('Mongo', cleanupError);
  }
  try {
    await removeNamedContainer(cleanupRemainingMs());
  } catch (cleanupError) {
    recordCleanupFailure('node-container post-compose', cleanupError);
  }
  await rm(scratch, { recursive: true, force: true }).catch((cleanupError) => {
    recordCleanupFailure('temporary-home', cleanupError);
  });
}
if (primaryFailure !== undefined) throw primaryFailure;
writeG10aEnvironmentProof(environmentProof);

function remainingMs() {
  const remaining = Math.floor(totalDeadlineMs - (performance.now() - startedAt));
  if (remaining <= 0) throw new Error(`G10a integration exceeded its ${totalDeadlineMs}ms total deadline`);
  return remaining;
}

async function run(command, args, env, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid remaining deadline for ${command}`);
  await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKill;
    const child = spawn(command, args, { stdio: 'inherit', env, shell: false });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKill.unref();
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forceKill !== undefined) clearTimeout(forceKill);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (timedOut) reject(new Error(`${command} exceeded its ${timeoutMs}ms phase deadline and was terminated`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function removeNamedContainer(timeoutMs) {
  const before = await inspectNamedContainer(timeoutMs);
  if (!before) return;
  try {
    await run('docker', ['rm', '-f', nodeContainerName], process.env, timeoutMs);
  } catch (error) {
    // The container can disappear between inspect and rm; only that exact
    // not-found race is ignored. A daemon/permission/timeout failure remains
    // a cleanup failure and cannot mask the primary test failure.
    if (await inspectNamedContainer(timeoutMs) === false) return;
    throw error;
  }
}

async function inspectNamedContainer(timeoutMs) {
  const result = await runCaptured('docker', ['container', 'inspect', nodeContainerName], process.env, timeoutMs);
  if (result.code === 0) return true;
  if (/No such (?:container|object)/iu.test(result.stderr)) return false;
  throw new Error(`docker container inspect ${nodeContainerName} failed with exit ${result.code}: ${result.stderr.trim()}`);
}

async function runCaptured(command, args, env, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid remaining deadline for ${command}`);
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKill;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKill.unref();
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => { clearTimeout(timer); if (forceKill !== undefined) clearTimeout(forceKill); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (timedOut) reject(new Error(`${command} exceeded its ${timeoutMs}ms phase deadline and was terminated`));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function assertOwnedTree(root, expectedUid, expectedGid) {
  const state = await lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== expectedUid || state.gid !== expectedGid) {
    throw new Error('G10a container build did not create a host-UID-owned dist directory');
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const child = await lstat(path);
    if (child.isSymbolicLink() || child.uid !== expectedUid || child.gid !== expectedGid) {
      throw new Error(`G10a container build left an unsafe or foreign-owned artifact: ${path}`);
    }
    if (child.isDirectory()) await assertOwnedTree(path, expectedUid, expectedGid);
  }
}
