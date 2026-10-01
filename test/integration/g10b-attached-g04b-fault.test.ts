import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { EJSON } from 'bson';
import { jest } from '@jest/globals';
import {
  MongoClient,
  type ClientSession,
  type CommandFailedEvent,
  type CommandStartedEvent,
  type CommandSucceededEvent,
  type Document,
} from 'mongodb';

import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import { createAccessComposition } from '../../src/composition/access-composition.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bRouteComposition,
  createG08aManagementComposition,
  createHttpResponsePlanBundle,
  createUnknownRecognitionCoordinatorBundle,
  createPassHubHttpApplication,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWorkContext,
  type HttpResponsePlan,
  type PassHubHttpApplication,
} from '../../src/composition/internal/index.js';
import { createG07bAdmissionHandler } from '../../src/composition/internal/g07b-admission-handler.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import {
  createG10bOperationBudgetBindingFactory,
  type G10bOperationBudgetBindingFactory,
} from '../../src/composition/internal/g10b-operation-bridge.js';
import { attachG10bG04bPersistenceSidecar } from '../../src/composition/internal/g10b-g04b-persistence-wire.js';
import type { WriteOperationContext } from '../../src/access/application/internal/write-operation-coordinator.js';
import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import { HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type { ManagementDataPort } from '../../src/access/ports/index.js';
import {
  G04B_FACE_SLOTS_COLLECTION,
  G04B_QUALIFICATIONS_COLLECTION,
  G04bMongoPersistenceAdapter,
  createG04bFixture,
  type G04bFixture,
  type G04bQualificationDocument,
} from '../../src/infrastructure/mongo/index.js';
import type { G04aFaceSlotDocument } from '../../src/infrastructure/mongo/g04a-face-index-schema.js';

const APP_URI = requiredEnvironment('G10_FAULT_APP_MONGO_URI');
const OBSERVER_URI = requiredEnvironment('G10_FAULT_OBSERVER_MONGO_URI');
const INTERFERER_URI = requiredEnvironment('G10_FAULT_INTERFERER_MONGO_URI');
const NOW = 1_800_000_000_000;
const OWNER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

type WireOutcome = 'STARTED' | 'SUCCEEDED' | 'FAILED';
type SanitizedWireObservation = Readonly<{
  readonly requestId: number;
  readonly commandName: string;
  readonly lsidMatchesAppSession: boolean;
  readonly transactionNumberPresent: boolean;
  readonly outcome: WireOutcome;
  readonly code: number | null;
}>;

class OperatorAuth implements HumanAuthCapability {
  readonly operator = new HumanPrincipal();

  login(): Promise<{ accessToken: string }> { return Promise.resolve({ accessToken: 'unused' }); }
  verifyAccessToken(token: string): Promise<HumanPrincipal> {
    return token === 'operator' ? Promise.resolve(this.operator) : Promise.reject(new Error('invalid token'));
  }
  facts(principal: HumanPrincipal): { userId: string; role: HumanRole } {
    if (principal !== this.operator) throw new Error('invalid principal');
    return { userId: ACTOR, role: 'OPERATOR' };
  }
  assertRole(principal: HumanPrincipal, role: HumanRole): void {
    if (principal !== this.operator || role !== 'OPERATOR') throw new Error('forbidden');
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`G10b attached fault test requires ${name}`);
  return value;
}

function expectFaultUriSplit(): void {
  const app = new URL(APP_URI);
  expect(app).toMatchObject({ protocol: 'mongodb:', hostname: 'toxiproxy-g10', port: '27032' });
  expect(app.searchParams.get('replicaSet')).toBe('rs0');
  expect(app.searchParams.has('directConnection')).toBe(false);
  for (const uri of [OBSERVER_URI, INTERFERER_URI]) {
    const direct = new URL(uri);
    expect(direct).toMatchObject({ protocol: 'mongodb:', hostname: 'mongo-g10', port: '27031' });
    expect(direct.searchParams.get('replicaSet')).toBe('rs0');
    expect(direct.searchParams.get('directConnection')).toBe('true');
  }
}

function sanitizeStarted(event: CommandStartedEvent, lsidMatchesAppSession: boolean): SanitizedWireObservation {
  return Object.freeze({
    requestId: event.requestId,
    commandName: event.commandName,
    lsidMatchesAppSession,
    transactionNumberPresent: event.command.txnNumber !== undefined,
    outcome: 'STARTED',
    code: null,
  });
}

function sanitizeSucceeded(event: CommandSucceededEvent, started: SanitizedWireObservation): SanitizedWireObservation {
  return Object.freeze({
    requestId: event.requestId,
    commandName: started.commandName,
    lsidMatchesAppSession: started.lsidMatchesAppSession,
    transactionNumberPresent: started.transactionNumberPresent,
    outcome: 'SUCCEEDED',
    // Duplicate-key write replies remain protocol-successful commands in the
    // driver. Keep only their numeric code; never retain the reply, key, or
    // document payload in this test evidence.
    code: writeErrorCode(event.reply),
  });
}

function sanitizeFailed(event: CommandFailedEvent, started: SanitizedWireObservation): SanitizedWireObservation {
  return Object.freeze({
    requestId: event.requestId,
    commandName: started.commandName,
    lsidMatchesAppSession: started.lsidMatchesAppSession,
    transactionNumberPresent: started.transactionNumberPresent,
    outcome: 'FAILED',
    code: typeof event.failure === 'object' && event.failure !== null && 'code' in event.failure && typeof event.failure.code === 'number'
      ? event.failure.code
      : null,
  });
}

function writeErrorCode(reply: unknown): number | null {
  if (typeof reply !== 'object' || reply === null || !('writeErrors' in reply)) return null;
  const writeErrors = (reply as { writeErrors?: unknown }).writeErrors;
  if (!Array.isArray(writeErrors) || writeErrors.length !== 1) return null;
  const error = writeErrors[0];
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
    ? error.code
    : null;
}

function createAttachedHandler(adapter: G04bMongoPersistenceAdapter, fixture: G04bFixture) {
  const responsePlans = createHttpResponsePlanBundle({ currentDatasetEpoch: fixture.datasetEpoch });
  const workHandoff = createAdmissionWorkHandoffBundle();
  const access = createAccessComposition({ management: adapter, query: adapter, epoch: fixture.datasetEpoch });
  const g08a = createG08aManagementComposition({
    auth: new OperatorAuth(),
    manageQualifications: access.manageQualifications,
    responsePlans,
    workHandoff,
  });
  const capabilities = createOperationRegistryCapabilityIssuer({
    registryId: `g10b-attached-fault-${randomUUID()}`,
    datasetEpoch: fixture.datasetEpoch,
    processRunId: randomUUID(),
    ownerId: OWNER,
    sameArtifact: () => true,
  });
  const registry = createOperationRegistry({
    capabilities,
    writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
    assertOwnerCurrent: () => undefined,
    assertContinuationEvidence: () => undefined,
  });
  const actualBindingFactory = createG10bOperationBudgetBindingFactory({
    clock: { nowMs: () => NOW },
    assertContinuationEvidence: () => undefined,
  });
  const bindingFactory: G10bOperationBudgetBindingFactory = Object.freeze({
    bind(write: WriteOperationContext, admission: AdmissionWorkContext) {
      return actualBindingFactory.bind(write, admission);
    },
  });
  const rejected = async (_input: AdmissionValidationInput): Promise<AdmissionValidationResult> =>
    Object.freeze({ kind: 'REJECTED', response: responsePlans.technical.issue('INVALID_REQUEST') });
  const fallback = (): Promise<HttpResponsePlan> => Promise.resolve(responsePlans.technical.issue('INVALID_REQUEST'));
  const query = createLegacyQueryAdmissionCapability({ validate: rejected, query: fallback });
  const login = Object.freeze({ validate: rejected, login: fallback });
  const recognition = Object.freeze({
    validate: rejected,
    recognition: async () => Object.freeze({ disposition: 'KNOWN_NO_EFFECT' as const, response: await fallback() }),
  });
  const management = Object.freeze({ validate: g08a.validator.validate, management: g08a.work.management });
  const routes = createG07bRouteComposition({ login, query, management, recognition });
  return createG07bAdmissionHandler({
    currentDatasetEpoch: fixture.datasetEpoch,
    registry,
    registryCapabilities: capabilities,
    responsePlans,
    workHandoff,
    unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
    validator: routes.validator,
    work: routes.work,
    operationBudgetBindingFactory: bindingFactory,
  });
}

interface AttachedHttpApplication {
  readonly app: PassHubHttpApplication;
  readonly port: number;
}

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function createAttachedHttpApplication(
  adapter: G04bMongoPersistenceAdapter,
  fixture: G04bFixture,
): Promise<AttachedHttpApplication> {
  const app = await createPassHubHttpApplication(createAttachedHandler(adapter, fixture));
  await app.nestApplication.listen(0, '127.0.0.1');
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('attached G10b HTTP server did not bind a port');
  return Object.freeze({ app, port: address.port });
}

function invokeUpdate(
  port: number,
  fixture: G04bFixture,
  body: Readonly<Record<string, unknown>>,
): Promise<HttpResult> {
  const wire = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method: 'PATCH', path: `/qualifications/${fixture.qualificationId}`, agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(wire)),
        Authorization: 'Bearer operator',
        'PassHub-Dataset-Epoch': fixture.datasetEpoch,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }));
    });
    request.once('error', reject);
    request.end(wire);
  });
}

