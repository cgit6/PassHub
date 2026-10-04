import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const script = readFileSync('scripts/g12/run-docker-demo.mjs', 'utf8');
const docs = readFileSync('docs/demo/g12f-docker.md', 'utf8');
const readme = readFileSync('readme.md', 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(`G12f checker: ${message}`);
}

assert(packageJson.scripts?.['demo:g12f:docker'] === 'node scripts/g12/run-docker-demo.mjs', 'demo command is missing');
assert(packageJson.scripts?.['check:g12f:docker-demo'] === 'node scripts/g12/check-docker-demo.mjs', 'checker command is missing');
for (const marker of ['DOCKER_BUILD', 'MONGO_PRIMARY', 'API_READY', 'CREATE_QR', 'QR_ENTRY', 'INSIDE_QUERY', 'FACE_EXIT', 'EVENTS_EXITED']) {
  assert(script.includes(`'${marker}'`), `runner is missing ${marker}`);
}
for (const marker of ['Docker Compose', 'QR ENTRY', 'Face EXIT', 'EXITED', 'RTSP', '/internal/*', '清除']) {
  assert(docs.includes(marker), `demo documentation is missing ${marker}`);
}
for (const forbidden of ['React.js', 'Mongoose', 'Cloudinary', 'Twilio', 'PDFKit']) {
  assert(!readme.includes(forbidden), `stale README technology remains: ${forbidden}`);
}
assert(script.includes("resolve(repository, 'infra/g11/api.Dockerfile')"), 'runner does not reuse the G11 production Dockerfile');
assert(script.includes("const composeFile = resolve(repository, 'infra/g11/compose.yml')"), 'runner does not reuse the G11 production compose');
assert(script.includes("compose(['down', '--volumes', '--remove-orphans"), 'runner has no compose cleanup');
assert(script.includes("rmSync(temporary, { recursive: true, force: true })"), 'runner has no temporary directory cleanup');
for (const forbidden of ['/__g11a/', '/internal/ready', 'runtime-control.sock']) {
  assert(!docs.includes(forbidden), `public demo docs expose private path: ${forbidden}`);
}
process.stdout.write(JSON.stringify({ gate: 'G12f', status: 'PASS', checks: 13 }) + '\n');
