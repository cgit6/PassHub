import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  G12G3_COMPOSE_TOPOLOGY_CASES,
  G12G3_RAW_COMPOSE_CASES,
  validateG12g3AtlasRawCompose,
  validateG12g3ComposeTopologies,
} from '../../dist/src/deployment/internal/g12g3-compose-topology-contract.js';

const CHECKER_CASES = Object.freeze([
  'G12G3_CONFIG_COMMAND_BOUNDARY',
  'G12G3_CONFIG_SECRET_CANARY',
  'G12G3_NORMALIZED_FORBIDDEN_SURFACE',
  'G12G3_TEMP_CLEANUP',
]);
const EXPECTED_CASES = Object.freeze([
  ...G12G3_COMPOSE_TOPOLOGY_CASES,
  ...G12G3_RAW_COMPOSE_CASES,
  ...CHECKER_CASES,
]);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const localCompose = resolve(repository, 'infra/g11/compose.yml');
const atlasCompose = resolve(repository, 'infra/g11/compose.atlas.yml');
const toolchain = JSON.parse(readFileSync(resolve(repository, 'infra/toolchain-images.json'), 'utf8')).images;
const dummyApiImage = `passhub-g12g3-dummy@sha256:${'a'.repeat(64)}`;
const temporary = mkdtempSync(join(tmpdir(), 'passhub-g12g3-compose-'));
const expectedTemporaryPrefix = join(tmpdir(), 'passhub-g12g3-compose-');
const directories = Object.fromEntries(
  ['tls', 'state', 'runtime', 'dataset', 'secrets'].map((name) => [name, join(temporary, name)]),
);
const secretFiles = Object.fromEntries([
  'local-app-mongo-uri', 'atlas-app-mongo-uri', 'jwt-key', 'comparison-key',
  'mongo-root-username', 'mongo-root-password', 'mongo-keyfile',
].map((name) => [name, join(directories.secrets, name)]));
const canaries = Object.freeze({
  localApp: ['mongodb', '://', 'local-canary:private@example.invalid/passhub_demo'].join(''),
  atlasApp: ['mongodb', '+srv', '://', 'atlas-canary:private@example.invalid/'].join(''),
  jwt: 'g12g3-jwt-secret-content-canary',
  comparison: 'g12g3-comparison-secret-content-canary',
  rootUser: 'g12g3-root-user-content-canary',
  rootPassword: 'g12g3-root-password-content-canary',
  keyfile: 'g12g3-keyfile-content-canary',
});
const environment = {
  ...process.env,
  PASSHUB_API_IMAGE: dummyApiImage,
  PASSHUB_TLS_DIR: directories.tls,
  PASSHUB_STATE_DIR: directories.state,
  PASSHUB_RUNTIME_DIR: directories.runtime,
  PASSHUB_ATLAS_DATASET_DIR: directories.dataset,
  PASSHUB_MONGO_URI_FILE: secretFiles['local-app-mongo-uri'],
  PASSHUB_ATLAS_APP_MONGO_URI_FILE: secretFiles['atlas-app-mongo-uri'],
  PASSHUB_JWT_KEY_FILE: secretFiles['jwt-key'],
  PASSHUB_COMPARISON_KEY_FILE: secretFiles['comparison-key'],
  PASSHUB_MONGO_ROOT_USERNAME_FILE: secretFiles['mongo-root-username'],
  PASSHUB_MONGO_ROOT_PASSWORD_FILE: secretFiles['mongo-root-password'],
  PASSHUB_MONGO_KEYFILE: secretFiles['mongo-keyfile'],
};

class G12g3ComposeCheckError extends Error {
  constructor(code) {
    super(code);
    this.name = 'G12g3ComposeCheckError';
  }
}

