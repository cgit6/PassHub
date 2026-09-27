import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const selected = [
  'src/access/application/internal/writer-quiescence.ts',
  'src/access/application/internal/query-cursor.ts',
  'src/access/application/internal/persisted-event-invariants.ts',
  'src/access/application/query-application.ts',
  'src/access/application/query-errors.ts',
  'src/access/ports/query-ports.ts',
];
const violations = [];
let edges = 0;
const importsOf = (source) => [...source.matchAll(/(?:from|import)\s*(?:type\s*)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gu)].map((match) => match[1]);

for (const relative of selected) {
  const source = await readFile(path.join(root, relative), 'utf8');
  for (const specifier of importsOf(source)) {
    edges += 1;
    if (/auth|sources|mongodb|infrastructure|composition|nestjs|express|http/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (G09a Access query core cannot depend on Auth, transport, composition, or infrastructure)`);
    }
  }
}

const publicText = `${await readFile(path.join(root, 'src/index.ts'), 'utf8')}\n${await readFile(path.join(root, 'src/composition/index.ts'), 'utf8')}`;
const internalSymbols = [
  'createQueryApplication', 'createQueryCursorCodec', 'QueryDataPort',
  'QuerySnapshotQualification', 'QuerySnapshotEvent', 'createWriterQuiescence',
  'ReadObservationLease', 'assertPersistedEventInvariant',
];
let publicLeaks = 0;
for (const symbol of internalSymbols) {
  if (publicText.includes(symbol)) {
    publicLeaks += 1;
    violations.push(`public surface leaks ${symbol}`);
  }
}
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(manifest.exports ?? {}).some((key) => /g09|query|cursor|quiescence|internal/iu.test(key))) {
  violations.push('package exports a G09a/query/cursor/quiescence/internal subpath');
}

const joined = (await Promise.all(selected.map((file) => readFile(path.join(root, file), 'utf8')))).join('\n');
if (/\b(?:withTransaction|insertOne|updateOne|deleteOne|setInterval|setTimeout|retry)\b/u.test(joined)) {
  violations.push('G09a Unit A core contains persistence writes, timer loops, or retries');
}

console.log(`G09a boundary files=${selected.length} edges=${edges} publicLeaks=${publicLeaks} forbidden=${violations.length}`);
for (const violation of violations) console.error(`boundary violation: ${violation}`);
if (selected.length !== 6 || violations.length > 0) process.exitCode = 1;
