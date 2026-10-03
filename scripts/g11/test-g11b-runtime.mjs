import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = process.cwd();
const composeFile = resolve(repository, 'infra/g11/compose.yml');
const project = `passhub-g11b-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const imageTag = `${project}-api:dev`;
const temporary = mkdtempSync(join(tmpdir(), `${project}-`));
const tls = join(temporary, 'tls');
const state = join(temporary, 'state');
const runtime = join(temporary, 'runtime');
const secrets = join(temporary, 'secrets');
const files = Object.fromEntries(['mongo-uri', 'jwt-key', 'comparison-key', 'mongo-root-username', 'mongo-root-password', 'mongo-keyfile'].map((name) => [name, join(secrets, name)]));
const rootUser = 'passhub_runtime_root';
const rootPassword = `root-${randomUUID()}`;
const password = `demo-${randomUUID()}`;
const sourceSecret = 'A'.repeat(43);
const jwtKey = 'j'.repeat(32);
const comparisonKey = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const expected = [
  'G11B_RUNTIME_IMMUTABLE_IMAGE', 'G11B_RUNTIME_BEFORE_CLAIM_CLOSED',
  'G11B_RUNTIME_TICKET_CONSUMED', 'G11B_RUNTIME_CANONICAL_CLAIM',
  'G11B_RUNTIME_LOCAL_READY', 'G11B_RUNTIME_BUSINESS_FLOW',
  'G11B_RUNTIME_PRIVATE_SOCKET', 'G11B_RUNTIME_SECRET_SCAN',
  'G11B_RUNTIME_SIGTERM_DISAPPEARANCE', 'G11B_RUNTIME_ORDINARY_RESTART_CLOSED',
  'G11B_RUNTIME_POSTCLAIM_FAILURE_CLOSED', 'G11B_RUNTIME_CLEANUP',
];
const cases = [];
const allowDirty = process.argv[2] === '--allow-dirty-development';
if (process.argv.length > (allowDirty ? 3 : 2)) throw new Error('G11b runtime arguments are invalid');
let sourceCommit;
let sourceDirty;
let sourceSha256;
const env = {
  ...process.env, PASSHUB_API_IMAGE: imageTag, PASSHUB_TLS_DIR: tls, PASSHUB_STATE_DIR: state,
  PASSHUB_RUNTIME_DIR: runtime, PASSHUB_MONGO_URI_FILE: files['mongo-uri'],
  PASSHUB_JWT_KEY_FILE: files['jwt-key'], PASSHUB_COMPARISON_KEY_FILE: files['comparison-key'],
  PASSHUB_MONGO_ROOT_USERNAME_FILE: files['mongo-root-username'], PASSHUB_MONGO_ROOT_PASSWORD_FILE: files['mongo-root-password'],
  PASSHUB_MONGO_KEYFILE: files['mongo-keyfile'], PASSHUB_HTTPS_BIND: '127.0.0.1', PASSHUB_HTTPS_PORT: '0',
};
const composeArgs = ['compose', '-p', project, '-f', composeFile];
let imageId;
let buildAttempted = false;
let failure;
let port;
let epoch;
let ticketId;
let ticketWire;
let ticketPath;
let runId = randomUUID();
const forbiddenSecrets = [rootPassword, password, sourceSecret, jwtKey, comparisonKey];
const httpEvidence = [];
const mongoEvidence = [];
const canonicalTicketPath = '/run/passhub/api/bootstrap-ticket.json';

function command(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8', env, timeout: options.timeout ?? 120_000,
      stdio: ['pipe', 'pipe', 'pipe'], input: options.input,
    }).trim();
  } catch {
    throw new Error(`G11b runtime ${binary} command failed`);
  }
}
const docker = (args, options) => command('docker', args, options);
const compose = (args, options) => docker([...composeArgs, ...args], options);
function assert(condition, message) { if (!condition) throw new Error(message); }
async function waitFor(label, probe, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch { /* readiness is observed again */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`G11b runtime timed out waiting for ${label}`);
}
function apiScript(script) { return compose(['exec', '-T', 'api', 'node', '-'], { input: script, timeout: 15_000 }); }
function oneOff(script) {
  return docker(['run', '--rm', '--interactive', '--network', `${project}_database`, '--user', '1000:1000',
    '--read-only', '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--env', 'PASSHUB_MONGO_URI_FILE=/run/secrets/app_mongo_uri',
    '--mount', `type=bind,source=${files['mongo-uri']},target=/run/secrets/app_mongo_uri,readonly`,
    imageId, 'node', '-'], { input: script, timeout: 30_000 });
}
function localStatus() {
  return Number(apiScript("fetch('http://127.0.0.1:3000/internal/ready').then(r=>process.stdout.write(String(r.status))).catch(()=>process.exit(1));"));
}
function mongoScript(script) {
  return `const {MongoClient}=require('mongodb');const fs=require('node:fs');(async()=>{const c=new MongoClient(fs.readFileSync(process.env.PASSHUB_MONGO_URI_FILE,'utf8').trim(),{retryReads:false,retryWrites:false});await c.connect();try{const db=c.db('passhub_demo');${script}}finally{await c.close();}})().catch(()=>{process.stderr.write('runtime fixture failed\\n');process.exitCode=1;});`;
}
function mongoExec(script) {
  const auth = "const fs=require('node:fs');const a=db.getSiblingDB('admin');const authResult=a.auth(fs.readFileSync('/run/secrets/mongo_root_username','utf8').trim(),fs.readFileSync('/run/secrets/mongo_root_password','utf8').trim());if(authResult!==true&&(!authResult||authResult.ok!==1))quit(2);";
  return compose(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', `${auth}${script}`]);
}
function metadata() {
  const output = oneOff(mongoScript("const m=await db.collection('metadata').findOne({_id:'system'});process.stdout.write(JSON.stringify({epoch:m.datasetEpoch,claim:m.writeRunClaim,claimedAtType:m.writeRunClaim===null?null:Object.prototype.toString.call(m.writeRunClaim.claimedAt)}));"));
  mongoEvidence.push(output);
  return JSON.parse(output);
}
function recordMongoSnapshot() {
  const output = oneOff(mongoScript("const names=await db.listCollections({}, {nameOnly:true}).toArray();const out={};for(const item of names)out[item.name]=await db.collection(item.name).find({}).toArray();process.stdout.write(JSON.stringify(out));"));
  mongoEvidence.push(output);
}
function seed() {
  const output = oneOff(mongoScript(`
    const {G04bMongoPersistenceAdapter}=require('./dist/src/infrastructure/mongo/g04b-persistence-adapter.js');
    const {createG04bFixture}=require('./dist/src/infrastructure/mongo/g04b-fixture.js');
    const {NodeScryptPasswordDeriver}=require('./dist/src/auth/infrastructure/node-scrypt-password-deriver.js');
    const {createHash}=require('node:crypto');
    const a=new G04bMongoPersistenceAdapter(c,'passhub_demo');await a.ensureSchema();
    const fixture=createG04bFixture(Date.now());const salt='e'.repeat(32);
    const hash=Buffer.from(await new NodeScryptPasswordDeriver().derive(${JSON.stringify(password)},Buffer.from(salt,'hex'))).toString('hex');
    const users=fixture.users.map(u=>({...u,passwordSalt:salt,passwordHash:hash}));
    const sources=fixture.sources.map(s=>({...s,credentialDigest:createHash('sha256').update(${JSON.stringify(sourceSecret)}).digest('hex')}));
    await a.clearAndSeed({...fixture,users,sources});process.stdout.write(fixture.datasetEpoch);
  `));
  assert(/^[0-9a-f-]{36}$/u.test(output), 'seed returned invalid epoch');
  epoch = output;
}
function writeIdentity() {
  rmSync(join(runtime, 'process-run-id'), { force: true });
  writeFileSync(join(runtime, 'process-run-id'), `${runId}\n`, { mode: 0o400 });
  chmodSync(join(runtime, 'process-run-id'), 0o400);
}
function issueTicket() {
  ticketId = randomUUID();
  forbiddenSecrets.push(ticketId);
  ticketPath = join(runtime, 'bootstrap-ticket.json');
  ticketWire = `${JSON.stringify({
    v: 'g11b.run-ticket.v1', ticketId, datasetEpoch: epoch, processRunId: runId,
  })}\n`;
  rmSync(ticketPath, { force: true });
  writeFileSync(ticketPath, ticketWire, { mode: 0o400 });
  chmodSync(ticketPath, 0o400);
}
function assertNoSecretEvidence(extraEvidence = []) {
  const inspections = ['api', 'mongo', 'proxy'].map((service) => {
    const id = compose(['ps', '-aq', service]);
    const inspected = JSON.parse(docker(['inspect', id]))[0];
    return { env: inspected.Config.Env, argv: inspected.Config.Cmd };
  });
  const logs = compose(['logs', '--no-color', 'api', 'mongo', 'proxy']);
  const logDirectory = join(runtime, 'logs');
  const runtimeLogs = existsSync(logDirectory) ? readdirSync(logDirectory)
    .filter((name) => /^runtime\.log(?:\.[1-4])?$/u.test(name))
    .map((name) => readFileSync(join(logDirectory, name), 'utf8')) : [];
  const nonHttpEvidence = JSON.stringify({ inspections, logs, runtimeLogs, mongoEvidence, extraEvidence });
  const forbiddenArtifacts = [...forbiddenSecrets, canonicalTicketPath, ticketPath, ticketWire].filter(Boolean);
  for (const secret of forbiddenArtifacts) {
    assert(!nonHttpEvidence.includes(secret), 'secret or ticket material leaked into runtime surfaces');
    for (const response of httpEvidence) {
      assert(!`${response.raw}${response.headers}`.includes(secret), 'unexpected secret or ticket material leaked in HTTP response');
    }
  }
}
function assertNoSecretValues(evidence) {
  for (const secret of [...forbiddenSecrets, canonicalTicketPath, ticketPath, ticketWire].filter(Boolean)) {
    assert(!evidence.includes(secret), 'secret or ticket material leaked into final evidence');
  }
}
function safeRuntimeStages() {
  const path = join(runtime, 'logs', 'runtime.log');
  if (!existsSync(path)) return [];
  const stages = [];
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (typeof record.code === 'string' && /^[A-Z_]{1,64}$/u.test(record.code)) stages.push(record.code);
    } catch { /* diagnostic never exports an unvalidated log record */ }
  }
  return stages.slice(-20);
}
function fingerprintSource() {
  const paths = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(`${path}\0`).update(readFileSync(join(repository, path))).update('\0');
  return hash.digest('hex');
}
function https(path, method = 'GET', body, headers = {}, allowedBodyFields = []) {
  return new Promise((resolveRequest, reject) => {
    const wire = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false,
      headers: { ...headers, ...(wire === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) }) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        const allowed = allowedBodyFields.map((field) => parsed && typeof parsed[field] === 'string' ? parsed[field] : null).filter(Boolean);
        const scrubbedBody = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([field]) => !allowedBodyFields.includes(field))))
          : raw;
        httpEvidence.push({ raw: scrubbedBody, headers: JSON.stringify(response.headers), allowed });
        resolveRequest({ status: response.statusCode, body: parsed });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('runtime HTTPS timeout')));
    req.once('error', reject); req.end(wire);
  });
}
function stopApi() {
  const before = metadata();
  const id = compose(['ps', '-q', 'api']);
  compose(['stop', '--timeout', '30', 'api'], { timeout: 40_000 });
  const stopped = JSON.parse(docker(['inspect', id]))[0];
  assert(stopped.State.Status === 'exited' && stopped.State.ExitCode === 0 && !stopped.State.OOMKilled, 'API did not stop gracefully');
  assert(!existsSync(join(runtime, 'control', 'runtime-control.sock')), 'private listener survived API shutdown');
  assert(JSON.stringify(metadata()) === JSON.stringify(before), 'graceful API shutdown changed the persistent claim');
  const connections = oneOff(mongoScript("const ops=await c.db('admin').command({currentOp:1,$all:true,idleConnections:true});process.stdout.write(String(ops.inprog.filter(op=>typeof op.client==='string'&&op.client.startsWith('172.31.212.20:')).length));"));
  assert(connections === '0', 'API Mongo connections survived API shutdown');
}

try {
  assert(process.geteuid?.() === 1000, 'runtime evidence requires host uid 1000 matching the immutable API user');
  sourceCommit = command('git', ['rev-parse', 'HEAD']);
  sourceDirty = command('git', ['status', '--porcelain']).length > 0;
  if (sourceDirty && !allowDirty) throw new Error('G11B_B5_FORMAL_EVIDENCE_REQUIRES_CLEAN_SOURCE');
  sourceSha256 = fingerprintSource();
  for (const directory of [tls, state, runtime, secrets]) mkdirSync(directory, { mode: 0o700 });
  chmodSync(temporary, 0o755); chmodSync(tls, 0o755); chmodSync(state, 0o755);
  const values = {
    'mongo-uri': `mongodb://${rootUser}:${rootPassword}@mongo:27017/passhub_demo?replicaSet=rs0&directConnection=true&authSource=admin`,
    'jwt-key': jwtKey, 'comparison-key': comparisonKey, 'mongo-root-username': rootUser,
    'mongo-root-password': rootPassword, 'mongo-keyfile': 'k'.repeat(756),
  };
  for (const [name, value] of Object.entries(values)) writeFileSync(files[name], `${value}\n`, { mode: 0o600 });
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(tls, 'tls.key'), '-out', join(tls, 'tls.crt')], { timeout: 30_000 });
  chmodSync(join(tls, 'tls.key'), 0o644); chmodSync(join(tls, 'tls.crt'), 0o644);
  buildAttempted = true;
  docker(['build', '--platform', 'linux/amd64', '-f', resolve(repository, 'infra/g11/api.Dockerfile'), '-t', imageTag, repository], { timeout: 600_000 });
  imageId = docker(['image', 'inspect', imageTag, '--format', '{{.Id}}']);
  assert(/^sha256:[0-9a-f]{64}$/u.test(imageId), 'API image is not immutable');
  env.PASSHUB_API_IMAGE = imageId;
  const model = JSON.parse(compose(['config', '--format', 'json']));
  assert(model.services.api.image === imageId && model.services.api.environment.PASSHUB_G11A_PROBE_MODE === undefined, 'runtime must use the production entrypoint without probe mode');
  cases.push(expected[0]);
  port = await new Promise((done, reject) => {
    const listener = createServer(); listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => { const address = listener.address(); listener.close((error) => error ? reject(error) : done(address.port)); });
  });
  env.PASSHUB_HTTPS_PORT = String(port);
  compose(['up', '-d', 'mongo']);
  await waitFor('Mongo ping', () => mongoExec('quit(db.adminCommand({ping:1}).ok===1?0:1)') === '');
  mongoExec("const h=db.getSiblingDB('admin').runCommand({hello:1});if(h.setName!=='rs0')rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]})");
  await waitFor('Mongo PRIMARY', () => mongoExec("const h=db.adminCommand({hello:1});quit(h.setName==='rs0'&&h.isWritablePrimary===true&&h.hosts.length===1?0:1)") === '');
  seed(); writeIdentity();
  compose(['up', '-d', 'api', 'proxy']);
  await waitFor('ordinary closed readiness', () => localStatus() === 503);
  await waitFor('HTTPS ordinary closed route', async () => (await https('/qualifications')).status === 503);
  assert(metadata().claim === null, 'ordinary startup wrote a claim');
  assertNoSecretEvidence();
  cases.push(expected[1]);
  stopApi(); issueTicket();
  compose(['start', 'api']);
  await waitFor('claimed local readiness', () => localStatus() === 200);
  assert(!existsSync(join(runtime, 'bootstrap-ticket.json')), 'pending canonical ticket survived consumption');
  const marker = join(runtime, `.bootstrap-ticket.used.${ticketId}`);
  assert(existsSync(marker) && statSync(marker).uid === 1000 && (statSync(marker).mode & 0o777) === 0o400, 'consumed marker missing or unsafe');
  cases.push(expected[2]);
  const claimed = metadata();
  assert(claimed.epoch === epoch && claimed.claim?.runId === runId && claimed.claimedAtType === '[object Date]', 'persistent claim is not canonical');
  cases.push(expected[3]);
  assert(localStatus() === 200 && (await https('/internal/ready')).status === 404, 'readiness was not private and open');
  cases.push(expected[4]);
  const login = await https('/auth/login', 'POST', { username: 'operator', password }, {}, ['accessToken']);
  assert(login.status === 200 && typeof login.body?.accessToken === 'string', 'real production login failed');
  const humanHeaders = { Authorization: `Bearer ${login.body.accessToken}`, 'PassHub-Dataset-Epoch': epoch };
  const validFrom = Date.now() + 1000;
  const created = await https('/qualifications', 'POST', {
    displayName: 'Runtime fixture', validFrom: new Date(validFrom).toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(), face: null,
  }, humanHeaders, ['qrToken']);
  const createCode = typeof created.body?.code === 'string' && /^[A-Z_]{1,64}$/u.test(created.body.code) ? created.body.code : 'NO_TECHNICAL_CODE';
  assert(created.status === 201 && typeof created.body?.qrToken === 'string', `real production create failed (status=${Number(created.status)},code=${createCode},stages=${safeRuntimeStages().join(',')})`);
  forbiddenSecrets.push(created.body.qrToken, login.body.accessToken);
  await waitFor('fixture validFrom', () => Date.now() >= validFrom, 10_000);
  const entry = await https('/recognition/attempts', 'POST', { externalEventId: 'runtime-entry', kind: 'QR_SCANNED', token: created.body.qrToken }, {
    Authorization: `Source entry.${sourceSecret}`, 'PassHub-Dataset-Epoch': epoch,
  });
  assert(entry.status === 200 && entry.body?.reasonCode === 'ENTRY_GRANTED', 'real production recognition failed');
  assert((await https('/qualifications', 'GET', undefined, humanHeaders)).status === 200, 'real production query failed');
  recordMongoSnapshot();
  cases.push(expected[5]);
  assert(existsSync(join(runtime, 'control', 'runtime-control.sock')), 'G10a private runtime socket absent');
  cases.push(expected[6]);
  assertNoSecretEvidence();
  cases.push(expected[7]);
  stopApi();
  assertNoSecretEvidence();
  cases.push(expected[8]);
  runId = randomUUID(); writeIdentity(); compose(['start', 'api']);
  await waitFor('ordinary same-epoch restart closed', () => localStatus() === 503);
  assert(metadata().claim?.runId === claimed.claim.runId && (await https('/qualifications')).status === 503, 'ordinary restart took over or became ready');
  assertNoSecretEvidence();
  stopApi();
  assertNoSecretEvidence();
  cases.push(expected[9]);
  // A fresh test dataset and ticket exercise failure after a confirmed claim.
  seed(); runId = randomUUID(); writeIdentity(); issueTicket();
  writeFileSync(files['comparison-key'], `${'f'.repeat(64)}\n`, { mode: 0o600 });
  forbiddenSecrets.push('f'.repeat(64));
  compose(['start', 'api']);
  await waitFor('post-claim failed composition diagnostic server', () => localStatus() === 503);
  assert(metadata().claim?.runId === runId && !existsSync(join(runtime, 'bootstrap-ticket.json')), 'post-claim failure cleared the claim or returned the ticket');
  assert((await https('/qualifications')).status === 503, 'failed composition forwarded business traffic');
  assertNoSecretEvidence();
  stopApi();
  assertNoSecretEvidence();
  cases.push(expected[10]);
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  try { compose(['down', '--volumes', '--remove-orphans', '--timeout', '30'], { timeout: 120_000 }); } catch { cleanupErrors.push('compose'); }
  try {
    for (const args of [
      ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
      ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
      ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
    ]) assert(docker(args).length === 0, 'project Docker resources survived cleanup');
  } catch { cleanupErrors.push('resources'); }
  if (buildAttempted) {
    try { docker(['image', 'rm', '--force', imageTag], { timeout: 60_000 }); } catch { /* exact absence query decides */ }
    try { assert(docker(['image', 'ls', '-q', '--filter', `reference=${imageTag}`]).length === 0, 'API image tag survived cleanup'); } catch { cleanupErrors.push('image'); }
  }
  try {
    assert(temporary.startsWith(join(tmpdir(), `${project}-`)), 'unsafe runtime temporary path');
    rmSync(temporary, { recursive: true, force: true });
    assert(!existsSync(temporary), 'runtime temporary path survived cleanup');
  } catch { cleanupErrors.push('temporary'); }
  if (cleanupErrors.length > 0) {
    const cleanupError = new Error(`G11b cleanup failed: ${cleanupErrors.join(',')}`);
    failure = failure === undefined ? cleanupError : new AggregateError([failure, cleanupError], 'G11b runtime and cleanup failed');
  }
  else cases.push(expected[11]);
}
if (failure !== undefined) throw failure;
assert(cases.length === expected.length && cases.every((value, index) => value === expected[index]), 'G11b runtime exact manifest incomplete');
assert(new Set(cases).size === expected.length && expected.length >= 9, 'G11b runtime manifest has duplicate or zero scenarios');
assert(fingerprintSource() === sourceSha256, 'G11b runtime source changed during execution');
const finalEvidence = JSON.stringify({
  gate: 'G11b', slice: 'b5', status: 'PASS', evidenceScope: sourceDirty ? 'development-process-slice' : 'clean-process-slice', cases,
  fingerprints: { sourceCommit, sourceDirty, sourceSha256, apiImageId: imageId, composeSha256: createHash('sha256').update(readFileSync(composeFile)).digest('hex'), dockerfileSha256: createHash('sha256').update(readFileSync(resolve(repository, 'infra/g11/api.Dockerfile'))).digest('hex') },
});
assertNoSecretValues(finalEvidence);
process.stdout.write(`${finalEvidence}\n`);
