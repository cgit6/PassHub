import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, normalize, relative } from 'node:path';

import {
  isG11aDangerousHostMountSource,
  validateG11aTopology,
  type G11aExpectedImages,
} from './g11a-topology-contract.js';

export const G12G3_COMPOSE_TOPOLOGY_CASES = Object.freeze([
  'G12G3_LOCAL_BASELINE',
  'G12G3_PROJECT_IDENTITY',
  'G12G3_ATLAS_SERVICES',
  'G12G3_ATLAS_NETWORKS',
  'G12G3_ATLAS_NO_VOLUMES',
  'G12G3_ATLAS_SECRETS',
  'G12G3_SOURCE_ISOLATION',
  'G12G3_ATLAS_URI_BOUNDARY',
  'G12G3_ATLAS_API_RUNTIME',
  'G12G3_ATLAS_API_MOUNTS',
  'G12G3_PROXY_PARITY',
  'G12G3_API_PARITY',
] as const);

export const G12G3_RAW_COMPOSE_CASES = Object.freeze([
  'G12G3_RAW_SECRET_REFERENCE',
  'G12G3_RAW_DESCRIPTOR_MOUNT',
  'G12G3_RAW_FORBIDDEN_TOPOLOGY',
  'G12G3_RAW_URI_BOUNDARY',
] as const);

export type G12g3ComposeTopologyCase =
  | (typeof G12G3_COMPOSE_TOPOLOGY_CASES)[number]
  | (typeof G12G3_RAW_COMPOSE_CASES)[number];

export class G12g3ComposeTopologyContractError extends Error {
  constructor(readonly caseId: G12g3ComposeTopologyCase, message: string) {
    super(`${caseId}: ${message}`);
    this.name = 'G12g3ComposeTopologyContractError';
  }
}

type UnknownRecord = Record<string, unknown>;

interface RawYamlBlock {
  readonly start: number;
  readonly end: number;
}

function fail(caseId: G12g3ComposeTopologyCase, message: string): never {
  throw new G12g3ComposeTopologyContractError(caseId, message);
}

function record(value: unknown, caseId: G12g3ComposeTopologyCase, message: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(caseId, message);
  return value as UnknownRecord;
}

function array(value: unknown, caseId: G12g3ComposeTopologyCase, message: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(caseId, message);
  return value;
}

function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  caseId: G12g3ComposeTopologyCase,
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(caseId, `${label} must contain exactly ${wanted.join(', ')}`);
  }
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  caseId: G12g3ComposeTopologyCase,
  message: string,
): void {
  if (actual !== expected) fail(caseId, message);
}

function cloneRecord(value: UnknownRecord): UnknownRecord {
  return JSON.parse(JSON.stringify(value)) as UnknownRecord;
}

function rawIndent(line: string): number | undefined {
  if (line.trim().length === 0) return undefined;
  return line.length - line.trimStart().length;
}

