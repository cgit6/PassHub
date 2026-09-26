import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

const composeFile = 'infra/g04b-mongo-compose.yml';
const projectName = 'passhub-g08a';
const nodeImage = 'node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
const uri = process.env.G08A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G08A_MONGO_DATABASE_PREFIX ?? `passhub_g08a_jest_${process.pid}`;
const compose = ['compose', '--project-name', projectName, '-f', composeFile];
const workspace = process.cwd();
const coverage = process.argv.includes('--coverage');
const coverageHost = process.env.G08A_COVERAGE_DIRECTORY ?? `/tmp/passhub-g08a-coverage-${process.pid}`;

let failure;
try {
  await run('docker', [...compose, 'up', '-d']);
  await run('node', ['scripts/g04b-init-replica-set.mjs'], { ...process.env, G04B_MONGO_URI: uri });
  if (coverage) await mkdir(coverageHost, { recursive: true });
  await run('docker', [
    'run', '--rm', '--network', 'host', '-v', `${workspace}:/workspace`, '-w', '/workspace',
    '-e', `G08A_MONGO_URI=${uri}`, '-e', `G08A_MONGO_DATABASE_PREFIX=${databasePrefix}`,
    ...(coverage ? ['-v', `${coverageHost}:/coverage`, '-e', 'G08A_COVERAGE_DIRECTORY=/coverage'] : []),
    nodeImage, 'sh', '-lc',
    `node --version && npm --version && npm run build && node --experimental-vm-modules node_modules/jest/bin/jest.js --config ${coverage ? 'jest.g08a.coverage.config.cjs --coverage' : 'jest.g08a.integration.config.cjs'}`,
  ]);
} catch (error) {
  failure = error;
} finally {
  try {
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
  } catch (cleanupError) {
    if (failure === undefined) failure = cleanupError;
    else process.stderr.write(`G08a cleanup also failed: ${String(cleanupError)}\n`);
  }
}
if (failure !== undefined) throw failure;
if (coverage) process.stdout.write(`G08a coverage reports: ${coverageHost}\n`);

async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`)));
  });
}
