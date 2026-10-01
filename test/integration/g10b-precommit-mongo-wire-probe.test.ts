import { randomUUID } from 'node:crypto';

import { EJSON } from 'bson';
import {
  MongoClient,
  type CommandFailedEvent,
  type CommandStartedEvent,
  type CommandSucceededEvent,
} from 'mongodb';

import { createBudgetLedger } from '../../src/access/application/internal/budget-ledger.js';
import { createPrecommitTerminationLifecycle } from '../../src/access/application/internal/precommit-termination-lifecycle.js';
import { createG10bPrecommitMongoTerminator } from '../../src/infrastructure/mongo/internal/g10b-precommit-mongo-terminator.js';

const APP_URI = requiredEnvironment('G10_FAULT_APP_MONGO_URI');
const OBSERVER_URI = requiredEnvironment('G10_FAULT_OBSERVER_MONGO_URI');

type WireOutcome = 'STARTED' | 'SUCCEEDED' | 'FAILED';
type WireObservation = Readonly<{
  readonly commandName: string;
  readonly lsidMatchesSession: boolean;
  /** Deliberately a presence bit, never the transaction number itself. */
  readonly transactionNumberPresent: boolean;
  readonly outcome: WireOutcome;
  readonly code: number | null;
}>;

class FixedClock {
  nowMs(): number { return 1_000; }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`G10b wire probe requires ${name}`);
  return value;
}

function observeStarted(event: CommandStartedEvent, sessionId: unknown): WireObservation {
  return Object.freeze({
    commandName: event.commandName,
    lsidMatchesSession: matchesSessionId(event.command.lsid, sessionId),
    transactionNumberPresent: event.command.txnNumber !== undefined,
    outcome: 'STARTED',
    code: null,
  });
}

function observeSucceeded(event: CommandSucceededEvent): WireObservation {
  return Object.freeze({
    commandName: event.commandName,
    // Successful command replies do not carry a request lsid.  Attribution
    // therefore comes solely from the commandStarted event, not a response
    // payload that could be misread as a second wire observation.
    lsidMatchesSession: false,
    transactionNumberPresent: false,
    outcome: 'SUCCEEDED',
    code: null,
  });
}

function observeFailed(event: CommandFailedEvent): WireObservation {
  return Object.freeze({
    commandName: event.commandName,
    lsidMatchesSession: false,
    transactionNumberPresent: false,
    outcome: 'FAILED',
    code: typeof event.failure === 'object' && event.failure !== null && 'code' in event.failure && typeof event.failure.code === 'number'
      ? event.failure.code
      : null,
  });
}

function matchesSessionId(value: unknown, expected: unknown): boolean {
  if (value === undefined || expected === undefined) return false;
  // EJSON is used only for an in-memory equality check; the probe never
  // stores or prints the driver command, lsid value, or document payload.
  return EJSON.stringify(value, { relaxed: false }) === EJSON.stringify(expected, { relaxed: false });
}

async function settleDriverQueue(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 75); });
}

