import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MongoClient,
  type CommandStartedEvent,
  type Db,
} from 'mongodb';

import { createVerifiedDatasetVerifier } from '../../src/deployment/internal/g11b-dataset-verification.js';
import { createPersistentRunClaimer } from '../../src/deployment/internal/g11b-persistent-run-claim.js';
import type { PersistentRunClaimOutcome } from '../support/g11b-persistent-run-claim-test-support.js';
import { createG11bRunTicketIntakeForFsTest } from '../support/g11b-run-ticket-test-support.js';
import {
  G04B_METADATA_COLLECTION,
  createG04bFixture,
  ensureG04bSchema,
  type G04bMetadataDocument,
} from '../../src/infrastructure/mongo/index.js';

const COMPETITOR_COUNT = 16;
const uri = process.env.G11B_B3C_A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databaseName = process.env.G11B_B3C_A_MONGO_DATABASE ?? `passhub_g11b_b3c_a_${process.pid}`;

interface Competitor {
  readonly client: MongoClient;
  readonly db: Db;
  readonly runId: string;
  readonly claim: () => Promise<PersistentRunClaimOutcome>;
  readonly commands: CommandStartedEvent[];
}

describe('G11b-b3c-a sixteen independent Mongo clients compete for one claim', () => {
  let setupClient: MongoClient;
  const competitors: Competitor[] = [];
  const clientsToCleanup: MongoClient[] = [];
  const temporaryDirectories: string[] = [];
  let databaseNeedsCleanup = false;

  beforeAll(async () => {
    setupClient = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    await setupClient.connect();
  });

  afterEach(async () => {
    await cleanupResources(false);
  });

  afterAll(async () => {
    await cleanupResources(true);
  });

  async function cleanupResources(closeSetupClient: boolean): Promise<void> {
    const failures: unknown[] = [];
    const clientsToClose = [...clientsToCleanup];
    const closeResults = await Promise.allSettled(
      clientsToClose.map(async (client) => client.close()),
    );
    const retryClients: MongoClient[] = [];
    for (const [index, result] of closeResults.entries()) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
        retryClients.push(clientsToClose[index]!);
      }
    }
    clientsToCleanup.splice(0, clientsToCleanup.length, ...retryClients);
    competitors.splice(0, competitors.length);

    if (databaseNeedsCleanup) {
      try {
        await setupClient.db(databaseName).dropDatabase();
        databaseNeedsCleanup = false;
      } catch (error) {
        failures.push(error);
      }
    }

    const directoriesToRemove = [...temporaryDirectories];
    const removeResults = await Promise.allSettled(directoriesToRemove.map(async (directory) => {
      if (!directory.startsWith(join(tmpdir(), 'passhub-b3c-a-'))) throw new Error('unsafe cleanup');
      await rm(directory, { recursive: true, force: true });
    }));
    const retryDirectories: string[] = [];
    for (const [index, result] of removeResults.entries()) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
        retryDirectories.push(directoriesToRemove[index]!);
      }
    }
    temporaryDirectories.splice(0, temporaryDirectories.length, ...retryDirectories);

    if (closeSetupClient) {
      try {
        await setupClient.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'G11b-b3c-a resource cleanup failed');
  }

  async function seed(): Promise<ReturnType<typeof createG04bFixture>> {
    databaseNeedsCleanup = true;
    const fixture = createG04bFixture(1_800_000_000_000);
    const collections = await ensureG04bSchema(setupClient.db(databaseName));
    await collections.qualifications.insertMany([...fixture.qualifications]);
    await collections.faceSlots.insertMany([...fixture.faceSlots]);
    await collections.users.insertMany([...fixture.users]);
    await collections.sources.insertMany([...fixture.sources]);
    await collections.metadata.insertOne(fixture.metadata);
    return fixture;
  }

  async function ticket(epoch: string, runId: string) {
    const directory = await mkdtemp(join(tmpdir(), 'passhub-b3c-a-'));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const path = join(directory, 'bootstrap-ticket.json');
    await writeFile(path, `${JSON.stringify({
      v: 'g11b.run-ticket.v1', ticketId: randomUUID(), datasetEpoch: epoch, processRunId: runId,
    })}\n`, { mode: 0o400 });
    await chmod(path, 0o400);
    return createG11bRunTicketIntakeForFsTest(directory)(runId);
  }

  async function createCompetitor(epoch: string): Promise<Competitor> {
    const commands: CommandStartedEvent[] = [];
    const client = new MongoClient(uri, {
      retryReads: false,
      retryWrites: false,
      maxAdaptiveRetries: 0,
      maxPoolSize: 1,
      monitorCommands: true,
    });
    clientsToCleanup.push(client);
    client.on('commandStarted', (event) => commands.push(event));
    await client.connect();
    const db = client.db(databaseName);
    const verifier = createVerifiedDatasetVerifier(db);
    const verified = await verifier.verify();
    const runId = randomUUID();
    const consumed = await ticket(epoch, runId);
    const claimer = createPersistentRunClaimer(db, verifier);
    commands.length = 0;
    const competitor = { client, db, runId, commands, claim: () => claimer.claimOnce(verified, consumed) };
    competitors.push(competitor);
    return competitor;
  }

  function assertCas(event: CommandStartedEvent, epoch: string, runId: string): void {
    expect(event.databaseName).toBe(databaseName);
    expect(event.command).toMatchObject({
      findAndModify: G04B_METADATA_COLLECTION,
      query: { _id: 'system', kind: 'system', datasetEpoch: epoch, writeRunClaim: null },
      update: [{ $set: { writeRunClaim: { runId: { $literal: runId }, claimedAt: '$$NOW' } } }],
      remove: false,
      new: true,
      upsert: false,
      writeConcern: { w: 'majority', j: true },
      $db: databaseName,
    });
    expect(Number.isInteger(event.command.maxTimeMS)).toBe(true);
    expect(event.command.maxTimeMS).toBeGreaterThanOrEqual(1);
    expect(event.command.maxTimeMS).toBeLessThanOrEqual(2000);
    for (const forbidden of ['txnNumber', 'projection', 'comment', 'bypassDocumentValidation', 'autocommit']) {
      expect(event.command).not.toHaveProperty(forbidden);
    }
  }

  function assertClassification(event: CommandStartedEvent): void {
    expect(event.databaseName).toBe(databaseName);
    expect(event.command).toMatchObject({
      find: G04B_METADATA_COLLECTION,
      filter: { _id: 'system' },
      limit: 1,
      singleBatch: true,
      readConcern: { level: 'majority' },
      $db: databaseName,
    });
    expect(Number.isInteger(event.command.maxTimeMS)).toBe(true);
    expect(event.command.maxTimeMS).toBeGreaterThanOrEqual(1);
    expect(event.command.maxTimeMS).toBeLessThanOrEqual(2000);
    for (const forbidden of ['txnNumber', 'projection', 'comment', 'autocommit']) {
      expect(event.command).not.toHaveProperty(forbidden);
    }
  }

  test('a simultaneous start barrier yields exactly one CLAIMED and fifteen exact CLAIM_HELD losers', async () => {
    const fixture = await seed();
    await Promise.all(Array.from(
      { length: COMPETITOR_COUNT },
      async () => createCompetitor(fixture.datasetEpoch),
    ));
    expect(new Set(competitors.map(({ client }) => client)).size).toBe(COMPETITOR_COUNT);
    expect(new Set(competitors.map(({ db }) => db)).size).toBe(COMPETITOR_COUNT);
    expect(new Set(competitors.map(({ runId }) => runId)).size).toBe(COMPETITOR_COUNT);

    let releaseStart: (() => void) | undefined;
    const start = new Promise<void>((resolve) => { releaseStart = resolve; });
    let ready = 0;
    const attempts = competitors.map(async (competitor) => {
      ready += 1;
      await start;
      return competitor.claim();
    });
    expect(ready).toBe(COMPETITOR_COUNT);
    if (releaseStart === undefined) throw new Error('start barrier unavailable');
    releaseStart();
    const outcomes = await Promise.all(attempts);

    const winners = outcomes
      .map((outcome, index) => ({ outcome, index }))
      .filter(({ outcome }) => outcome.status === 'CLAIMED');
    expect(winners).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'CLAIM_HELD')).toHaveLength(COMPETITOR_COUNT - 1);
    expect(outcomes.every(({ status }) => status === 'CLAIMED' || status === 'CLAIM_HELD')).toBe(true);

    const winnerIndex = winners[0]!.index;
    for (const [index, competitor] of competitors.entries()) {
      expect(competitor.commands.map(({ commandName }) => commandName)).toEqual(
        index === winnerIndex ? ['findAndModify'] : ['findAndModify', 'find'],
      );
      assertCas(competitor.commands[0]!, fixture.datasetEpoch, competitor.runId);
      if (index !== winnerIndex) assertClassification(competitor.commands[1]!);
    }
    expect(competitors.flatMap(({ commands }) => commands)
      .filter(({ commandName }) => commandName === 'findAndModify')).toHaveLength(COMPETITOR_COUNT);
    expect(competitors.flatMap(({ commands }) => commands)
      .filter(({ commandName }) => commandName === 'find')).toHaveLength(COMPETITOR_COUNT - 1);

    const persisted = await setupClient.db(databaseName)
      .collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION)
      .findOne({ _id: 'system' });
    expect(persisted?.writeRunClaim?.runId).toBe(competitors[winnerIndex]!.runId);
    expect(persisted?.writeRunClaim?.claimedAt).toBeInstanceOf(Date);
    expect(Number.isFinite(persisted?.writeRunClaim?.claimedAt.getTime())).toBe(true);
    expect({ ...persisted, writeRunClaim: null }).toEqual(fixture.metadata);
    expect(await setupClient.db(databaseName).collection(G04B_METADATA_COLLECTION).countDocuments()).toBe(1);
  });
});
