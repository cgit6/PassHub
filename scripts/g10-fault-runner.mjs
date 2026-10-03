import process from 'node:process';
import { spawn } from 'node:child_process';

// G10b/G10c may add fault cases here.  Until then, this entry point does not
// exercise application code; it only makes the three intentionally distinct
// in-network endpoints visible to a test container.
const requiredEnvironment = Object.freeze([
  'G10_FAULT_APP_MONGO_URI',
  'G10_FAULT_OBSERVER_MONGO_URI',
  'G10_FAULT_INTERFERER_MONGO_URI',
  'G10_FAULT_TOXIPROXY_API_URL',
]);

const contract = Object.create(null);
for (const name of requiredEnvironment) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`G10 fault runner requires ${name}`);
  }
  contract[name] = value;
}

const mode = process.argv[2];
if (process.argv.length !== 3 || !['--print-contract', '--g10b-wire-probe', '--g10c-transport-loss-probe'].includes(mode)) {
  throw new Error('G10 fault runner requires --print-contract, --g10b-wire-probe, or --g10c-transport-loss-probe');
}

if (mode === '--print-contract') {
  process.stdout.write(`${JSON.stringify(contract)}\n`);
} else {
  // The test is compiled by the host before Docker starts.  This container
  // receives the workspace read-only, which prevents a test run from leaving
  // root-owned build output behind on the host.
  const child = spawn(process.execPath, [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config',
    mode === '--g10b-wire-probe' ? 'jest.g10b.fault.config.cjs' : 'jest.g10c.fault.config.cjs',
    '--runInBand',
  ], { stdio: 'inherit', shell: false, env: process.env });
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (outcome.code !== 0) {
    throw new Error(`G10b wire probe failed with ${outcome.signal ?? `exit ${outcome.code}`}`);
  }
}
