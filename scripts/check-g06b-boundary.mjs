import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const violations = [];
let edges = 0;

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

const sourceFiles = await filesUnder(path.join(root, 'src', 'sources'));
const authCoreFiles = (await filesUnder(path.join(root, 'src', 'auth')))
  .filter((file) => !file.includes(`${path.sep}infrastructure${path.sep}`));
const accessFiles = await filesUnder(path.join(root, 'src', 'access'));
const selected = [...sourceFiles, ...authCoreFiles, ...accessFiles];

for (const file of selected) {
  const relative = path.relative(root, file);
  const source = await readFile(file, 'utf8');
  for (const specifier of importsOf(source)) {
    edges += 1;
    if (file.includes(`${path.sep}sources${path.sep}`) && /(?:^|[\/_-])auth(?:$|[\/_-])/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (Sources imports Auth)`);
    }
    if (file.includes(`${path.sep}auth${path.sep}`)
        && /(?:^|[\/_-])(?:access|sources|mongo|mongodb)(?:$|[\/_-])/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (Auth core crosses boundary)`);
    }
    if (file.includes(`${path.sep}access${path.sep}`)
        && /(?:^|[\/_-])auth(?:$|[\/_-])/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (Access imports Auth)`);
    }
  }
  if (file.includes(`${path.sep}auth${path.sep}`) && /\bSourceFacts\b/u.test(source)) {
    violations.push(`${relative} imports or defines forbidden shared SourceFacts`);
  }
  if (file.includes(`${path.sep}access${path.sep}`) && /credential(?:Alias|Digest|Verifier|Verification)|SourceAuth/iu.test(source)) {
    violations.push(`${relative} obtains credential/auth capability`);
  }
}

const publicFiles = [
  path.join(root, 'src', 'index.ts'),
  path.join(root, 'src', 'composition', 'index.ts'),
  path.join(root, 'src', 'auth', 'index.ts'),
];
const publicText = (await Promise.all(publicFiles.map((file) => readFile(file, 'utf8')))).join('\n');
for (const symbol of [
  'createSourceAuth', 'createSourceAuthComposition', 'createSourceCredentialVerifier',
  'MongoSourceCredentialReader', 'SourceCredentialRecordReaderPort',
  'SourceCredentialVerifierPort', 'SourcePrincipal', 'credentialDigest',
]) {
  if (publicText.includes(symbol)) violations.push(`public surface leaks ${symbol}`);
}

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(manifest.exports ?? {}).some((entry) => /(?:auth|sources|internal)/iu.test(entry))) {
  violations.push('package.json exposes Auth, Sources, or internal implementation subpath');
}

const verifierSource = await readFile(path.join(root, 'src', 'sources', 'application', 'source-credential-verifier.ts'), 'utf8');
if (!/createHash\('sha256'\)/u.test(verifierSource)) violations.push('verifier does not pin SHA-256');
if (!/timingSafeEqual\(actualDigest, expectedDigest\)/u.test(verifierSource)) violations.push('verifier does not use timingSafeEqual');
if (/credentialDigest\s*(?:===|==)|\.equals\(/u.test(verifierSource)) violations.push('verifier compares digest as string or with Buffer.equals');

const g06bFiles = [
  path.join(root, 'src', 'auth', 'application', 'source-auth.ts'),
  path.join(root, 'src', 'auth', 'domain', 'source-auth-error.ts'),
  path.join(root, 'src', 'auth', 'domain', 'source-principal.ts'),
  path.join(root, 'src', 'auth', 'ports', 'source-credential-verifier-port.ts'),
  ...sourceFiles,
  path.join(root, 'src', 'composition', 'internal', 'source-auth-composition.ts'),
];
const excluded = /@nestjs|express|(?:^|\W)http|controller|route|admin|CRUD|rotate|rotation|G07|G08|insertOne|updateOne|deleteOne|withTransaction/iu;
for (const file of g06bFiles) {
  const source = await readFile(file, 'utf8');
  if (excluded.test(source)) violations.push(`${path.relative(root, file)} contains excluded G06b feature`);
}

const allSource = await filesUnder(path.join(root, 'src'));
for (const file of allSource) {
  const source = await readFile(file, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|mongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s@]+@/u.test(source)) {
    violations.push(`${path.relative(root, file)} contains a probable real secret`);
  }
}

console.log(`G06b boundary files=${selected.length} edges=${edges} forbidden=${violations.length}`);
for (const violation of violations) console.error(`boundary violation: ${violation}`);
if (selected.length === 0 || violations.length > 0) process.exitCode = 1;
