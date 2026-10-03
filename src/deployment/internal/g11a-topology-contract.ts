export const G11A_TOPOLOGY_CASES = Object.freeze([
  'G11A_TOPOLOGY_SERVICES',
  'G11A_TOPOLOGY_IMAGES',
  'G11A_TOPOLOGY_PORTS',
  'G11A_TOPOLOGY_NETWORKS',
  'G11A_RUNTIME_POLICY',
  'G11A_SECRET_AND_MOUNT_BOUNDARY',
] as const);

export const G11A_NGINX_CASES = Object.freeze([
  'G11A_NGINX_TLS',
  'G11A_NGINX_PROXY_POLICY',
  'G11A_NGINX_MAINTENANCE_FENCE',
  'G11A_NGINX_LOG_POLICY',
] as const);

export const G11A_MONGO_ENTRYPOINT_CASES = Object.freeze([
  'G11A_MONGO_AUTH_ENTRYPOINT',
] as const);

export const G11A_CANONICAL_NGINX_CONFIG = `user nginx;
worker_processes 1;
pid /var/run/nginx.pid;

events {
  worker_connections 256;
}

http {
  access_log off;
  error_log /dev/null emerg;
  server_tokens off;

  upstream passhub_api {
    server api:3000;
    keepalive 8;
  }

  server {
    listen 443 ssl;
    listen [::]:443 ssl;
    ssl_certificate /etc/nginx/tls/tls.crt;
    ssl_certificate_key /etc/nginx/tls/tls.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 16k;
    if (-f /run/passhub/host/maintenance) {
      return 503;
    }

    location ^~ /internal/ {
      return 404;
    }

    location / {
      proxy_pass http://passhub_api;
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_next_upstream off;
      proxy_connect_timeout 5s;
      proxy_read_timeout 15s;
      proxy_send_timeout 15s;
      proxy_set_header Host $host;
      proxy_set_header Connection "";
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header Forwarded "";
    }
  }
}
`;

export const G11A_CANONICAL_MONGO_ENTRYPOINT = `#!/bin/bash
set -euo pipefail

install -m 0400 -o mongodb -g mongodb /run/secrets/mongo_root_username /tmp/passhub-mongo-root-username
install -m 0400 -o mongodb -g mongodb /run/secrets/mongo_root_password /tmp/passhub-mongo-root-password
install -m 0400 -o mongodb -g mongodb /run/secrets/mongo_keyfile /tmp/passhub-mongo-keyfile
export MONGO_INITDB_ROOT_USERNAME_FILE=/tmp/passhub-mongo-root-username
export MONGO_INITDB_ROOT_PASSWORD_FILE=/tmp/passhub-mongo-root-password
exec /usr/local/bin/docker-entrypoint.sh "$@" --auth --keyFile /tmp/passhub-mongo-keyfile
`;

export interface G11aExpectedImages {
  readonly api: string;
  readonly mongo: string;
  readonly proxy: string;
}

export class G11aTopologyContractError extends Error {
  constructor(readonly caseId: string, message: string) {
    super(`${caseId}: ${message}`);
    this.name = 'G11aTopologyContractError';
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, caseId: string, message: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new G11aTopologyContractError(caseId, message);
  }
  return value as UnknownRecord;
}

function array(value: unknown, caseId: string, message: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new G11aTopologyContractError(caseId, message);
  return value;
}

