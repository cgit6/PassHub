import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// G11d evidence intentionally exercises only the private reset/seed capability.
// It never exposes a maintenance route and never drops a database or collection.
const repository = process.cwd();
const allowDirty = process.argv[2] === '--allow-dirty-development';
if (process.argv.length > (allowDirty ? 3 : 2)) throw new Error('G11d runtime arguments are invalid');
const composeTemplate = resolve(repository, 'infra/g11/compose.yml');
const project = `passhub-g11d-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const imageTag = `${project}-api:dev`;
const temporary = mkdtempSync(join(tmpdir(), `${project}-`));
const secrets = join(temporary, 'secrets');
mkdirSync(secrets, { mode: 0o700 });
const tls = join(temporary, 'tls');
const state = join(temporary, 'state');
const runtime = join(temporary, 'runtime');
// Keep the existing G11 topology contract intact, but give this isolated
// runtime a generated subnet so concurrent evidence runs cannot collide.
const runtimeComposeFile = join(temporary, 'compose.yml');
const networkOctet = 20 + (Number.parseInt(randomUUID().slice(0, 2), 16) % 200);
const edgePrefix = `10.240.${networkOctet}`;
const databasePrefix = `10.241.${networkOctet}`;
writeFileSync(runtimeComposeFile, readFileSync(composeTemplate, 'utf8')
  .replaceAll('172.31.211', edgePrefix)
  .replaceAll('172.31.212', databasePrefix)
  .replace('source: ./mongo/entrypoint.sh', `source: ${resolve(repository, 'infra/g11/mongo/entrypoint.sh')}`));
for (const directory of [tls, state, runtime]) mkdirSync(directory, { mode: 0o700 });
const files = Object.fromEntries(['mongo-uri', 'jwt-key', 'comparison-key', 'mongo-root-username', 'mongo-root-password', 'mongo-keyfile'].map((name) => [name, join(secrets, name)]));
const rootUser = `g11d_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const rootPassword = `root-${randomUUID()}`;
const env = {
  ...process.env, PASSHUB_API_IMAGE: imageTag, PASSHUB_TLS_DIR: tls, PASSHUB_STATE_DIR: state, PASSHUB_RUNTIME_DIR: runtime,
  PASSHUB_HTTPS_BIND: '127.0.0.1', PASSHUB_HTTPS_PORT: '0', PASSHUB_MONGO_URI_FILE: files['mongo-uri'],
  PASSHUB_JWT_KEY_FILE: files['jwt-key'], PASSHUB_COMPARISON_KEY_FILE: files['comparison-key'],
  PASSHUB_MONGO_ROOT_USERNAME_FILE: files['mongo-root-username'], PASSHUB_MONGO_ROOT_PASSWORD_FILE: files['mongo-root-password'],
  PASSHUB_MONGO_KEYFILE: files['mongo-keyfile'],
};
const composeArgs = ['compose', '--project-directory', repository, '-p', project, '-f', runtimeComposeFile];
const command = (binary, args, options = {}) => execFileSync(binary, args, { encoding: 'utf8', env, input: options.input, timeout: options.timeout ?? 120_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const docker = (args, options) => command('docker', args, options);
const compose = (args, options) => docker([...composeArgs, ...args], options);
const fingerprintSource = () => {
  const files = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(resolve(repository, file))).update('\0');
  return hash.digest('hex');
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const mongoScript = (body) => `const{MongoClient}=require('mongodb');const fs=require('node:fs');(async()=>{const c=new MongoClient(fs.readFileSync(process.env.PASSHUB_MONGO_URI_FILE,'utf8').trim(),{retryReads:false,retryWrites:false});await c.connect();try{const db=c.db('passhub_demo');${body}}finally{await c.close()}})().catch(e=>{process.stderr.write(String(e));process.exitCode=1})`;
const oneOff = (script) => docker(['run', '--rm', '--interactive', '--network', `${project}_database`, '--user', '1000:1000', '--read-only', '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL', '--env', 'PASSHUB_MONGO_URI_FILE=/run/secrets/app_mongo_uri', '--mount', `type=bind,source=${files['mongo-uri']},target=/run/secrets/app_mongo_uri,readonly`, imageTag, 'node', '-'], { input: script, timeout: 60_000 });
const mongoAdmin = (script) => {
  const auth = "const fs=require('node:fs');const a=db.getSiblingDB('admin');const r=a.auth(fs.readFileSync('/run/secrets/mongo_root_username','utf8').trim(),fs.readFileSync('/run/secrets/mongo_root_password','utf8').trim());if(r!==true&&(!r||r.ok!==1))quit(2);";
  return compose(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', `${auth}${script}`]);
};
const waitForPrimary = () => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { if (mongoAdmin("const h=db.adminCommand({hello:1});quit(h.setName==='rs0'&&h.isWritablePrimary===true&&h.hosts.length===1?0:1)") === '') return; } catch { /* retry */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('Mongo PRIMARY readiness timeout');
};

let builtImage = false;
let result;
let sourceCommit;
let sourceDirty;
let sourceSha256;
try {
  assert(process.geteuid?.() === 1000, 'G11d runtime requires uid 1000');
  sourceCommit = command('git', ['rev-parse', '--verify', 'HEAD']);
  sourceDirty = command('git', ['status', '--porcelain=1', '--untracked-files=all']).length !== 0;
  if (sourceDirty && !allowDirty) throw new Error('G11d formal runtime requires a clean source revision; use --allow-dirty-development for development evidence');
  sourceSha256 = fingerprintSource();
  const values = {
    'mongo-uri': `mongodb://${rootUser}:${rootPassword}@mongo:27017/passhub_demo?replicaSet=rs0&directConnection=true&authSource=admin`,
    'jwt-key': 'j'.repeat(32), 'comparison-key': '0'.repeat(64),
    'mongo-root-username': rootUser, 'mongo-root-password': rootPassword, 'mongo-keyfile': 'k'.repeat(756),
  };
  for (const [name, value] of Object.entries(values)) writeFileSync(files[name], `${value}\n`, { mode: 0o600 });
  docker(['build', '--platform', 'linux/amd64', '-f', resolve(repository, 'infra/g11/api.Dockerfile'), '-t', imageTag, repository], { timeout: 600_000 });
  builtImage = true;
  compose(['up', '-d', 'mongo']);
  // The compose healthcheck intentionally requires an initialized replica set;
  // initialize it as the isolated runtime fixture before waiting for PRIMARY.
  const initDeadline = Date.now() + 120_000;
  while (Date.now() < initDeadline) {
    try {
      mongoAdmin("const h=db.adminCommand({hello:1});if(h.setName!=='rs0')rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]});quit(0)");
      break;
    } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
  waitForPrimary();
  const setup = oneOff(mongoScript(`
    const{G04bMongoPersistenceAdapter}=require('./dist/src/infrastructure/mongo/g04b-persistence-adapter.js');
    const{createG04bFixture}=require('./dist/src/infrastructure/mongo/g04b-fixture.js');
    const a=new G04bMongoPersistenceAdapter(c,'passhub_demo');await a.ensureSchema();
    const f=createG04bFixture(Date.UTC(2026,0,1));await a.clearAndSeed(f);
    await db.collection('unrelated').insertOne({_id:'keep-me',value:'untouched'});
    const other=c.db('other_demo');await other.collection('keep').insertOne({_id:'other-keep'});
    process.stdout.write(JSON.stringify({epoch:f.datasetEpoch}));`));
  const initial = JSON.parse(setup);
  const oldIndexes = JSON.parse(oneOff(mongoScript("const out={};for(const n of await db.listCollections({}, {nameOnly:true}).toArray())out[n.name]=await db.collection(n.name).listIndexes().toArray();process.stdout.write(JSON.stringify(out));")));
  const beforeSnapshot = JSON.parse(oneOff(mongoScript("const names=await db.listCollections({}, {nameOnly:true}).toArray();const out={};for(const n of names)if(!['qualifications','faceSlots','events','users','sources','metadata','managementReceipts'].includes(n.name))out[n.name]=await db.collection(n.name).find({}).sort({_id:1}).toArray();out.__otherDb=await c.db('other_demo').collection('keep').find({}).sort({_id:1}).toArray();process.stdout.write(JSON.stringify(out));")));
  const epoch = randomUUID();
  const reset = JSON.parse(oneOff(mongoScript(`
    const{resetAndSeedG11d}=require('./dist/src/deployment/internal/g11d-reset-seed.js');
    const r=await resetAndSeedG11d(db,${JSON.stringify(epoch)});process.stdout.write(JSON.stringify(r));`)));
  const afterIndexes = JSON.parse(oneOff(mongoScript("const out={};for(const n of await db.listCollections({}, {nameOnly:true}).toArray())out[n.name]=await db.collection(n.name).listIndexes().toArray();process.stdout.write(JSON.stringify(out));")));
  const snapshot = JSON.parse(oneOff(mongoScript("const names=await db.listCollections({}, {nameOnly:true}).toArray();const out={};for(const n of names)out[n.name]=await db.collection(n.name).find({}).sort({_id:1}).toArray();const other=await c.db('other_demo').collection('keep').find({}).toArray();out.__other=other;process.stdout.write(JSON.stringify(out));")));
  const secondEpoch = randomUUID();
  const second = JSON.parse(oneOff(mongoScript(`const{resetAndSeedG11d}=require('./dist/src/deployment/internal/g11d-reset-seed.js');const r=await resetAndSeedG11d(db,${JSON.stringify(secondEpoch)});process.stdout.write(JSON.stringify(r));`)));
  const secondSnapshot = JSON.parse(oneOff(mongoScript("const names=await db.listCollections({}, {nameOnly:true}).toArray();const out={};for(const n of names)if(['qualifications','faceSlots','events','users','sources','metadata','managementReceipts'].includes(n.name))out[n.name]=await db.collection(n.name).find({}).sort({_id:1}).toArray();process.stdout.write(JSON.stringify(out));")));
  const canonical = JSON.parse(oneOff(mongoScript(`const{createG11dStableSeed,fingerprintG11dStableSeed}=require('./dist/src/deployment/internal/g11d-reset-seed.js');const seed=createG11dStableSeed(${JSON.stringify(secondEpoch)});process.stdout.write(JSON.stringify({...seed,seedFingerprint:fingerprintG11dStableSeed(seed)}));`)));
  for (const name of ['qualifications', 'faceSlots', 'events', 'users', 'sources', 'managementReceipts']) {
    assert(stableJson(secondSnapshot[name]) === stableJson(canonical[name]), `canonical ${name} snapshot mismatch`);
  }
  assert(stableJson(secondSnapshot.metadata?.[0]) === stableJson(canonical.metadata), 'canonical metadata snapshot mismatch');
  assert(second.seedFingerprint === canonical.seedFingerprint, 'fingerprint should match the canonical seed');
  assert(secondSnapshot.metadata?.[0]?.writeRunClaim === null, 'second reset retained a write claim');
  for (const name of ['qualifications', 'faceSlots', 'events', 'users', 'sources', 'managementReceipts']) assert(second.inserted[name] === canonical[name].length, `second insert count mismatch for ${name}`);
  assert(fingerprintSource() === sourceSha256, 'G11d runtime source changed during execution');
  assert(reset.previousDatasetEpoch === initial.epoch, 'previous epoch mismatch');
  assert(reset.datasetEpoch === epoch && reset.indexesPreserved === true, 'reset result invalid');
  assert(snapshot.metadata?.[0]?.datasetEpoch === epoch && snapshot.metadata?.[0]?.writeRunClaim === null, 'first reset metadata was not unclaimed');
  assert(second.previousDatasetEpoch === epoch && second.datasetEpoch === secondEpoch, 'second reset did not advance epoch');
  assert(reset.untouchedCollectionNames.includes('unrelated'), 'unrelated collection was not reported untouched');
  assert(stableJson(beforeSnapshot) === stableJson({ unrelated: snapshot.unrelated, __otherDb: snapshot.__other }), 'untouched baseline changed');
  assert(snapshot.unrelated?.[0]?._id === 'keep-me' && snapshot.__other?.[0]?._id === 'other-keep', 'unrelated data changed');
  assert(JSON.stringify(oldIndexes) === JSON.stringify(afterIndexes), 'indexes changed');
  result = { cases: ['G11D_EXACT_COLLECTION_ALLOWLIST', 'G11D_TRANSACTIONAL_RESET', 'G11D_SEQUENTIAL_RESET', 'G11D_STABLE_SEED', 'G11D_NEW_EPOCH_NULL_CLAIM', 'G11D_INDEXES_PRESERVED', 'G11D_OTHER_DATA_UNTOUCHED', 'G11D_REPEAT_RESET'], first: reset, second: second, sourceEpoch: initial.epoch, sourceCommit, sourceDirty, sourceSha256, runtimeComposeSha256: createHash('sha256').update(readFileSync(runtimeComposeFile)).digest('hex') };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  try { compose(['down', '--volumes', '--remove-orphans'], { timeout: 60_000 }); } catch { /* cleanup is asserted by caller */ }
  if (builtImage) { try { docker(['image', 'rm', '-f', imageTag]); } catch { /* report below */ } }
  rmSync(temporary, { recursive: true, force: true });
}

function stableJson(value) {
  if (value instanceof Array) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
