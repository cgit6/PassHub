import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateG11aTopology } from '../../dist/src/deployment/internal/g11a-topology-contract.js';

const EXPECTED_CASES = Object.freeze([
  'G11A_RUNTIME_API_IMAGE',
  'G11A_RUNTIME_MONGO_PRIMARY',
  'G11A_RUNTIME_CONTAINER_POLICY',
  'G11A_RUNTIME_PROXY_IDENTITY',
  'G11A_RUNTIME_NETWORK_ISOLATION',
  'G11A_RUNTIME_MAINTENANCE_FENCE',
  'G11A_RUNTIME_GRACEFUL_STOP',
  'G11A_RUNTIME_CLEANUP',
]);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseCompose = resolve(repository, 'infra/g11/compose.yml');
const smokeCompose = resolve(repository, 'infra/g11/compose.smoke.yml');
const images = JSON.parse(readFileSync(resolve(repository, 'infra/toolchain-images.json'), 'utf8')).images;
const project = `passhub-g11a-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const apiTag = `${project}-api:dev`;
const temporary = mkdtempSync(join(tmpdir(), `${project}-`));
const tls = join(temporary, 'tls');
const state = join(temporary, 'state');
const runtime = join(temporary, 'runtime');
const secrets = join(temporary, 'secrets');
const mongoUriFile = join(secrets, 'mongo-uri');
const jwtKeyFile = join(secrets, 'jwt-key');
const comparisonKeyFile = join(secrets, 'comparison-key');
const mongoRootUsernameFile = join(secrets, 'mongo-root-username');
const mongoRootPasswordFile = join(secrets, 'mongo-root-password');
const mongoKeyfile = join(secrets, 'mongo-keyfile');
const mongoRootUsername = 'passhub_root';
const mongoRootPassword = 'g11a-root-password-9f7a2c';
const deploymentFingerprints = Object.freeze({
  dockerfileSha256: createHash('sha256').update(readFileSync(resolve(repository, 'infra/g11/api.Dockerfile'))).digest('hex'),
  composeSha256: createHash('sha256').update(readFileSync(baseCompose)).digest('hex'),
  smokeComposeSha256: createHash('sha256').update(readFileSync(smokeCompose)).digest('hex'),
  nginxSha256: createHash('sha256').update(readFileSync(resolve(repository, 'infra/g11/nginx/nginx.conf'))).digest('hex'),
  mongoEntrypointSha256: createHash('sha256').update(readFileSync(resolve(repository, 'infra/g11/mongo/entrypoint.sh'))).digest('hex'),
});
const environment = {
  ...process.env,
  PASSHUB_API_IMAGE: apiTag,
  PASSHUB_TLS_DIR: tls,
  PASSHUB_STATE_DIR: state,
  PASSHUB_RUNTIME_DIR: runtime,
  PASSHUB_MONGO_URI_FILE: mongoUriFile,
  PASSHUB_JWT_KEY_FILE: jwtKeyFile,
  PASSHUB_COMPARISON_KEY_FILE: comparisonKeyFile,
  PASSHUB_MONGO_ROOT_USERNAME_FILE: mongoRootUsernameFile,
  PASSHUB_MONGO_ROOT_PASSWORD_FILE: mongoRootPasswordFile,
  PASSHUB_MONGO_KEYFILE: mongoKeyfile,
  PASSHUB_HTTPS_BIND: '127.0.0.1',
  PASSHUB_HTTPS_PORT: '0',
};
const composeArgs = ['compose', '-p', project, '-f', baseCompose, '-f', smokeCompose];
const cases = [];
let primaryFailure;
let cleanupFailure;
let apiImageId;
let buildAttempted = false;
let port;
let cleanupStarted = false;

function command(binary, args, options = {}) {
  const output = execFileSync(binary, args, {
    encoding: 'utf8',
    env: environment,
    timeout: options.timeout ?? 180_000,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  return typeof output === 'string' ? output.trim() : '';
}

function docker(args, options = {}) {
  return command('docker', args, options);
}

function compose(args, options = {}) {
  return docker([...composeArgs, ...args], options);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitFor(label, probe, timeoutMs = 120_000, failed = () => false) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (failed()) throw new Error(`${label} exited before becoming ready`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`${label} did not become ready${last instanceof Error ? `: ${last.message}` : ''}`);
}

function curl(path, headers = []) {
  assert(typeof port === 'number', 'HTTPS port is unavailable');
  return command('curl', [
    '--silent', '--insecure', '--max-time', '10',
    ...headers.flatMap(([name, value]) => ['--header', `${name}: ${value}`]),
    `https://127.0.0.1:${String(port)}${path}`,
  ], { timeout: 15_000 });
}

