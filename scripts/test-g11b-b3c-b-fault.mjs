import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const projectName = `passhub-g11b-b3c-b-${process.pid}-${randomUUID()}`;
const generatedNpmCacheVolume = `${projectName}_g10-fault-npm-cache`;
const compose = ['compose', '--project-name', projectName, '-f', 'infra/g10-fault-compose.yml'];
const mainDeadline = Date.now() + 180_000;
const cleanupDeadlineMs = 30_000;
let primaryFailure;
let cleanupFailure;

try {
  await run('docker', [...compose, 'up', '-d', 'mongo-g10', 'toxiproxy-g10'], mainDeadline, 'setup');
  await run('npm', ['run', 'build'], mainDeadline, 'build');
  await run('docker', [
    ...compose,
    'run', '--rm', '--no-deps', 'g10-fault-runner',
    'sh', '-lc',
    'node scripts/g10-fault-topology-init.mjs && exec node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.g11b.b3c-b.fault.config.cjs --runInBand',
  ], mainDeadline, 'fault probe');
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    await cleanupProject(Date.now() + cleanupDeadlineMs);
  } catch (error) {
    cleanupFailure = error;
  }
}

if (primaryFailure !== undefined && cleanupFailure !== undefined) {
  throw new AggregateError(
    [primaryFailure, cleanupFailure],
    'G11b-b3c-b primary fault probe and cleanup both failed',
  );
}
if (primaryFailure !== undefined) throw primaryFailure;
if (cleanupFailure !== undefined) throw cleanupFailure;

async function cleanupProject(deadline) {
  const failures = [];
  try {
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '10'], deadline, 'cleanup');
  } catch (error) {
    failures.push(error);
  }
  try {
    await removeGeneratedNpmCacheVolume(deadline);
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
      const outcome = await runProcess('docker', args, deadline, 'cleanup verification', true);
      if (outcome.code !== 0) throw new Error(`Docker ${kind} inventory failed`);
      if (outcome.stdout.trim() !== '') failures.push(new Error(`G11b-b3c-b cleanup left project-scoped ${kind}`));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'G11b-b3c-b project cleanup failed');
}

async function removeGeneratedNpmCacheVolume(deadline) {
  const initial = await runProcess(
    'docker', ['volume', 'inspect', generatedNpmCacheVolume], deadline, 'cleanup volume inspection', true,
  );
  if (initial.code === 0) {
    await run('docker', ['volume', 'rm', generatedNpmCacheVolume], deadline, 'cleanup volume removal');
  } else if (!(initial.code === 1 && /no such volume/iu.test(initial.stderr))) {
    throw new Error('G11b-b3c-b could not inspect its generated cache volume');
  }
  const final = await runProcess(
    'docker', ['volume', 'inspect', generatedNpmCacheVolume], deadline, 'cleanup volume verification', true,
  );
  if (!(final.code === 1 && /no such volume/iu.test(final.stderr))) {
    throw new Error('G11b-b3c-b generated cache volume remained after cleanup');
  }
}

async function run(command, args, deadline, phase) {
  const outcome = await runProcess(command, args, deadline, phase, false);
  if (outcome.code !== 0) {
    throw new Error(`${command} ${phase} failed with ${outcome.signal ?? `exit ${outcome.code}`}`);
  }
}

async function runProcess(command, args, deadline, phase, capture) {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error(`G11b-b3c-b ${phase} exceeded its deadline`);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKill;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      env: process.env,
    });
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKill.unref();
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forceKill !== undefined) clearTimeout(forceKill);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (timedOut) reject(new Error(`${command} ${phase} deadline elapsed and it was terminated`));
      else resolve({ code, signal, stdout, stderr });
    });
  });
}
