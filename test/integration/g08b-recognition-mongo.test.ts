import { randomUUID } from 'node:crypto';

import { MongoClient, type Document } from 'mongodb';

import { createSourceAuth } from '../../src/auth/application/source-auth.js';
import {
  createVerifiedComparisonPort,
  verifyStartupVectorsAndCreateComparisonCapability,
} from '../../src/access/application/comparison/index.js';
import { createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import {
  createAdmissionWorkHandoffBundle,
  createG08bRecognitionComposition,
  createHttpResponsePlanBundle,
  createSourceBoundRecognitionExecutorFactory,
  type AdmissionValidationInput,
  type HttpResponsePlan,
} from '../../src/composition/internal/index.js';
import {
  G04A_FACE_SLOTS_COLLECTION,
  G04B_EVENTS_COLLECTION,
  G04B_QUALIFICATIONS_COLLECTION,
  G04B_SOURCES_COLLECTION,
  G04bMongoPersistenceAdapter,
  createG04bFixture,
} from '../../src/infrastructure/mongo/index.js';
import {
  FIXED_COMPARISON_REFERENCE_ID, FIXED_STARTUP_VECTORS, FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';

const uri = process.env.G08B_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G08B_MONGO_DATABASE_PREFIX ?? `passhub_g08b_${process.pid}`;
const BASE_NOW = 1_800_000_000_000;
const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
  hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
}));
interface StringIdDocument extends Document { _id: string }

