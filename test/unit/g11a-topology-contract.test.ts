import {
  G11A_NGINX_CASES,
  G11A_CANONICAL_MONGO_ENTRYPOINT,
  G11A_CANONICAL_NGINX_CONFIG,
  G11A_MONGO_ENTRYPOINT_CASES,
  G11A_TOPOLOGY_CASES,
  G11aTopologyContractError,
  validateG11aMongoEntrypoint,
  validateG11aNginxConfig,
  validateG11aTopology,
} from '../../src/deployment/internal/g11a-topology-contract.js';
import { resolveIngressClientAddress } from '../../src/deployment/ingress-client-address.js';

const SHA = 'a'.repeat(64);
const images = Object.freeze({
  api: `node@sha256:${SHA}`,
  mongo: `mongo@sha256:${SHA}`,
  proxy: `nginx@sha256:${SHA}`,
});

function service(image: string, networks: Record<string, object>, memory: string): Record<string, unknown> {
  return {
    image,
    platform: 'linux/amd64',
    restart: 'no',
    stop_signal: 'SIGTERM',
    stop_grace_period: '30s',
    mem_limit: memory,
    deploy: { replicas: 1 },
    networks,
    volumes: [],
    logging: { driver: 'local', options: { 'max-size': '10m', 'max-file': '2' } },
  };
}

function validModel(): Record<string, unknown> {
  const api = service(images.api, { database: { ipv4_address: '172.31.212.20' }, edge: { ipv4_address: '172.31.211.20' } }, '805306368');
  api.environment = { PASSHUB_TRUSTED_PROXY_IP: '172.31.211.10' };
  api.secrets = [{ source: 'app_mongo_uri' }, { source: 'comparison_key' }, { source: 'jwt_key' }];
  api.read_only = true;
  api.user = 'node';
  api.init = true;
  api.command = ['node', '/opt/passhub/dist/src/deployment/production-main.js'];
  api.cap_drop = ['ALL'];
  api.security_opt = ['no-new-privileges:true'];
  api.tmpfs = ['/tmp:rw,noexec,nosuid,size=16m'];
  api.healthcheck = {
    test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/internal/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
    interval: '5s', timeout: '3s', retries: 12,
  };
  api.volumes = [{ type: 'bind', source: '/safe/runtime', target: '/run/passhub/api' }];
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
  mongo.secrets = [{ source: 'mongo_keyfile' }, { source: 'mongo_root_password' }, { source: 'mongo_root_username' }];
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
  return {
    services: { api, mongo, proxy },
    networks: {
      database: { internal: true, ipam: { config: [{ subnet: '172.31.212.0/24' }] } },
      edge: { internal: false, ipam: { config: [{ subnet: '172.31.211.0/24' }] } },
    },
    secrets: {
      app_mongo_uri: {}, comparison_key: {}, jwt_key: {},
      mongo_keyfile: {}, mongo_root_password: {}, mongo_root_username: {},
    },
  };
}

function mutableService(model: Record<string, unknown>, name: 'api' | 'mongo' | 'proxy'): Record<string, unknown> {
  const services = model.services as Record<string, unknown>;
  return services[name] as Record<string, unknown>;
}

const nginx = G11A_CANONICAL_NGINX_CONFIG;

