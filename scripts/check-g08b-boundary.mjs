import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const selected = [
  'src/access/application/recognition-result-mapper.ts',
  'src/access/application/internal/recognition-execution.ts',
  'src/composition/internal/g08b-recognition-composition.ts',
  'src/composition/internal/g07b-route-composition.ts',
  'src/composition/internal/source-bound-recognition.ts',
  'src/composition/internal/recognition-event-invariants.ts',
  'src/composition/internal/unknown-recognition-recovery.ts',
];
const violations = [];
let edges = 0;
const importsOf = (source) => [...source.matchAll(/(?:from|import)\s*(?:type\s*)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gu)].map((match) => match[1]);

for (const relative of selected) {
  const source = await readFile(path.join(root, relative), 'utf8');
  for (const specifier of importsOf(source)) {
    edges += 1;
    if (relative.startsWith('src/access/') && /auth|sources|mongodb|infrastructure|composition|nestjs|express|http/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (Access recognition core cannot depend on Auth, transport, or infrastructure)`);
    }
    if (relative.endsWith('g08b-recognition-composition.ts') && /g09|g10|g11|timer|scheduler|control/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (G08b cannot own later-gate control/timer dependencies)`);
    }
  }
}

const publicText = `${await readFile(path.join(root, 'src/index.ts'), 'utf8')}\n${await readFile(path.join(root, 'src/composition/index.ts'), 'utf8')}`;
const internalSymbols = [
  'createG08bRecognitionComposition', 'createSourceBoundRecognitionExecutorFactory',
  'createSourceBoundRecognitionExecutorForPrincipal', 'RecognitionPersistenceResult',
  'RecognitionPersistenceErrorFacts', 'UnknownRecognitionRecoveryToken',
  'issueUnknownRecognitionRecoveryToken', 'ComparisonArtifact', 'SourceBoundRecognitionBinding',
];
let publicLeaks = 0;
for (const symbol of internalSymbols) {
  if (publicText.includes(symbol)) {
    publicLeaks += 1;
    violations.push(`public surface leaks ${symbol}`);
  }
}
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(manifest.exports ?? {}).some((key) => /g08b|recognition|internal|mongo|recovery/iu.test(key))) {
  violations.push('package exports a G08b/recognition/internal/Mongo/recovery subpath');
}

const joined = (await Promise.all(selected.map((file) => readFile(path.join(root, file), 'utf8')))).join('\n');
if (/\b(?:withTransaction|insertOne|updateOne|deleteOne|Promise\.all|setInterval|setTimeout)\b/u.test(joined)) {
  violations.push('G08b application/composition contains transaction writes, parallel persistence, retry timers, or control loops');
}

console.log(`G08b boundary files=${selected.length} edges=${edges} publicLeaks=${publicLeaks} forbidden=${violations.length}`);
for (const violation of violations) console.error(`boundary violation: ${violation}`);
if (selected.length !== 7 || violations.length > 0) process.exitCode = 1;
