import { spawn } from 'node:child_process';
import process from 'node:process';

const composeFile = 'infra/g04b-mongo-compose.yml';
const projectName = 'passhub-g04b';
const uri = process.env.G04B_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G04B_MONGO_DATABASE_PREFIX ?? `passhub_g04b_jest_${process.pid}`;
const compose = ['compose', '--project-name', projectName, '-f', composeFile];

let failure;
try {
  await run('docker', [...compose, 'up', '-d']);
  await run('node', ['scripts/g04b-init-replica-set.mjs'], {
    ...process.env,
    G04B_MONGO_URI: uri,
  });
  await run('npm', ['run', 'build']);
  await run(
    process.execPath,
    ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--config', 'jest.g04b.integration.config.cjs'],
    { ...process.env, G04B_MONGO_URI: uri, G04B_MONGO_DATABASE_PREFIX: databasePrefix },
  );
} catch (error) {
  failure = error;
} finally {
  try {
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
  } catch (cleanupError) {
    if (failure === undefined) {
      failure = cleanupError;
    } else {
      process.stderr.write(`G04b cleanup also failed: ${String(cleanupError)}\n`);
    }
  }
}

if (failure !== undefined) {
  throw failure;
}

async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}
