import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const selected = [
  'src/composition/internal/admission-resource-ledger.ts',
  'src/composition/internal/admission-work-handoff.ts',
  'src/composition/internal/fixed-minute-rate-ledger.ts',
  'src/composition/internal/g07b-admission-handler.ts',
  'src/composition/internal/http-response-owner.ts',
  'src/composition/internal/http-response-plan.ts',
  'src/composition/internal/unknown-recognition-coordinator.ts',
  'src/shared/internal/http/business-route-classifier.ts',
];
const violations = []; let edges = 0;
const importsOf = (source) => [...source.matchAll(/(?:from|import)\s*(?:type\s*)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gu)].map((m) => m[1]);
for (const relative of selected) {
  const source = await readFile(path.join(root, relative), 'utf8');
  for (const specifier of importsOf(source)) {
    edges += 1;
    if (/(?:g05b|budget-ledger|\/auth\/|\/sources\/|mongo|event-repository|access-composition)/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (forbidden formal G05b/G06/Auth/Access/Event/Mongo import)`);
    }
    if (relative.endsWith('g07b-admission-handler.ts') && specifier.includes('/access/')
      && !/(?:write-operation-coordinator|operation-registry)\.js$/u.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (only G05a/G05c internal primitives are permitted)`);
    }
  }
}
const publicText = `${await readFile(path.join(root, 'src/index.ts'), 'utf8')}\n${await readFile(path.join(root, 'src/composition/index.ts'), 'utf8')}`;
const internalSymbols = ['createG07bAdmissionHandler', 'createAdmissionResourceLedger', 'createFixedMinuteRateLedger',
  'createHttpResponseOwner', 'createHttpResponsePlanBundle', 'createUnknownRecognitionCoordinatorBundle',
  'createAdmissionWorkHandoffBundle', 'classifyBusinessRoute'];
let publicLeaks = 0;
for (const symbol of internalSymbols) if (publicText.includes(symbol)) { publicLeaks += 1; violations.push(`public surface leaks ${symbol}`); }
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(manifest.exports ?? {}).some((key) => /internal|g07b|admission/iu.test(key))) violations.push('package exports an internal/G07b subpath');
async function walk(dir) { const out = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) out.push(...await walk(file)); else if (entry.isFile() && file.endsWith('.ts')) out.push(file); } return out; }
const all = await walk(path.join(root, 'src'));
const serverOwners = [];
for (const file of all) if (/\bcreateServer\s*\(/u.test(await readFile(file, 'utf8'))) serverOwners.push(path.relative(root, file));
if (serverOwners.length !== 1 || serverOwners[0] !== 'src/composition/internal/http-application.ts') violations.push(`single server violated: ${serverOwners.join(',')}`);
console.log(`G07b boundary files=${selected.length} edges=${edges} servers=${serverOwners.length} publicLeaks=${publicLeaks} forbidden=${violations.length}`);
for (const violation of violations) console.error(`boundary violation: ${violation}`);
if (selected.length !== 8 || violations.length > 0) process.exitCode = 1;