describe('G11a deployment topology contract', () => {
  test('accepts a single forwarded address only from the fixed trusted proxy', () => {
    expect(resolveIngressClientAddress('::ffff:172.31.211.10', '198.51.100.8', '172.31.211.10')).toEqual({
      peerAddress: '172.31.211.10', clientAddress: '198.51.100.8', trustedProxy: true,
    });
  });

  test('ignores spoofed, chained, array, and invalid forwarded addresses', () => {
    expect(resolveIngressClientAddress('198.51.100.9', '203.0.113.7', '172.31.211.10').clientAddress).toBe('198.51.100.9');
    expect(resolveIngressClientAddress('172.31.211.10', '203.0.113.7, 198.51.100.4', '172.31.211.10').clientAddress).toBe('172.31.211.10');
    expect(resolveIngressClientAddress('172.31.211.10', ['203.0.113.7'], '172.31.211.10').clientAddress).toBe('172.31.211.10');
    expect(resolveIngressClientAddress('172.31.211.10', 'not-an-ip', '172.31.211.10').clientAddress).toBe('172.31.211.10');
  });

  test('executes the exact positive topology and NGINX case manifests', () => {
    expect(validateG11aTopology(validModel(), images)).toEqual(G11A_TOPOLOGY_CASES);
    expect(validateG11aNginxConfig(nginx)).toEqual(G11A_NGINX_CASES);
  });

  test.each([
    ['extra service', (model: Record<string, unknown>) => { (model.services as Record<string, unknown>).worker = {}; }, 'G11A_TOPOLOGY_SERVICES'],
    ['unpinned image', (model: Record<string, unknown>) => { mutableService(model, 'api').image = 'node:latest'; }, 'G11A_TOPOLOGY_IMAGES'],
    ['api host port', (model: Record<string, unknown>) => { mutableService(model, 'api').ports = [{ target: 3000 }]; }, 'G11A_TOPOLOGY_PORTS'],
    ['proxy on database network', (model: Record<string, unknown>) => { mutableService(model, 'proxy').networks = { edge: {}, database: {} }; }, 'G11A_TOPOLOGY_NETWORKS'],
    ['automatic restart', (model: Record<string, unknown>) => { mutableService(model, 'api').restart = 'always'; }, 'G11A_RUNTIME_POLICY'],
    ['changed subnet', (model: Record<string, unknown>) => { (((model.networks as Record<string, unknown>).edge as Record<string, unknown>).ipam as Record<string, unknown>) = { config: [{ subnet: '172.31.213.0/24' }] }; }, 'G11A_TOPOLOGY_NETWORKS'],
    ['changed fixed address', (model: Record<string, unknown>) => {
      const networks = mutableService(model, 'api').networks as Record<string, Record<string, unknown>>;
      if (networks.edge !== undefined) networks.edge.ipv4_address = '172.31.211.21';
    }, 'G11A_TOPOLOGY_NETWORKS'],
    ['changed production command', (model: Record<string, unknown>) => { mutableService(model, 'api').command = ['node', 'other.js']; }, 'G11A_RUNTIME_POLICY'],
    ['removed hardening', (model: Record<string, unknown>) => { delete mutableService(model, 'api').cap_drop; }, 'G11A_RUNTIME_POLICY'],
    ['changed healthcheck', (model: Record<string, unknown>) => { mutableService(model, 'api').healthcheck = { test: ['CMD', 'true'] }; }, 'G11A_RUNTIME_POLICY'],
    ['docker socket', (model: Record<string, unknown>) => { mutableService(model, 'api').volumes = [{ type: 'bind', source: '/var/run/docker.sock', target: '/run/passhub/api' }]; }, 'G11A_SECRET_AND_MOUNT_BOUNDARY'],
  ])('fails closed for %s', (_label, mutate, caseId) => {
    const model = validModel();
    mutate(model);
    try {
      validateG11aTopology(model, images);
      throw new Error('expected topology validation failure');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(G11aTopologyContractError);
      expect((error as G11aTopologyContractError).caseId).toBe(caseId);
    }
  });

  test.each([
    ['upstream retries', 'proxy_next_upstream off;', 'G11A_NGINX_PROXY_POLICY'],
    ['maintenance marker', 'if (-f /run/passhub/host/maintenance)', 'G11A_NGINX_MAINTENANCE_FENCE'],
    ['access log', 'access_log off;', 'G11A_NGINX_LOG_POLICY'],
  ])('rejects missing NGINX %s rule', (_label, rule, caseId) => {
    const changed = nginx.replace(rule, '');
    try {
      validateG11aNginxConfig(changed);
      throw new Error('expected NGINX validation failure');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(G11aTopologyContractError);
      expect((error as G11aTopologyContractError).caseId).toBe(caseId);
    }
  });

  test('locks the Mongo auth entrypoint to the reviewed canonical content', () => {
    expect(validateG11aMongoEntrypoint(G11A_CANONICAL_MONGO_ENTRYPOINT)).toEqual(G11A_MONGO_ENTRYPOINT_CASES);
    expect(() => validateG11aMongoEntrypoint(G11A_CANONICAL_MONGO_ENTRYPOINT.replace(' --auth', '')))
      .toThrow(G11aTopologyContractError);
  });
});
