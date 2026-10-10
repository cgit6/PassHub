import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = process.cwd();
const srcRoot = resolve(root, 'src');
const violations = [];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(srcRoot);
for (const path of files) {
  const name = relative(root, path);
  const text = readFileSync(path, 'utf8');
  if (/\bNODE_ENV\b/u.test(text)) violations.push(`${name}: NODE_ENV deployment selection is forbidden`);
  if (/(?:LOCAL_SELF_HOSTED|ATLAS_MANAGED)/u.test(text) && !name.startsWith('src/deployment/')) {
    violations.push(`${name}: deployment profile leaked outside deployment boundary`);
  }
  if (/test\/support|\.\.\/\.\.\/test/u.test(text)) violations.push(`${name}: production imports test support`);
}

const profilePath = resolve(root, 'src/deployment/internal/g12g1-deployment-profile.ts');
const profile = readFileSync(profilePath, 'utf8');
const descriptor = readFileSync(resolve(root, 'src/deployment/internal/g12g1-dataset-descriptor-intake.ts'), 'utf8');
const production = readFileSync(resolve(root, 'src/deployment/production-main.ts'), 'utf8');
const application = readFileSync(resolve(root, 'src/deployment/internal/g11b-production-application.ts'), 'utf8');
const compose = readFileSync(resolve(root, 'infra/g11/compose.yml'), 'utf8');

if (!profile.includes("export type DeploymentProfile = 'LOCAL_SELF_HOSTED' | 'ATLAS_MANAGED'")) {
  violations.push('typed deployment profile is not exact');
}
if (!profile.includes("databaseName: 'passhub_demo'") || !profile.includes('expectedDatasetEpoch: null')) {
  violations.push('Local dataset target is not fixed');
}
if (!profile.includes("throw new DeploymentProfileConfigError('DEPLOYMENT_PROFILE_PROBE_FORBIDDEN')")) {
  violations.push('Atlas probe mode is not rejected');
}
if (!descriptor.includes("export const G12G1_DATASET_DESCRIPTOR_DIRECTORY = '/run/passhub/dataset'")) {
  violations.push('descriptor production directory is not fixed');
}
if (!descriptor.includes('/active-dataset.json') || /process\.env|PASSHUB_[A-Z_]*DESCRIPTOR/u.test(descriptor)) {
  violations.push('descriptor production path is configurable or missing');
}
if (!production.includes("parseDeploymentProfile(process.env.PASSHUB_DEPLOYMENT_PROFILE)")) {
  violations.push('production profile intake is missing');
}
if (!production.includes('config.datasetTarget') || !application.includes('datasetTarget.databaseName')) {
  violations.push('validated dataset target is not injected into production composition');
}
if (application.includes("G04bMongoPersistenceAdapter(mongo, 'passhub_demo'")) {
  violations.push('production application still hard-codes the Local database');
}
const profileComposeLines = compose.match(/^\s+PASSHUB_DEPLOYMENT_PROFILE:\s+LOCAL_SELF_HOSTED\s*$/gmu) ?? [];
if (profileComposeLines.length !== 1) violations.push('Local Compose must declare exactly one LOCAL_SELF_HOSTED profile');
if (/\/run\/passhub\/dataset|active-dataset\.json/u.test(compose)) {
  violations.push('Local Compose must not mount the Atlas dataset descriptor');
}

if (violations.length > 0) {
  for (const violation of violations) process.stderr.write(`G12g-1 boundary violation: ${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    gate: 'G12g-1',
    status: 'PASS',
    sourceFiles: files.length,
    profileLiteralsOutsideDeployment: 0,
    nodeEnvSelectors: 0,
    configurableDescriptorPaths: 0,
  })}\n`);
}
