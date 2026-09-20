import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const authRoot = path.join(root, 'src', 'auth');
const violations = [];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(fullPath));
    else if (entry.isFile() && fullPath.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

function importsOf(source) {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]);
}

const files = await filesUnder(authRoot);
let edges = 0;
for (const file of files) {
  const relative = path.relative(root, file);
  const source = await readFile(file, 'utf8');
  for (const specifier of importsOf(source)) {
    edges += 1;
    const isCore = /src[\/]auth[\/](?:application|domain|ports)[\/]/u.test(file);
    const forbidden = isCore
      ? /(?:^|[\/_-])(?:access|sources|mongo|mongodb|http|nestjs|express)(?:$|[\/_-])/iu
      : /(?:^|[\/_-])(?:access|sources|http|nestjs|express)(?:$|[\/_-])/iu;
    if (forbidden.test(specifier)) violations.push(`${relative} -> ${specifier}`);
  }
  if (/src[\/]auth[\/](?:application|domain|ports)[\/]/u.test(file)
      && /\b(?:transaction|insertOne|updateOne|deleteOne|withTransaction|retry)\b|Promise\.all/u.test(source)) {
    violations.push(`${relative} contains forbidden write/retry/parallel orchestration`);
  }
}

const rootIndex = await readFile(path.join(root, 'src', 'index.ts'), 'utf8');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const symbol of ['createHumanAuth', 'HumanAuthDependencies', 'NodeScryptPasswordDeriver',
  'MongoHumanAccountReader', 'AccountRecord', 'jwtKey', 'issueHumanPrincipal']) {
  if (rootIndex.includes(symbol)) violations.push(`src/index.ts leaks ${symbol}`);
}
if (Object.keys(manifest.exports ?? {}).some((entry) => /auth/iu.test(entry))) {
  violations.push('package.json exposes an auth implementation subpath');
}

const forbiddenFeatures = /\b(?:register|refresh|logout|resetPassword|admin)\s*\(|credentialAlias|sourceActive|\bdirection\s*:/iu;
for (const file of files.filter((entry) => !entry.includes(`${path.sep}infrastructure${path.sep}`))) {
  const source = await readFile(file, 'utf8');
  if (forbiddenFeatures.test(source)) violations.push(`${path.relative(root, file)} contains excluded lifecycle/source feature`);
}

const tracked = await filesUnder(path.join(root, 'src'));
for (const file of tracked) {
  const source = await readFile(file, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|mongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s@]+@/u.test(source)) {
    violations.push(`${path.relative(root, file)} contains a probable real secret`);
  }
}

console.log(`G06a boundary files=${files.length} edges=${edges} forbidden=${violations.length}`);
for (const violation of violations) console.error(`boundary violation: ${violation}`);
if (files.length === 0 || violations.length > 0) process.exitCode = 1;
