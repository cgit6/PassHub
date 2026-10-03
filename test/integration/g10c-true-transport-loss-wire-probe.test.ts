import { randomUUID } from 'node:crypto';

import { MongoClient, type CommandStartedEvent } from 'mongodb';

const APP_URI = requiredEnvironment('G10_FAULT_APP_MONGO_URI');
const OBSERVER_URI = requiredEnvironment('G10_FAULT_OBSERVER_MONGO_URI');
const INTERFERER_URI = requiredEnvironment('G10_FAULT_INTERFERER_MONGO_URI');
const TOXIPROXY_API = requiredEnvironment('G10_FAULT_TOXIPROXY_API_URL');

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`G10c transport-loss probe requires ${name}`);
  return value;
}

async function proxyRequest(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${TOXIPROXY_API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Toxiproxy ${init?.method ?? 'GET'} ${path} returned ${response.status}`);
}

async function configureCommitResponseTimeout(name: string): Promise<void> {
  await proxyRequest('/proxies/mongodb-rs0/toxics', {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: 'timeout',
      stream: 'downstream',
      attributes: { timeout: 120_000 },
    }),
  });
}

async function removeToxic(name: string): Promise<void> {
  const response = await fetch(`${TOXIPROXY_API}/proxies/mongodb-rs0/toxics/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) throw new Error(`Toxiproxy toxic cleanup returned ${response.status}`);
}

async function resetProxyConnections(): Promise<void> {
  await proxyRequest('/reset', { method: 'POST', body: '{}' });
}

async function waitFor<T>(read: () => Promise<T | null>, deadlineMs: number): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('G10c transport-loss probe timed out while waiting for Mongo state');
}

describe('G10c true MongoDB commit response-loss wire probe', () => {
  let appClient: MongoClient;
  let observerClient: MongoClient;
  let interfererClient: MongoClient;
  let databaseName: string;
  let failpointEnabled = false;
  let toxicName: string | undefined;

  beforeAll(async () => {
    appClient = new MongoClient(APP_URI, {
      monitorCommands: true,
      retryReads: false,
      retryWrites: false,
      maxAdaptiveRetries: 0,
      serverSelectionTimeoutMS: 5_000,
    });
    observerClient = new MongoClient(OBSERVER_URI, {
      retryReads: false,
      retryWrites: false,
      maxAdaptiveRetries: 0,
      serverSelectionTimeoutMS: 5_000,
    });
    interfererClient = new MongoClient(INTERFERER_URI, {
      retryReads: false,
      retryWrites: false,
      maxAdaptiveRetries: 0,
      serverSelectionTimeoutMS: 5_000,
    });
    await Promise.all([appClient.connect(), observerClient.connect(), interfererClient.connect()]);
    const [appHello, observerHello] = await Promise.all([
      appClient.db('admin').command({ hello: 1 }),
      observerClient.db('admin').command({ hello: 1 }),
    ]);
    expect(appHello).toMatchObject({ setName: 'rs0', isWritablePrimary: true, hosts: ['toxiproxy-g10:27032'] });
    expect(observerHello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });

  afterAll(async () => {
    if (failpointEnabled) {
      await interfererClient.db('admin').command({ configureFailPoint: 'hangBeforeCommitingTxn', mode: 'off' }).catch(() => undefined);
    }
    if (toxicName !== undefined) await removeToxic(toxicName).catch(() => undefined);
    await resetProxyConnections().catch(() => undefined);
    await observerClient?.db(databaseName).dropDatabase().catch(() => undefined);
    await Promise.all([
      appClient?.close().catch(() => undefined),
      observerClient?.close().catch(() => undefined),
      interfererClient?.close().catch(() => undefined),
    ]);
  });

  test('loses only the commit response after Mongo has durably committed through the proxy', async () => {
    databaseName = `passhub_g10c_transport_loss_${randomUUID().replaceAll('-', '')}`.slice(0, 63);
    const collectionName = 'commit_response_loss';
    const documentId = randomUUID();
    const toxic = `g10c-commit-response-${randomUUID()}`;
    toxicName = toxic;
    const commitStarted = new Promise<void>((resolve) => {
      const listener = (event: CommandStartedEvent): void => {
        if (event.commandName === 'commitTransaction') {
          appClient.off('commandStarted', listener);
          resolve();
        }
      };
      appClient.on('commandStarted', listener);
    });
    const session = appClient.startSession();
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', j: true },
      });
      await appClient.db(databaseName).collection<{ readonly _id: string }>(collectionName).insertOne({ _id: documentId }, { session });

      // The server-side barrier is the only synchronization primitive. It is
      // a Mongo test command, not failCommand and not an application throw.
      await interfererClient.db('admin').command({
        configureFailPoint: 'hangBeforeCommitingTxn',
        mode: 'alwaysOn',
      });
      failpointEnabled = true;
      await configureCommitResponseTimeout(toxic);
      const commit = session.commitTransaction();
      await commitStarted;

      // Releasing the real server barrier lets Mongo apply the transaction;
      // the downstream Toxiproxy timeout keeps the commit reply unavailable.
      await interfererClient.db('admin').command({ configureFailPoint: 'hangBeforeCommitingTxn', mode: 'off' });
      failpointEnabled = false;
      await waitFor(async () => {
        const found = await observerClient.db(databaseName).collection<{ readonly _id: string }>(collectionName).findOne({ _id: documentId });
        return found === null ? null : found;
      }, 10_000);

      // Reset the proxy only after the direct observer proves the write is
      // committed. The application can therefore receive only an unknown
      // transport outcome, never a synthetic application exception.
      await resetProxyConnections();
      await expect(commit).rejects.toBeTruthy();
      await expect(observerClient.db(databaseName).collection<{ readonly _id: string }>(collectionName).findOne({ _id: documentId })).resolves.toEqual({ _id: documentId });
    } finally {
      await removeToxic(toxic).catch(() => undefined);
      toxicName = undefined;
      await resetProxyConnections().catch(() => undefined);
      if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
      await session.endSession().catch(() => undefined);
    }
  }, 60_000);
});
