import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
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
  return [...source.matchAll(/(?:from|import)\s*(?:type\s*)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gu)]
    .map((match) => match[1]);
}

const strictJson = path.join(root, 'src', 'shared', 'internal', 'http', 'strict-json-object.ts');
const boundedIngress = path.join(root, 'src', 'shared', 'internal', 'http', 'bounded-json-ingress.ts');
const httpIndex = path.join(root, 'src', 'shared', 'internal', 'http', 'index.ts');
const httpComposition = path.join(root, 'src', 'composition', 'internal', 'http-application.ts');
const selected = [strictJson, boundedIngress, httpIndex, httpComposition];
let edges = 0;

for (const file of selected) {
  const relative = path.relative(root, file);
  const source = await readFile(file, 'utf8');
  for (const specifier of importsOf(source)) {
    edges += 1;
    if (/(?:^|[\/_-])(?:auth|access|sources|mongo|mongodb|infrastructure)(?:$|[\/_-])/iu.test(specifier)) {
      violations.push(`${relative} -> ${specifier} (G07a crosses into business/auth/persistence)`);
    }
    if (file !== httpComposition && /@nestjs|@?express/iu.test(specifier)) {
      if (!(file === boundedIngress && specifier === 'express')) {
        violations.push(`${relative} -> ${specifier} (strict/shared ingress owns framework composition)`);
      }
    }
  }
}

const allSourceFiles = await filesUnder(path.join(root, 'src'));
const allSourceEntries = await Promise.all(allSourceFiles.map(async (file) => ({
  file,
  source: await readFile(file, 'utf8'),
})));
const createServerOwners = allSourceEntries.filter(({ source }) => /\bcreateServer\s*\(/u.test(source));
const listenOwners = allSourceEntries.filter(({ source }) => /\.listen\s*\(/u.test(source));
if (createServerOwners.length !== 1 || createServerOwners[0]?.file !== httpComposition) {
  violations.push(`Node HTTP server ownership is not unique: ${createServerOwners.map(({ file }) => path.relative(root, file)).join(', ')}`);
}
if (listenOwners.length !== 0) {
  violations.push(`production starts a server directly: ${listenOwners.map(({ file }) => path.relative(root, file)).join(', ')}`);
}

const compositionSource = await readFile(httpComposition, 'utf8');
if (!/bodyParser:\s*false/u.test(compositionSource) || /rawBody:\s*true/u.test(compositionSource)) {
  violations.push('Nest composition does not exclusively disable its body parser');
}
const useIndex = compositionSource.indexOf('nestApplication.use(ingress.middleware)');
const initIndex = compositionSource.indexOf('await nestApplication.init()');
if (useIndex < 0 || initIndex < 0 || useIndex >= initIndex) {
  violations.push('bounded ingress is not installed before Nest initialization');
}
for (const setting of [
  'server.headersTimeout = HTTP_SERVER_LIMITS.headersTimeoutMs',
  'server.keepAliveTimeout = HTTP_SERVER_LIMITS.keepAliveTimeoutMs',
  'server.keepAliveTimeoutBuffer = HTTP_SERVER_LIMITS.keepAliveTimeoutBufferMs',
  'server.maxConnections = HTTP_SERVER_LIMITS.maxConnections',
]) {
  if (!compositionSource.includes(setting)) violations.push(`missing sole-server limit wiring: ${setting}`);
}

const combinedG07a = (await Promise.all(selected.map((file) => readFile(file, 'utf8')))).join('\n');
const g07bFeatures = [
  ['FIFO coordinator', /WriteOperationCoordinator|write-operation-coordinator/iu],
  ['budget ledger', /BudgetLedger|budget-ledger/iu],
  ['operation registry', /OperationRegistry|operation-registry/iu],
  ['authentication composition', /HumanAuth|SourceAuth|human-auth|source-auth/iu],
  ['business route', /\/auth\/login|\/qualifications|\/events|\/recognition\/attempts/iu],
  ['controller or route decorator', /@Controller\b|@(Get|Post|Patch)\b/iu],
  ['database wiring', /MongoClient|withTransaction|insertOne|updateOne|deleteOne/iu],
  ['rate limiter', /rateLimit|fixedMinute|scryptCapacity|queryDbCapacity/iu],
];
let g07bViolations = 0;
for (const [label, pattern] of g07bFeatures) {
  if (pattern.test(combinedG07a)) {
    g07bViolations += 1;
    violations.push(`G07a contains later-gate ${label}`);
  }
}

const publicFiles = [
  path.join(root, 'src', 'index.ts'),
  path.join(root, 'src', 'composition', 'index.ts'),
];
const publicText = (await Promise.all(publicFiles.map((file) => readFile(file, 'utf8')))).join('\n');
let publicLeaks = 0;
for (const symbol of [
  'createPassHubHttpApplication',
  'createBoundedJsonIngress',
  'parseStrictJsonObject',
  'HTTP_SERVER_LIMITS',
  'INGRESS_LIMITS',
  'AcceptedIngress',
  'BoundedJsonIngress',
]) {
  if (publicText.includes(symbol)) {
    publicLeaks += 1;
    violations.push(`public surface leaks internal G07a symbol ${symbol}`);
  }
}
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(manifest.exports ?? {}).some((entry) => /http|internal/iu.test(entry))) {
  publicLeaks += 1;
  violations.push('package.json exposes HTTP/internal implementation subpath');
}

for (const { file, source } of allSourceEntries) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|mongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s@]+@/u.test(source)) {
    violations.push(`${path.relative(root, file)} contains a probable real secret`);
  }
}

console.log(
  `G07a boundary files=${selected.length} edges=${edges} createServers=${createServerOwners.length} directListens=${listenOwners.length} g07b=${g07bViolations} publicLeaks=${publicLeaks} forbidden=${violations.length}`,
);
for (const violation of violations) console.error(`boundary violation: ${violation}`);
if (selected.length !== 4 || violations.length > 0) process.exitCode = 1;
