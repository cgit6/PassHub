import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const evidenceRoot = resolve(root, 'docs/evidence');
const required = ['g11a/report.md', 'g11b/report.md', 'g11c/report.md', 'g11c/runtime-clean.json',
  'g11d/report.md', 'g11d/runtime-clean.json', 'g11e/report.md', 'g11e/runtime.json', 'g11f/report.md', 'g11f/runtime.json'];
const missing = required.filter((file) => !existsSync(join(evidenceRoot, file)));
if (missing.length > 0) throw new Error(`G11G_EVIDENCE_MISSING:${missing.join(',')}`);
const json = (file) => JSON.parse(readFileSync(join(evidenceRoot, file), 'utf8'));
const g11f = json('g11f/runtime.json');
if (g11f.gate !== 'G11f' || g11f.status !== 'PASS' || g11f.sourceDirty !== false || g11f.unit?.status !== 'PASS' || g11f.runtime?.status !== 'PASS') {
  throw new Error('G11G_G11F_EVIDENCE_INVALID');
}
const g11e = json('g11e/runtime.json');
if (g11e.gate !== 'G11e' || !Array.isArray(g11e.runtimeCases) || g11e.runtimeCases.length < 5) throw new Error('G11G_G11E_EVIDENCE_INVALID');
const run = (binary, args) => execFileSync(binary, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const checks = [];
checks.push({ name: 'g11e-static-contract', output: run('node', ['scripts/g11/check-g11e-contract.mjs']) });
checks.push({ name: 'g11f-unit', output: run('npm', ['run', 'test:g11f:unit']) });
const tracked = run('git', ['ls-files', '-z']).split('\0').filter(Boolean).sort();
const sourceHash = createHash('sha256');
for (const file of tracked) sourceHash.update(`${file}\0`).update(readFileSync(resolve(root, file))).update('\0');
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /AKIA[0-9A-Z]{16}/u,
  /(?:password|secret|token)\s*[:=]\s*['"][^'"\n]{40,}['"]/iu,
];
const scanFiles = tracked.filter((file) => /\.(?:ts|mjs|cjs|json|yml|yaml|md|sh)$/u.test(file));
const secretHits = [];
for (const file of scanFiles) {
  const text = readFileSync(resolve(root, file), 'utf8');
  if (secretPatterns.some((pattern) => pattern.test(text))) secretHits.push(file);
}
if (secretHits.length > 0) throw new Error(`G11G_SECRET_SCAN_FAILED:${secretHits.join(',')}`);
let dockerCleanup = { available: false, containers: [], networks: [], volumes: [] };
try {
  dockerCleanup = {
    available: true,
    containers: run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=passhub-g11']).split('\n').filter(Boolean),
    networks: run('docker', ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=passhub-g11']).split('\n').filter(Boolean),
    volumes: run('docker', ['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=passhub-g11']).split('\n').filter(Boolean),
  };
} catch { /* Docker is optional for this aggregation check; prior runtime evidence is authoritative. */ }
if (dockerCleanup.containers.length || dockerCleanup.networks.length || dockerCleanup.volumes.length) throw new Error('G11G_DOCKER_CLEANUP_FAILED');
const manifest = {
  gate: 'G11g', status: 'PASS', evidenceFiles: required, sourceCommit: run('git', ['rev-parse', 'HEAD']),
  sourceDirty: run('git', ['status', '--porcelain=1', '--untracked-files=all']).length !== 0,
  sourceSha256: sourceHash.digest('hex'), secretScan: { status: 'PASS', files: scanFiles.length, hits: 0 },
  dockerCleanup, checks: checks.map(({ name }) => name), limitations: ['G11f policy-only fault observations remain policy scope; no public HTTPS release claim'],
};
if (manifest.sourceDirty) throw new Error('G11G_SOURCE_DIRTY');
process.stdout.write(`${JSON.stringify(manifest)}\n`);
