const uri =
  process.env.G04A_MONGO_URI ??
  'mongodb://127.0.0.1:27028';
const initializationUri =
  process.env.G04A_MONGO_INIT_URI ?? `${uri}${uri.includes('?') ? '&' : '?'}directConnection=true`;
const replicaSet = process.env.G04A_MONGO_REPLICA_SET ?? 'rs0';
const memberHost = process.env.G04A_MONGO_MEMBER_HOST ?? '127.0.0.1:27028';
const readinessUri =
  process.env.G04A_MONGO_READINESS_URI ??
  `mongodb://127.0.0.1:27028/?replicaSet=${replicaSet}`;
const readinessDeadlineMs = Date.now() + 30_000;

const client = new (await import('mongodb')).MongoClient(initializationUri, {
  retryReads: false,
  retryWrites: false,
  maxAdaptiveRetries: 0,
});

await client.connect();
try {
  const admin = client.db('admin');
  const hello = await admin.command({ hello: 1 });
  if (hello.setName === replicaSet) {
    process.stdout.write(`replica set ${replicaSet} already initialized\n`);
  } else {
    await admin.command({
      replSetInitiate: {
        _id: replicaSet,
        members: [{ _id: 0, host: memberHost }],
      },
    });
    process.stdout.write(`replica set ${replicaSet} initialization requested\n`);
  }
} finally {
  await client.close();
}

const readinessClient = new (await import('mongodb')).MongoClient(readinessUri, {
  retryReads: false,
  retryWrites: false,
  maxAdaptiveRetries: 0,
  serverSelectionTimeoutMS: 1_000,
});
try {
  while (Date.now() < readinessDeadlineMs) {
    try {
      await readinessClient.connect();
      const hello = await readinessClient.db('admin').command({ hello: 1 });
      if (
        hello.setName === replicaSet &&
        hello.isWritablePrimary === true &&
        Array.isArray(hello.hosts) &&
        hello.hosts.length === 1 &&
        hello.hosts[0] === memberHost
      ) {
        process.stdout.write(
          `replica set ${replicaSet} is writable primary at ${memberHost}\n`,
        );
        break;
      }
    } catch {
      // The single member may still be electing its primary.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (Date.now() >= readinessDeadlineMs) {
    throw new Error('G04a replica-set readiness deadline exceeded');
  }
} finally {
  await readinessClient.close();
}
