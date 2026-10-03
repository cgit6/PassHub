import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

const runToken = randomBytes(16).toString('hex');
const projectName = `passhub-g10b-fault-${process.pid}-${runToken}`;
const generatedNpmCacheVolume = `${projectName}_g10-fault-npm-cache`;
const compose = ['compose', '--project-name', projectName, '-f', 'infra/g10-fault-compose.yml'];
const mode = process.env.G10_FAULT_PROBE_MODE === 'g10c'
  ? '--g10c-transport-loss-probe'
  : '--g10b-wire-probe';
const mainDeadline = Date.now() + 180_000;
const CLEANUP_TIMEOUT_MS = 30_000;
let primaryFailure;

try {
  await run('docker', [...compose, 'up', '-d', 'mongo-g10', 'toxiproxy-g10']);
  await run('docker', [
    ...compose,
    'run', '--rm', '--no-deps', 'g10-fault-runner',
    'sh', '-lc',
    `node scripts/g10-fault-topology-init.mjs && exec node scripts/g10-fault-runner.mjs ${mode}`,
  ]);
} catch (error) {
  primaryFailure = error;
} finally {
  const cleanupDeadline = Date.now() + CLEANUP_TIMEOUT_MS;
  const cleanupFailures = [];
  try { await run('docker', [...compose, 'down', '--remove-orphans'], cleanupDeadline, 'cleanup'); } catch (error) { cleanupFailures.push(error); }
  try { await removeGeneratedNpmCacheVolume(cleanupDeadline); } catch (error) { cleanupFailures.push(error); }
  if (cleanupFailures.length > 0) {
    const cleanupError = new Error('G10b fault cleanup failed');
    if (primaryFailure === undefined) primaryFailure = cleanupError;
    else process.stderr.write('G10b fault cleanup also failed\n');
  }
}

if (primaryFailure !== undefined) throw primaryFailure;

function remainingMs(deadline, phase) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`G10b fault ${phase} exceeded its deadline`);
  return remaining;
}

async function run(command, args, deadline = mainDeadline, phase = 'probe') {
  const outcome = await runProcess(command, args, deadline, phase, false);
  if (outcome.code !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${outcome.signal ?? `exit ${outcome.code}`}`);
}

async function runProcess(command, args, deadline, phase, capture) {
  const timeoutMs = remainingMs(deadline, phase);
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKill;
    let stdout = ''; let stderr = '';
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false, env: process.env });
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

async function removeGeneratedNpmCacheVolume(cleanupDeadline) {
  const initialState = await inspectGeneratedNpmCacheVolume(cleanupDeadline);
  if (initialState === 'PRESENT') {
    await run('docker', ['volume', 'rm', generatedNpmCacheVolume], cleanupDeadline, 'cleanup');
  }
  if (await inspectGeneratedNpmCacheVolume(cleanupDeadline) !== 'ABSENT') {
    throw new Error('G10b fault cleanup left its generated npm-cache volume behind');
  }
}

async function inspectGeneratedNpmCacheVolume(cleanupDeadline) {
  const outcome = await runProcess('docker', ['volume', 'inspect', generatedNpmCacheVolume], cleanupDeadline, 'cleanup', true);
  if (outcome.code === 0) return 'PRESENT';
  if (outcome.code === 1 && /no such volume/iu.test(outcome.stderr)) return 'ABSENT';
  throw new Error('G10b fault cleanup could not confirm its generated npm-cache volume is absent');
}
