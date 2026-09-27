import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { DEFAULT_NODE_IMAGE, runG09bCorrectness } from './internal-g09b-runner.mjs';
import { parsePerfArgs } from './internal-g09b-performance-model.mjs';

const args = process.argv.slice(2);
const parsed = parsePerfArgs(args);
if (parsed.smoke) {
  await import('./internal-g09b-performance-smoke.mjs');
  process.exit(0);
}
const sourceCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain=1', '--untracked-files=all'], { encoding: 'utf8' });
if (dirty.length !== 0) throw new Error('G09b formal performance requires a clean source revision; use --smoke while tooling is dirty');
const productionCodeHash = hashTrackedFiles('src');
const packageLockHash = hashTrackedFiles('package-lock.json');
const runId = `g09b-b2-${process.pid}-${Date.now()}`;
const projectName = `passhub-g09b-b2-${process.pid}`;
const databaseName = `passhub_g09b_b2_${process.pid}_${Date.now()}`.slice(0, 63);
await runG09bCorrectness({
  projectName,
  workerName: `passhub-g09b-b2-worker-${process.pid}`,
  workerLabel: `com.passhub.g09b.b2=${projectName}`,
  databaseName,
  workerScript: 'scripts/internal-g09b-performance-worker.mjs',
  workerEnv: {
    G09B_PERF_RUN_ID: runId,
    G09B_PERF_OUTPUT_ROOT: 'output/evidence/g09b',
    G09B_PERF_SOURCE_COMMIT: sourceCommit,
    G09B_SOURCE_DIRTY: '0',
    G09B_PRODUCTION_CODE_HASH: productionCodeHash,
    G09B_PACKAGE_LOCK_HASH: packageLockHash,
    G09B_IMAGE_DIGEST: DEFAULT_NODE_IMAGE.split('@')[1] ?? null,
  },
  report: (message) => process.stderr.write(`${message}\n`),
});

function hashTrackedFiles(pathSpec) {
  const files = execFileSync('git', ['ls-files', '--', pathSpec], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (files.length === 0) throw new Error(`G09b provenance has no tracked files for ${pathSpec}`);
  const hash = createHash('sha256');
  for (const file of files) hash.update(file, 'utf8').update('\0', 'utf8').update(readFileSync(file));
  return hash.digest('hex');
}
