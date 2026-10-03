import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  G11A_NGINX_CASES,
  G11A_MONGO_ENTRYPOINT_CASES,
  G11A_TOPOLOGY_CASES,
  validateG11aMongoEntrypoint,
  validateG11aNginxConfig,
  validateG11aTopology,
} from '../../dist/src/deployment/internal/g11a-topology-contract.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const images = JSON.parse(readFileSync(resolve(repository, 'infra/toolchain-images.json'), 'utf8')).images;
const environment = {
  ...process.env,
  PASSHUB_API_IMAGE: images.node,
  PASSHUB_TLS_DIR: '/tmp/passhub-g11-contract-tls',
  PASSHUB_STATE_DIR: '/tmp/passhub-g11-contract-state',
  PASSHUB_RUNTIME_DIR: '/tmp/passhub-g11-contract-runtime',
  PASSHUB_MONGO_URI_FILE: '/tmp/passhub-g11-contract-mongo-uri',
  PASSHUB_JWT_KEY_FILE: '/tmp/passhub-g11-contract-jwt-key',
  PASSHUB_COMPARISON_KEY_FILE: '/tmp/passhub-g11-contract-comparison-key',
  PASSHUB_MONGO_ROOT_USERNAME_FILE: '/tmp/passhub-g11-contract-mongo-root-username',
  PASSHUB_MONGO_ROOT_PASSWORD_FILE: '/tmp/passhub-g11-contract-mongo-root-password',
  PASSHUB_MONGO_KEYFILE: '/tmp/passhub-g11-contract-mongo-keyfile',
};
const normalized = JSON.parse(execFileSync('docker', [
  'compose', '-f', resolve(repository, 'infra/g11/compose.yml'), 'config', '--format', 'json',
], { encoding: 'utf8', env: environment }));
const topologyCases = validateG11aTopology(normalized, {
  api: images.node,
  mongo: images.mongo,
  proxy: images.nginx,
});
const nginxCases = validateG11aNginxConfig(readFileSync(resolve(repository, 'infra/g11/nginx/nginx.conf'), 'utf8'));
const mongoEntrypointCases = validateG11aMongoEntrypoint(readFileSync(resolve(repository, 'infra/g11/mongo/entrypoint.sh'), 'utf8'));
const actual = [...topologyCases, ...nginxCases, ...mongoEntrypointCases];
const expected = [...G11A_TOPOLOGY_CASES, ...G11A_NGINX_CASES, ...G11A_MONGO_ENTRYPOINT_CASES];
if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
  throw new Error('G11a topology checker did not execute the exact case manifest');
}
process.stdout.write(`${JSON.stringify({ gate: 'G11a', status: 'PASS', cases: actual })}\n`);