describe('G10b true MongoDB precommit wire probe', () => {
  let appClient: MongoClient;
  let observerClient: MongoClient;
  let databaseName: string;

  beforeAll(async () => {
    databaseName = `passhub_g10b_wire_${randomUUID().replaceAll('-', '')}`.slice(0, 63);
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
    await Promise.all([appClient.connect(), observerClient.connect()]);
    const [appHello, observerHello] = await Promise.all([
      appClient.db('admin').command({ hello: 1 }),
      observerClient.db('admin').command({ hello: 1 }),
    ]);
    expect(appHello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
    expect(observerHello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
    expect(appHello.hosts).toEqual(['toxiproxy-g10:27032']);
  });

  afterAll(async () => {
    await observerClient.db(databaseName).dropDatabase().catch(() => undefined);
    await Promise.all([
      appClient.close().catch(() => undefined),
      observerClient.close().catch(() => undefined),
    ]);
  });

  test('aborts a real proxied transaction through one high-level terminator call, then emits no late transaction or CRUD command', async () => {
    const collectionName = 'precommit_wire_probe';
    const documentId = randomUUID();
    const observations: WireObservation[] = [];
    const session = appClient.startSession();
    const sessionId = session.id;
    const started = (event: CommandStartedEvent): void => { observations.push(observeStarted(event, sessionId)); };
    const succeeded = (event: CommandSucceededEvent): void => { observations.push(observeSucceeded(event)); };
    const failed = (event: CommandFailedEvent): void => { observations.push(observeFailed(event)); };
    appClient.on('commandStarted', started);
    appClient.on('commandSucceeded', succeeded);
    appClient.on('commandFailed', failed);

    try {
      session.startTransaction();
      await appClient.db(databaseName).collection<{ readonly _id: string }>(collectionName)
        .insertOne({ _id: documentId }, { session });

      const ledger = createBudgetLedger({
        clock: new FixedClock(),
        ownerFence: { assertCurrent: () => undefined },
        operationId: 'g10b-wire-probe',
        assertContinuationEvidence: () => undefined,
      });
      const round = ledger.beginRound();
      ledger.finishRound(round);
      ledger.startConfirmation('PRECOMMIT_CLEANUP');
      const lifecycle = createPrecommitTerminationLifecycle({
        ledger,
        ownerFence: { assertCurrent: () => undefined },
      });
      let group: ReturnType<typeof lifecycle.reserveAbortGroup> | undefined;
      const terminator = createG10bPrecommitMongoTerminator({
        session,
        authority: {
          abortOnce: async (send) => {
            lifecycle.sealScope('PRECOMMIT');
            group = lifecycle.reserveAbortGroup();
            try {
              await lifecycle.executeAbort(group, send);
              return 'NO_EFFECT_CONFIRMED' as const;
            } catch {
              return 'STILL_UNKNOWN' as const;
            }
          },
          terminate: (outcome) => {
            if (group === undefined) throw new Error('wire probe precommit abort group is missing');
            lifecycle.terminate(group, outcome);
          },
        },
      });

      await expect(terminator.terminatePrecommit()).resolves.toEqual({ outcome: 'NO_EFFECT_CONFIRMED', abortAttempts: 1 });
      expect(lifecycle.snapshot()).toMatchObject({ phase: 'TERMINATED', activeGroup: false, abortCommandInFlight: false });

      // The observer deliberately connects directly to MongoDB, independent
      // from the app's Toxiproxy route.  It proves the transaction write did
      // not become visible after the abort, without adding observer commands
      // to the app client's monitored lifecycle.
      await expect(observerClient.db(databaseName).collection<{ readonly _id: string }>(collectionName).countDocuments({ _id: documentId })).resolves.toBe(0);

      const afterEndSession = observations.length;
      await settleDriverQueue();
      const lateCommands = observations.slice(afterEndSession)
        .filter((item) => ['abortTransaction', 'commitTransaction', 'insert', 'update', 'delete', 'findAndModify'].includes(item.commandName));
      expect(lateCommands).toEqual([]);

      const sessionWire = observations.filter((item) => item.lsidMatchesSession);
      const abortCommands = sessionWire.filter((item) => item.commandName === 'abortTransaction' && item.outcome === 'STARTED');
      const commitCommands = observations.filter((item) => item.commandName === 'commitTransaction' && item.outcome === 'STARTED');
      const writeCommands = sessionWire.filter((item) => item.commandName === 'insert' && item.outcome === 'STARTED');
      expect(writeCommands).toHaveLength(1);
      expect(abortCommands.length).toBeGreaterThanOrEqual(1);
      expect(abortCommands.length).toBeLessThanOrEqual(2);
      expect(commitCommands).toEqual([]);
      expect(abortCommands.every((item) => item.transactionNumberPresent)).toBe(true);
      expect(observations.some((item) => item.commandName === 'abortTransaction' && item.outcome === 'SUCCEEDED')).toBe(true);
      expect(sessionWire.every((item) => item.code === null || Number.isInteger(item.code))).toBe(true);
    } finally {
      appClient.off('commandStarted', started);
      appClient.off('commandSucceeded', succeeded);
      appClient.off('commandFailed', failed);
      // A rejected probe setup must still leave the session in a state the
      // driver can close.  No result from this cleanup is used as evidence.
      await session.endSession().catch(() => undefined);
    }
  });
});