function uniqueRawChildBlock(
  lines: readonly string[],
  parent: RawYamlBlock,
  key: string,
  indent: number,
  caseId: G12g3ComposeTopologyCase,
  message: string,
): RawYamlBlock {
  const header = `${' '.repeat(indent)}${key}:`;
  const starts: number[] = [];
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    if (lines[index] === header) starts.push(index);
  }
  if (starts.length !== 1) fail(caseId, message);
  const start = starts[0] as number;
  let end = parent.end;
  for (let index = start + 1; index < parent.end; index += 1) {
    const indentation = rawIndent(lines[index] as string);
    if (indentation !== undefined && indentation <= indent) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function rawNonBlankLines(lines: readonly string[], block: RawYamlBlock): readonly string[] {
  return lines.slice(block.start, block.end).filter((line) => line.trim().length > 0);
}

function assertRawSecretReference(text: string, lines: readonly string[]): void {
  const caseId = 'G12G3_RAW_SECRET_REFERENCE';
  const root = { start: -1, end: lines.length };
  const secrets = uniqueRawChildBlock(lines, root, 'secrets', 0, caseId, 'top-level secrets block is missing or ambiguous');
  const appSecret = uniqueRawChildBlock(
    lines,
    secrets,
    'app_mongo_uri',
    2,
    caseId,
    'top-level app_mongo_uri secret is missing or ambiguous',
  );
  const expected = [
    '  app_mongo_uri:',
    '    file: ${PASSHUB_ATLAS_APP_MONGO_URI_FILE:?set PASSHUB_ATLAS_APP_MONGO_URI_FILE}',
  ];
  const references = text.match(/\$\{PASSHUB_ATLAS_APP_MONGO_URI_FILE:\?set PASSHUB_ATLAS_APP_MONGO_URI_FILE\}/gu) ?? [];
  if (references.length !== 1 || !isDeepStrictEqual(rawNonBlankLines(lines, appSecret), expected)) {
    fail(caseId, 'Atlas application secret must use the exact top-level external file reference');
  }
}

function assertRawDescriptorMount(text: string, lines: readonly string[]): void {
  const caseId = 'G12G3_RAW_DESCRIPTOR_MOUNT';
  const root = { start: -1, end: lines.length };
  const services = uniqueRawChildBlock(lines, root, 'services', 0, caseId, 'top-level services block is missing or ambiguous');
  const api = uniqueRawChildBlock(lines, services, 'api', 2, caseId, 'services.api block is missing or ambiguous');
  const volumes = uniqueRawChildBlock(lines, api, 'volumes', 4, caseId, 'services.api.volumes block is missing or ambiguous');
  const starts: number[] = [];
  for (let index = volumes.start + 1; index < volumes.end; index += 1) {
    if (/^ {6}- /u.test(lines[index] as string)) starts.push(index);
  }
  const blocks = starts.map((start, index): RawYamlBlock => ({
    start,
    end: starts[index + 1] ?? volumes.end,
  }));
  const descriptors = blocks.filter((block) => rawNonBlankLines(lines, block)
    .includes('        target: /run/passhub/dataset'));
  const expected = [
    '      - type: bind',
    '        source: ${PASSHUB_ATLAS_DATASET_DIR:?set PASSHUB_ATLAS_DATASET_DIR}',
    '        target: /run/passhub/dataset',
    '        read_only: true',
    '        bind:',
    '          create_host_path: false',
  ];
  const references = text.match(/\$\{PASSHUB_ATLAS_DATASET_DIR:\?set PASSHUB_ATLAS_DATASET_DIR\}/gu) ?? [];
  if (references.length !== 1 || descriptors.length !== 1
    || !isDeepStrictEqual(rawNonBlankLines(lines, descriptors[0] as RawYamlBlock), expected)) {
    fail(caseId, 'Atlas descriptor mount must use the exact services.api.volumes contract');
  }
}

function projectIndependentNetwork(value: unknown): UnknownRecord {
  const network = cloneRecord(record(value, 'G12G3_ATLAS_NETWORKS', 'edge network is invalid'));
  delete network.name;
  return network;
}

function assertProjectIdentity(localRoot: UnknownRecord, atlasRoot: UnknownRecord): void {
  const caseId = 'G12G3_PROJECT_IDENTITY';
  assertEqual(localRoot.name, 'passhub-g11', caseId, 'Local Compose project name must be exact');
  assertEqual(
    atlasRoot.name,
    'passhub-g12g3-atlas',
    caseId,
    'Atlas Compose project name must be exact',
  );
  if (localRoot.name === atlasRoot.name) {
    fail(caseId, 'Local and Atlas Compose project names must be distinct');
  }
}

function absoluteHostPath(
  value: unknown,
  caseId: G12g3ComposeTopologyCase,
  label: string,
): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    fail(caseId, `${label} must be an absolute host path`);
  }
  return normalize(value);
}

function hostPathsOverlap(left: string, right: string): boolean {
  const forward = relative(left, right);
  const reverse = relative(right, left);
  return forward === ''
    || (forward !== '..' && !forward.startsWith('../') && !isAbsolute(forward))
    || (reverse !== '..' && !reverse.startsWith('../') && !isAbsolute(reverse));
}