describe('G08b true MongoDB 8.0.32 replica-set recognition composition', () => {
  let client: MongoClient;
  const databases: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    await client.connect();
    const buildInfo = await client.db('admin').command({ buildInfo: 1 });
    const hello = await client.db('admin').command({ hello: 1 });
    expect(buildInfo.version).toBe('8.0.32');
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });

  afterEach(async () => {
    const databaseName = databases.pop();
    if (databaseName !== undefined) await client.db(databaseName).dropDatabase();
  });
  afterAll(async () => { await client.close(); });

  async function setup(label: string) {
    const databaseName = `${databasePrefix}_${label}_${databases.length}`.slice(0, 63);
    databases.push(databaseName);
    const fixture = createG04bFixture(BASE_NOW);
    const adapter = new G04bMongoPersistenceAdapter(client, databaseName, { nowMs: () => BASE_NOW + 10 });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const sourceAuth = createSourceAuth({ credentialVerifier: {
      verify: (alias, secret) => Promise.resolve(
        alias === 'entry' && secret === 'A'.repeat(43) ? Object.freeze({ sourceId: fixture.sourceEntryId })
          : alias === 'exit' && secret === 'B'.repeat(43) ? Object.freeze({ sourceId: fixture.sourceExitId }) : null,
      ),
    } });
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: fixture.datasetEpoch });
    const handoff = createAdmissionWorkHandoffBundle();
    const capabilities = createOperationRegistryCapabilityIssuer({
      registryId: `g08b-${label}`, datasetEpoch: fixture.datasetEpoch, processRunId: 'run', ownerId: 'owner',
      sameArtifact: (left, right) => {
        const a = left as Readonly<{ inputHmac?: unknown; comparisonReferenceId?: unknown }>;
        const b = right as Readonly<{ inputHmac?: unknown; comparisonReferenceId?: unknown }>;
        return a.inputHmac === b.inputHmac && a.comparisonReferenceId === b.comparisonReferenceId;
      },
    });
    const composition = createG08bRecognitionComposition({
      sourceAuth, comparison, registryCapabilities: capabilities,
      recognizeAttempt: createSourceBoundRecognitionExecutorFactory({ recognition: adapter, sourceFacts: adapter, epoch: fixture.datasetEpoch, comparison }),
      responsePlans: plans, workHandoff: handoff,
    });
    return { fixture, adapter, database: client.db(databaseName), composition, plans };
  }

  function validationInput(epoch: string, body: Record<string, unknown>, authorization: string): AdmissionValidationInput {
    return {
      routeId: 'RECOGNITION_ATTEMPT', retryMode: 'NORMAL', parameters: {},
      accepted: { method: 'POST', body: body as never, query: [], headers: { authorization, datasetEpoch: epoch } },
    };
  }

  async function execute(
    h: Awaited<ReturnType<typeof setup>>,
    body: Record<string, unknown>,
    authorization = `Source entry.${'A'.repeat(43)}`,
    receivedAtMs = BASE_NOW,
  ) {
    const validation = await h.composition.validator.validate(validationInput(h.fixture.datasetEpoch, body, authorization));
    if (validation.kind !== 'RECOGNITION') throw new Error(`expected recognition, received ${validation.kind}`);
    return h.composition.work.recognition(validation.workInput, {
      operationId: randomUUID(), receivedAtMs, sequence: 0n,
    });
  }

  function render(h: Awaited<ReturnType<typeof setup>>, plan: HttpResponsePlan) {
    const response = h.plans.renderer.render(plan);
    return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
  }

  test('FACE ENTRY then EXIT atomically persists two Events, Presence, and mapping release', async () => {
    const h = await setup('face_lifecycle');
    const entry = await execute(h, {
      externalEventId: 'face-entry', kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1',
    });
    expect(entry.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    if (entry.disposition !== 'BUSINESS_RESULT_PERSISTED') return;
    expect(render(h, entry.originalResponse).body).toMatchObject({
      sourceId: h.fixture.sourceEntryId, direction: 'ENTRY', outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED', replayed: false,
    });

    const exit = await execute(h, {
      externalEventId: 'face-exit', kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: 'subject-1',
    }, `Source exit.${'B'.repeat(43)}`, BASE_NOW + 1);
    expect(exit.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    if (exit.disposition !== 'BUSINESS_RESULT_PERSISTED') return;
    expect(render(h, exit.originalResponse).body).toMatchObject({
      sourceId: h.fixture.sourceExitId, direction: 'EXIT', outcome: 'ACCEPTED', reasonCode: 'EXIT_RECORDED', replayed: false,
    });
    expect(await h.database.collection<Document>(G04B_EVENTS_COLLECTION).countDocuments()).toBe(2);
    expect(await h.database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: h.fixture.qualificationId })).toMatchObject({
      presence: 'EXITED', version: 2,
    });
    expect(await h.database.collection<Document>(G04A_FACE_SLOTS_COLLECTION).countDocuments({ qualificationId: h.fixture.qualificationId })).toBe(0);
  });

  test('FACE_UNKNOWN and inactive Source each persist one rejected Event without orphan effects', async () => {
    const h = await setup('rejected_events');
    const unknown = await execute(h, { externalEventId: 'unknown-event', kind: 'FACE_UNKNOWN' });
    expect(unknown.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    if (unknown.disposition === 'BUSINESS_RESULT_PERSISTED') {
      expect(render(h, unknown.originalResponse).body).toMatchObject({ outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN', qualificationId: null });
    }
    await h.database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).updateOne(
      { _id: h.fixture.sourceEntryId }, { $set: { active: false }, $inc: { version: 1 } },
    );
    const inactive = await execute(h, { externalEventId: 'inactive-event', kind: 'FACE_UNKNOWN' });
    expect(inactive.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    if (inactive.disposition === 'BUSINESS_RESULT_PERSISTED') {
      expect(render(h, inactive.originalResponse).body).toMatchObject({ outcome: 'REJECTED', reasonCode: 'SOURCE_INACTIVE' });
    }
    expect(await h.database.collection<Document>(G04B_EVENTS_COLLECTION).countDocuments()).toBe(2);
    expect(await h.database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).findOne({ _id: h.fixture.qualificationId })).toMatchObject({
      presence: 'NOT_ENTERED', version: 0,
    });
  });

  test('canonical replay survives Source mutation and creates no second Event', async () => {
    const h = await setup('canonical_replay');
    const body = { externalEventId: 'canonical-event', kind: 'FACE_UNKNOWN' };
    const first = await execute(h, body);
    expect(first.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    await h.database.collection<StringIdDocument>(G04B_SOURCES_COLLECTION).updateOne(
      { _id: h.fixture.sourceEntryId }, { $set: { active: false }, $inc: { version: 1 } },
    );
    const replay = await execute(h, body);
    expect(replay.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    if (replay.disposition !== 'BUSINESS_RESULT_PERSISTED') return;
    expect(render(h, replay.originalResponse).body).toMatchObject({ reasonCode: 'FACE_UNKNOWN', replayed: true });
    expect(await h.database.collection<Document>(G04B_EVENTS_COLLECTION).countDocuments({
      sourceId: h.fixture.sourceEntryId, externalEventId: body.externalEventId,
    })).toBe(1);
  });
});
