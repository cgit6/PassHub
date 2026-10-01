import process from 'node:process';

// The replica-set member advertises the proxy address, rather than Mongo's
// direct service address.  This is what keeps driver SDAM discovery on the
// fault path.  The observer intentionally uses directConnection for its
// independent, read-only view of the same single-member replica set.
const directUri = required('G10_FAULT_OBSERVER_MONGO_URI');
const appUri = required('G10_FAULT_APP_MONGO_URI');
const { MongoClient } = await import('mongodb');
const deadline = Date.now() + 30_000;

let initialized = false;
while (!initialized && Date.now() < deadline) {
  const client = createClient(directUri);
  try {
    await client.connect();
    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 });
    if (hello.setName !== 'rs0') {
      await admin.command({
        replSetInitiate: {
          _id: 'rs0',
          members: [{ _id: 0, host: 'toxiproxy-g10:27032' }],
        },
      });
    }
    initialized = true;
  } catch {
    await delay(250);
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (!initialized) throw new Error('G10 fault replica-set initialization deadline exceeded');

while (Date.now() < deadline) {
  const client = createClient(appUri);
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (
      hello.setName === 'rs0' &&
      hello.isWritablePrimary === true &&
      Array.isArray(hello.hosts) &&
      hello.hosts.length === 1 &&
      hello.hosts[0] === 'toxiproxy-g10:27032'
    ) {
      process.exitCode = 0;
      break;
    }
  } catch {
    // Election / proxy discovery can still be converging.
  } finally {
    await client.close().catch(() => undefined);
  }
  await delay(250);
}

if (Date.now() >= deadline) throw new Error('G10 fault proxy-path replica-set readiness deadline exceeded');

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function createClient(uri) {
  return new MongoClient(uri, {
    retryReads: false,
    retryWrites: false,
    maxAdaptiveRetries: 0,
    serverSelectionTimeoutMS: 1_000,
  });
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
