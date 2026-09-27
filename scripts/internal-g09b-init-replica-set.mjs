import process from 'node:process';
import { MongoClient } from 'mongodb';

const port = 27039;
const bootstrapUri = process.env.G09B_MONGO_BOOTSTRAP_URI ?? `mongodb://127.0.0.1:${port}/?directConnection=true`;
const readinessUri = process.env.G09B_MONGO_URI ?? `mongodb://127.0.0.1:${port}/?replicaSet=rs0`;
const deadline = Date.now() + 60_000;

let initiated = false;
while (!initiated && Date.now() < deadline) {
  const client = new MongoClient(bootstrapUri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, serverSelectionTimeoutMS: 1_000 });
  try {
    await client.connect();
    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 });
    if (hello.setName !== 'rs0') {
      await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    }
    initiated = true;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await client.close().catch(() => undefined);
  }
}
if (!initiated) throw new Error('G09b replica-set initialization deadline exceeded');

while (Date.now() < deadline) {
  const client = new MongoClient(readinessUri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, serverSelectionTimeoutMS: 1_000 });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (hello.setName === 'rs0' && hello.isWritablePrimary === true && Array.isArray(hello.hosts) && hello.hosts.length === 1 && hello.hosts[0] === `127.0.0.1:${port}`) {
      process.stdout.write(`MongoDB 8.0.32 rs0 is writable at 127.0.0.1:${port}\n`);
      process.exit(0);
    }
  } catch {
    // Election may still be in progress.
  } finally {
    await client.close().catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
throw new Error('G09b replica-set readiness deadline exceeded');
