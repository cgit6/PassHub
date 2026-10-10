import { spawn } from 'node:child_process';
import process from 'node:process';

const composeFile = 'infra/g04b-mongo-compose.yml';
const projectName = `passhub-g12g2-${process.pid}`;
const nodeTestContainerName = `${projectName}-node-test`;
const nodeImage = 'node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
const uri = 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const database = `passhub_g12g2_${process.pid}`;
const compose = ['compose', '--project-name', projectName, '-f', composeFile];
const workspace = process.cwd();
const user = `${process.getuid()}:${process.getgid()}`;

let activeChild;
let receivedSignal;
let cleanupPromise;
let failure;

const signalHandler = (signal) => {
  if (receivedSignal !== undefined) return;
  receivedSignal = signal;
  if (activeChild !== undefined) {
    activeChild.kill('SIGTERM');
    const forceKill = setTimeout(() => activeChild?.kill('SIGKILL'), 2_000);
    forceKill.unref();
  }
};
const onSigint = () => signalHandler('SIGINT');
const onSigterm = () => signalHandler('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

try {
  await run('docker', [...compose, 'up', '-d']);
  await run('node', ['scripts/g04b-init-replica-set.mjs'], {
    ...process.env,
    G04B_MONGO_URI: uri,
  });
  await run('docker', [
    'run', '--rm', '--name', nodeTestContainerName, '--network', 'host', '--user', user,
    '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/npm-cache',
    '-v', `${workspace}:/workspace`, '-w', '/workspace',
    '-e', `G12G2_MONGO_URI=${uri}`, '-e', `G12G2_MONGO_DATABASE=${database}`,
    nodeImage, 'sh', '-lc',
    'test "$(node --version)" = "v24.21.0" && npm run build && node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.g12g2.integration.config.cjs',
  ]);
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (failure === undefined) failure = cleanupError;
    else process.stderr.write(`G12g-2 cleanup also failed: ${safeError(cleanupError)}\n`);
  }
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}

if (receivedSignal !== undefined) {
  process.stderr.write(`G12g-2 runner interrupted by ${receivedSignal}; scoped cleanup completed\n`);
  process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143;
} else if (failure !== undefined) {
  throw failure;
}

async function cleanup() {
  cleanupPromise ??= performCleanup();
  await cleanupPromise;
}

async function performCleanup() {
  const removal = await runCaptured('docker', ['rm', '--force', nodeTestContainerName]);
  if (removal.code !== 0 && !/No such container/u.test(removal.stderr)) {
    throw new Error('G12G2_NODE_CONTAINER_CLEANUP_FAILED');
  }
  const down = await runCaptured('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
  if (down.code !== 0) throw new Error('G12G2_COMPOSE_CLEANUP_FAILED');

  const checks = await Promise.all([
    runCaptured('docker', ['ps', '-a', '--filter', `name=^/${nodeTestContainerName}$`, '--format', '{{.Names}}']),
    runCaptured('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Names}}']),
    runCaptured('docker', ['network', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}']),
    runCaptured('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}']),
  ]);
  if (checks.some(({ code, stdout }) => code !== 0 || stdout.trim().length !== 0)) {
    throw new Error('G12G2_SCOPED_CLEANUP_INCOMPLETE');
  }
}

async function run(command, args, env = process.env) {
  if (receivedSignal !== undefined) throw new Error('G12G2_RUNNER_INTERRUPTED');
  if (activeChild !== undefined) throw new Error('G12G2_RUNNER_CONCURRENT_CHILD');
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, shell: false });
    activeChild = child;
    child.once('error', (error) => {
      if (activeChild === child) activeChild = undefined;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (receivedSignal !== undefined) reject(new Error('G12G2_RUNNER_INTERRUPTED'));
      else if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function runCaptured(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: safeError(error) }));
    child.once('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function safeError(error) {
  return error instanceof Error && /^G12G2_[A-Z_]+$/u.test(error.message)
    ? error.message
    : 'G12G2_CLEANUP_ERROR';
}
