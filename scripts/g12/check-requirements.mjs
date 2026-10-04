import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const tracePath = resolve(root, 'docs/requirements-traceability.md');
const trace = readFileSync(tracePath, 'utf8');

// The formal matrix is the part before the historical/detail sections.  Keep
// this parser deliberately narrow so a historical table cannot silently add a
// second requirement with the same ID.
const formalMatrix = trace.split('\n## 3. ')[0];
const formalIds = [...formalMatrix.matchAll(/^\|\s*([A-Z][0-9]{2})\s*\|/gmu)].map((match) => match[1]);
const excludedSection = trace.split('\n## 4. ')[0];
const excludedIds = [...new Set([...excludedSection.matchAll(/^\|\s*(X[0-9]{2})\s*\|/gmu)].map((match) => match[1]))];
const allIds = [...formalIds, ...excludedIds];
const duplicateIds = [...new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index))];
if (formalIds.length !== 125 || excludedIds.length !== 11 || duplicateIds.length) {
  throw new Error(`G12C_MATRIX_COUNT_INVALID:formal=${formalIds.length}:excluded=${excludedIds.length}:duplicates=${duplicateIds.join('|')}`);
}

const indexSection = trace.split('### 10.1 ')[1]?.split('### 10.2 ')[0] ?? '';
const mapped = [...indexSection.matchAll(/^\|\s*([A-Z][0-9]{2})\s*\|([^\n]*)$/gmu)].map((match) => ({ id: match[1], gates: match[2] }));
const mappedIds = mapped.map(({ id }) => id);
const missingMappings = allIds.filter((id) => !mappedIds.includes(id));
const extraMappings = mappedIds.filter((id) => !allIds.includes(id));
const duplicateMappings = [...new Set(mappedIds.filter((id, index) => mappedIds.indexOf(id) !== index))];
const emptyMappings = mapped.filter(({ gates }) => !/G\d{2}[a-z]?/u.test(gates)).map(({ id }) => id);
if (missingMappings.length || extraMappings.length || duplicateMappings.length || emptyMappings.length) {
  throw new Error(`G12C_MAPPING_INVALID:missing=${missingMappings.join('|')}:extra=${extraMappings.join('|')}:duplicates=${duplicateMappings.join('|')}:empty=${emptyMappings.join('|')}`);
}

const rows = [...formalMatrix.matchAll(/^\|\s*([A-Z][0-9]{2})\s*\|([^\n]*)$/gmu)];
const evidenceColumnFailures = rows.filter(([, id, rest]) => !/\b(?:U|I|V|R)(?:\s*(?:：|:|\||$))/u.test(rest)).map(([, id]) => id);
if (evidenceColumnFailures.length) throw new Error(`G12C_EVIDENCE_COLUMN_INVALID:${evidenceColumnFailures.join('|')}`);
const audit = rows.map(([, id, rest]) => {
  const columns = rest.split('|').map((value) => value.trim()).filter(Boolean);
  const evidence = columns.at(-1) ?? '';
  const status = /^(U|I|V|R)(?:：|:|\s|$)/u.exec(evidence)?.[1] ?? 'U';
  const hasAcceptanceScenario = rest.includes(`T-${id}`);
  const hasGateMapping = mapped.some((entry) => entry.id === id);
  const hasArtifact = /docs\/evidence\/[A-Za-z0-9._/-]+/u.test(evidence);
  const hasResult = /\b(?:PASS|通過|已驗|驗證|直接驗|未驗|未閉合|U：|V：|R：|I：)/u.test(evidence);
  let classification = 'STRUCTURAL_ONLY';
  if (hasResult && (status === 'V' || status === 'R') && hasArtifact) classification = 'DIRECT_EVIDENCE';
  else if (hasResult || status !== 'U') classification = 'PARTIAL_EVIDENCE';
  return { id, status, classification, hasAcceptanceScenario, hasGateMapping, hasArtifact, hasResult };
});
if (audit.some((entry) => !entry.hasAcceptanceScenario || !entry.hasGateMapping)) {
  throw new Error(`G12C_AUDIT_ROW_INVALID:${audit.filter((entry) => !entry.hasAcceptanceScenario || !entry.hasGateMapping).map((entry) => entry.id).join('|')}`);
}
const excludedAudit = excludedIds.map((id) => ({ id, classification: 'EXCLUDED' }));

