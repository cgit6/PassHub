import { spawn } from 'node:child_process';
import process from 'node:process';

const composeFile = 'infra/g04a-mongo-compose.yml';
const uri =
  process.env.G04A_MONGO_URI ??
  'mongodb://127.0.0.1:27028/?replicaSet=rs0';
const database =
  process.env.G04A_MONGO_DATABASE ??
  `passhub_g04a_jest_${process.pid}`;

const compose = ['compose', '-f', composeFile];

await run('docker', [...compose, 'up', '-d']);
try {
  await run('node', ['scripts/g04a-init-replica-set.mjs'], {
    env: { ...process.env, G04A_MONGO_URI: uri },
  });
  await run('npm', ['run', 'test:integration'], {
    env: {
      ...process.env,
      G04A_MONGO_URI: uri,
      G04A_MONGO_DATABASE: database,
    },
  });
} finally {
  await run('docker', [...compose, 'down', '--remove-orphans']);
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: options.env,
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`,
        ),
      );
    });
  });
}