function composeConfig(path) {
  const args = ['compose', '-f', path, 'config', '--format', 'json'];
  if (args.includes('--environment') || args.includes('create') || args.includes('up')) {
    throw new G12g3ComposeCheckError('G12G3_CONFIG_COMMAND_BOUNDARY_FAILED');
  }
  const result = spawnSync('docker', args, {
    cwd: repository,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new G12g3ComposeCheckError('G12G3_CONFIG_NORMALIZATION_FAILED');
  }
  const combined = `${result.stdout}${result.stderr}`;
  if (Object.values(canaries).some((canary) => combined.includes(canary))) {
    throw new G12g3ComposeCheckError('G12G3_CONFIG_SECRET_CANARY_FAILED');
  }
  try {
    return { model: JSON.parse(result.stdout), output: combined };
  } catch {
    throw new G12g3ComposeCheckError('G12G3_CONFIG_JSON_FAILED');
  }
}

function assertNormalizedForbiddenSurface(atlas) {
  const wire = JSON.stringify(atlas);
  const forbidden = [
    /mongo_root_(?:username|password)/iu,
    /mongo_keyfile/iu,
    /mongo-data/iu,
    /\/data\/db/iu,
    /maintenance/iu,
    /mongodb(?:\+srv)?:\/\//iu,
  ];
  if (forbidden.some((pattern) => pattern.test(wire))) {
    throw new G12g3ComposeCheckError('G12G3_NORMALIZED_FORBIDDEN_SURFACE_FAILED');
  }
}

let primaryFailure;
let cleanupFailure;
let result;
try {
  for (const directory of Object.values(directories)) mkdirSync(directory, { mode: 0o700 });
  const values = {
    'local-app-mongo-uri': canaries.localApp,
    'atlas-app-mongo-uri': canaries.atlasApp,
    'jwt-key': canaries.jwt,
    'comparison-key': canaries.comparison,
    'mongo-root-username': canaries.rootUser,
    'mongo-root-password': canaries.rootPassword,
    'mongo-keyfile': canaries.keyfile,
  };
  for (const [name, value] of Object.entries(values)) {
    writeFileSync(secretFiles[name], `${value}\n`, { mode: 0o600 });
  }
  writeFileSync(
    join(directories.dataset, 'active-dataset.json'),
    '{"profile":"ATLAS_MANAGED","slot":"BLUE","databaseName":"passhub_demo_blue","datasetEpoch":"11111111-1111-4111-8111-111111111111"}\n',
    { mode: 0o400 },
  );

  const rawCases = validateG12g3AtlasRawCompose(readFileSync(atlasCompose, 'utf8'));
  const local = composeConfig(localCompose);
  const atlas = composeConfig(atlasCompose);
  const topologyCases = validateG12g3ComposeTopologies(local.model, atlas.model, {
    api: dummyApiImage,
    mongo: toolchain.mongo,
    proxy: toolchain.nginx,
  });
  assertNormalizedForbiddenSurface(atlas.model);
  result = {
    gate: 'G12g-3',
    status: 'PASS',
    cases: [
      ...topologyCases,
      ...rawCases,
      'G12G3_CONFIG_COMMAND_BOUNDARY',
      'G12G3_CONFIG_SECRET_CANARY',
      'G12G3_NORMALIZED_FORBIDDEN_SURFACE',
    ],
  };
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    if (!temporary.startsWith(expectedTemporaryPrefix)) {
      throw new G12g3ComposeCheckError('G12G3_TEMP_PATH_UNSAFE');
    }
    rmSync(temporary, { recursive: true, force: true });
    if (existsSync(temporary)) throw new G12g3ComposeCheckError('G12G3_TEMP_CLEANUP_FAILED');
    result?.cases.push('G12G3_TEMP_CLEANUP');
  } catch (error) {
    cleanupFailure = error;
  }
}

if (primaryFailure !== undefined || cleanupFailure !== undefined) {
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure], 'G12g-3 Compose check and cleanup failed');
  }
  throw primaryFailure ?? cleanupFailure;
}
if (result === undefined || result.cases.length !== EXPECTED_CASES.length
  || result.cases.some((value, index) => value !== EXPECTED_CASES[index])) {
  throw new G12g3ComposeCheckError('G12G3_CASE_MANIFEST_INCOMPLETE');
}
process.stdout.write(`${JSON.stringify(result)}\n`);