interface AppMonitor {
  readonly observations: SanitizedWireObservation[];
  readonly sessionEndCalls: () => number;
  waitForSessionEnd(): Promise<void>;
  sealNoLateCommandFence(): number;
  stop(): void;
}

function monitorAppFailurePath(client: MongoClient): AppMonitor {
  const observations: SanitizedWireObservation[] = [];
  const sessionIds = new Set<string>();
  const startedByRequestId = new Map<number, SanitizedWireObservation>();
  const endSpies: jest.SpiedFunction<ClientSession['endSession']>[] = [];
  let endCalls = 0;
  let resolveSessionEnd!: () => void;
  const sessionEnded = new Promise<void>((resolve) => { resolveSessionEnd = resolve; });
  const originalStartSession = client.startSession.bind(client);
  const startSession = jest.spyOn(client, 'startSession').mockImplementation((options) => {
    const session = originalStartSession(options);
    sessionIds.add(EJSON.stringify(session.id, { relaxed: false }));
    const originalEndSession = session.endSession.bind(session);
    endSpies.push(jest.spyOn(session, 'endSession').mockImplementation(async (...args) => {
      try {
        return await originalEndSession(...args);
      } finally {
        endCalls += 1;
        resolveSessionEnd();
      }
    }));
    return session;
  });
  const started = (event: CommandStartedEvent): void => {
    const sessionId = event.command.lsid;
    const matchesAppSession = sessionId === undefined
      ? false
      : sessionIds.has(EJSON.stringify(sessionId, { relaxed: false }));
    const observation = sanitizeStarted(event, matchesAppSession);
    observations.push(observation);
    startedByRequestId.set(event.requestId, observation);
  };
  const succeeded = (event: CommandSucceededEvent): void => {
    const started = startedByRequestId.get(event.requestId);
    if (started !== undefined) observations.push(sanitizeSucceeded(event, started));
  };
  const failed = (event: CommandFailedEvent): void => {
    const started = startedByRequestId.get(event.requestId);
    if (started !== undefined) observations.push(sanitizeFailed(event, started));
  };
  client.on('commandStarted', started);
  client.on('commandSucceeded', succeeded);
  client.on('commandFailed', failed);
  return {
    observations,
    sessionEndCalls: () => endCalls,
    waitForSessionEnd: async () => { await sessionEnded; },
    sealNoLateCommandFence: (): number => {
      if (endCalls !== 1) throw new Error(`G10b fault no-late fence requires one ended app session, got ${endCalls}`);
      return observations.length;
    },
    stop(): void {
      client.off('commandStarted', started);
      client.off('commandSucceeded', succeeded);
      client.off('commandFailed', failed);
      for (const endSpy of endSpies) endSpy.mockRestore();
      startSession.mockRestore();
    },
  };
}

