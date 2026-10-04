import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const run = (file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8' }).trim();
const evidenceRoot = resolve(root, 'docs/evidence');
const priorGates = ['g02', 'g03a', 'g03b', 'g03c', 'g04a', 'g04b', 'g05a', 'g05b', 'g05c',
  'g06a', 'g06b', 'g07a', 'g07b', 'g08a', 'g08b', 'g09a', 'g09b', 'g10a', 'g10b', 'g10c',
  'g11a', 'g11b', 'g11c', 'g11d', 'g11e', 'g11f', 'g11g'];
const requiredEvidence = priorGates.map((gate) => join('docs/evidence', gate, 'report.md'));
const missing = requiredEvidence.filter((file) => !existsSync(join(root, file)) || readFileSync(join(root, file), 'utf8').trim().length === 0);
if (missing.length) throw new Error(`G12A_EVIDENCE_MISSING:${missing.join(',')}`);
const statuslessReports = requiredEvidence.filter((file) => !/PASS|通過/u.test(readFileSync(join(root, file), 'utf8')));
if (statuslessReports.length) throw new Error(`G12A_EVIDENCE_STATUS_MISSING:${statuslessReports.join(',')}`);
const runtimeStatusFailures = [];
for (const gate of priorGates) {
  const directory = resolve(evidenceRoot, gate);
  if (!existsSync(directory)) continue;
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const value = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if ('status' in value && value.status !== 'PASS') runtimeStatusFailures.push(`${gate}/${file}:${value.status}`);
  }
}
if (runtimeStatusFailures.length) throw new Error(`G12A_RUNTIME_STATUS_INVALID:${runtimeStatusFailures.join(',')}`);

const tracePath = resolve(root, 'docs/requirements-traceability.md');
const trace = readFileSync(tracePath, 'utf8');
const formalMatrix = trace.split('\n## 3. ')[0];
const ids = [...formalMatrix.matchAll(/^\|\s*([A-Z][0-9]{2})\s*\|/gmu)].map((match) => match[1]);
const unique = [...new Set(ids)];
const duplicateIds = unique.filter((id) => ids.filter((candidate) => candidate === id).length > 1);
const excludedSection = trace.split('\n## 4. ')[0];
const excludedIds = [...new Set([...excludedSection.matchAll(/^\|\s*(X[0-9]{2})\s*\|/gmu)].map((match) => match[1]))];
const effectiveIds = unique;
if (unique.length + excludedIds.length !== 136 || effectiveIds.length !== 125 || excludedIds.length !== 11 || duplicateIds.length !== 0) {
  throw new Error(`G12A_REQUIREMENT_MATRIX_INVALID:effective=${effectiveIds.length}:excluded=${excludedIds.length}:duplicates=${duplicateIds.join('|')}`);
}
if (!/G02–G11g已發行各自限定 evidence，目前停止於 G11g/su.test(trace) || !/下一合法 gate 為 G12/su.test(trace)) {
  throw new Error('G12A_TRACEABILITY_STATUS_STALE');
}

const maintenance = JSON.parse(readFileSync(resolve(evidenceRoot, 'g11g/runtime.json'), 'utf8'));
if (maintenance.status !== 'PASS' || maintenance.sourceDirty !== false || maintenance.reviewers?.pm !== 'PASS' || maintenance.reviewers?.architecture !== 'PASS' || maintenance.reviewers?.tester !== 'PASS') {
  throw new Error('G12A_G11G_MANIFEST_INVALID');
}
const status = run('git', ['status', '--porcelain=1', '--untracked-files=all']).split('\n').filter((line) => line.length > 0 && !line.slice(3).startsWith('node_modules')).join('\n');
if (status.length) throw new Error(`G12A_SOURCE_DIRTY:${status}`);
const commit = run('git', ['rev-parse', 'HEAD']);
const hash = createHash('sha256');
for (const file of ['package.json', 'package-lock.json', 'docs/business-scope.md', 'docs/implementation-plan.md', 'docs/requirements-traceability.md']) {
  hash.update(`${file}\0`).update(readFileSync(resolve(root, file))).update('\0');
}
process.stdout.write(`${JSON.stringify({ gate: 'G12a', status: 'PASS', sourceCommit: commit, sourceDirty: false, excludedUserChanges: [],
  requiredEvidence: requiredEvidence.length, requirementIds: unique.length, effectiveRequirementIds: effectiveIds.length,
  excludedRequirementIds: excludedIds.length,
  g11gEvidenceCommit: maintenance.verifiedAtCommit ?? maintenance.sourceCommit,
  docsConfigSha256: hash.digest('hex') })}\n`);