function curlStatus(path) {
  assert(typeof port === 'number', 'HTTPS port is unavailable');
  return command('curl', [
    '--silent', '--insecure', '--max-time', '10', '--output', '/dev/null', '--write-out', '%{http_code}',
    `https://127.0.0.1:${String(port)}${path}`,
  ], { timeout: 15_000 });
}

function directObservations() {
  const output = compose(['exec', '-T', 'api', 'node', '-e', `fetch('http://127.0.0.1:3000/__g11a/observations').then(async r=>{if(!r.ok)process.exit(2);process.stdout.write(await r.text())}).catch(()=>process.exit(1))`]);
  return JSON.parse(output).forwardedRequests;
}

function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const failures = [];
  try { compose(['down', '--volumes', '--remove-orphans', '--timeout', '30'], { timeout: 120_000 }); } catch (error) { failures.push(error); }
  try {
    const leftovers = [
      docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]),
      docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
      docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
    ].filter(Boolean);
    if (leftovers.length > 0) throw new Error('G11a cleanup left project-scoped Docker resources');
  } catch (error) {
    failures.push(error);
  }
  if (buildAttempted) {
    try {
      try { docker(['image', 'rm', '--force', apiTag], { timeout: 60_000 }); } catch {
        // Absence is decided by the independent exact-tag query below, not by rm stderr.
      }
      if (docker(['image', 'ls', '--quiet', '--filter', `reference=${apiTag}`], { timeout: 15_000 }).length > 0) {
        throw new Error('G11a cleanup left the project-scoped API image tag');
      }
    } catch (error) {
      failures.push(error);
    }
  }
  try { rmSync(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length === 0) {
    cases.push('G11A_RUNTIME_CLEANUP');
  } else {
    cleanupFailure = failures.length === 1 ? failures[0] : new AggregateError(failures, 'G11a cleanup phases failed');
  }
}

process.once('SIGTERM', () => {
  primaryFailure ??= new Error('G11a runtime received SIGTERM');
  cleanup();
  process.exit(cleanupFailure === undefined ? 143 : 1);
});
process.once('SIGINT', () => {
  primaryFailure ??= new Error('G11a runtime received SIGINT');
  cleanup();
  process.exit(cleanupFailure === undefined ? 130 : 1);
});

