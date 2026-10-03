import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STATIC_CASES = [
  'G11A_TOPOLOGY_SERVICES', 'G11A_TOPOLOGY_IMAGES', 'G11A_TOPOLOGY_PORTS',
  'G11A_TOPOLOGY_NETWORKS', 'G11A_RUNTIME_POLICY', 'G11A_SECRET_AND_MOUNT_BOUNDARY',
  'G11A_NGINX_TLS', 'G11A_NGINX_PROXY_POLICY', 'G11A_NGINX_MAINTENANCE_FENCE',
  'G11A_NGINX_LOG_POLICY', 'G11A_MONGO_AUTH_ENTRYPOINT',
];
const RUNTIME_CASES = [
  'G11A_RUNTIME_API_IMAGE', 'G11A_RUNTIME_MONGO_PRIMARY', 'G11A_RUNTIME_CONTAINER_POLICY',
  'G11A_RUNTIME_PROXY_IDENTITY', 'G11A_RUNTIME_NETWORK_ISOLATION',
  'G11A_RUNTIME_MAINTENANCE_FENCE', 'G11A_RUNTIME_GRACEFUL_STOP', 'G11A_RUNTIME_CLEANUP',
];
const temporary = mkdtempSync(join(tmpdir(), 'passhub-g11a-evidence-'));
const repository = resolve(import.meta.dirname, '../..');
const DEPLOYMENT_FINGERPRINT_PATHS = Object.freeze({
  dockerfileSha256: 'infra/g11/api.Dockerfile',
  composeSha256: 'infra/g11/compose.yml',
  smokeComposeSha256: 'infra/g11/compose.smoke.yml',
  nginxSha256: 'infra/g11/nginx/nginx.conf',
  mongoEntrypointSha256: 'infra/g11/mongo/entrypoint.sh',
});

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(join(repository, path))).digest('hex');
}

function git(args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function sourceFingerprint() {
  const paths = git(['ls-files', '-z']).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(`${path}\0`).update(readFileSync(join(repository, path))).update('\0');
  return hash.digest('hex');
}

const trackedStatus = git(['status', '--porcelain', '--untracked-files=no']);
if (trackedStatus.length > 0) throw new Error('G11a formal evidence requires a clean tracked worktree');
const sourceCommit = git(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error('G11a source commit is invalid');

function run(args, timeout) {
  const result = spawnSync('npm', args, {
    encoding: 'utf8', timeout, killSignal: 'SIGTERM', maxBuffer: 16 * 1024 * 1024,
  });
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    process.stderr.write(combined);
    throw result.error ?? new Error(`G11a command failed: npm ${args.join(' ')}`);
  }
  process.stdout.write(combined);
  return combined;
}

function lastJsonLine(output) {
  const candidates = output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{') && line.endsWith('}'));
  if (candidates.length === 0) throw new Error('G11a command did not emit a machine-readable result');
  return JSON.parse(candidates.at(-1));
}

function exactCases(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} exact case manifest is incomplete or changed`);
  }
}

let primaryFailure;
let cleanupFailure;
let result;
try {
  const jestResultPath = join(temporary, 'jest.json');
  run(['run', 'test:g11a:unit', '--', '--json', '--outputFile', jestResultPath], 120_000);
  const jest = JSON.parse(readFileSync(jestResultPath, 'utf8'));
  if (jest.numTotalTestSuites !== 1 || jest.numPassedTestSuites !== 1 || jest.numFailedTestSuites !== 0
    || jest.numTotalTests !== 18 || jest.numPassedTests !== 18 || jest.numFailedTests !== 0
    || jest.numPendingTests !== 0 || jest.numTodoTests !== 0 || jest.wasInterrupted !== false) {
    throw new Error('G11a Jest totals are incomplete, skipped, failed, or interrupted');
  }

  const staticResult = lastJsonLine(run(['run', 'check:g11a:topology'], 120_000));
  if (staticResult.gate !== 'G11a' || staticResult.status !== 'PASS') throw new Error('G11a static checker did not pass');
  exactCases(staticResult.cases, STATIC_CASES, 'G11a static');

  const runtimeResult = lastJsonLine(run(['run', 'test:g11a:runtime'], 660_000));
  if (runtimeResult.gate !== 'G11a' || runtimeResult.status !== 'PASS') throw new Error('G11a runtime checker did not pass');
  exactCases(runtimeResult.cases, RUNTIME_CASES, 'G11a runtime');
  const runtimeFingerprints = runtimeResult.fingerprints;
  const expectedFingerprintKeys = ['apiImageId', ...Object.keys(DEPLOYMENT_FINGERPRINT_PATHS)].sort();
  const actualFingerprintKeys = typeof runtimeFingerprints === 'object' && runtimeFingerprints !== null
    ? Object.keys(runtimeFingerprints).sort()
    : [];
  if (actualFingerprintKeys.length !== expectedFingerprintKeys.length
    || actualFingerprintKeys.some((value, index) => value !== expectedFingerprintKeys[index])
    || typeof runtimeFingerprints.apiImageId !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(runtimeFingerprints.apiImageId)) {
    throw new Error('G11a runtime fingerprints are missing or malformed');
  }
  for (const [key, path] of Object.entries(DEPLOYMENT_FINGERPRINT_PATHS)) {
    if (runtimeFingerprints[key] !== fileSha256(path)) throw new Error(`G11a runtime fingerprint mismatch: ${key}`);
  }

  result = {
    gate: 'G11a', status: 'PASS',
    unit: { suites: 1, tests: 18 },
    staticCases: STATIC_CASES,
    runtimeCases: RUNTIME_CASES,
    fingerprints: { sourceCommit, sourceSha256: sourceFingerprint(), ...runtimeFingerprints },
  };
} catch (error) {
  primaryFailure = error;
} finally {
  try { rmSync(temporary, { recursive: true, force: true }); } catch (error) { cleanupFailure = error; }
}

if (primaryFailure !== undefined || cleanupFailure !== undefined) {
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure], 'G11a evidence and cleanup both failed');
  }
  throw primaryFailure ?? cleanupFailure;
}
process.stdout.write(`${JSON.stringify(result)}\n`);