const boundaryChecks = [
  ['g03c', 'scripts/check-g03c-boundary.mjs'],
  ['g06a', 'scripts/check-g06a-boundary.mjs'],
  ['g06b', 'scripts/check-g06b-boundary.mjs'],
  ['g08a', 'scripts/check-g08a-boundary.mjs'],
  ['g08b', 'scripts/check-g08b-boundary.mjs'],
  ['g09a', 'scripts/check-g09a-boundary.mjs'],
  ['g10', 'scripts/check-g10-fault-topology.mjs'],
  ['g11a', 'scripts/g11/check-g11a-topology.mjs'],
  ['g11e', 'scripts/g11/check-g11e-contract.mjs'],
];
const checks = [];
const scriptFingerprint = (script) => createHash('sha256').update(readFileSync(resolve(root, script))).digest('hex');
for (const [name, script] of boundaryChecks) {
  const output = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' }).trim();
  checks.push({ name, script, sha256: scriptFingerprint(script), exitCode: 0, output });
}

// G07a/G07b predate the G11 private control socket and production lifecycle.
// They must remain visibly classified as stale rather than silently treated
// as current boundary evidence.
const legacyBoundaryChecks = [];
for (const [name, script] of [['g07a-legacy', 'scripts/check-g07a-boundary.mjs'], ['g07b-legacy', 'scripts/check-g07b-boundary.mjs']]) {
  let failed = false;
  let output = '';
  try {
    output = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    failed = true;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
  }
  const expected = name === 'g07a-legacy'
    ? ['Node HTTP server ownership is not unique', 'unexpected non-HTTP server owner', 'production starts a server directly outside private control adapter']
    : ['only G05a/G05c internal primitives are permitted', 'single HTTP server violated', 'unexpected server owner'];
  if (!failed || expected.some((marker) => !output.includes(marker)) || (output.match(/boundary violation:/gu) ?? []).length !== expected.length) {
    throw new Error(`G12C_LEGACY_BOUNDARY_CLASSIFICATION_INVALID:${name}`);
  }
  legacyBoundaryChecks.push({ name, script, sha256: scriptFingerprint(script), exitCode: 1, status: 'STALE_LEGACY_TOPOLOGY', reason: 'G11 private control socket and production lifecycle are outside G07 scope', output });
}

const business = readFileSync(resolve(root, 'docs/business-scope.md'), 'utf8');
const plan = readFileSync(resolve(root, 'docs/implementation-plan.md'), 'utf8');
const traceStatus = readFileSync(tracePath, 'utf8');
for (const [name, text] of [['business-scope', business], ['implementation-plan', plan], ['requirements-traceability', traceStatus]]) {
  if (!/G12c/u.test(text) || !/G12d/u.test(text) || /目前停止於\s*G(?:11g|12b)\b/u.test(text) || /下一合法\s*gate\s*(?:為|是)?\s*G12c\b/u.test(text)) {
    throw new Error(`G12C_CURRENT_STOP_INCONSISTENT:${name}`);
  }
}
if (!/當前停止點：G12c[\s\S]*下一合法 gate 為 G12d/u.test(traceStatus)) {
  throw new Error('G12C_TRACE_STATUS_NOT_CANONICAL');
}

process.stdout.write(`${JSON.stringify({
  gate: 'G12c', status: 'PASS', formalRequirements: formalIds.length,
  excludedRequirements: excludedIds.length, totalRequirements: allIds.length,
  traceabilityMappings: mapped.length, evidenceColumnsChecked: rows.length,
  auditSummary: {
    directEvidence: audit.filter(({ classification }) => classification === 'DIRECT_EVIDENCE').length,
    partialEvidence: audit.filter(({ classification }) => classification === 'PARTIAL_EVIDENCE').length,
    structuralOnly: audit.filter(({ classification }) => classification === 'STRUCTURAL_ONLY').length,
    excluded: excludedAudit.length,
  },
  audit,
  boundaryChecks: checks,
  legacyBoundaryChecks,
})}\n`);