function expectPrecommitFailureWire(
  monitor: AppMonitor,
  expectedCode: number,
): void {
  const started = monitor.observations.filter((item) => item.outcome === 'STARTED');
  const sessionWire = started.filter((item) => item.lsidMatchesAppSession);
  const aborts = sessionWire.filter((item) => item.commandName === 'abortTransaction');
  const commits = started.filter((item) => item.commandName === 'commitTransaction');
  const errorObservations = monitor.observations.filter((item) => item.outcome !== 'STARTED' && item.code === expectedCode);
  expect(errorObservations.length).toBeGreaterThanOrEqual(1);
  expect(errorObservations.every((item) => item.lsidMatchesAppSession && item.transactionNumberPresent)).toBe(true);
  expect(commits).toEqual([]);
  expect(aborts.length).toBeGreaterThanOrEqual(1);
  expect(aborts.length).toBeLessThanOrEqual(2);
  expect(aborts.every((item) => item.transactionNumberPresent)).toBe(true);
  expect(monitor.sessionEndCalls()).toBe(1);
}

function expectNoLateTransactionOrCrud(
  monitor: AppMonitor,
  observationsAtSessionEnd: number,
): void {
  expect(monitor.observations.slice(observationsAtSessionEnd)
    .filter((item) => item.outcome === 'STARTED' && ['abortTransaction', 'commitTransaction', 'insert', 'update', 'delete', 'findAndModify'].includes(item.commandName)))
    .toEqual([]);
}

