import process from 'node:process';

// G10b/G10c may add fault cases here.  Until then, this entry point does not
// exercise application code; it only makes the three intentionally distinct
// in-network endpoints visible to a test container.
const requiredEnvironment = Object.freeze([
  'G10_FAULT_APP_MONGO_URI',
  'G10_FAULT_OBSERVER_MONGO_URI',
  'G10_FAULT_TOXIPROXY_API_URL',
]);

if (process.argv.length !== 3 || process.argv[2] !== '--print-contract') {
  throw new Error('G10 fault runner has no fault cases registered; use --print-contract only');
}

const contract = Object.create(null);
for (const name of requiredEnvironment) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`G10 fault runner requires ${name}`);
  }
  contract[name] = value;
}

process.stdout.write(`${JSON.stringify(contract)}\n`);