try {
  for (const directory of [tls, state, runtime, secrets]) mkdirSync(directory, { mode: 0o700 });
  chmodSync(temporary, 0o755);
  chmodSync(tls, 0o755);
  chmodSync(state, 0o755);
  writeFileSync(mongoUriFile, `mongodb://${mongoRootUsername}:${mongoRootPassword}@mongo:27017/passhub_demo?replicaSet=rs0&directConnection=true&authSource=admin\n`, { mode: 0o600 });
  writeFileSync(jwtKeyFile, `${'j'.repeat(64)}\n`, { mode: 0o600 });
  writeFileSync(comparisonKeyFile, `${'c'.repeat(64)}\n`, { mode: 0o600 });
  writeFileSync(mongoRootUsernameFile, `${mongoRootUsername}\n`, { mode: 0o600 });
  writeFileSync(mongoRootPasswordFile, `${mongoRootPassword}\n`, { mode: 0o600 });
  writeFileSync(mongoKeyfile, `${'k'.repeat(756)}\n`, { mode: 0o600 });
  command('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', join(tls, 'tls.key'), '-out', join(tls, 'tls.crt'),
  ], { stdio: 'ignore', timeout: 30_000 });
  chmodSync(join(tls, 'tls.crt'), 0o644);
  chmodSync(join(tls, 'tls.key'), 0o644);

  buildAttempted = true;
  docker(['build', '--platform', 'linux/amd64', '--file', resolve(repository, 'infra/g11/api.Dockerfile'), '--tag', apiTag, repository], { timeout: 600_000 });
  apiImageId = docker(['image', 'inspect', apiTag, '--format', '{{.Id}}']);
  assert(/^sha256:[0-9a-f]{64}$/u.test(apiImageId), 'built API image ID is not immutable');
  environment.PASSHUB_API_IMAGE = apiImageId;
  const deployedModel = JSON.parse(compose(['config', '--format', 'json']));
  validateG11aTopology(deployedModel, { api: apiImageId, mongo: images.mongo, proxy: images.nginx });
  cases.push('G11A_RUNTIME_API_IMAGE');

  port = await new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (typeof address !== 'object' || address === null) return reject(new Error('cannot allocate G11a HTTPS port'));
      listener.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
    });
  });
  environment.PASSHUB_HTTPS_PORT = String(port);

  compose(['up', '-d', 'mongo']);
  const mongoAuth = ['mongosh', '--quiet', '--username', mongoRootUsername, '--password', mongoRootPassword, '--authenticationDatabase', 'admin'];
  waitFor(
    'Mongo process',
    () => compose(['exec', '-T', 'mongo', ...mongoAuth, '--eval', 'quit(db.adminCommand({ping:1}).ok===1?0:1)']) === '',
    120_000,
    () => compose(['ps', '--status', 'exited', '-q', 'mongo']).length > 0,
  );
  compose(['exec', '-T', 'mongo', ...mongoAuth, '--eval', `
    try { const s=rs.status(); if (s.ok!==1) quit(2); }
    catch (e) { const r=rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]}); if (r.ok!==1) quit(3); }
  `]);
  waitFor('Mongo rs0 PRIMARY', () => compose(['exec', '-T', 'mongo', ...mongoAuth, '--eval', `const h=db.adminCommand({hello:1}); if(h.setName==='rs0'&&h.isWritablePrimary===true&&h.hosts.length===1){print('PRIMARY')}else{quit(1)}`]) === 'PRIMARY');
  cases.push('G11A_RUNTIME_MONGO_PRIMARY');

  compose(['up', '-d', 'api', 'proxy']);
  waitFor('HTTPS proxy', () => curlStatus('/__g11a/probe') === '200');
  assert(curlStatus('/internal/ready') === '404', 'internal readiness route is publicly reachable');

  const ids = Object.fromEntries(['api', 'mongo', 'proxy'].map((service) => [service, compose(['ps', '-q', service])]));
  assert(Object.values(ids).every((id) => typeof id === 'string' && id.length > 0), 'one or more G11a containers are missing');
  const expectedImages = { api: apiImageId, mongo: images.mongo, proxy: images.nginx };
  const expectedMemory = { api: 805306368, mongo: 1610612736, proxy: 134217728 };
  for (const service of ['api', 'mongo', 'proxy']) {
    const inspect = JSON.parse(docker(['inspect', ids[service]]))[0];
    assert(inspect.Config.Image === expectedImages[service], `${service} image reference is not exact`);
    assert(inspect.HostConfig.RestartPolicy.Name === 'no', `${service} restart policy is not disabled`);
    assert(inspect.Config.StopSignal === 'SIGTERM', `${service} stop signal is not SIGTERM`);
    assert(inspect.Config.StopTimeout === 30, `${service} stop timeout is not 30 seconds`);
    assert(inspect.HostConfig.Memory === expectedMemory[service], `${service} memory limit is incorrect`);
    if (service !== 'proxy') assert(Object.keys(inspect.HostConfig.PortBindings ?? {}).length === 0, `${service} published a host port`);
    if (service === 'api') assert(inspect.HostConfig.ReadonlyRootfs === true && inspect.Config.User === 'node', 'api runtime privilege policy is incorrect');
  }
  const proxyInspect = JSON.parse(docker(['inspect', ids.proxy]))[0];
  assert(Object.keys(proxyInspect.HostConfig.PortBindings).length === 1 && proxyInspect.HostConfig.PortBindings['443/tcp'].length === 1, 'proxy must publish only HTTPS');
  cases.push('G11A_RUNTIME_CONTAINER_POLICY');

  const observed = JSON.parse(curl('/__g11a/probe', [
    ['X-Forwarded-For', '203.0.113.7'],
    ['Forwarded', 'for=203.0.113.7'],
  ]));
  assert(observed.peer === '172.31.211.10' && observed.trustedProxy === true, 'production API did not enforce the fixed trusted proxy');
  assert(observed.clientAddress !== '203.0.113.7', 'spoofed X-Forwarded-For reached the production API');
  assert(observed.forwarded === null, 'spoofed Forwarded header reached the production API');
  cases.push('G11A_RUNTIME_PROXY_IDENTITY');

  let mongoResolvable = true;
  try { compose(['exec', '-T', 'proxy', 'getent', 'hosts', 'mongo'], { timeout: 10_000 }); } catch { mongoResolvable = false; }
  assert(!mongoResolvable, 'proxy can resolve the database service name');
  let databaseReachable = true;
  try {
    docker(['run', '--rm', '--network', `${project}_edge`, images.node, 'node', '-e', `const s=require('node:net').connect({host:'172.31.212.10',port:27017});const t=setTimeout(()=>process.exit(0),1500);s.once('connect',()=>{clearTimeout(t);process.exit(2)});s.once('error',()=>{clearTimeout(t);process.exit(0)})`], { timeout: 10_000 });
    databaseReachable = false;
  } catch (error) {
    if (error.status === 2) databaseReachable = true;
    else throw error;
  }
  assert(!databaseReachable, 'edge network can reach the fixed database address');
  cases.push('G11A_RUNTIME_NETWORK_ISOLATION');

  const before = directObservations();
  writeFileSync(join(state, 'maintenance'), 'maintenance\n', { mode: 0o600 });
  assert(curlStatus('/__g11a/probe') === '503', 'maintenance marker did not produce HTTPS 503');
  assert(directObservations() === before, 'maintenance-fenced request reached the API');
  cases.push('G11A_RUNTIME_MAINTENANCE_FENCE');

  compose(['stop', '--timeout', '30', 'api'], { timeout: 40_000 });
  const stopped = JSON.parse(docker(['inspect', ids.api]))[0];
  assert(stopped.State.Status === 'exited' && stopped.State.ExitCode === 0 && stopped.State.OOMKilled === false, 'production API did not stop gracefully');
  cases.push('G11A_RUNTIME_GRACEFUL_STOP');
} catch (error) {
  let diagnostics = '';
  try {
    diagnostics = compose(['logs', '--no-color', '--tail', '80', 'mongo', 'api', 'proxy'], { timeout: 15_000 });
  } catch {
    // Preserve the original failure even when Docker cannot provide diagnostics.
  }
  primaryFailure = diagnostics.length === 0
    ? error
    : new Error(`${error instanceof Error ? error.message : String(error)}\nG11a container diagnostics:\n${diagnostics}`, { cause: error });
} finally {
  cleanup();
}

if (primaryFailure !== undefined || cleanupFailure !== undefined) {
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure], 'G11a runtime and cleanup both failed');
  }
  throw primaryFailure ?? cleanupFailure;
}
assert(cases.length === EXPECTED_CASES.length && cases.every((value, index) => value === EXPECTED_CASES[index]), 'G11a runtime exact case manifest is incomplete');
process.stdout.write(`${JSON.stringify({
  gate: 'G11a', status: 'PASS', project, cases,
  fingerprints: { apiImageId, ...deploymentFingerprints },
})}\n`);