function exactKeys(value: UnknownRecord, expected: readonly string[], caseId: string, label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new G11aTopologyContractError(caseId, `${label} must contain exactly ${wanted.join(', ')}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, caseId: string, message: string): void {
  if (actual !== expected) throw new G11aTopologyContractError(caseId, message);
}

function assertExactArray(actual: unknown, expected: readonly unknown[], caseId: string, message: string): void {
  const values = array(actual, caseId, message);
  if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) {
    throw new G11aTopologyContractError(caseId, message);
  }
}

function serviceNetworks(service: UnknownRecord, caseId: string): readonly string[] {
  return Object.keys(record(service.networks, caseId, 'service networks are missing')).sort();
}

function assertExactMounts(service: UnknownRecord, expected: Readonly<Record<string, Readonly<{ type: string; readOnly: boolean }>>>, caseId: string): void {
  const volumes = array(service.volumes, caseId, 'service volumes are invalid');
  if (volumes.length !== Object.keys(expected).length) throw new G11aTopologyContractError(caseId, 'service mount count is incorrect');
  for (const value of volumes) {
    const mount = record(value, caseId, 'service mount is invalid');
    const target = mount.target;
    const source = mount.source;
    if (typeof target !== 'string' || typeof source !== 'string' || source.length === 0) {
      throw new G11aTopologyContractError(caseId, 'mount source or target is invalid');
    }
    const dangerousSource = source === '/' || source === '/run' || source.startsWith('/run/')
      || source === '/var/run' || source.startsWith('/var/run/')
      || source === '/var/lib/docker' || source.startsWith('/var/lib/docker/')
      || source === '/etc' || source.startsWith('/etc/')
      || source === '/proc' || source.startsWith('/proc/')
      || source === '/sys' || source.startsWith('/sys/')
      || source === '/dev' || source.startsWith('/dev/');
    if (dangerousSource) throw new G11aTopologyContractError(caseId, 'dangerous host mount source is forbidden');
    const rule = expected[target];
    if (rule === undefined || mount.type !== rule.type || (mount.read_only === true) !== rule.readOnly) {
      throw new G11aTopologyContractError(caseId, 'service mount is outside the exact allowlist');
    }
  }
}

function assertRuntimePolicy(service: UnknownRecord, memory: string, caseId: string): void {
  assertEqual(service.platform, 'linux/amd64', caseId, 'platform must be linux/amd64');
  assertEqual(service.restart, 'no', caseId, 'automatic restart must be disabled');
  assertEqual(service.stop_signal, 'SIGTERM', caseId, 'stop signal must be SIGTERM');
  assertEqual(service.stop_grace_period, '30s', caseId, 'stop grace must be 30s');
  assertEqual(service.mem_limit, memory, caseId, 'memory limit is missing or incorrect');
  const deploy = record(service.deploy, caseId, 'deploy policy is missing');
  assertEqual(deploy.replicas, 1, caseId, 'service must have exactly one replica');
}

function assertPinnedImage(actual: unknown, expected: string, caseId: string): void {
  assertEqual(actual, expected, caseId, 'image reference does not match the deployment manifest');
  if (!/@sha256:[0-9a-f]{64}$/u.test(expected) && !/^sha256:[0-9a-f]{64}$/u.test(expected)) {
    throw new G11aTopologyContractError(caseId, 'image must use an exact sha256 digest');
  }
}

export function validateG11aTopology(model: unknown, images: G11aExpectedImages): readonly string[] {
  const root = record(model, 'G11A_TOPOLOGY_SERVICES', 'normalized Compose model must be an object');
  const services = record(root.services, 'G11A_TOPOLOGY_SERVICES', 'services are missing');
  exactKeys(services, ['api', 'mongo', 'proxy'], 'G11A_TOPOLOGY_SERVICES', 'services');
  const api = record(services.api, 'G11A_TOPOLOGY_SERVICES', 'api service is invalid');
  const mongo = record(services.mongo, 'G11A_TOPOLOGY_SERVICES', 'mongo service is invalid');
  const proxy = record(services.proxy, 'G11A_TOPOLOGY_SERVICES', 'proxy service is invalid');

  assertPinnedImage(api.image, images.api, 'G11A_TOPOLOGY_IMAGES');
  assertPinnedImage(mongo.image, images.mongo, 'G11A_TOPOLOGY_IMAGES');
  assertPinnedImage(proxy.image, images.proxy, 'G11A_TOPOLOGY_IMAGES');

  if (api.ports !== undefined || mongo.ports !== undefined) {
    throw new G11aTopologyContractError('G11A_TOPOLOGY_PORTS', 'api and mongo must not publish host ports');
  }
  const proxyPorts = array(proxy.ports, 'G11A_TOPOLOGY_PORTS', 'proxy must publish one HTTPS port');
  if (proxyPorts.length !== 1) throw new G11aTopologyContractError('G11A_TOPOLOGY_PORTS', 'proxy must publish exactly one port');
  const httpsPort = record(proxyPorts[0], 'G11A_TOPOLOGY_PORTS', 'proxy port mapping is invalid');
  assertEqual(httpsPort.target, 443, 'G11A_TOPOLOGY_PORTS', 'proxy may only publish container port 443');
  for (const service of [api, mongo, proxy]) {
    if (service.network_mode === 'host') throw new G11aTopologyContractError('G11A_TOPOLOGY_PORTS', 'host networking is forbidden');
  }

  const networks = record(root.networks, 'G11A_TOPOLOGY_NETWORKS', 'networks are missing');
  exactKeys(networks, ['database', 'edge'], 'G11A_TOPOLOGY_NETWORKS', 'networks');
  assertEqual(record(networks.database, 'G11A_TOPOLOGY_NETWORKS', 'database network is invalid').internal, true, 'G11A_TOPOLOGY_NETWORKS', 'database network must be internal');
  const edgeNetwork = record(networks.edge, 'G11A_TOPOLOGY_NETWORKS', 'edge network is invalid');
  assertEqual(edgeNetwork.internal ?? false, false, 'G11A_TOPOLOGY_NETWORKS', 'edge network must permit the sole HTTPS host publication');
  const databaseNetwork = record(networks.database, 'G11A_TOPOLOGY_NETWORKS', 'database network is invalid');
  const exactSubnet = (network: UnknownRecord, expected: string): void => {
    const ipam = record(network.ipam, 'G11A_TOPOLOGY_NETWORKS', 'network IPAM is missing');
    const configs = array(ipam.config, 'G11A_TOPOLOGY_NETWORKS', 'network subnet is missing');
    if (configs.length !== 1) throw new G11aTopologyContractError('G11A_TOPOLOGY_NETWORKS', 'network must have exactly one subnet');
    assertEqual(record(configs[0], 'G11A_TOPOLOGY_NETWORKS', 'network subnet is invalid').subnet, expected, 'G11A_TOPOLOGY_NETWORKS', 'network subnet is incorrect');
  };
  exactSubnet(edgeNetwork, '172.31.211.0/24');
  exactSubnet(databaseNetwork, '172.31.212.0/24');
  const expectedNetworkSets = [
    [serviceNetworks(api, 'G11A_TOPOLOGY_NETWORKS'), ['database', 'edge']],
    [serviceNetworks(mongo, 'G11A_TOPOLOGY_NETWORKS'), ['database']],
    [serviceNetworks(proxy, 'G11A_TOPOLOGY_NETWORKS'), ['edge']],
  ] as const;
  for (const [actual, expected] of expectedNetworkSets) {
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new G11aTopologyContractError('G11A_TOPOLOGY_NETWORKS', 'service network isolation is incorrect');
    }
  }
  const proxyEdge = record(record(proxy.networks, 'G11A_TOPOLOGY_NETWORKS', 'proxy networks missing').edge, 'G11A_TOPOLOGY_NETWORKS', 'proxy edge attachment missing');
  const apiNetworks = record(api.networks, 'G11A_TOPOLOGY_NETWORKS', 'api networks missing');
  assertEqual(record(apiNetworks.edge, 'G11A_TOPOLOGY_NETWORKS', 'api edge attachment missing').ipv4_address, '172.31.211.20', 'G11A_TOPOLOGY_NETWORKS', 'api edge address is incorrect');
  assertEqual(record(apiNetworks.database, 'G11A_TOPOLOGY_NETWORKS', 'api database attachment missing').ipv4_address, '172.31.212.20', 'G11A_TOPOLOGY_NETWORKS', 'api database address is incorrect');
  assertEqual(record(record(mongo.networks, 'G11A_TOPOLOGY_NETWORKS', 'mongo networks missing').database, 'G11A_TOPOLOGY_NETWORKS', 'mongo database attachment missing').ipv4_address, '172.31.212.10', 'G11A_TOPOLOGY_NETWORKS', 'mongo database address is incorrect');
  assertEqual(proxyEdge.ipv4_address, '172.31.211.10', 'G11A_TOPOLOGY_NETWORKS', 'proxy edge address is incorrect');
  const apiEnvironment = record(api.environment, 'G11A_TOPOLOGY_NETWORKS', 'api environment is missing');
  assertEqual(apiEnvironment.PASSHUB_TRUSTED_PROXY_IP, proxyEdge.ipv4_address, 'G11A_TOPOLOGY_NETWORKS', 'trusted proxy must equal the proxy fixed address');

  assertRuntimePolicy(api, '805306368', 'G11A_RUNTIME_POLICY');
  assertRuntimePolicy(mongo, '1610612736', 'G11A_RUNTIME_POLICY');
  assertRuntimePolicy(proxy, '134217728', 'G11A_RUNTIME_POLICY');
  assertEqual(api.read_only, true, 'G11A_RUNTIME_POLICY', 'api root filesystem must be read-only');
  assertEqual(api.user, 'node', 'G11A_RUNTIME_POLICY', 'api must run as the node user');
  assertEqual(api.init, true, 'G11A_RUNTIME_POLICY', 'api init process must be enabled');
  assertExactArray(api.command, ['node', '/opt/passhub/dist/src/deployment/production-main.js'], 'G11A_RUNTIME_POLICY', 'api command is incorrect');
  assertExactArray(api.cap_drop, ['ALL'], 'G11A_RUNTIME_POLICY', 'api capabilities are incorrect');
  assertExactArray(api.security_opt, ['no-new-privileges:true'], 'G11A_RUNTIME_POLICY', 'api security options are incorrect');
  assertExactArray(api.tmpfs, ['/tmp:rw,noexec,nosuid,size=16m'], 'G11A_RUNTIME_POLICY', 'api tmpfs is incorrect');
  assertExactArray(mongo.entrypoint, ['/bin/bash', '/opt/passhub/mongo-entrypoint.sh'], 'G11A_RUNTIME_POLICY', 'mongo entrypoint is incorrect');
  assertExactArray(mongo.command, ['mongod', '--replSet', 'rs0', '--bind_ip_all', '--port', '27017', '--quiet', '--setParameter', 'diagnosticDataCollectionEnabled=false'], 'G11A_RUNTIME_POLICY', 'mongo command is incorrect');
  assertEqual(proxy.read_only, true, 'G11A_RUNTIME_POLICY', 'proxy root filesystem must be read-only');
  assertExactArray(proxy.cap_drop, ['ALL'], 'G11A_RUNTIME_POLICY', 'proxy dropped capabilities are incorrect');
  assertExactArray(proxy.cap_add, ['CHOWN', 'NET_BIND_SERVICE', 'SETGID', 'SETUID'], 'G11A_RUNTIME_POLICY', 'proxy capabilities are incorrect');
  assertExactArray(proxy.security_opt, ['no-new-privileges:true'], 'G11A_RUNTIME_POLICY', 'proxy security options are incorrect');
  assertExactArray(proxy.tmpfs, ['/var/cache/nginx:rw,noexec,nosuid,size=16m', '/var/run:rw,noexec,nosuid,size=1m'], 'G11A_RUNTIME_POLICY', 'proxy tmpfs is incorrect');
  const assertHealthcheck = (service: UnknownRecord, test: readonly string[], retries: number): void => {
    const health = record(service.healthcheck, 'G11A_RUNTIME_POLICY', 'healthcheck is missing');
    assertExactArray(health.test, test, 'G11A_RUNTIME_POLICY', 'healthcheck command is incorrect');
    assertEqual(health.interval, '5s', 'G11A_RUNTIME_POLICY', 'healthcheck interval is incorrect');
    assertEqual(health.timeout, '3s', 'G11A_RUNTIME_POLICY', 'healthcheck timeout is incorrect');
    assertEqual(health.retries, retries, 'G11A_RUNTIME_POLICY', 'healthcheck retries are incorrect');
  };
  assertHealthcheck(api, ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/internal/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], 12);
  assertHealthcheck(mongo, ['CMD-SHELL', 'mongosh --quiet --username "$$(cat /run/secrets/mongo_root_username)" --password "$$(cat /run/secrets/mongo_root_password)" --authenticationDatabase admin --eval "const h=db.adminCommand({hello:1}); quit(h.setName===\'rs0\' && h.isWritablePrimary===true && h.hosts.length===1 ? 0 : 1)"'], 24);
  assertHealthcheck(proxy, ['CMD', 'nginx', '-t'], 12);
  assertExactMounts(api, { '/run/passhub/api': { type: 'bind', readOnly: false } }, 'G11A_SECRET_AND_MOUNT_BOUNDARY');
  assertExactMounts(mongo, {
    '/data/db': { type: 'volume', readOnly: false },
    '/opt/passhub/mongo-entrypoint.sh': { type: 'bind', readOnly: true },
  }, 'G11A_SECRET_AND_MOUNT_BOUNDARY');
  assertExactMounts(proxy, {
    '/etc/nginx/nginx.conf': { type: 'bind', readOnly: true },
    '/etc/nginx/tls': { type: 'bind', readOnly: true },
    '/run/passhub/host': { type: 'bind', readOnly: true },
  }, 'G11A_SECRET_AND_MOUNT_BOUNDARY');
  const secrets = array(api.secrets, 'G11A_SECRET_AND_MOUNT_BOUNDARY', 'api deployment secrets are missing');
  const secretNames = secrets.map((value) => String(record(value, 'G11A_SECRET_AND_MOUNT_BOUNDARY', 'secret mapping is invalid').source)).sort();
  const expectedSecrets = ['app_mongo_uri', 'comparison_key', 'jwt_key'];
  if (secretNames.length !== expectedSecrets.length || secretNames.some((name, index) => name !== expectedSecrets[index])) {
    throw new G11aTopologyContractError('G11A_SECRET_AND_MOUNT_BOUNDARY', 'api secret mapping is incomplete or expanded');
  }
  const mongoSecrets = array(mongo.secrets, 'G11A_SECRET_AND_MOUNT_BOUNDARY', 'mongo deployment secrets are missing');
  const mongoSecretNames = mongoSecrets.map((value) => String(record(value, 'G11A_SECRET_AND_MOUNT_BOUNDARY', 'mongo secret mapping is invalid').source)).sort();
  const expectedMongoSecrets = ['mongo_keyfile', 'mongo_root_password', 'mongo_root_username'];
  if (mongoSecretNames.length !== expectedMongoSecrets.length || mongoSecretNames.some((name, index) => name !== expectedMongoSecrets[index])) {
    throw new G11aTopologyContractError('G11A_SECRET_AND_MOUNT_BOUNDARY', 'mongo secret mapping is incomplete or expanded');
  }
  const rootSecrets = record(root.secrets, 'G11A_SECRET_AND_MOUNT_BOUNDARY', 'top-level secrets are missing');
  exactKeys(rootSecrets, [...expectedSecrets, ...expectedMongoSecrets], 'G11A_SECRET_AND_MOUNT_BOUNDARY', 'top-level secrets');
  const apiLogging = record(api.logging, 'G11A_RUNTIME_POLICY', 'api logging policy is missing');
  const mongoLogging = record(mongo.logging, 'G11A_RUNTIME_POLICY', 'mongo logging policy is missing');
  const proxyLogging = record(proxy.logging, 'G11A_RUNTIME_POLICY', 'proxy logging policy is missing');
  for (const logging of [apiLogging, mongoLogging]) {
    assertEqual(logging.driver, 'local', 'G11A_RUNTIME_POLICY', 'api and mongo must use bounded local logging');
    const options = record(logging.options, 'G11A_RUNTIME_POLICY', 'bounded logging options are missing');
    assertEqual(options['max-size'], '10m', 'G11A_RUNTIME_POLICY', 'bounded log size is incorrect');
    assertEqual(options['max-file'], '2', 'G11A_RUNTIME_POLICY', 'bounded log count is incorrect');
  }
  assertEqual(proxyLogging.driver, 'none', 'G11A_RUNTIME_POLICY', 'proxy container logging must be disabled');

  return G11A_TOPOLOGY_CASES;
}

export function validateG11aNginxConfig(text: string): readonly string[] {
  if (!text.includes('listen 443 ssl;') || !text.includes('ssl_certificate /etc/nginx/tls/tls.crt;')) {
    throw new G11aTopologyContractError('G11A_NGINX_TLS', 'NGINX TLS configuration is incomplete');
  }
  if (!text.includes('if (-f /run/passhub/host/maintenance)') || !text.includes('location ^~ /internal/')) {
    throw new G11aTopologyContractError('G11A_NGINX_MAINTENANCE_FENCE', 'NGINX maintenance fence is incomplete');
  }
  if (!text.includes('access_log off;') || !text.includes('error_log /dev/null emerg;')) {
    throw new G11aTopologyContractError('G11A_NGINX_LOG_POLICY', 'NGINX log policy is incomplete');
  }
  if (text !== G11A_CANONICAL_NGINX_CONFIG) {
    throw new G11aTopologyContractError('G11A_NGINX_PROXY_POLICY', 'NGINX config differs from the reviewed canonical file');
  }
  return G11A_NGINX_CASES;
}

export function validateG11aMongoEntrypoint(text: string): readonly string[] {
  if (text !== G11A_CANONICAL_MONGO_ENTRYPOINT) {
    throw new G11aTopologyContractError('G11A_MONGO_AUTH_ENTRYPOINT', 'Mongo auth entrypoint differs from the reviewed canonical file');
  }
  return G11A_MONGO_ENTRYPOINT_CASES;
}
