import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
if (formalIds.length !== 132 || excludedIds.length !== 11 || duplicateIds.length) {
  throw new Error(`G12C_MATRIX_COUNT_INVALID:formal=${formalIds.length}:excluded=${excludedIds.length}:duplicates=${duplicateIds.join('|')}`);
}

const indexSection = trace.split('### 10.1 ')[1]?.split('### 10.2 ')[0] ?? '';
const mapped = [...indexSection.matchAll(/^\|\s*([A-Z][0-9]{2})\s*\|([^\n]*)$/gmu)].map((match) => ({ id: match[1], gates: match[2] }));
const mappedIds = mapped.map(({ id }) => id);
const missingMappings = allIds.filter((id) => !mappedIds.includes(id));
const extraMappings = mappedIds.filter((id) => !allIds.includes(id));
const duplicateMappings = [...new Set(mappedIds.filter((id, index) => mappedIds.indexOf(id) !== index))];
const mappedGateTokens = mapped.flatMap(({ id, gates }) => gates
  .replace(/（[^）]*）/gu, '')
  .split(/[、|]/u)
  .map((token) => token.trim())
  .filter(Boolean)
  .map((token) => ({ id, token })));
const emptyMappings = mapped.filter(({ id }) => !mappedGateTokens.some((entry) => entry.id === id)).map(({ id }) => id);
const malformedGateTokens = mappedGateTokens
  .filter(({ token }) => !/^G[0-9]{2}[a-z]?(?:-[0-9]+)?$/u.test(token))
  .map(({ id, token }) => `${id}:${token}`);
const invalidG12gSubgates = mappedGateTokens
  .filter(({ token }) => token.startsWith('G12g') && !/^G12g-[0-7]$/u.test(token))
  .map(({ id, token }) => `${id}:${token}`);
const mappedG12gSubgates = new Set(mappedGateTokens
  .map(({ token }) => /^G12g-([0-7])$/u.exec(token)?.[1])
  .filter((value) => value !== undefined));
