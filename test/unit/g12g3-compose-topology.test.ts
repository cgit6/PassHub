import {
  G12G3_COMPOSE_TOPOLOGY_CASES,
  G12G3_RAW_COMPOSE_CASES,
  G12g3ComposeTopologyContractError,
  validateG12g3AtlasRawCompose,
  validateG12g3ComposeTopologies,
} from '../../src/deployment/internal/g12g3-compose-topology-contract.js';
import { G11aTopologyContractError } from '../../src/deployment/internal/g11a-topology-contract.js';

const SHA = 'a'.repeat(64);
const images = Object.freeze({
  api: `node@sha256:${SHA}`,
  mongo: `mongo@sha256:${SHA}`,
  proxy: `nginx@sha256:${SHA}`,
});

type Model = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function service(image: string, networks: Record<string, object>, memory: string): Record<string, unknown> {
  return {
    image,
    platform: 'linux/amd64',
    restart: 'no',
    stop_signal: 'SIGTERM',
    stop_grace_period: '30s',
    mem_limit: memory,
    deploy: { replicas: 1, resources: { limits: { memory } }, placement: {} },
    networks,
    volumes: [],
    logging: { driver: 'local', options: { 'max-size': '10m', 'max-file': '2' } },
  };
}

function localModel(): Model {
  const api = service(
    images.api,
    { database: { ipv4_address: '172.31.212.20' }, edge: { ipv4_address: '172.31.211.20' } },
    '805306368',
  );
  api.environment = {
    PASSHUB_DEPLOYMENT_PROFILE: 'LOCAL_SELF_HOSTED',
    PASSHUB_HTTP_HOST: '0.0.0.0',
    PASSHUB_HTTP_PORT: '3000',
    PASSHUB_TRUSTED_PROXY_IP: '172.31.211.10',
    PASSHUB_MONGO_URI_FILE: '/run/secrets/app_mongo_uri',
    PASSHUB_JWT_KEY_FILE: '/run/secrets/jwt_key',
    PASSHUB_COMPARISON_KEY_FILE: '/run/secrets/comparison_key',
    PASSHUB_RUNTIME_DIRECTORY: '/run/passhub/api',
  };
  api.secrets = [
    { source: 'app_mongo_uri', target: '/run/secrets/app_mongo_uri' },
    { source: 'jwt_key', target: '/run/secrets/jwt_key' },
    { source: 'comparison_key', target: '/run/secrets/comparison_key' },
  ];
  api.read_only = true;
  api.user = 'node';
  api.init = true;
  api.entrypoint = null;
  api.command = ['node', '/opt/passhub/dist/src/deployment/production-main.js'];
  api.cap_drop = ['ALL'];
  api.security_opt = ['no-new-privileges:true'];
  api.tmpfs = ['/tmp:rw,noexec,nosuid,size=16m'];
  api.healthcheck = {
    test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/internal/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
    interval: '5s', timeout: '3s', retries: 12,
  };
  api.volumes = [{ type: 'bind', source: '/safe/runtime', target: '/run/passhub/api' }];
  api.depends_on = { mongo: { condition: 'service_started', required: true } };

  const mongo = service(images.mongo, { database: { ipv4_address: '172.31.212.10' } }, '1610612736');
  mongo.entrypoint = ['/bin/bash', '/opt/passhub/mongo-entrypoint.sh'];
  mongo.command = ['mongod', '--replSet', 'rs0', '--bind_ip_all', '--port', '27017', '--quiet', '--setParameter', 'diagnosticDataCollectionEnabled=false'];
  mongo.healthcheck = {
    test: ['CMD-SHELL', 'mongosh --quiet --username "$$(cat /run/secrets/mongo_root_username)" --password "$$(cat /run/secrets/mongo_root_password)" --authenticationDatabase admin --eval "const h=db.adminCommand({hello:1}); quit(h.setName===\'rs0\' && h.isWritablePrimary===true && h.hosts.length===1 ? 0 : 1)"'],
    interval: '5s', timeout: '3s', retries: 24,
  };
  mongo.volumes = [
    { type: 'volume', source: 'mongo-data', target: '/data/db' },
    { type: 'bind', source: '/safe/mongo-entrypoint.sh', target: '/opt/passhub/mongo-entrypoint.sh', read_only: true },
  ];
  mongo.secrets = [
    { source: 'mongo_keyfile' },
    { source: 'mongo_root_password' },
    { source: 'mongo_root_username' },
  ];

  const proxy = service(images.proxy, { edge: { ipv4_address: '172.31.211.10' } }, '134217728');
  proxy.ports = [{ target: 443 }];
  proxy.logging = { driver: 'none' };
  proxy.read_only = true;
  proxy.cap_drop = ['ALL'];
  proxy.cap_add = ['CHOWN', 'NET_BIND_SERVICE', 'SETGID', 'SETUID'];
  proxy.security_opt = ['no-new-privileges:true'];
  proxy.tmpfs = ['/var/cache/nginx:rw,noexec,nosuid,size=16m', '/var/run:rw,noexec,nosuid,size=1m'];
  proxy.healthcheck = { test: ['CMD', 'nginx', '-t'], interval: '5s', timeout: '3s', retries: 12 };
  proxy.volumes = [
    { type: 'bind', source: '/safe/nginx.conf', target: '/etc/nginx/nginx.conf', read_only: true },
    { type: 'bind', source: '/safe/tls', target: '/etc/nginx/tls', read_only: true },
    { type: 'bind', source: '/safe/state', target: '/run/passhub/host', read_only: true },
  ];
  proxy.depends_on = { api: { condition: 'service_started', required: true } };

  return {
    name: 'passhub-g11',
    services: { api, mongo, proxy },
    networks: {
      database: { name: 'passhub-g11_database', internal: true, ipam: { config: [{ subnet: '172.31.212.0/24' }] } },
      edge: { name: 'passhub-g11_edge', internal: false, ipam: { config: [{ subnet: '172.31.211.0/24' }] } },
    },
    volumes: { 'mongo-data': {} },
    secrets: {
      app_mongo_uri: { file: '/safe/local-app-uri' },
      comparison_key: { file: '/safe/comparison-key' },
      jwt_key: { file: '/safe/jwt-key' },
      mongo_keyfile: { file: '/safe/mongo-keyfile' },
      mongo_root_password: { file: '/safe/mongo-root-password' },
      mongo_root_username: { file: '/safe/mongo-root-username' },
    },
  };
}

