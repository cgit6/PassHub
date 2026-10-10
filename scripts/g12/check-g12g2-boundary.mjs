import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = process.cwd();
const violations = [];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

const srcFiles = sourceFiles(resolve(root, 'src'));
const allFiles = [...srcFiles, ...sourceFiles(resolve(root, 'test'))];
const engineReference = 'g12g2-mongo-capability-engine';
const facadeReference = 'g12g2-mongo-capability-verification';

const engineImporters = allFiles
  .filter((path) => readFileSync(path, 'utf8').includes(engineReference))
  .map((path) => relative(root, path))
  .sort();
const expectedEngineImporters = [
  'src/deployment/internal/g12g2-mongo-capability-verification.ts',
  'test/support/g12g2-mongo-capability-test-support.ts',
];
if (JSON.stringify(engineImporters) !== JSON.stringify(expectedEngineImporters)) {
  violations.push(`engine importer graph is not closed: ${engineImporters.join(',')}`);
}

const facadeImporters = srcFiles
  .filter((path) => readFileSync(path, 'utf8').includes(facadeReference))
  .map((path) => relative(root, path));
if (facadeImporters.length !== 1 || facadeImporters[0] !== 'src/deployment/production-main.ts') {
  violations.push(`facade importer graph is not closed: ${facadeImporters.join(',')}`);
}

const productionPath = resolve(root, 'src/deployment/production-main.ts');
const production = readFileSync(productionPath, 'utf8');
const calls = production.match(/await verifyProductionMongoCapabilities\(mongo, config\.profile\);/gu) ?? [];
if (calls.length !== 1) violations.push(`production verifier call count must be one, got ${calls.length}`);
const capabilityStage = production.indexOf("startupStage = 'MONGO_CAPABILITY';");
const capabilityCall = production.indexOf('await verifyProductionMongoCapabilities(mongo, config.profile);');
const datasetStage = production.indexOf("startupStage = 'DATASET_COMPOSITION';");
if (!(capabilityStage >= 0 && capabilityStage < capabilityCall && capabilityCall < datasetStage)) {
  violations.push('capability verification is not between connect and dataset composition');
}
if (/\b(?:buildInfo|setName|isWritablePrimary|logicalSessionTimeoutMinutes|hosts)\b/u.test(production)
  || /\.command\(\{\s*hello/u.test(production)) {
  violations.push('production-main contains an inline raw topology check');
}

const application = readFileSync(resolve(root, 'src/deployment/internal/g11b-production-application.ts'), 'utf8');
if (/\.connect\(|ensureSchema\(|assertMongo8032ReplicaSet\(/u.test(application)) {
  violations.push('production application owns a forbidden connection or schema/topology check');
}

const integration = readFileSync(resolve(root, 'test/integration/g12g2-local-capability.test.ts'), 'utf8');
const targetGuard = integration.indexOf('const TARGET = assertG12g2LocalIntegrationTarget(');
const clientConstruction = integration.indexOf('new MongoClient(TARGET.uri');
const ensureSchema = integration.indexOf('await adapter.ensureSchema()');
const clearAndSeed = integration.indexOf('await adapter.clearAndSeed(');
const dropDatabase = integration.indexOf('.dropDatabase()');
if (!(targetGuard >= 0 && targetGuard < clientConstruction && clientConstruction < ensureSchema
  && targetGuard < clearAndSeed && targetGuard < dropDatabase)
  || /G12G2_MONGO_DATABASE[^\n]{0,200}\.slice\(/u.test(integration)) {
  violations.push('destructive Local integration target is not fail-closed before Mongo operations');
}

const runtimeRunner = readFileSync(resolve(root, 'scripts/g12/test-g12g2-local-runtime.mjs'), 'utf8');
if (!runtimeRunner.includes("'run', '--rm', '--name', nodeTestContainerName")
  || !runtimeRunner.includes("process.once('SIGINT', onSigint)")
  || !runtimeRunner.includes("process.once('SIGTERM', onSigterm)")) {
  violations.push('runtime runner lacks named-container or signal cleanup ownership');
}

const engine = readFileSync(resolve(root, 'src/deployment/internal/g12g2-mongo-capability-engine.ts'), 'utf8');
const facade = readFileSync(resolve(root, 'src/deployment/internal/g12g2-mongo-capability-verification.ts'), 'utf8');
for (const [name, text] of [['engine', engine], ['facade', facade]]) {
  if (/\b(?:insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|createIndex|createCollection|dropDatabase|drop\(|rename\()\b/u.test(text)) {
    violations.push(`${name} contains a mutation primitive`);
  }
}
if ((engine.match(/runCommand\(Object\.freeze\(\{ buildInfo: 1 \}\)\)/gu) ?? []).length !== 1
  || (engine.match(/runCommand\(Object\.freeze\(\{ hello: 1 \}\)\)/gu) ?? []).length !== 2) {
  violations.push('engine command whitelist is not exactly one Local buildInfo and two profile hello literals');
}

for (const path of srcFiles) {
  const name = relative(root, path);
  const text = readFileSync(path, 'utf8');
  if (/(?:LOCAL_SELF_HOSTED|ATLAS_MANAGED)/u.test(text) && !name.startsWith('src/deployment/')) {
    violations.push(`${name}: deployment profile leaked outside deployment boundary`);
  }
}

for (const barrel of ['src/index.ts', 'src/composition/index.ts', 'src/infrastructure/mongo/index.ts']) {
  const text = readFileSync(resolve(root, barrel), 'utf8');
  if (/g12g2|MongoCapability/u.test(text)) violations.push(`${barrel}: private verifier is publicly exported`);
}

if (violations.length > 0) {
  for (const violation of violations) process.stderr.write(`G12g-2 boundary violation: ${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    gate: 'G12g-2',
    status: 'PASS',
    engineImporters,
    productionVerifierCalls: calls.length,
    mutationPrimitives: 0,
    publicExports: 0,
  })}\n`);
}
