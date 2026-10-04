import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = process.cwd();
const composeFile = resolve(repository, 'infra/g11/compose.yml');
const project = `passhub-g12f-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const imageTag = `${project}-api:demo`;
const temporary = mkdtempSync(join(tmpdir(), `${project}-`));
const tls = join(temporary, 'tls');
const state = join(temporary, 'state');
const runtime = join(temporary, 'runtime');
const secrets = join(temporary, 'secrets');
const files = Object.fromEntries([
  'mongo-uri', 'jwt-key', 'comparison-key', 'mongo-root-username', 'mongo-root-password', 'mongo-keyfile',
].map((name) => [name, join(secrets, name)]));
const rootUser = 'passhub_g12f_root';
const rootPassword = `root-${randomUUID()}`;
const operatorPassword = `demo-${randomUUID()}`;
const sourceSecret = 'A'.repeat(43);
const jwtKey = 'j'.repeat(32);
const comparisonKey = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const composeArgs = ['compose', '-p', project, '-f', composeFile];
const env = {
  ...process.env,
  PASSHUB_API_IMAGE: imageTag,
  PASSHUB_TLS_DIR: tls,
  PASSHUB_STATE_DIR: state,
  PASSHUB_RUNTIME_DIR: runtime,
  PASSHUB_MONGO_URI_FILE: files['mongo-uri'],
  PASSHUB_JWT_KEY_FILE: files['jwt-key'],
  PASSHUB_COMPARISON_KEY_FILE: files['comparison-key'],
  PASSHUB_MONGO_ROOT_USERNAME_FILE: files['mongo-root-username'],
  PASSHUB_MONGO_ROOT_PASSWORD_FILE: files['mongo-root-password'],
  PASSHUB_MONGO_KEYFILE: files['mongo-keyfile'],
  PASSHUB_HTTPS_BIND: '127.0.0.1',
  PASSHUB_HTTPS_PORT: '0',
};
let imageBuilt = false;
let port;
let epoch;
let failure;

function command(binary, args, options = {}) {
  const output = execFileSync(binary, args, {
    encoding: 'utf8', env, timeout: options.timeout ?? 180_000,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'], input: options.input,
  });
  return typeof output === 'string' ? output.trim() : '';
}
const docker = (args, options) => command('docker', args, options);
const compose = (args, options) => docker([...composeArgs, ...args], options);
function assert(condition, message) { if (!condition) throw new Error(message); }
async function waitFor(label, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch { /* retry readiness probes */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`timed out waiting for ${label}`);
}
function mongoScript(script) {
  return `const {MongoClient}=require('mongodb');const fs=require('node:fs');(async()=>{const c=new MongoClient(fs.readFileSync(process.env.PASSHUB_MONGO_URI_FILE,'utf8').trim(),{retryReads:false,retryWrites:false});await c.connect();try{const db=c.db('passhub_demo');${script}}finally{await c.close();}})().catch(()=>process.exit(1));`;
}
function oneOff(script) {
  return docker(['run', '--rm', '--interactive', '--network', `${project}_database`, '--user', '1000:1000',
    '--read-only', '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--env', 'PASSHUB_MONGO_URI_FILE=/run/secrets/app_mongo_uri',
    '--mount', `type=bind,source=${files['mongo-uri']},target=/run/secrets/app_mongo_uri,readonly`,
    imageTag, 'node', '-'], { input: script, timeout: 30_000 });
}
function mongoExec(script) {
  const auth = "const fs=require('node:fs');const a=db.getSiblingDB('admin');const r=a.auth(fs.readFileSync('/run/secrets/mongo_root_username','utf8').trim(),fs.readFileSync('/run/secrets/mongo_root_password','utf8').trim());if(r!==true&&(!r||r.ok!==1))quit(2);";
  return compose(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', `${auth}${script}`]);
}
function seed() {
  epoch = oneOff(mongoScript(`
    const {G04bMongoPersistenceAdapter}=require('./dist/src/infrastructure/mongo/g04b-persistence-adapter.js');
    const {createG04bFixture}=require('./dist/src/infrastructure/mongo/g04b-fixture.js');
    const {NodeScryptPasswordDeriver}=require('./dist/src/auth/infrastructure/node-scrypt-password-deriver.js');
    const {createHash}=require('node:crypto');
    const adapter=new G04bMongoPersistenceAdapter(c,'passhub_demo');await adapter.ensureSchema();
    const fixture=createG04bFixture(Date.now());const salt='e'.repeat(32);
    const hash=Buffer.from(await new NodeScryptPasswordDeriver().derive(${JSON.stringify(operatorPassword)},Buffer.from(salt,'hex'))).toString('hex');
    const users=fixture.users.map(u=>({...u,passwordSalt:salt,passwordHash:hash}));
    const sources=fixture.sources.map(s=>({...s,credentialDigest:createHash('sha256').update(${JSON.stringify(sourceSecret)}).digest('hex')}));
    await adapter.clearAndSeed({...fixture,users,sources});process.stdout.write(fixture.datasetEpoch);
  `));
  assert(/^[0-9a-f-]{36}$/u.test(epoch), 'seed did not return a dataset epoch');
}
function prepareRuntime() {
  const runId = randomUUID();
  const ticketId = randomUUID();
  writeFileSync(join(runtime, 'process-run-id'), `${runId}\n`, { mode: 0o400 });
  writeFileSync(join(runtime, 'bootstrap-ticket.json'), `${JSON.stringify({ v: 'g11b.run-ticket.v1', ticketId, datasetEpoch: epoch, processRunId: runId })}\n`, { mode: 0o400 });
  chmodSync(join(runtime, 'process-run-id'), 0o400);
  chmodSync(join(runtime, 'bootstrap-ticket.json'), 0o400);
}
function httpsRequest(path, method, body, headers = {}) {
  return new Promise((resolveRequest, reject) => {
    const wire = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false,
      headers: { ...headers, ...(wire === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) }) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = null; }
        resolveRequest({ status: response.statusCode ?? 0, body: parsed, raw });
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('HTTPS request timed out')));
    req.once('error', reject); req.end(wire);
  });
}
async function waitForReady() {
  await waitFor('API readiness', async () => {
    const result = await httpsRequest('/auth/login', 'POST', { username: 'operator', password: operatorPassword });
    return result.status === 200;
  });
}
async function runDemo() {
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      const address = server.address(); if (address === null || typeof address === 'string') return reject(new Error('port unavailable'));
      port = address.port; server.close((error) => error === undefined ? resolvePort() : reject(error));
    });
  });
  env.PASSHUB_HTTPS_PORT = String(port);
  compose(['up', '-d', 'mongo']);
  await waitFor('Mongo ping', () => mongoExec('quit(db.adminCommand({ping:1}).ok===1?0:1)') === '');
  mongoExec("const h=db.getSiblingDB('admin').runCommand({hello:1});if(h.setName!=='rs0')rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]})");
  await waitFor('Mongo primary', () => mongoExec("const h=db.adminCommand({hello:1});quit(h.setName==='rs0'&&h.isWritablePrimary===true&&h.hosts.length===1?0:1)") === '');
  seed(); prepareRuntime();
  compose(['up', '-d', 'api', 'proxy']); await waitForReady();

  const login = await httpsRequest('/auth/login', 'POST', { username: 'operator', password: operatorPassword });
  assert(login.status === 200 && typeof login.body?.accessToken === 'string', 'operator login failed');
  const human = { Authorization: `Bearer ${login.body.accessToken}`, 'PassHub-Dataset-Epoch': epoch };
  const created = await httpsRequest('/qualifications', 'POST', {
    displayName: 'G12f Docker Demo Visitor', validFrom: new Date(Date.now() - 1_000).toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(), face: { provider: 'DemoFace', externalSubjectId: 'g12f-demo-subject' },
  }, human);
  assert(created.status === 201 && typeof created.body?.qualificationId === 'string' && typeof created.body?.qrToken === 'string', 'qualification create failed');
  const sourceHeaders = (alias) => ({ Authorization: `Source ${alias}.${sourceSecret}`, 'PassHub-Dataset-Epoch': epoch });
  const entry = await httpsRequest('/recognition/attempts', 'POST', { externalEventId: 'g12f-entry-001', kind: 'QR_SCANNED', token: created.body.qrToken }, sourceHeaders('entry'));
  assert(entry.status === 200 && entry.body?.reasonCode === 'ENTRY_GRANTED', 'QR ENTRY was not granted');
  const inside = await httpsRequest('/qualifications/inside', 'GET', undefined, human);
  assert(inside.status === 200 && inside.raw.includes(created.body.qualificationId) && inside.raw.includes('INSIDE'), 'INSIDE query did not show the visitor');
  const exit = await httpsRequest('/recognition/attempts', 'POST', { externalEventId: 'g12f-exit-001', kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'g12f-demo-subject' }, sourceHeaders('exit'));
  assert(exit.status === 200 && exit.body?.reasonCode === 'EXIT_RECORDED', 'Face EXIT was not recorded');
  const detail = await httpsRequest(`/qualifications/${created.body.qualificationId}`, 'GET', undefined, human);
  assert(detail.status === 200 && detail.raw.includes('EXITED'), 'qualification detail did not reach EXITED');
  const events = await httpsRequest('/events', 'GET', undefined, human);
  assert(events.status === 200 && events.raw.includes('ENTRY_GRANTED') && events.raw.includes('EXIT_RECORDED'), 'event query did not include both decisions');
  process.stdout.write(JSON.stringify({ gate: 'G12f', status: 'PASS', cases: ['DOCKER_BUILD', 'MONGO_PRIMARY', 'API_READY', 'CREATE_QR', 'QR_ENTRY', 'INSIDE_QUERY', 'FACE_EXIT', 'EVENTS_EXITED'], imageTag, imageId: docker(['image', 'inspect', imageTag, '--format', '{{.Id}}']), composeSha256: createHash('sha256').update(readFileSync(composeFile)).digest('hex') }) + '\n');
}
try {
  for (const directory of [tls, state, runtime, secrets]) mkdirSync(directory, { mode: 0o700 });
  chmodSync(temporary, 0o755); chmodSync(tls, 0o755); chmodSync(state, 0o755);
  const values = {
    'mongo-uri': `mongodb://${rootUser}:${rootPassword}@mongo:27017/passhub_demo?replicaSet=rs0&directConnection=true&authSource=admin`,
    'jwt-key': jwtKey, 'comparison-key': comparisonKey, 'mongo-root-username': rootUser,
    'mongo-root-password': rootPassword, 'mongo-keyfile': 'k'.repeat(756),
  };
  for (const [name, value] of Object.entries(values)) writeFileSync(files[name], `${value}\n`, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(tls, 'tls.key'), '-out', join(tls, 'tls.crt')], { stdio: 'ignore' });
  chmodSync(join(tls, 'tls.key'), 0o644); chmodSync(join(tls, 'tls.crt'), 0o644);
  docker(['build', '--platform', 'linux/amd64', '-f', resolve(repository, 'infra/g11/api.Dockerfile'), '-t', imageTag, repository], { timeout: 600_000, stdio: 'ignore' });
  imageBuilt = true; await runDemo();
} catch (error) { failure = error; }
finally {
  try { compose(['down', '--volumes', '--remove-orphans', '--timeout', '30'], { timeout: 120_000 }); } catch (error) { failure ??= error; }
  try { if (imageBuilt) docker(['image', 'rm', '--force', imageTag], { timeout: 60_000 }); } catch (error) { failure ??= error; }
  try { rmSync(temporary, { recursive: true, force: true }); } catch (error) { failure ??= error; }
}
if (failure !== undefined) { process.stderr.write(`G12f Docker Demo failed: ${failure instanceof Error ? failure.message : String(failure)}\n`); process.exitCode = 1; }
