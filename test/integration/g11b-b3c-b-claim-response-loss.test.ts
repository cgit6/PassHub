import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { MongoClient, type CommandStartedEvent } from 'mongodb';

import { createVerifiedDatasetVerifier } from '../../src/deployment/internal/g11b-dataset-verification.js';
import { createPersistentRunClaimer } from '../../src/deployment/internal/g11b-persistent-run-claim.js';
import { createG11bRunTicketIntakeForFsTest } from '../support/g11b-run-ticket-test-support.js';
import {
  G04B_METADATA_COLLECTION,
  createG04bFixture,
  ensureG04bSchema,
  type G04bMetadataDocument,
} from '../../src/infrastructure/mongo/index.js';

const APP_URI = requiredEnvironment('G10_FAULT_APP_MONGO_URI');
const OBSERVER_URI = requiredEnvironment('G10_FAULT_OBSERVER_MONGO_URI');
const TOXIPROXY_API = requiredEnvironment('G10_FAULT_TOXIPROXY_API_URL');

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`G11b-b3c-b requires ${name}`);
  return value;
}

describe('G11b-b3c-b persistent claim response-loss fault', () => {
  let appClient: MongoClient;
  let observerClient: MongoClient;
  let databaseName: string | undefined;
  let temporaryDirectory: string | undefined;
  let toxicName: string | undefined;
  const appCommands: CommandStartedEvent[] = [];

  beforeAll(async () => {
    const appRoute = new URL(APP_URI);
    const observerRoute = new URL(OBSERVER_URI);
    if (appRoute.hostname !== 'toxiproxy-g10' || appRoute.port !== '27032'
      || appRoute.searchParams.get('replicaSet') !== 'rs0'
      || appRoute.searchParams.has('directConnection')) {
      throw new Error('application URI is not the proxy-only replica-set route');
    }
    if (observerRoute.hostname !== 'mongo-g10' || observerRoute.port !== '27031'
      || observerRoute.searchParams.get('replicaSet') !== 'rs0'
      || observerRoute.searchParams.get('directConnection') !== 'true') {
      throw new Error('observer URI is not the direct replica-set route');
    }
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
    appClient.on('commandStarted', (event) => appCommands.push(event));
    await Promise.all([appClient.connect(), observerClient.connect()]);
    const [appHello, observerHello] = await Promise.all([
      appClient.db('admin').command({ hello: 1 }),
      observerClient.db('admin').command({ hello: 1 }),
    ]);
    if (appHello.setName !== 'rs0' || appHello.isWritablePrimary !== true
      || !Array.isArray(appHello.hosts) || appHello.hosts.length !== 1
      || appHello.hosts[0] !== 'toxiproxy-g10:27032') throw new Error('application Mongo route is not proxy-only rs0');
    if (observerHello.setName !== 'rs0' || observerHello.isWritablePrimary !== true) {
      throw new Error('direct observer is not a writable rs0 member');
    }
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    if (toxicName !== undefined) {
      try { await removeToxic(toxicName); } catch (error) { failures.push(error); }
    }
    try { await resetProxyConnections(); } catch (error) { failures.push(error); }
    try {
      await observerClient.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    } catch (error) {
      failures.push(error);
    }
    if (databaseName !== undefined) {
      try { await observerClient.db(databaseName).dropDatabase(); } catch (error) { failures.push(error); }
    }
    if (temporaryDirectory !== undefined) {
      try {
        if (!temporaryDirectory.startsWith(join(tmpdir(), 'passhub-b3c-b-'))) throw new Error('unsafe cleanup');
        await rm(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    const closeResults = await Promise.allSettled([appClient?.close(), observerClient?.close()]);
    for (const result of closeResults) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'G11b-b3c-b fixture cleanup failed');
  });

  test('a landed CAS with its downstream response withheld is UNKNOWN and never retried', async () => {
    databaseName = `passhub_g11b_b3c_b_${randomUUID().replaceAll('-', '')}`.slice(0, 63);
    const observerDb = observerClient.db(databaseName);
    const fixture = createG04bFixture(1_800_000_000_000);
    const collections = await ensureG04bSchema(observerDb);
    await collections.qualifications.insertMany([...fixture.qualifications]);
    await collections.faceSlots.insertMany([...fixture.faceSlots]);
    await collections.users.insertMany([...fixture.users]);
    await collections.sources.insertMany([...fixture.sources]);
    await collections.metadata.insertOne(fixture.metadata);

    const appDb = appClient.db(databaseName);
    const verifier = createVerifiedDatasetVerifier(appDb);
    const verified = await verifier.verify();
    const processRunId = randomUUID();
    const { consumed, ticketId } = await createTicket(fixture.datasetEpoch, processRunId);
    const claimer = createPersistentRunClaimer(appDb, verifier);
    toxicName = `g11b-b3c-b-${randomUUID()}`;
    await addDownstreamTimeout(toxicName);
    appCommands.length = 0;

    const claimCommandStarted = waitForClaimCommand(databaseName);
    const claimAttempt = claimer.claimOnce(verified, consumed);
    await claimCommandStarted;

    // This is not a server barrier. A commandStarted event alone cannot prove
    // delivery, so this case passes only when the direct majority observer
    // independently sees the canonical claim land while the response is held.
    const landed = await waitForLandedClaim(databaseName, processRunId, 10_000);
    if (!(landed.writeRunClaim?.claimedAt instanceof Date)
      || !Number.isFinite(landed.writeRunClaim.claimedAt.getTime())) {
      throw new Error('direct observer did not see a canonical BSON claim date');
    }
    if (!sameMetadataExceptClaim(landed, fixture.metadata)) {
      throw new Error('claim changed metadata outside writeRunClaim');
    }

    const outcome = await claimAttempt;
    if (outcome.status !== 'CLAIM_UNKNOWN') throw new Error('landed response-loss claim was not UNKNOWN');
    assertOnlyExactClaimCommand(databaseName, fixture.datasetEpoch, processRunId, ticketId);
    const commandCountBeforeReuse = observedApplicationOperations(databaseName).length;

    let reuseCode: string | undefined;
    try {
      await claimer.claimOnce(verified, consumed);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        reuseCode = error.code;
      }
    }
    if (reuseCode !== 'RUN_TICKET_ALREADY_USED') throw new Error('unknown ticket reuse was not rejected');
    if (observedApplicationOperations(databaseName).length !== commandCountBeforeReuse) {
      throw new Error('unknown ticket reuse issued a second Mongo command');
    }
    assertOnlyExactClaimCommand(databaseName, fixture.datasetEpoch, processRunId, ticketId);

    const afterReplay = await readMetadataMajority(databaseName);
    if (afterReplay === null || !isDeepStrictEqual(afterReplay, landed)) {
      throw new Error('canonical landed claim changed after UNKNOWN or ticket replay rejection');
    }
    if (afterReplay.writeRunClaim?.runId !== processRunId
      || !(afterReplay.writeRunClaim.claimedAt instanceof Date)
      || !Number.isFinite(afterReplay.writeRunClaim.claimedAt.getTime())
      || !sameMetadataExceptClaim(afterReplay, fixture.metadata)) {
      throw new Error('post-replay majority read did not retain the canonical claim');
    }
    assertOnlyExactClaimCommand(databaseName, fixture.datasetEpoch, processRunId, ticketId);
  });

  async function createTicket(epoch: string, runId: string) {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'passhub-b3c-b-'));
    await chmod(temporaryDirectory, 0o700);
    const path = join(temporaryDirectory, 'bootstrap-ticket.json');
    const ticketId = randomUUID();
    await writeFile(path, `${JSON.stringify({
      v: 'g11b.run-ticket.v1', ticketId, datasetEpoch: epoch, processRunId: runId,
    })}\n`, { mode: 0o400 });
    await chmod(path, 0o400);
    return {
      consumed: await createG11bRunTicketIntakeForFsTest(temporaryDirectory)(runId),
      ticketId,
    };
  }

  function waitForClaimCommand(expectedDatabase: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        appClient.off('commandStarted', listener);
        reject(new Error('claim command was not started before deadline'));
      }, 5_000);
      const listener = (event: CommandStartedEvent): void => {
        if (event.databaseName === expectedDatabase && event.commandName === 'findAndModify') {
          clearTimeout(timeout);
          appClient.off('commandStarted', listener);
          resolve();
        }
      };
      appClient.on('commandStarted', listener);
    });
  }

  function observedApplicationOperations(expectedDatabase: string): CommandStartedEvent[] {
    const databaseIndependentOperations = new Set(['bulkWrite', 'commitTransaction', 'abortTransaction']);
    return appCommands.filter((event) => event.databaseName === expectedDatabase
      || databaseIndependentOperations.has(event.commandName));
  }

  function assertOnlyExactClaimCommand(
    expectedDatabase: string,
    expectedEpoch: string,
    expectedRunId: string,
    ticketId: string,
  ): void {
    const observed = observedApplicationOperations(expectedDatabase);
    if (observed.length !== 1 || observed[0]?.commandName !== 'findAndModify') {
      throw new Error('claim window contained a command other than the single CAS');
    }
    const command = observed[0].command;
    const expectedKeys = [
      '$clusterTime', '$db', 'findAndModify', 'lsid', 'maxTimeMS', 'new', 'query', 'remove', 'update', 'upsert',
      'writeConcern',
    ];
    if (!isDeepStrictEqual(Reflect.ownKeys(command).sort(), expectedKeys)) {
      throw new Error('claim CAS wire keys were not exact');
    }
    if (command.findAndModify !== G04B_METADATA_COLLECTION || command.$db !== expectedDatabase
      || command.remove !== false || command.new !== true || command.upsert !== false
      || !isDeepStrictEqual(command.query, {
        _id: 'system', kind: 'system', datasetEpoch: expectedEpoch, writeRunClaim: null,
      })
      || !isDeepStrictEqual(command.update, [{
        $set: { writeRunClaim: { runId: { $literal: expectedRunId }, claimedAt: '$$NOW' } },
      }])
      || !isDeepStrictEqual(command.writeConcern, { w: 'majority', j: true })
      || !Number.isInteger(command.maxTimeMS) || command.maxTimeMS < 1 || command.maxTimeMS > 2000) {
      throw new Error('claim CAS wire contract was not exact');
    }
    if (JSON.stringify(command).includes(ticketId)) throw new Error('ticket identifier reached Mongo command wire');
    for (const forbidden of [
      'txnNumber', 'projection', 'comment', 'bypassDocumentValidation', 'autocommit', 'startTransaction',
    ]) {
      if (Object.hasOwn(command, forbidden)) throw new Error('claim CAS contained a forbidden Mongo option');
    }
  }

  async function waitForLandedClaim(
    expectedDatabase: string,
    expectedRunId: string,
    timeoutMs: number,
  ): Promise<G04bMetadataDocument> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const observed = await observerClient.db(expectedDatabase)
        .collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION)
        .findOne(
          { _id: 'system' },
          { readPreference: 'primary', readConcern: { level: 'majority' }, maxTimeMS: 1_000 },
        );
      if (observed?.writeRunClaim?.runId === expectedRunId) return observed;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('direct majority observer never proved the claim landed');
  }

  async function readMetadataMajority(expectedDatabase: string): Promise<G04bMetadataDocument | null> {
    return observerClient.db(expectedDatabase)
      .collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION)
      .findOne(
        { _id: 'system' },
        { readPreference: 'primary', readConcern: { level: 'majority' }, maxTimeMS: 1_000 },
      );
  }
});

async function addDownstreamTimeout(name: string): Promise<void> {
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
  if (!response.ok && response.status !== 404) throw new Error('Toxiproxy toxic cleanup failed');
  const state = await fetch(`${TOXIPROXY_API}/proxies/mongodb-rs0`);
  if (!state.ok) throw new Error('Toxiproxy cleanup verification failed');
  const body = await state.json() as { toxics?: unknown[] };
  if (!Array.isArray(body.toxics) || body.toxics.length !== 0) throw new Error('Toxiproxy toxic remained after cleanup');
}

async function resetProxyConnections(): Promise<void> {
  await proxyRequest('/reset', { method: 'POST', body: '{}' });
}

async function proxyRequest(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${TOXIPROXY_API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error('Toxiproxy control request failed');
}

function sameMetadataExceptClaim(observed: G04bMetadataDocument, expected: G04bMetadataDocument): boolean {
  return JSON.stringify({ ...observed, writeRunClaim: null }) === JSON.stringify(expected);
}
