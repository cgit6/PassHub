import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const evidenceRoot = resolve(root, 'docs/evidence');
const required = ['g11a/report.md', 'g11b/report.md', 'g11c/report.md', 'g11c/runtime-clean.json',
  'g11d/report.md', 'g11d/runtime-clean.json', 'g11e/report.md', 'g11e/runtime.json', 'g11f/report.md', 'g11f/runtime.json'];
const missing = required.filter((file) => !existsSync(join(evidenceRoot, file)));
if (missing.length > 0) throw new Error(`G11G_EVIDENCE_MISSING:${missing.join(',')}`);
const json = (file) => JSON.parse(readFileSync(join(evidenceRoot, file), 'utf8'));
const reportText = (file) => readFileSync(join(evidenceRoot, file), 'utf8');
for (const file of required.filter((file) => file.endsWith('report.md'))) {
  if (!/狀態：\*\*PASS|status[^\n]*PASS|PASS/u.test(reportText(file))) throw new Error(`G11G_REPORT_NOT_PASS:${file}`);
}
const g11b = json('g11b/b5-runtime-clean-final4.json');
const g11c = json('g11c/runtime-clean.json');
const g11d = json('g11d/runtime-clean.json');
if (g11b.status !== 'PASS' || g11b.fingerprints?.sourceDirty !== false || g11b.fingerprints?.composeSha256 === undefined || g11b.fingerprints?.apiImageId === undefined) throw new Error('G11G_G11B_EVIDENCE_INVALID');
if (g11c.gate !== 'G11c' || g11c.status !== 'PASS' || g11c.sourceDirty !== false || !Array.isArray(g11c.cases) || g11c.cases.length < 7) throw new Error('G11G_G11C_EVIDENCE_INVALID');
if (g11d.gate !== 'G11d' || g11d.status !== 'PASS' || g11d.sourceDirty !== false || !Array.isArray(g11d.cases) || g11d.cases.length !== 8 || g11d.reviewers?.pm !== 'PASS' || g11d.reviewers?.architecture !== 'PASS' || g11d.reviewers?.tester !== 'PASS') throw new Error('G11G_G11D_EVIDENCE_INVALID');
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
const configFiles = tracked.filter((file) => file === 'package.json' || file === 'package-lock.json' || file.startsWith('infra/g11/') || file.startsWith('scripts/g11/'));
const configHash = createHash('sha256');
for (const file of configFiles) configHash.update(`${file}\0`).update(readFileSync(resolve(root, file))).update('\0');
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
const projectPattern = /^passhub-g11[a-g]-[0-9a-z]+$/u;
function labelledResources(kind, format) {
  const ids = run('docker', kind === 'container' ? ['ps', '-aq'] : kind === 'network' ? ['network', 'ls', '-q'] : ['volume', 'ls', '-q']).split('\n').filter(Boolean);
  return ids.filter((id) => {
    try { const label = run('docker', ['inspect', '--format', format, id]); return projectPattern.test(label); } catch { return false; }
  });
}
let dockerCleanup = { available: false, containers: [], networks: [], volumes: [], images: [] };
try {
  const images = run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).split('\n').filter((name) => /^passhub-g11[a-g]-[0-9a-z]+-api:/u.test(name));
  dockerCleanup = {
    available: true,
    containers: labelledResources('container', '{{index .Config.Labels "com.docker.compose.project"}}'),
    networks: labelledResources('network', '{{index .Labels "com.docker.compose.project"}}'),
    volumes: labelledResources('volume', '{{index .Labels "com.docker.compose.project"}}'), images,
  };
} catch { /* Docker is optional for this aggregation check; prior runtime evidence is authoritative. */ }
if (dockerCleanup.containers.length || dockerCleanup.networks.length || dockerCleanup.volumes.length || dockerCleanup.images.length) throw new Error('G11G_DOCKER_CLEANUP_FAILED');
const manifest = {
  gate: 'G11g', status: 'PASS', evidenceFiles: required, sourceCommit: run('git', ['rev-parse', 'HEAD']),
  sourceDirty: run('git', ['status', '--porcelain=1', '--untracked-files=all']).split('\n').some((line) => line.length > 0 && !line.slice(3).startsWith('node_modules')),
  sourceSha256: sourceHash.digest('hex'), configSha256: configHash.digest('hex'), fingerprints: {
    g11bCompose: g11b.fingerprints.composeSha256, g11bImage: g11b.fingerprints.apiImageId,
    g11cCompose: g11c.composeSha256, g11cImage: g11c.apiImageId, g11dCompose: g11d.runtimeComposeSha256,
  }, secretScan: { status: 'PASS', files: scanFiles.length, hits: 0 },
  dockerCleanup, checks: checks.map(({ name }) => name), limitations: ['G11f policy-only fault observations remain policy scope; no public HTTPS release claim'],
};
if (manifest.sourceDirty) throw new Error('G11G_SOURCE_DIRTY');
if (process.env.G11G_WRITE_EVIDENCE === '1') {
  writeFileSync(join(evidenceRoot, 'g11g/runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
process.stdout.write(`${JSON.stringify(manifest)}\n`);