type ObserverSnapshot = Readonly<{
  readonly eventCount: number;
  readonly qualification: Readonly<{
    readonly displayName: string;
    readonly presence: string;
    readonly version: number;
  }> | null;
  readonly mappingSlots: readonly Readonly<{
    readonly provider: string;
    readonly subject: string;
    readonly qualificationId: string | null;
    readonly version: number;
  }>[];
  readonly metadata: Readonly<{
    readonly qrGuardVersion: number;
    readonly faceGuardVersion: number;
    readonly slotCount: number;
  }> | null;
}>;

/** A direct, logically read-only, majority-committed snapshot observer. */
async function readObserverSnapshot(
  client: MongoClient,
  databaseName: string,
  fixture: G04bFixture,
): Promise<ObserverSnapshot> {
  const database = client.db(databaseName);
  const session = client.startSession();
  try {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      readPreference: 'primary',
      writeConcern: { w: 'majority', j: true },
    });
    // MongoDB does not permit concurrent operations on one transaction
    // session. These sequential reads are one coherent server snapshot.
    const eventCount = await database.collection<Document>('events').countDocuments({}, { session });
    const qualification = await database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne(
      { _id: fixture.qualificationId },
      { session, projection: { displayName: 1, presence: 1, version: 1 } },
    );
    const slots = await database.collection<Document>(G04B_FACE_SLOTS_COLLECTION).find(
      { qualificationId: fixture.qualificationId },
      { session, projection: { provider: 1, subject: 1, qualificationId: 1, version: 1 } },
    ).sort({ _id: 1 }).toArray();
    const metadata = await database.collection<{
      readonly _id: string;
      readonly qrGuardVersion: number;
      readonly faceGuardVersion: number;
      readonly slotCount: number;
    }>('metadata').findOne(
      { _id: 'system' },
      { session, projection: { qrGuardVersion: 1, faceGuardVersion: 1, slotCount: 1 } },
    );
    await session.commitTransaction();
    return Object.freeze({
      eventCount,
      qualification: qualification === null ? null : Object.freeze({
        displayName: qualification.displayName,
        presence: qualification.presence,
        version: qualification.version,
      }),
      mappingSlots: Object.freeze(slots.map((slot) => Object.freeze({
        provider: String(slot.provider),
        subject: String(slot.subject),
        qualificationId: typeof slot.qualificationId === 'string' ? slot.qualificationId : null,
        version: Number(slot.version),
      }))),
      metadata: metadata === null ? null : Object.freeze({
        qrGuardVersion: Number(metadata.qrGuardVersion),
        faceGuardVersion: Number(metadata.faceGuardVersion),
        slotCount: Number(metadata.slotCount),
      }),
    });
  } finally {
    if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
    await session.endSession();
  }
}

