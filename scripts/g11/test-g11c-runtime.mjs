import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// G11c runtime evidence only.  It intentionally does not reset, seed, or
// mutate business data after maintenance begins; reset/seed belongs to G11d.
const repository = process.cwd();
const composeFile = resolve(repository, 'infra/g11/compose.yml');
const project = `passhub-g11c-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const imageTag = `${project}-api:dev`;
const temporary = mkdtempSync(join(tmpdir(), `${project}-`));
const tls = join(temporary, 'tls'); const state = join(temporary, 'state');
const runtime = join(temporary, 'runtime'); const secrets = join(temporary, 'secrets');
const files = Object.fromEntries(['mongo-uri', 'jwt-key', 'comparison-key', 'mongo-root-username', 'mongo-root-password', 'mongo-keyfile'].map((name) => [name, join(secrets, name)]));
const rootUser = 'passhub_g11c_root'; const rootPassword = `root-${randomUUID()}`;
const password = `demo-${randomUUID()}`; const sourceSecret = 'A'.repeat(43);
const jwtKey = 'j'.repeat(32); const comparisonKey = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const composeArgs = ['compose', '-p', project, '-f', composeFile];
const allowDirty = process.argv[2] === '--allow-dirty-development';
if (process.argv.length > (allowDirty ? 3 : 2)) throw new Error('G11c runtime arguments are invalid');
const cases = [];
let sourceCommit; let sourceDirty; let sourceSha256; let imageId; let buildAttempted = false; let failure;
let epoch; const runId = randomUUID(); let ticketId; let port; let noLateObservations; let apiProcessEvidence; let mongoProcessEvidence;

function command(binary, args, options = {}) {
  try { return execFileSync(binary, args, { encoding: 'utf8', env, timeout: options.timeout ?? 120_000, input: options.input, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 'unknown';
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim().split('\n')[0]?.slice(0, 240) ?? '' : '';
    throw new Error(`G11c command failed: ${binary} ${args[0] ?? ''} exit=${String(status)}${stderr.length === 0 ? '' : ` detail=${stderr}`}`);
  }
}
const env = {
  ...process.env, PASSHUB_API_IMAGE: imageTag, PASSHUB_TLS_DIR: tls, PASSHUB_STATE_DIR: state, PASSHUB_RUNTIME_DIR: runtime,
  PASSHUB_MONGO_URI_FILE: files['mongo-uri'], PASSHUB_JWT_KEY_FILE: files['jwt-key'], PASSHUB_COMPARISON_KEY_FILE: files['comparison-key'],
  PASSHUB_MONGO_ROOT_USERNAME_FILE: files['mongo-root-username'], PASSHUB_MONGO_ROOT_PASSWORD_FILE: files['mongo-root-password'], PASSHUB_MONGO_KEYFILE: files['mongo-keyfile'],
  PASSHUB_HTTPS_BIND: '127.0.0.1', PASSHUB_HTTPS_PORT: '0',
};
const docker = (args, options) => command('docker', args, options);
const compose = (args, options) => docker([...composeArgs, ...args], options);
function assert(condition, message) { if (!condition) throw new Error(message); }
async function waitFor(label, probe, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await probe()) return; } catch { /* observe again */ } await new Promise((done) => setTimeout(done, 500)); }
  throw new Error(`G11c timed out waiting for ${label}`);
}
function apiScript(script) { return compose(['exec', '-T', 'api', 'node', '-'], { input: script, timeout: 15_000 }); }
function oneOff(script) {
  return docker(['run', '--rm', '--interactive', '--network', `${project}_database`, '--user', '1000:1000', '--read-only', '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--env', 'PASSHUB_MONGO_URI_FILE=/run/secrets/app_mongo_uri', '--mount', `type=bind,source=${files['mongo-uri']},target=/run/secrets/app_mongo_uri,readonly`, imageId, 'node', '-'], { input: script, timeout: 30_000 });
}
function mongoScript(script) { return `const{MongoClient}=require('mongodb');const fs=require('node:fs');(async()=>{const c=new MongoClient(fs.readFileSync(process.env.PASSHUB_MONGO_URI_FILE,'utf8').trim(),{retryReads:false,retryWrites:false});await c.connect();try{const db=c.db('passhub_demo');${script}}finally{await c.close()}})().catch(()=>{process.exitCode=1})`; }
function mongoExec(script) {
  const auth = "const fs=require('node:fs');const a=db.getSiblingDB('admin');const r=a.auth(fs.readFileSync('/run/secrets/mongo_root_username','utf8').trim(),fs.readFileSync('/run/secrets/mongo_root_password','utf8').trim());if(r!==true&&(!r||r.ok!==1))quit(2);";
  return compose(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', `${auth}${script}`]);
}
function metadata() { return JSON.parse(oneOff(mongoScript("const m=await db.collection('metadata').findOne({_id:'system'});process.stdout.write(JSON.stringify({epoch:m.datasetEpoch,claim:m.writeRunClaim}));"))); }
function datasetSnapshot() {
  return oneOff(mongoScript("const names=(await db.listCollections({}, {nameOnly:true}).toArray()).map(x=>x.name).sort();const out={};for(const name of names){const docs=await db.collection(name).find({}).sort({_id:1}).toArray();out[name]=docs;}process.stdout.write(JSON.stringify(out));"));
}
function apiDatabaseOperations() {
  return JSON.parse(oneOff(mongoScript("const result=await c.db('admin').command({currentOp:1,$all:true,idleConnections:true});const operations=result.inprog.filter(op=>typeof op.client==='string'&&op.client.startsWith('172.31.212.20:')).map(op=>({opid:op.opid,op:op.op,ns:op.ns,commandName:op.commandName??null}));process.stdout.write(JSON.stringify({count:operations.length,operations}));")));
}
async function verifyNoLateWork(apiIdentity, beforeSnapshot) {
  const observations=[];
  assert(containerState(apiIdentity.id).Running === false && containerState(apiIdentity.id).Pid === 0, 'old API process reappeared before no-late barrier');
  for (let index=0; index<3; index += 1) {
    const observation=apiDatabaseOperations();
    observations.push(observation);
    assert(observation.count === 0, 'old API database operation remained after process disappearance');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const afterSnapshot=datasetSnapshot();
  assert(afterSnapshot === beforeSnapshot, 'business collections changed after API disappearance and Mongo recovery');
  return observations;
}
function initMongo() {
  compose(['up', '-d', 'mongo']);
  // This is fixture setup before the maintenance lifecycle, not G11d reset.
  // G11c starts from an already prepared dataset and never calls this again.
  return (async () => {
    await waitFor('Mongo authentication', () => { try { return mongoExec('quit(db.runCommand({ping:1}).ok===1?0:1)') === ''; } catch { return false; } });
    mongoExec("const h=db.getSiblingDB('admin').runCommand({hello:1});if(h.setName!=='rs0')rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]})");
    await waitFor('Mongo PRIMARY', () => {
      try { return mongoExec("const h=db.adminCommand({hello:1});quit(h.setName==='rs0'&&h.isWritablePrimary===true&&h.hosts.length===1?0:1)") === ''; } catch { return false; }
    });
  })();
}
function seedBeforeMaintenance() {
  const output = oneOff(mongoScript(`
    const{G04bMongoPersistenceAdapter}=require('./dist/src/infrastructure/mongo/g04b-persistence-adapter.js');
    const{createG04bFixture}=require('./dist/src/infrastructure/mongo/g04b-fixture.js');
    const{NodeScryptPasswordDeriver}=require('./dist/src/auth/infrastructure/node-scrypt-password-deriver.js');const{createHash}=require('node:crypto');
    const a=new G04bMongoPersistenceAdapter(c,'passhub_demo');await a.ensureSchema();const f=createG04bFixture(Date.now());const salt='e'.repeat(32);
    const hash=Buffer.from(await new NodeScryptPasswordDeriver().derive(${JSON.stringify(password)},Buffer.from(salt,'hex'))).toString('hex');
    const users=f.users.map(u=>({...u,passwordSalt:salt,passwordHash:hash}));const sources=f.sources.map(s=>({...s,credentialDigest:createHash('sha256').update(${JSON.stringify(sourceSecret)}).digest('hex')}));
    await a.clearAndSeed({...f,users,sources});process.stdout.write(f.datasetEpoch);`));
  assert(/^[0-9a-f-]{36}$/u.test(output), 'seed epoch invalid'); epoch = output;
}
function writeBootstrap() {
  writeFileSync(join(runtime, 'process-run-id'), `${runId}\n`, { mode: 0o400 }); chmodSync(join(runtime, 'process-run-id'), 0o400);
  ticketId = randomUUID();
  writeFileSync(join(runtime, 'bootstrap-ticket.json'), `${JSON.stringify({ v: 'g11b.run-ticket.v1', ticketId, datasetEpoch: epoch, processRunId: runId })}\n`, { mode: 0o400 });
  chmodSync(join(runtime, 'bootstrap-ticket.json'), 0o400);
}
function runtimeReady() { return apiScript("fetch('http://127.0.0.1:3000/internal/ready').then(r=>process.stdout.write(String(r.status))).catch(()=>process.exit(1));") === '200'; }
function acquireMarker() {
  const path = join(state, 'maintenance');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  fsyncSync(fd); closeSync(fd); chmodSync(path, 0o600);
  assert(statSync(path).mode % 0o1000 === 0o600, 'maintenance marker mode invalid');
  return path;
}
function privateDrain(timeoutMs) {
  const socket = join(runtime, 'control', 'runtime-control.sock');
  const cli = resolve(repository, 'dist/src/runtime/internal/runtime-control-cli.js');
  const status = JSON.parse(command(process.execPath, [cli, socket], { input: `${JSON.stringify({ v: 'c1', requestControlId: randomUUID(), command: 'STATUS', epoch, run: runId })}\n`, timeout: 15_000 }));
  assert(status.ok === true && status.snapshot?.epoch === epoch && status.snapshot?.run === runId, 'private STATUS failed');
  const drain = JSON.parse(command(process.execPath, [cli, socket], { input: `${JSON.stringify({ v: 'c1', requestControlId: randomUUID(), command: 'DRAIN', epoch, run: runId, expectedRevision: status.revision, timeoutMs })}\n`, timeout: timeoutMs + 15_000 }));
  assert(drain.ok === true && drain.command === 'DRAIN' && (drain.outcome === 'DRAINED' || drain.outcome === 'NOT_DRAINED'), 'private DRAIN failed');
  return drain;
}
function containerState(id) { return JSON.parse(docker(['inspect', '--format={{json .State}}', id])); }
function stopAndObserve(service) {
  const id = compose(['ps', '-q', service]); assert(/^[0-9a-f]{12,64}$/u.test(id), `${service} identity missing`);
  const before = containerState(id); assert(before.Running === true && before.Pid > 0, `${service} was not running before stop`);
  compose(['stop', '--timeout', '30', service], { timeout: 40_000 });
  const after = containerState(id); assert(after.Running === false && after.Pid === 0 && after.Status === 'exited', `${service} process did not disappear`);
  return Object.freeze({ id, pidBefore: before.Pid, state: after });
}
function mongoPrimary() {
  compose(['start', 'mongo']);
  return waitFor('Mongo recovered PRIMARY', () => { try { return mongoExec("const h=db.adminCommand({hello:1});quit(h.setName==='rs0'&&h.isWritablePrimary===true&&h.hosts.length===1?0:1)") === ''; } catch { return false; } });
}
function fingerprint() { const files = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort(); const hash = createHash('sha256'); for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(repository, file))).update('\0'); return hash.digest('hex'); }
function findPort() { return new Promise((resolvePort, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close((error) => error ? reject(error) : resolvePort(address.port)); }); }); }
function identityEvidence(identity) {
  return { idSha256: createHash('sha256').update(identity.id).digest('hex'), pidBefore: identity.pidBefore, finalState: identity.state };
}

try {
  assert(process.geteuid?.() === 1000, 'G11c formal runtime requires uid 1000');
  sourceCommit = command('git', ['rev-parse', 'HEAD']); sourceDirty = command('git', ['status', '--porcelain']).length > 0;
  if (sourceDirty && !allowDirty) throw new Error('G11C_FORMAL_EVIDENCE_REQUIRES_CLEAN_SOURCE');
  sourceSha256 = fingerprint();
  for (const dir of [tls, state, runtime, secrets]) mkdirSync(dir, { mode: 0o700 });
  chmodSync(temporary, 0o755); chmodSync(tls, 0o755); chmodSync(state, 0o755);
  const values = { 'mongo-uri': `mongodb://${rootUser}:${rootPassword}@mongo:27017/passhub_demo?replicaSet=rs0&directConnection=true&authSource=admin`, 'jwt-key': jwtKey, 'comparison-key': comparisonKey, 'mongo-root-username': rootUser, 'mongo-root-password': rootPassword, 'mongo-keyfile': 'k'.repeat(756) };
  for (const [name, value] of Object.entries(values)) writeFileSync(files[name], `${value}\n`, { mode: 0o600 });
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(tls, 'tls.key'), '-out', join(tls, 'tls.crt')], { timeout: 30_000 }); chmodSync(join(tls, 'tls.key'), 0o644); chmodSync(join(tls, 'tls.crt'), 0o644);
  buildAttempted = true; docker(['build', '--platform', 'linux/amd64', '-f', resolve(repository, 'infra/g11/api.Dockerfile'), '-t', imageTag, repository], { timeout: 600_000 }); imageId = docker(['image', 'inspect', imageTag, '--format', '{{.Id}}']); env.PASSHUB_API_IMAGE = imageId;
  port = await findPort(); env.PASSHUB_HTTPS_PORT = String(port);
  await initMongo(); seedBeforeMaintenance(); writeBootstrap();
  compose(['up', '-d', 'api', 'proxy']); await waitFor('API ready', runtimeReady); assert(metadata().claim?.runId === runId, 'bootstrap claim missing'); cases.push('G11C_BOOTSTRAP_READY');
  const before = metadata(); const beforeSnapshot = datasetSnapshot(); const markerPath = acquireMarker(); assert(existsSync(markerPath), 'persistent marker missing'); cases.push('G11C_MARKER_ACTIVE');
  const drain = privateDrain(30_000); cases.push(`G11C_PRIVATE_DRAIN_${drain.outcome}`);
  const api = stopAndObserve('api'); apiProcessEvidence = identityEvidence(api); assert(!existsSync(join(runtime, 'control', 'runtime-control.sock')), 'API private socket survived'); cases.push('G11C_API_PROCESS_GONE');
  const mongo = stopAndObserve('mongo'); mongoProcessEvidence = identityEvidence(mongo); cases.push('G11C_MONGO_PROCESS_GONE');
  await mongoPrimary(); cases.push('G11C_MONGO_PRIMARY_RECOVERED');
  assert(existsSync(markerPath), 'maintenance marker disappeared during recovery'); assert(containerState(api.id).Running === false); assert(containerState(mongo.id).Running === true);
  const after = metadata(); assert(JSON.stringify(after) === JSON.stringify(before), 'no-late-work metadata changed across isolated recovery');
  noLateObservations = await verifyNoLateWork(api, beforeSnapshot); cases.push('G11C_NO_LATE_WORK_OBSERVED');
  assert(metadata().claim?.runId === runId, 'claim changed during G11c');
} catch (error) { failure = error; }
finally {
  const cleanup = []; try { compose(['down', '--volumes', '--remove-orphans', '--timeout', '30'], { timeout: 120_000 }); } catch { cleanup.push('compose'); }
  try { docker(['image', 'rm', '--force', imageTag], { timeout: 60_000 }); } catch { /* absence checked below */ }
  try { rmSync(temporary, { recursive: true, force: true }); } catch { cleanup.push('temporary'); }
  if (cleanup.length > 0) failure = failure === undefined ? new Error(`G11c cleanup failed: ${cleanup.join(',')}`) : new AggregateError([failure, new Error(`cleanup:${cleanup.join(',')}`)]);
}
if (failure !== undefined) throw failure;
assert(cases.includes('G11C_NO_LATE_WORK_OBSERVED'), 'G11c manifest incomplete');
assert(fingerprint() === sourceSha256, 'source changed during G11c runtime');
process.stdout.write(`${JSON.stringify({ gate: 'G11c', status: 'PASS', evidenceScope: sourceDirty ? 'development-runtime-slice' : 'clean-runtime-slice', cases, apiProcess: apiProcessEvidence, mongoProcess: mongoProcessEvidence, markerRemains: true, apiRemainsOff: true, mongoPrimaryRecovered: true, metadataStable: true, noLateObservations, sourceCommit, sourceDirty, sourceSha256, apiImageId: imageId, composeSha256: createHash('sha256').update(readFileSync(composeFile)).digest('hex') })}\n`);