function assertAtlasSecrets(root: UnknownRecord, api: UnknownRecord): ReadonlyMap<string, string> {
  const caseId = 'G12G3_ATLAS_SECRETS';
  const expected = ['app_mongo_uri', 'comparison_key', 'jwt_key'];
  const definitions = record(root.secrets, caseId, 'top-level secrets are missing');
  exactKeys(definitions, expected, caseId, 'top-level secrets');
  const files = new Map<string, string>();
  for (const name of expected) {
    const definition = record(definitions[name], caseId, `${name} secret definition is invalid`);
    if (Object.keys(definition).some((key) => key !== 'file' && key !== 'name')) {
      fail(caseId, `${name} secret definition contains an unsupported field`);
    }
    const file = absoluteHostPath(definition.file, caseId, `${name} secret file`);
    if (isG11aDangerousHostMountSource(file)) {
      fail(caseId, `${name} secret file must not be located in a dangerous host tree`);
    }
    files.set(name, file);
  }

  const mappings = array(api.secrets, caseId, 'API secrets are missing');
  if (mappings.length !== expected.length) fail(caseId, 'API must receive exactly three secrets');
  const targets = new Map<string, string>();
  for (const value of mappings) {
    const mapping = record(value, caseId, 'API secret mapping is invalid');
    exactKeys(mapping, ['source', 'target'], caseId, 'API secret mapping');
    if (typeof mapping.source !== 'string' || typeof mapping.target !== 'string') {
      fail(caseId, 'API secret source and target must be strings');
    }
    targets.set(mapping.source, mapping.target);
  }
  if (targets.size !== expected.length || expected.some((name) => !targets.has(name))) {
    fail(caseId, 'API secret sources are incomplete or expanded');
  }
  assertEqual(
    targets.get('app_mongo_uri'),
    '/run/secrets/app_mongo_uri',
    caseId,
    'application Mongo secret target is not fixed',
  );
  assertEqual(targets.get('jwt_key'), '/run/secrets/jwt_key', caseId, 'JWT secret target is not fixed');
  assertEqual(
    targets.get('comparison_key'),
    '/run/secrets/comparison_key',
    caseId,
    'comparison secret target is not fixed',
  );
  return files;
}

function assertNoMongoUriLiteral(api: UnknownRecord): void {
  const scoped = JSON.stringify({
    environment: api.environment,
    command: api.command,
    labels: api.labels,
  });
  if (/mongodb(?:\+srv)?:\/\//iu.test(scoped)) {
    fail('G12G3_ATLAS_URI_BOUNDARY', 'Mongo URI literals are forbidden in API environment, command, and labels');
  }
}

function assertAtlasRuntime(api: UnknownRecord, images: G11aExpectedImages): void {
  const caseId = 'G12G3_ATLAS_API_RUNTIME';
  assertEqual(api.image, images.api, caseId, 'Atlas API image must equal the immutable Local API image');
  if (api.ports !== undefined) fail(caseId, 'Atlas API must not publish a host port');
  if (api.depends_on !== undefined) fail(caseId, 'Atlas API must not depend on a database service');
  const environment = record(api.environment, caseId, 'Atlas API environment is missing');
  assertEqual(
    environment.PASSHUB_DEPLOYMENT_PROFILE,
    'ATLAS_MANAGED',
    caseId,
    'Atlas deployment profile must be exact',
  );
  assertEqual(
    environment.PASSHUB_MONGO_URI_FILE,
    '/run/secrets/app_mongo_uri',
    caseId,
    'Atlas application Mongo secret path must be fixed',
  );
  const deploy = record(api.deploy, caseId, 'Atlas API deploy policy is missing');
  assertEqual(deploy.replicas, 1, caseId, 'Atlas API must have exactly one replica');
}

