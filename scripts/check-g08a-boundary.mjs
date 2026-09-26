import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const selected = [
  'src/access/application/management-errors.ts',
  'src/access/application/management-result-mapper.ts',
  'src/access/application/use-cases.ts',
  'src/access/ports/trusted-operation.ts',
  'src/composition/internal/g08a-management-composition.ts',
];
const violations = [];
let edges = 0;
const importsOf = (source) => [...source.matchAll(/(?:from|import)\s*(?:type\s*)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gu)].map((match) => match[1]);

for (const relative of selected) {
  const source = await readFile(path.join(root, relative), 'utf8');
  for (const specifier of importsOf(source)) {
    edges += 1;
    if (relative.startsWith('src/access/') && /auth|sources|mongodb|infrastructure|composition|nestjs|express|http/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (Access application/ports cannot depend on Auth, transport, or infrastructure)`);
    }
    if (relative.endsWith('g08a-management-composition.ts') && /sources|source-auth|recognition.*composition/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (management composition cannot depend on Source auth/recognition composition)`);
    }
  }
}

const publicText = `${await readFile(path.join(root, 'src/index.ts'), 'utf8')}\n${await readFile(path.join(root, 'src/composition/index.ts'), 'utf8')}`;
const internalSymbols = [
  'createG08aManagementComposition', 'readManagementPersistenceEnvelope',
  'registerManagementPersistenceEnvelope', 'createManagementChangePlan',
  'G04bManagementResult', 'G04bMongoPersistenceAdapter',
];
let publicLeaks = 0;
for (const symbol of internalSymbols) {
  if (publicText.includes(symbol)) {
    publicLeaks += 1;
    violations.push(`public surface leaks ${symbol}`);
  }
}
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(manifest.exports ?? {}).some((key) => /g08a|management|internal|mongo/iu.test(key))) {
  violations.push('package exports a G08a/management/internal/Mongo implementation subpath');
}

const applicationText = selected.filter((file) => file.startsWith('src/access/'))
  .map(async (file) => readFile(path.join(root, file), 'utf8'));
const joinedApplication = (await Promise.all(applicationText)).join('\n');
if (/\b(?:withTransaction|insertOne|updateOne|deleteOne|Promise\.all|retry)\b/u.test(joinedApplication)) {
  violations.push('Access management core contains transaction/write/retry/parallel persistence orchestration');
}

console.log(`G08a boundary files=${selected.length} edges=${edges} publicLeaks=${publicLeaks} forbidden=${violations.length}`);
for (const violation of violations) console.error(`boundary violation: ${violation}`);
if (selected.length !== 5 || violations.length > 0) process.exitCode = 1;
