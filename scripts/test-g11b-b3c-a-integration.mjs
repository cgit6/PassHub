import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const composeFile = 'infra/g04b-mongo-compose.yml';
const projectName = `passhub-g11b-b3c-a-${process.pid}-${randomUUID()}`;
const uri = process.env.G11B_B3C_A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databaseName = process.env.G11B_B3C_A_MONGO_DATABASE ?? `passhub_g11b_b3c_a_${process.pid}`;
const compose = ['compose', '--project-name', projectName, '-f', composeFile];

let primaryFailure;
let cleanupFailure;
try {
  await run('docker', [...compose, 'up', '-d']);
  await run('node', ['scripts/g04b-init-replica-set.mjs'], {
    ...process.env,
    G04B_MONGO_URI: uri,
  });
  await run('npm', ['run', 'build']);
  await run(process.execPath, [
    '--experimental-vm-modules', 'node_modules/jest/bin/jest.js',
    '--config', 'jest.g11b.b3c-a.integration.config.cjs',
  ], {
    ...process.env,
    G11B_B3C_A_MONGO_URI: uri,
    G11B_B3C_A_MONGO_DATABASE: databaseName,
  });
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    await cleanupProject();
  } catch (error) {
    cleanupFailure = error;
  }
}

if (primaryFailure !== undefined && cleanupFailure !== undefined) {
  throw new AggregateError(
    [primaryFailure, cleanupFailure],
    'G11b-b3c-a primary run and project cleanup both failed',
  );
}
if (primaryFailure !== undefined) throw primaryFailure;
if (cleanupFailure !== undefined) throw cleanupFailure;

async function cleanupProject() {
  const failures = [];
  try {
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '10'], process.env, 30_000);
  } catch (error) {
    failures.push(error);
  }
  const inventories = [
    ['containers', ['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.ID}}']],
    ['networks', ['network', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.ID}}']],
    ['volumes', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}']],
  ];
  for (const [kind, args] of inventories) {
    try {
      const remaining = await runCapture('docker', args, 10_000);
      if (remaining.trim() !== '') failures.push(new Error(`G11b-b3c-a cleanup left project-scoped ${kind}`));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'G11b-b3c-a project cleanup failed');
}

async function run(command, args, env = process.env, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, shell: false });
    let timedOut = false;
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (timedOut) reject(new Error(`${command} ${args.join(' ')} exceeded ${timeoutMs}ms`));
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function runCapture(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${command} ${args.join(' ')} exceeded ${timeoutMs}ms`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}: ${stderr.trim()}`));
      }
    });
  });
}