const missingG12gSubgates = [...Array(8).keys()].map(String).filter((value) => !mappedG12gSubgates.has(value));
if (missingMappings.length || extraMappings.length || duplicateMappings.length || emptyMappings.length
  || malformedGateTokens.length || invalidG12gSubgates.length || missingG12gSubgates.length) {
  throw new Error(`G12C_MAPPING_INVALID:missing=${missingMappings.join('|')}:extra=${extraMappings.join('|')}:duplicates=${duplicateMappings.join('|')}:empty=${emptyMappings.join('|')}:malformed=${malformedGateTokens.join('|')}:invalidG12g=${invalidG12gSubgates.join('|')}:missingG12g=${missingG12gSubgates.join('|')}`);
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
  const artifactPaths = [...evidence.matchAll(/docs\/evidence\/[A-Za-z0-9._/-]+/gu)].map(([path]) => path.replace(/[)`.,；。]+$/u, ''));
  const artifactExists = artifactPaths.length > 0 && artifactPaths.every((path) => existsSync(resolve(root, path)));
  const hasArtifact = artifactExists;
  const hasResult = /\b(?:PASS|通過|已驗|驗證|直接驗|未驗|未閉合|U：|V：|R：|I：)/u.test(evidence);
  let classification = 'STRUCTURAL_ONLY';
  if (hasResult && (status === 'V' || status === 'R') && hasArtifact) classification = 'DIRECT_EVIDENCE';
  else if (hasResult || status !== 'U') classification = 'PARTIAL_EVIDENCE';
  return { id, status, classification, hasAcceptanceScenario, hasGateMapping, artifactPaths, artifactExists, hasArtifact, hasResult };
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
const discuss = readFileSync(resolve(root, 'docs/discuss.md'), 'utf8');
const gatePlanRows = [...plan.matchAll(/^\|\s*(G12g[^|]*)\|\s*([^|]*)\|/gmu)]
  .map((match) => ({ token: match[1]?.trim() ?? '', status: match[2]?.trim() ?? '' }));
const g12hPlanRows = [...plan.matchAll(/^\|\s*(G12h[^|]*)\|\s*([^|]*)\|/gmu)]
  .map((match) => ({ token: match[1]?.trim() ?? '', status: match[2]?.trim() ?? '' }));
const invalidGatePlanTokens = gatePlanRows
  .filter(({ token }, index) => token !== `G12g-${index}`)
  .map(({ token }) => token);
const isPassingSubgate = ({ status }) => /^PASS(?:：|$)/u.test(status);
const firstPendingSubgate = gatePlanRows.findIndex(({ status }) => !/^PASS(?:：|$)/u.test(status));
const terminalG12g = firstPendingSubgate < 0;
const nonContiguousPass = terminalG12g
  ? []
  : gatePlanRows.slice(firstPendingSubgate + 1).filter(isPassingSubgate);
if (gatePlanRows.length !== 8 || invalidGatePlanTokens.length
  || g12hPlanRows.length !== 1 || g12hPlanRows[0]?.token !== 'G12h'
  || (g12hPlanRows[0] !== undefined && isPassingSubgate(g12hPlanRows[0]))
  || (!terminalG12g && (firstPendingSubgate < 1 || firstPendingSubgate > 7))
  || nonContiguousPass.length) {
  throw new Error(`G12C_G12G_GATE_PLAN_INVALID:tokens=${gatePlanRows.map(({ token }) => token).join('|')}:invalid=${invalidGatePlanTokens.join('|')}:firstPending=${firstPendingSubgate}:nonContiguous=${nonContiguousPass.length}:g12h=${g12hPlanRows.map(({ token, status }) => `${token}:${status}`).join('|')}`);
}
const expectedCompletedSubgate = terminalG12g ? '7' : String(firstPendingSubgate - 1);
const expectedNextSubgate = terminalG12g ? null : String(firstPendingSubgate);
const currentStatusRegions = [
  ['business-scope', business],
  ['implementation-plan', plan],
  ['requirements-traceability', traceStatus.split('\n### 10.2 ')[0] ?? ''],
  ['discuss', discuss.split('\n### D01')[0] ?? ''],
];
for (const [name, region] of currentStatusRegions) {
  const statusLines = region.split('\n').filter((line) => line.includes('G12g內部'));
  const allCurrent = statusLines.length > 0 && statusLines.every((statusLine) => {
    const topLevelCurrent = terminalG12g
      ? /頂層\s*已完成\s*G12g\s*[／/]\s*下一合法頂層\s*G12h/u.test(statusLine)
        && !/尚未完成/u.test(statusLine)
      : /G12f[^\n]{0,100}下一[^\n]{0,50}G12g/u.test(statusLine);
    const subgateCurrent = terminalG12g
      ? /G12g內部\s*已完成\s*g-7\s*[／/]\s*無下一子關/u.test(statusLine)
      : (() => {
          const match = /G12g內部[^\n]{0,100}?g-([0-7])[^\n]{0,100}?下一[^\n]{0,50}?g-([0-7])/u.exec(statusLine);
          return match !== null
            && match[1] === expectedCompletedSubgate
            && match[2] === expectedNextSubgate;
        })();
    return topLevelCurrent && subgateCurrent;
  });
  if (!allCurrent || /目前停止於\s*G(?:11g|12b)\b/u.test(region)
    || /下一合法\s*gate\s*(?:為|是)?\s*G12c\b/u.test(region)) {
    throw new Error(`G12C_CURRENT_STOP_INCONSISTENT:${name}`);
  }
}

process.stdout.write(`${JSON.stringify({
  gate: 'G12-requirements-baseline', baseline: 'D207', status: 'PASS',
  completedSubgate: `G12g-${expectedCompletedSubgate}`,
  nextSubgate: expectedNextSubgate === null ? null : `G12g-${expectedNextSubgate}`,
  formalRequirements: formalIds.length,
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