describe('G10b attached G07 to G08a to G04b fault paths through Toxiproxy', () => {
  let appClient: MongoClient;
  let observerClient: MongoClient;
  let interfererClient: MongoClient;

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
    expectFaultUriSplit();
    const [appHello, observerHello] = await Promise.all([
      appClient.db('admin').command({ hello: 1 }),
      observerClient.db('admin').command({ hello: 1 }),
    ]);
    expect(appHello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
    expect(appHello.hosts).toEqual(['toxiproxy-g10:27032']);
    expect(observerHello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });

  afterAll(async () => {
    await Promise.all([
      appClient.close().catch(() => undefined),
      observerClient.close().catch(() => undefined),
      interfererClient.close().catch(() => undefined),
    ]);
  });

  test('an actual 112 after the direct interferer changes the snapshot-read qualification aborts without an app partial effect', async () => {
    const databaseName = `passhub_g10b_attached_112_${randomUUID().replaceAll('-', '')}`.slice(0, 63);
    const fixture = createG04bFixture(NOW);
    const adapter = new G04bMongoPersistenceAdapter(appClient, databaseName, { nowMs: () => NOW });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    attachG10bG04bPersistenceSidecar(adapter);
    const managementAdapter = adapter as unknown as Pick<ManagementDataPort, 'readQualification'>;
    const originalReadQualification = managementAdapter.readQualification.bind(managementAdapter);
    let interfered = false;
    const readQualification = jest.spyOn(managementAdapter, 'readQualification').mockImplementation(async (context, qualificationId) => {
      const snapshot = await originalReadQualification(context, qualificationId);
      if (!interfered) {
        interfered = true;
        const changed = await interfererClient.db(databaseName)
          .collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
          .updateOne({ _id: fixture.qualificationId }, { $set: { displayName: 'interferer-112', updatedAt: new Date(NOW + 1) }, $inc: { version: 1 } });
        expect(changed.modifiedCount).toBe(1);
      }
      return snapshot;
    });
    const before = await readObserverSnapshot(observerClient, databaseName, fixture);
    expect(before).toMatchObject({
      eventCount: 0,
      qualification: { displayName: 'G04b fixture', presence: 'NOT_ENTERED', version: 0 },
      mappingSlots: [{ provider: 'DemoFace', subject: 'subject-1', qualificationId: fixture.qualificationId, version: 0 }],
      metadata: { qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 2 },
    });
    const http = await createAttachedHttpApplication(adapter, fixture);
    const monitor = monitorAppFailurePath(appClient);
    let httpClosed = false;
    try {
      const response = await invokeUpdate(http.port, fixture, { displayName: 'app-112-must-not-persist' });
      expect(response.status).toBe(503);
      expect(interfered).toBe(true);
      await monitor.waitForSessionEnd();
      // The completed HTTP response plus G04b's resolved endSession closes
      // both ingress and transaction lifecycles before the late-command
      // fence. The following direct snapshot supplies the next I/O turn;
      // this is a lifecycle boundary, not a time-based sleep.
      await http.app.nestApplication.close();
      httpClosed = true;
      const observationsAtSessionEnd = monitor.sealNoLateCommandFence();
      const after = await readObserverSnapshot(observerClient, databaseName, fixture);
      expectPrecommitFailureWire(monitor, 112);
      expectNoLateTransactionOrCrud(monitor, observationsAtSessionEnd);
      expect(after.eventCount).toBe(before.eventCount);
      expect(after.mappingSlots).toEqual(before.mappingSlots);
      expect(after.metadata).toEqual(before.metadata);
      expect(after.qualification).toMatchObject({ displayName: 'interferer-112', presence: 'NOT_ENTERED', version: 1 });
      expect(after.qualification?.displayName).not.toBe('app-112-must-not-persist');
    } finally {
      monitor.stop();
      readQualification.mockRestore();
      if (!httpClosed) await http.app.nestApplication.close();
    }
  });

  test('a normal server unique index duplicate face 11000 aborts without an app partial effect', async () => {
    const databaseName = `passhub_g10b_attached_11000_${randomUUID().replaceAll('-', '')}`.slice(0, 63);
    const fixture = createG04bFixture(NOW);
    const adapter = new G04bMongoPersistenceAdapter(appClient, databaseName, { nowMs: () => NOW });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    attachG10bG04bPersistenceSidecar(adapter);
    const duplicateProvider = 'DemoFace';
    const duplicateSubject = 'server-duplicate-subject';
    const interfererQualificationId = randomUUID();
    // This direct writer creates an ordinary, already-committed conflicting
    // face mapping. The app sees it through its snapshot but its normal
    // bind path deliberately claims an empty slot, so the server's unique
    // index—not a test double—rejects the final update with E11000.
    await interfererClient.db(databaseName).collection<G04aFaceSlotDocument>(G04B_FACE_SLOTS_COLLECTION).insertOne({
      _id: randomUUID(),
      provider: duplicateProvider,
      subject: duplicateSubject,
      qualificationId: interfererQualificationId,
      qualificationIncarnation: randomUUID(),
      slotIncarnation: randomUUID(),
      version: 0,
    });
    const before = await readObserverSnapshot(observerClient, databaseName, fixture);
    expect(before).toMatchObject({
      eventCount: 0,
      qualification: { displayName: 'G04b fixture', presence: 'NOT_ENTERED', version: 0 },
      mappingSlots: [{ provider: 'DemoFace', subject: 'subject-1', qualificationId: fixture.qualificationId, version: 0 }],
      metadata: { qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 2 },
    });
    const http = await createAttachedHttpApplication(adapter, fixture);
    const monitor = monitorAppFailurePath(appClient);
    let httpClosed = false;
    try {
      const response = await invokeUpdate(http.port, fixture, {
        face: { provider: duplicateProvider, externalSubjectId: duplicateSubject },
      });
      expect(response.status).toBe(409);
      await monitor.waitForSessionEnd();
      await http.app.nestApplication.close();
      httpClosed = true;
      const observationsAtSessionEnd = monitor.sealNoLateCommandFence();
      const after = await readObserverSnapshot(observerClient, databaseName, fixture);
      expectPrecommitFailureWire(monitor, 11000);
      expectNoLateTransactionOrCrud(monitor, observationsAtSessionEnd);
      expect(after).toEqual(before);
    } finally {
      monitor.stop();
      if (!httpClosed) await http.app.nestApplication.close();
    }
  });
});
