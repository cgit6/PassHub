import { spawn } from 'node:child_process';
import process from 'node:process';

const projectName = `passhub-g10b-fault-${process.pid}`;
const compose = ['compose', '--project-name', projectName, '-f', 'infra/g10-fault-compose.yml'];
const deadline = Date.now() + 180_000;
let primaryFailure;

try {
  await run('docker', [...compose, 'up', '-d', 'mongo-g10', 'toxiproxy-g10']);
  await run('docker', [
    ...compose,
    'run', '--rm', '--no-deps', 'g10-fault-runner',
    'sh', '-lc',
    'node scripts/g10-fault-topology-init.mjs && exec node scripts/g10-fault-runner.mjs --g10b-wire-probe',
  ]);
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
  } catch (cleanupError) {
    if (primaryFailure === undefined) primaryFailure = cleanupError;
    else process.stderr.write(`G10b fault cleanup also failed: ${String(cleanupError)}\n`);
  }
}

if (primaryFailure !== undefined) throw primaryFailure;

function remainingMs() {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('G10b fault probe exceeded its 180000ms deadline');
  return remaining;
}

async function run(command, args) {
  const timeoutMs = remainingMs();
  await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKill;
    const child = spawn(command, args, { stdio: 'inherit', shell: false, env: process.env });
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
      if (timedOut) reject(new Error(`${command} exceeded its phase deadline and was terminated`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}