function atlasModel(local: Model): Model {
  const localRoot = local;
  const localServices = localRoot.services as Record<string, Record<string, unknown>>;
  const api = clone(localServices.api as Record<string, unknown>);
  const environment = api.environment as Record<string, unknown>;
  environment.PASSHUB_DEPLOYMENT_PROFILE = 'ATLAS_MANAGED';
  const networks = api.networks as Record<string, unknown>;
  delete networks.database;
  delete api.depends_on;
  (api.volumes as unknown[]).push({
    type: 'bind', source: '/safe/dataset', target: '/run/passhub/dataset', read_only: true, bind: {},
  });
  const edge = clone((localRoot.networks as Record<string, unknown>).edge) as Model;
  edge.name = 'passhub-g12g3-atlas_edge';
  return {
    name: 'passhub-g12g3-atlas',
    services: { api, proxy: clone(localServices.proxy as Record<string, unknown>) },
    networks: { edge },
    secrets: {
      app_mongo_uri: { file: '/safe/atlas-app-uri' },
      comparison_key: { file: '/safe/comparison-key' },
      jwt_key: { file: '/safe/jwt-key' },
    },
  };
}

function models(): { readonly local: Model; readonly atlas: Model } {
  const local = localModel();
  return { local, atlas: atlasModel(local) };
}

