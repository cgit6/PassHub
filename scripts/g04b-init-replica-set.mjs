const uri = process.env.G04B_MONGO_INIT_URI ?? 'mongodb://127.0.0.1:27029/?directConnection=true';
const readinessUri = process.env.G04B_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const deadline = Date.now() + 30_000;
const { MongoClient } = await import('mongodb');

let initialized = false;
while (!initialized && Date.now() < deadline) {
  const client = new MongoClient(uri, {
    retryReads: false,
    retryWrites: false,
    maxAdaptiveRetries: 0,
    serverSelectionTimeoutMS: 1_000,
  });
  try {
    await client.connect();
    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 });
    if (hello.setName !== 'rs0') {
      await admin.command({
        replSetInitiate: {
          _id: 'rs0',
          members: [{ _id: 0, host: '127.0.0.1:27029' }],
        },
      });
    }
    initialized = true;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await client.close().catch(() => undefined);
  }
}
if (!initialized) {
  throw new Error('G04b replica-set initialization deadline exceeded');
}

while (Date.now() < deadline) {
  const probe = new MongoClient(readinessUri, {
    retryReads: false,
    retryWrites: false,
    maxAdaptiveRetries: 0,
    serverSelectionTimeoutMS: 1_000,
  });
  try {
    await probe.connect();
    const hello = await probe.db('admin').command({ hello: 1 });
    if (
      hello.setName === 'rs0' &&
      hello.isWritablePrimary === true &&
      Array.isArray(hello.hosts) &&
      hello.hosts.length === 1 &&
      hello.hosts[0] === '127.0.0.1:27029'
    ) {
      process.stdout.write('MongoDB 8.0.32 rs0 is writable at 127.0.0.1:27029\n');
      process.exitCode = 0;
      break;
    }
  } catch {
    // Election may still be in progress.
  } finally {
    await probe.close().catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (Date.now() >= deadline) {
  throw new Error('G04b replica-set readiness deadline exceeded');
}
