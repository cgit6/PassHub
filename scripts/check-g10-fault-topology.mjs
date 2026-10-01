import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const [compose, toxiproxy, runner, initializer, imagesSource] = await Promise.all([
  readFile(new URL('../infra/g10-fault-compose.yml', import.meta.url), 'utf8'),
  readFile(new URL('../infra/g10-fault-toxiproxy.json', import.meta.url), 'utf8'),
  readFile(new URL('./g10-fault-runner.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./g10-fault-topology-init.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../infra/toolchain-images.json', import.meta.url), 'utf8'),
]);
const images = JSON.parse(imagesSource).images;
const proxy = JSON.parse(toxiproxy);

assert.deepEqual(Object.keys(proxy), ['0']);
assert.deepEqual(proxy[0], {
  name: 'mongodb-rs0',
  listen: '0.0.0.0:27032',
  upstream: 'mongo-g10:27031',
  enabled: true,
  toxics: [],
});

assert.match(compose, new RegExp(`mongo-g10:\\n\\s+image: ${escapeRegExp(images.mongo)}`));
assert.match(compose, new RegExp(`toxiproxy-g10:\\n\\s+image: ${escapeRegExp(images.toxiproxyAmd64)}`));
assert.match(compose, new RegExp(`g10-fault-runner:\\n\\s+image: ${escapeRegExp(images.node)}`));
assert.match(compose, /g10-fault:\n\s+internal: true/u);
assert.doesNotMatch(compose, /^\s{2}ports:/mu, 'fault services must not publish a host port');
assert.match(compose, /G10_FAULT_APP_MONGO_URI: mongodb:\/\/toxiproxy-g10:27032\/\?replicaSet=rs0/u);
assert.match(compose, /G10_FAULT_OBSERVER_MONGO_URI: mongodb:\/\/mongo-g10:27031\/\?directConnection=true&replicaSet=rs0/u);
assert.match(compose, /G10_FAULT_INTERFERER_MONGO_URI: mongodb:\/\/mongo-g10:27031\/\?directConnection=true&replicaSet=rs0/u);
assert.match(compose, /G10_FAULT_TOXIPROXY_API_URL: http:\/\/toxiproxy-g10:8474/u);
assert.match(compose, /node scripts\/g10-fault-topology-init\.mjs && exec node scripts\/g10-fault-runner\.mjs --print-contract/u);

// Driver discovery has to receive the proxy as the replica-set member.  If
// this changes to mongo-g10:27031, an application client could bypass a toxic
// after its first SDAM hello response.
assert.match(initializer, /members: \[\{ _id: 0, host: 'toxiproxy-g10:27032' \}\]/u);
assert.match(initializer, /hello\.hosts\[0\] === 'toxiproxy-g10:27032'/u);
assert.match(initializer, /retryReads: false/u);
assert.match(initializer, /retryWrites: false/u);

assert.match(runner, /G10_FAULT_APP_MONGO_URI/u);
assert.match(runner, /G10_FAULT_OBSERVER_MONGO_URI/u);
assert.match(runner, /G10_FAULT_INTERFERER_MONGO_URI/u);
assert.match(runner, /G10_FAULT_TOXIPROXY_API_URL/u);
assert.doesNotMatch(`${compose}\n${toxiproxy}\n${runner}\n${initializer}`, /(?:mongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@|password|secret|api[_-]?key|token)/iu);

const { stdout } = await execute(process.execPath, ['scripts/g10-fault-runner.mjs', '--print-contract'], {
  cwd: root,
  env: {
    ...process.env,
    G10_FAULT_APP_MONGO_URI: 'mongodb://toxiproxy-g10:27032/?replicaSet=rs0',
    G10_FAULT_OBSERVER_MONGO_URI: 'mongodb://mongo-g10:27031/?directConnection=true&replicaSet=rs0',
    G10_FAULT_INTERFERER_MONGO_URI: 'mongodb://mongo-g10:27031/?directConnection=true&replicaSet=rs0',
    G10_FAULT_TOXIPROXY_API_URL: 'http://toxiproxy-g10:8474',
  },
});
assert.deepEqual(JSON.parse(stdout), {
  G10_FAULT_APP_MONGO_URI: 'mongodb://toxiproxy-g10:27032/?replicaSet=rs0',
  G10_FAULT_OBSERVER_MONGO_URI: 'mongodb://mongo-g10:27031/?directConnection=true&replicaSet=rs0',
  G10_FAULT_INTERFERER_MONGO_URI: 'mongodb://mongo-g10:27031/?directConnection=true&replicaSet=rs0',
  G10_FAULT_TOXIPROXY_API_URL: 'http://toxiproxy-g10:8474',
});

process.stdout.write('G10 fault topology static contract PASS\n');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