function assertAtlasMounts(api: UnknownRecord): Readonly<{ runtime: string; descriptor: string }> {
  const caseId = 'G12G3_ATLAS_API_MOUNTS';
  const mounts = array(api.volumes, caseId, 'Atlas API mounts are missing');
  if (mounts.length !== 2) fail(caseId, 'Atlas API must have exactly runtime and descriptor mounts');
  const byTarget = new Map<string, UnknownRecord>();
  for (const value of mounts) {
    const mount = record(value, caseId, 'Atlas API mount is invalid');
    if (typeof mount.target !== 'string' || byTarget.has(mount.target)) {
      fail(caseId, 'Atlas API mount targets must be unique strings');
    }
    byTarget.set(mount.target, mount);
  }
  const runtime = byTarget.get('/run/passhub/api');
  const descriptor = byTarget.get('/run/passhub/dataset');
  if (runtime === undefined || descriptor === undefined) {
    fail(caseId, 'Atlas API mount targets are incomplete or outside the allowlist');
  }
  if (runtime.type !== 'bind' || typeof runtime.source !== 'string' || runtime.source.length === 0
    || runtime.read_only === true) {
    fail(caseId, 'runtime directory must be a writable bind mount');
  }
  if (descriptor.type !== 'bind' || typeof descriptor.source !== 'string' || descriptor.source.length === 0
    || descriptor.read_only !== true) {
    fail(caseId, 'dataset descriptor directory must be a read-only bind mount');
  }
  const runtimeSource = absoluteHostPath(runtime.source, caseId, 'runtime bind source');
  const descriptorSource = absoluteHostPath(descriptor.source, caseId, 'descriptor bind source');
  if (isG11aDangerousHostMountSource(runtimeSource)
    || isG11aDangerousHostMountSource(descriptorSource)) {
    fail(caseId, 'dangerous host mount source is forbidden');
  }
  if (hostPathsOverlap(runtimeSource, descriptorSource)) {
    fail('G12G3_SOURCE_ISOLATION', 'runtime and descriptor host paths must not overlap');
  }
  return { runtime: runtimeSource, descriptor: descriptorSource };
}

function assertAtlasSourceIsolation(
  mountSources: Readonly<{ runtime: string; descriptor: string }>,
  secretFiles: ReadonlyMap<string, string>,
): void {
  const caseId = 'G12G3_SOURCE_ISOLATION';
  const entries = [...secretFiles.entries()];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (entries[left]?.[1] === entries[right]?.[1]) {
        fail(caseId, 'Atlas secret file sources must be pairwise distinct');
      }
    }
  }
  for (const [name, file] of entries) {
    if (hostPathsOverlap(file, mountSources.runtime)
      || hostPathsOverlap(file, mountSources.descriptor)) {
      fail(caseId, `${name} secret file must not overlap runtime or descriptor host paths`);
    }
  }
}

function sharedApiModel(api: UnknownRecord): UnknownRecord {
  const shared = cloneRecord(api);
  const environment = record(shared.environment, 'G12G3_API_PARITY', 'API environment is missing');
  delete environment.PASSHUB_DEPLOYMENT_PROFILE;
  const networks = record(shared.networks, 'G12G3_API_PARITY', 'API networks are missing');
  delete networks.database;
  delete shared.depends_on;
  const mounts = array(shared.volumes, 'G12G3_API_PARITY', 'API mounts are missing');
  shared.volumes = mounts.filter((value) => {
    const mount = record(value, 'G12G3_API_PARITY', 'API mount is invalid');
    return mount.target !== '/run/passhub/dataset';
  });
  return shared;
}