function services(model: Model): Record<string, Record<string, unknown>> {
  return model.services as Record<string, Record<string, unknown>>;
}

function atlasApi(model: Model): Record<string, unknown> {
  return services(model).api as Record<string, unknown>;
}

function atlasMount(model: Model, target: string): Model {
  return (atlasApi(model).volumes as Model[]).find((mount) => mount.target === target) as Model;
}

function expectAtlasFailure(
  mutate: (local: Model, atlas: Model) => void,
  caseId?: string,
): void {
  const fixture = models();
  mutate(fixture.local, fixture.atlas);
  try {
    validateG12g3ComposeTopologies(fixture.local, fixture.atlas, images);
    throw new Error('expected G12g-3 topology rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(G12g3ComposeTopologyContractError);
    if (caseId !== undefined) expect(error).toMatchObject({ caseId });
  }
}

function validRawAtlasCompose(): string {
  return `name: passhub-g12g3-atlas
services:
  api:
    image: \${PASSHUB_API_IMAGE:?set immutable PASSHUB_API_IMAGE reference}
    volumes:
      - type: bind
        source: \${PASSHUB_ATLAS_DATASET_DIR:?set PASSHUB_ATLAS_DATASET_DIR}
        target: /run/passhub/dataset
        read_only: true
        bind:
          create_host_path: false
secrets:
  app_mongo_uri:
    file: \${PASSHUB_ATLAS_APP_MONGO_URI_FILE:?set PASSHUB_ATLAS_APP_MONGO_URI_FILE}
`;
}

describe('G12g-3 Local and Atlas Compose topology contract', () => {
  test('executes the exact non-empty case manifest for valid normalized models', () => {
    const fixture = models();
    const actual = validateG12g3ComposeTopologies(fixture.local, fixture.atlas, images);
    expect(actual.length).toBeGreaterThan(0);
    expect(actual).toEqual(G12G3_COMPOSE_TOPOLOGY_CASES);
  });

  test('validates the Local model first with the existing G11a contract', () => {
    const fixture = models();
    services(fixture.local).worker = {};
    expect(() => validateG12g3ComposeTopologies(fixture.local, fixture.atlas, images))
      .toThrow(G11aTopologyContractError);
  });

  test.each([
    ['missing Local project name', (local: Model, _atlas: Model) => { delete local.name; }],
    ['missing Atlas project name', (_local: Model, atlas: Model) => { delete atlas.name; }],
    ['same Local and Atlas project name', (local: Model, atlas: Model) => { atlas.name = local.name; }],
    ['arbitrary Atlas project name', (_local: Model, atlas: Model) => { atlas.name = 'passhub-unreviewed'; }],
  ] as const)('rejects %s', (_label, mutate) => {
    expectAtlasFailure(mutate, 'G12G3_PROJECT_IDENTITY');
  });

  test('rejects a missing Local mongo-data declaration', () => {
    expectAtlasFailure((local) => { delete (local.volumes as Model)['mongo-data']; }, 'G12G3_LOCAL_BASELINE');
  });

  test.each([
    ['Mongo service', (_local: Model, atlas: Model) => { services(atlas).mongo = {}; }, 'G12G3_ATLAS_SERVICES'],
    ['second API-like service', (_local: Model, atlas: Model) => { services(atlas).initializer = {}; }, 'G12G3_ATLAS_SERVICES'],
    ['top-level volume', (_local: Model, atlas: Model) => { atlas.volumes = { 'mongo-data': {} }; }, 'G12G3_ATLAS_NO_VOLUMES'],
    ['root password secret', (_local: Model, atlas: Model) => { (atlas.secrets as Model).mongo_root_password = { file: '/safe/root' }; }, 'G12G3_ATLAS_SECRETS'],
    ['keyfile secret', (_local: Model, atlas: Model) => { (atlas.secrets as Model).mongo_keyfile = { file: '/safe/keyfile' }; }, 'G12G3_ATLAS_SECRETS'],
    ['maintenance secret', (_local: Model, atlas: Model) => { (atlas.secrets as Model).maintenance_mongo_uri = { file: '/safe/maintenance' }; }, 'G12G3_ATLAS_SECRETS'],
    ['API port', (_local: Model, atlas: Model) => { atlasApi(atlas).ports = [{ target: 3000 }]; }, 'G12G3_ATLAS_API_RUNTIME'],
    ['database network', (_local: Model, atlas: Model) => {
      (atlas.networks as Model).database = { internal: true };
      (atlasApi(atlas).networks as Model).database = {};
    }, 'G12G3_ATLAS_NETWORKS'],
    ['Mongo depends_on', (_local: Model, atlas: Model) => { atlasApi(atlas).depends_on = { mongo: { condition: 'service_started' } }; }, 'G12G3_ATLAS_API_RUNTIME'],
    ['wrong profile', (_local: Model, atlas: Model) => { (atlasApi(atlas).environment as Model).PASSHUB_DEPLOYMENT_PROFILE = 'LOCAL_SELF_HOSTED'; }, 'G12G3_ATLAS_API_RUNTIME'],
    ['second replica', (_local: Model, atlas: Model) => { (atlasApi(atlas).deploy as Model).replicas = 2; }, 'G12G3_ATLAS_API_RUNTIME'],
    ['API image drift', (_local: Model, atlas: Model) => { atlasApi(atlas).image = `node@sha256:${'b'.repeat(64)}`; }, 'G12G3_ATLAS_API_RUNTIME'],
    ['proxy pinned image drift', (_local: Model, atlas: Model) => { (services(atlas).proxy as Model).image = `nginx@sha256:${'b'.repeat(64)}`; }, 'G12G3_PROXY_PARITY'],
    ['proxy nginx mount drift', (_local: Model, atlas: Model) => {
      ((((services(atlas).proxy as Model).volumes as Model[])
        .find((mount) => mount.target === '/etc/nginx/nginx.conf')) as Model).source = '/safe/unreviewed-nginx.conf';
    }, 'G12G3_PROXY_PARITY'],
    ['production command drift', (_local: Model, atlas: Model) => { atlasApi(atlas).command = ['node', '/opt/passhub/dist/src/deployment/unreviewed.js']; }, 'G12G3_API_PARITY'],
    ['proxy drift', (_local: Model, atlas: Model) => { (services(atlas).proxy as Model).restart = 'always'; }, 'G12G3_PROXY_PARITY'],
  ] as const)('rejects %s', (_label, mutate, caseId) => {
    expectAtlasFailure(mutate, caseId);
  });

  test.each([
    ['missing descriptor', (_local: Model, atlas: Model) => { atlasApi(atlas).volumes = (atlasApi(atlas).volumes as Model[]).filter((mount) => mount.target !== '/run/passhub/dataset'); }],
    ['writable descriptor', (_local: Model, atlas: Model) => { ((atlasApi(atlas).volumes as Model[]).find((mount) => mount.target === '/run/passhub/dataset') as Model).read_only = false; }],
    ['wrong descriptor target', (_local: Model, atlas: Model) => { ((atlasApi(atlas).volumes as Model[]).find((mount) => mount.target === '/run/passhub/dataset') as Model).target = '/run/passhub/wrong'; }],
    ['read-only runtime', (_local: Model, atlas: Model) => { ((atlasApi(atlas).volumes as Model[]).find((mount) => mount.target === '/run/passhub/api') as Model).read_only = true; }],
  ] as const)('rejects %s mount', (_label, mutate) => {
    expectAtlasFailure(mutate, 'G12G3_ATLAS_API_MOUNTS');
  });

  test.each([
    '/',
    '/run',
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/var/run',
    '/var/lib/docker',
  ])('rejects dangerous descriptor host source %s', (source) => {
    expectAtlasFailure((_local, atlas) => { atlasMount(atlas, '/run/passhub/dataset').source = source; }, 'G12G3_ATLAS_API_MOUNTS');
  });

  test.each([
    ['/safe/runtime', '/safe/runtime'],
    ['/safe/runtime', '/safe/runtime/dataset'],
    ['/safe/runtime/child', '/safe/runtime'],
  ])('rejects overlapping runtime %s and descriptor %s host paths', (runtime, descriptor) => {
    expectAtlasFailure((_local, atlas) => {
      atlasMount(atlas, '/run/passhub/api').source = runtime;
      atlasMount(atlas, '/run/passhub/dataset').source = descriptor;
    }, 'G12G3_SOURCE_ISOLATION');
  });

  test('rejects duplicate Atlas secret file sources', () => {
    expectAtlasFailure((_local, atlas) => {
      ((atlas.secrets as Model).jwt_key as Model).file = ((atlas.secrets as Model).comparison_key as Model).file;
    }, 'G12G3_SOURCE_ISOLATION');
  });

  test.each([
    '/etc/passhub/atlas-uri',
    '/proc/passhub/atlas-uri',
    '/run/passhub/atlas-uri',
    '/var/lib/docker/passhub/atlas-uri',
  ])('rejects dangerous Atlas secret file source %s', (source) => {
    expectAtlasFailure((_local, atlas) => {
      ((atlas.secrets as Model).app_mongo_uri as Model).file = source;
    }, 'G12G3_ATLAS_SECRETS');
  });

  test.each([
    ['/safe/runtime/secret', 'app_mongo_uri'],
    ['/safe', 'jwt_key'],
    ['/safe/dataset/secret', 'comparison_key'],
    ['/safe/dataset/secret/child', 'comparison_key'],
  ])('rejects secret source %s overlapping deployment trees', (source, name) => {
    expectAtlasFailure((_local, atlas) => {
      ((atlas.secrets as Model)[name] as Model).file = source;
    }, 'G12G3_SOURCE_ISOLATION');
  });

  test.each([
    ['environment', (_local: Model, atlas: Model) => { (atlasApi(atlas).environment as Model).PRIVATE_URI = `mongodb${'+srv'}://${'example.invalid'}/`; }],
    ['command', (_local: Model, atlas: Model) => { atlasApi(atlas).command = ['node', 'app.js', ['mongodb', '://', 'example.invalid/'].join('')]; }],
    ['labels', (_local: Model, atlas: Model) => { atlasApi(atlas).labels = { private: ['mongodb', '://', 'example.invalid/'].join('') }; }],
  ] as const)('rejects a Mongo URI literal in API %s', (_label, mutate) => {
    expectAtlasFailure(mutate, 'G12G3_ATLAS_URI_BOUNDARY');
  });

  test.each([
    ['wrong app secret environment path', (_local: Model, atlas: Model) => { (atlasApi(atlas).environment as Model).PASSHUB_MONGO_URI_FILE = '/tmp/uri'; }, 'G12G3_ATLAS_API_RUNTIME'],
    ['wrong app secret target', (_local: Model, atlas: Model) => { ((atlasApi(atlas).secrets as Model[]).find((secret) => secret.source === 'app_mongo_uri') as Model).target = '/run/secrets/wrong'; }, 'G12G3_ATLAS_SECRETS'],
    ['extra API secret', (_local: Model, atlas: Model) => { (atlasApi(atlas).secrets as Model[]).push({ source: 'maintenance_mongo_uri', target: '/run/secrets/maintenance_mongo_uri' }); }, 'G12G3_ATLAS_SECRETS'],
    ['changed API security policy', (_local: Model, atlas: Model) => { atlasApi(atlas).read_only = false; }, 'G12G3_API_PARITY'],
  ] as const)('rejects %s', (_label, mutate, caseId) => {
    expectAtlasFailure(mutate, caseId);
  });
});

describe('G12g-3 raw Atlas Compose boundary', () => {
  test('executes the exact non-empty raw case manifest', () => {
    const actual = validateG12g3AtlasRawCompose(validRawAtlasCompose());
    expect(actual.length).toBeGreaterThan(0);
    expect(actual).toEqual(G12G3_RAW_COMPOSE_CASES);
  });

  test.each([
    ['removed create_host_path', (text: string) => text.replace('          create_host_path: false\n', '')],
    ['create_host_path true', (text: string) => text.replace('create_host_path: false', 'create_host_path: true')],
  ] as const)('rejects descriptor mount with %s', (_label, mutate) => {
    expect(() => validateG12g3AtlasRawCompose(mutate(validRawAtlasCompose())))
      .toThrow(expect.objectContaining({ caseId: 'G12G3_RAW_DESCRIPTOR_MOUNT' }));
  });

  test('rejects the wrong Atlas application secret environment reference', () => {
    const changed = validRawAtlasCompose().replaceAll(
      'PASSHUB_ATLAS_APP_MONGO_URI_FILE',
      'PASSHUB_MONGO_URI_FILE',
    );
    expect(() => validateG12g3AtlasRawCompose(changed))
      .toThrow(expect.objectContaining({ caseId: 'G12G3_RAW_SECRET_REFERENCE' }));
  });

  test('rejects a decoy app secret reference when the effective top-level secret is wrong', () => {
    const correct = '${PASSHUB_ATLAS_APP_MONGO_URI_FILE:?set PASSHUB_ATLAS_APP_MONGO_URI_FILE}';
    const changed = validRawAtlasCompose()
      .replace(correct, '${PASSHUB_MONGO_URI_FILE:?set PASSHUB_MONGO_URI_FILE}')
      .concat(`x-decoy:\n  app_mongo_uri:\n    file: ${correct}\n`);
    expect(() => validateG12g3AtlasRawCompose(changed))
      .toThrow(expect.objectContaining({ caseId: 'G12G3_RAW_SECRET_REFERENCE' }));
  });

  test('rejects a decoy descriptor when the effective API mount is wrong', () => {
    const source = '${PASSHUB_ATLAS_DATASET_DIR:?set PASSHUB_ATLAS_DATASET_DIR}';
    const changed = validRawAtlasCompose()
      .replace(source, '${PASSHUB_RUNTIME_DIR:?set PASSHUB_RUNTIME_DIR}')
      .concat(`x-decoy:\n  services:\n    api:\n      volumes:\n        - type: bind\n          source: ${source}\n          target: /run/passhub/dataset\n          read_only: true\n          bind:\n            create_host_path: false\n`);
    expect(() => validateG12g3AtlasRawCompose(changed))
      .toThrow(expect.objectContaining({ caseId: 'G12G3_RAW_DESCRIPTOR_MOUNT' }));
  });

  test('rejects a raw Mongo URI literal', () => {
    const literal = `mongodb${'+srv'}://${'example.invalid'}/`;
    expect(() => validateG12g3AtlasRawCompose(`${validRawAtlasCompose()}x-private: ${literal}\n`))
      .toThrow(expect.objectContaining({ caseId: 'G12G3_RAW_URI_BOUNDARY' }));
  });

  test.each([
    ['Mongo service', '  mongo:\n'],
    ['top-level volume', 'volumes:\n'],
    ['root password', 'x-mongo_root_password: forbidden\n'],
    ['keyfile', 'x-mongo_keyfile: forbidden\n'],
    ['maintenance credential', 'x-maintenance_mongo_uri: forbidden\n'],
    ['Mongo data volume', 'x-volume: mongo-data\n'],
  ])('rejects raw forbidden %s text', (_label, forbidden) => {
    expect(() => validateG12g3AtlasRawCompose(`${validRawAtlasCompose()}${forbidden}`))
      .toThrow(expect.objectContaining({ caseId: 'G12G3_RAW_FORBIDDEN_TOPOLOGY' }));
  });
});