export function validateG12g3ComposeTopologies(
  localModel: unknown,
  atlasModel: unknown,
  images: G11aExpectedImages,
): readonly G12g3ComposeTopologyCase[] {
  validateG11aTopology(localModel, images);
  const localRoot = record(localModel, 'G12G3_LOCAL_BASELINE', 'Local normalized Compose model is invalid');
  const localServices = record(localRoot.services, 'G12G3_LOCAL_BASELINE', 'Local services are missing');
  const localApi = record(localServices.api, 'G12G3_LOCAL_BASELINE', 'Local API service is missing');
  const localProxy = record(localServices.proxy, 'G12G3_LOCAL_BASELINE', 'Local proxy service is missing');
  const localVolumes = record(localRoot.volumes, 'G12G3_LOCAL_BASELINE', 'Local volumes are missing');
  exactKeys(localVolumes, ['mongo-data'], 'G12G3_LOCAL_BASELINE', 'Local volumes');
  const localEnvironment = record(localApi.environment, 'G12G3_LOCAL_BASELINE', 'Local API environment is missing');
  assertEqual(
    localEnvironment.PASSHUB_DEPLOYMENT_PROFILE,
    'LOCAL_SELF_HOSTED',
    'G12G3_LOCAL_BASELINE',
    'Local deployment profile must be exact',
  );

  const atlasRoot = record(atlasModel, 'G12G3_ATLAS_SERVICES', 'Atlas normalized Compose model is invalid');
  assertProjectIdentity(localRoot, atlasRoot);
  const atlasServices = record(atlasRoot.services, 'G12G3_ATLAS_SERVICES', 'Atlas services are missing');
  exactKeys(atlasServices, ['api', 'proxy'], 'G12G3_ATLAS_SERVICES', 'Atlas services');
  const atlasApi = record(atlasServices.api, 'G12G3_ATLAS_SERVICES', 'Atlas API service is invalid');
  const atlasProxy = record(atlasServices.proxy, 'G12G3_ATLAS_SERVICES', 'Atlas proxy service is invalid');

  const localNetworks = record(localRoot.networks, 'G12G3_LOCAL_BASELINE', 'Local networks are missing');
  const atlasNetworks = record(atlasRoot.networks, 'G12G3_ATLAS_NETWORKS', 'Atlas networks are missing');
  exactKeys(atlasNetworks, ['edge'], 'G12G3_ATLAS_NETWORKS', 'Atlas networks');
  const atlasApiNetworks = record(atlasApi.networks, 'G12G3_ATLAS_NETWORKS', 'Atlas API networks are missing');
  exactKeys(atlasApiNetworks, ['edge'], 'G12G3_ATLAS_NETWORKS', 'Atlas API networks');
  if (!isDeepStrictEqual(
    projectIndependentNetwork(atlasNetworks.edge),
    projectIndependentNetwork(localNetworks.edge),
  )) {
    fail('G12G3_ATLAS_NETWORKS', 'Atlas edge network must equal the Local edge network');
  }

  if (atlasRoot.volumes !== undefined) {
    fail('G12G3_ATLAS_NO_VOLUMES', 'Atlas Compose must not declare top-level volumes');
  }
  const secretFiles = assertAtlasSecrets(atlasRoot, atlasApi);
  assertNoMongoUriLiteral(atlasApi);
  assertAtlasRuntime(atlasApi, images);
  const mountSources = assertAtlasMounts(atlasApi);
  assertAtlasSourceIsolation(mountSources, secretFiles);

  if (!isDeepStrictEqual(atlasProxy, localProxy)) {
    fail('G12G3_PROXY_PARITY', 'Atlas and Local proxy services must be exactly equal');
  }
  if (!isDeepStrictEqual(sharedApiModel(atlasApi), sharedApiModel(localApi))) {
    fail('G12G3_API_PARITY', 'Atlas and Local API services differ outside the allowed profile topology');
  }
  return G12G3_COMPOSE_TOPOLOGY_CASES;
}

export function validateG12g3AtlasRawCompose(text: string): readonly G12g3ComposeTopologyCase[] {
  const lines = text.split(/\r?\n/u);
  assertRawSecretReference(text, lines);
  assertRawDescriptorMount(text, lines);

  const forbiddenTopology = [
    /^ {2}mongo:\s*$/mu,
    /^volumes:\s*$/mu,
    /^ {2}database:\s*$/mu,
    /mongo_root_(?:username|password)/iu,
    /mongo_keyfile/iu,
    /mongo-data/iu,
    /\/data\/db/iu,
    /maintenance/iu,
  ];
  if (forbiddenTopology.some((pattern) => pattern.test(text))) {
    fail('G12G3_RAW_FORBIDDEN_TOPOLOGY', 'Atlas raw Compose contains forbidden Local or maintenance topology');
  }
  if (/mongodb(?:\+srv)?:\/\//iu.test(text)) {
    fail('G12G3_RAW_URI_BOUNDARY', 'Atlas raw Compose must not contain a Mongo URI literal');
  }
  return G12G3_RAW_COMPOSE_CASES;
}
