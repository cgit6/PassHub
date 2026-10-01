import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MongoClient, type Document } from 'mongodb';

import { createAccessComposition } from '../../src/composition/access-composition.js';
import { createSourceAuth, type HumanAuthCapability } from '../../src/auth/application/index.js';
import { HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import {
  createVerifiedComparisonPort,
  verifyStartupVectorsAndCreateComparisonCapability,
} from '../../src/access/application/comparison/index.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import type { RecognitionDataPort } from '../../src/access/ports/access-ports.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bRouteComposition,
  createG08aManagementComposition,
  createG08bRecognitionComposition,
  createG09aQueryComposition,
  createHttpResponsePlanBundle,
  createQueryApplication,
  createSourceBoundRecognitionExecutorFactory,
  createUnknownRecognitionCoordinatorBundle,
  createWriterQuiescence,
} from '../../src/composition/internal/index.js';
import { createG10aAdmissionRuntimeComposition } from '../../src/composition/internal/g10a-admission-runtime-composition.js';
import { createG10aRuntimeHttpApplication } from '../../src/composition/internal/g10a-runtime-http-application.js';
import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import {
  G04B_EVENTS_COLLECTION,
  G04bMongoPersistenceAdapter,
  createG04bFixture,
} from '../../src/infrastructure/mongo/index.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { dispatchRuntimeControlProtocol, type RuntimeControlProtocolFrame } from '../../src/runtime/internal/runtime-control-protocol.js';
import type { RuntimeControl } from '../../src/runtime/internal/runtime-control.js';
import { validateRuntimeLogRecord } from '../../src/runtime/internal/runtime-log-schema.js';
import {
  FIXED_COMPARISON_REFERENCE_ID,
  FIXED_STARTUP_VECTORS,
  FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';

const URI = process.env.G10A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_SECRET = 'A'.repeat(43);
const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
  hmacKey: FIXED_TEST_HMAC_KEY,
  comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
  vectors: FIXED_STARTUP_VECTORS,
}));

class HarnessAuth implements HumanAuthCapability {
  readonly operator = new HumanPrincipal();
  login(): Promise<{ accessToken: string }> { return Promise.resolve({ accessToken: 'unused' }); }
  verifyAccessToken(value: string): Promise<HumanPrincipal> {
    return value === 'operator' ? Promise.resolve(this.operator) : Promise.reject(new Error('invalid token'));
  }
  facts(principal: HumanPrincipal): { userId: string; role: HumanRole } {
    if (principal !== this.operator) throw new Error('unknown principal');
    return { userId: ACCOUNT_ID, role: 'OPERATOR' };
  }
  assertRole(principal: HumanPrincipal, role: HumanRole): void {
    if (principal !== this.operator || role !== 'OPERATOR') throw new Error('forbidden');
  }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function sendRecognition(
  port: number,
  body: Record<string, unknown>,
  retryMode?: 'existing-only',
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const wire = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/recognition/attempts', agent: false,
      headers: {
        Authorization: `Source entry.${SOURCE_SECRET}`,
        'PassHub-Dataset-Epoch': EPOCH,
        ...(retryMode === undefined ? {} : { 'PassHub-Retry-Mode': retryMode }),
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(wire)),
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

async function status(control: RuntimeControl): Promise<ReturnType<RuntimeControl['snapshot']>> {
  const text = `${JSON.stringify({ v: 'c1', requestControlId: randomUUID(), command: 'STATUS', epoch: EPOCH, run: RUN })}\n`;
  const response = await dispatchRuntimeControlProtocol(control, Object.freeze({
    text, utf8Valid: true, hasBom: false, singleFinalLf: true, byteLength: Buffer.byteLength(text),
  }) satisfies RuntimeControlProtocolFrame);
  if (response === undefined || !response.ok || response.snapshot === null) throw new Error('expected STATUS snapshot');
  return response.snapshot;
}

async function command(
  control: RuntimeControl,
  commandName: 'HOLD' | 'RELEASE' | 'DRAIN',
  expectedRevision: string,
  extra: Readonly<Record<string, unknown>> = Object.freeze({}),
): Promise<Extract<Awaited<ReturnType<typeof dispatchRuntimeControlProtocol>>, { readonly ok: true }>> {
  const text = `${JSON.stringify({
    v: 'c1', requestControlId: randomUUID(), command: commandName, epoch: EPOCH, run: RUN, expectedRevision, ...extra,
  })}\n`;
  const response = await dispatchRuntimeControlProtocol(control, Object.freeze({
    text, utf8Valid: true, hasBom: false, singleFinalLf: true, byteLength: Buffer.byteLength(text),
  }) satisfies RuntimeControlProtocolFrame);
  if (response === undefined || !response.ok) throw new Error(`${commandName} unexpectedly rejected`);
  return response;
}

async function waitForStatus(
  control: RuntimeControl,
  predicate: (snapshot: ReturnType<RuntimeControl['snapshot']>) => boolean,
  label: string,
): Promise<ReturnType<RuntimeControl['snapshot']>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const snapshot = await status(control);
    if (predicate(snapshot)) return snapshot;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('G10a true HTTP/Mongo recognition retry provenance', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = new MongoClient(URI, { monitorCommands: true, retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });
  afterAll(async () => { await client.close(); });

  test('existing-only joins then canonically replays under maintenance without a second registration or Mongo Event', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-recognition-http-'));
    const database = `passhub_g10a_recognition_${process.pid}`.slice(0, 63);
    const adapter = new G04bMongoPersistenceAdapter(client, database, { nowMs: () => Date.now() });
    await adapter.ensureSchema();
    const seeded = createG04bFixture(Date.now());
    const fixture = Object.freeze({
      ...seeded,
      datasetEpoch: EPOCH,
      metadata: Object.freeze({ ...seeded.metadata, datasetEpoch: EPOCH }),
    });
    await adapter.clearAndSeed(fixture);
    const stageEntered = deferred<void>();
    const stageRelease = deferred<void>();
    let stageCalls = 0;
    // The timing gate is deliberately outside business behavior: it pauses
    // immediately before one real adapter write, then delegates that exact
    // write to G04b. It makes the existing-operation join externally visible.
    const recognitionPort: RecognitionDataPort = Object.freeze({
      readQualification: adapter.readQualification.bind(adapter),
      readMapping: adapter.readMapping.bind(adapter),
      resolveQr: adapter.resolveQr.bind(adapter),
      resolveFace: adapter.resolveFace.bind(adapter),
      async stageRecognitionResult(...args: Parameters<RecognitionDataPort['stageRecognitionResult']>) {
        stageCalls += 1;
        stageEntered.resolve();
        await stageRelease.promise;
        return adapter.stageRecognitionResult(...args);
      },
      discard: adapter.discard.bind(adapter),
    });
    const sourceAuth = createSourceAuth({ credentialVerifier: {
      verify: (alias, secret) => Promise.resolve(
        alias === 'entry' && secret === SOURCE_SECRET ? Object.freeze({ sourceId: fixture.sourceEntryId }) : null,
      ),
    } });
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const handoff = createAdmissionWorkHandoffBundle();
    const capabilities = createOperationRegistryCapabilityIssuer({
      registryId: `g10a-recognition-${process.pid}`,
      datasetEpoch: EPOCH,
      processRunId: RUN,
      ownerId: '44444444-4444-4444-8444-444444444444',
      sameArtifact: (left, right) => {
        const a = left as Readonly<{ readonly inputHmac?: unknown; readonly comparisonReferenceId?: unknown }>;
        const b = right as Readonly<{ readonly inputHmac?: unknown; readonly comparisonReferenceId?: unknown }>;
        return a.inputHmac === b.inputHmac && a.comparisonReferenceId === b.comparisonReferenceId;
      },
    });
    const registry = createOperationRegistry({
      capabilities,
      writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: () => undefined,
      assertContinuationEvidence: () => undefined,
    });
    const quiescence = createWriterQuiescence({ clock: { nowMs: Date.now } });
    const humanAuth = new HarnessAuth();
    const access = createAccessComposition({ management: adapter, query: adapter, epoch: EPOCH });
    const management = createG08aManagementComposition({
      auth: humanAuth, manageQualifications: access.manageQualifications, responsePlans: plans, workHandoff: handoff,
    });
    const query = createG09aQueryComposition({
      currentDatasetEpoch: EPOCH,
      auth: humanAuth,
      queryApplication: createQueryApplication({ data: adapter, writerQuiescence: quiescence, epoch: EPOCH }),
      responsePlans: plans,
      workHandoff: handoff,
      writerQuiescence: quiescence,
    });
    const recognition = createG08bRecognitionComposition({
      sourceAuth,
      comparison,
      registryCapabilities: capabilities,
      recognizeAttempt: createSourceBoundRecognitionExecutorFactory({
        recognition: recognitionPort, sourceFacts: adapter, epoch: EPOCH, comparison,
      }),
      responsePlans: plans,
      workHandoff: handoff,
    });
    const rejected = async () => Object.freeze({ kind: 'REJECTED' as const, response: plans.technical.issue('INVALID_REQUEST') });
    const routes = createG07bRouteComposition({
      login: Object.freeze({ validate: rejected, login: async () => plans.technical.issue('INVALID_REQUEST') }),
      query,
      management: Object.freeze({ validate: management.validator.validate, management: management.work.management }),
      recognition: Object.freeze({ validate: recognition.validator.validate, recognition: recognition.work.recognition }),
    });
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH,
      run: RUN,
      logDirectory: join(parent, 'logs'),
      controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() },
      awaitObservation: () => undefined,
    });
    let control: RuntimeControl | undefined;
    let application: Awaited<ReturnType<typeof createG10aRuntimeHttpApplication>> | undefined;
    try {
      application = await createG10aRuntimeHttpApplication({
        runtimeOwner: owner,
        createAcceptedHandler: (runtime) => {
          const composed = createG10aAdmissionRuntimeComposition({
            epoch: EPOCH,
            run: RUN,
            monotonicClock: { nowMs: () => performance.now() },
            awaitObservation: () => undefined,
            runtime,
            admission: {
              currentDatasetEpoch: EPOCH,
              registry,
              registryCapabilities: capabilities,
              responsePlans: plans,
              workHandoff: handoff,
              unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
              validator: routes.validator,
              work: routes.work,
              writerQuiescence: quiescence,
            },
          });
          control = composed.control;
          return composed.handler;
        },
      });
      await application.application.nestApplication.listen(0, '127.0.0.1');
      const address = application.application.server.address();
      if (address === null || typeof address === 'string' || control === undefined) throw new Error('recognition test server did not start');
      const body = Object.freeze({ externalEventId: 'g10a-retry-event', kind: 'FACE_UNKNOWN' });

      const original = sendRecognition(address.port, body);
      await stageEntered.promise;
      await waitForStatus(control, (snapshot) => snapshot.issuedPersistence === 1 && snapshot.writers.running === 1, 'original recognition at real G04b write seam');

      const held = await command(control, 'HOLD', (await status(control)).revision);
      expect(held.outcome).toBe('HELD');
      const joined = await sendRecognition(address.port, body, 'existing-only');
      expect(joined).toMatchObject({ status: 202, body: { externalEventId: body.externalEventId, stage: 'RUNNING' } });
      expect(stageCalls).toBe(1);
      expect(await client.db(database).collection<Document>(G04B_EVENTS_COLLECTION).countDocuments()).toBe(0);
      await expect(status(control)).resolves.toMatchObject({ issuedPersistence: 1, writers: { running: 1, queued: 0 } });

      const heldControlId = held.controlId;
      if (heldControlId === null) throw new Error('HOLD lacked control ID');
      await expect(command(control, 'RELEASE', (await status(control)).revision, { controlId: heldControlId })).resolves.toMatchObject({ outcome: 'RELEASED' });
      stageRelease.resolve();
      const originalResponse = await original;
      expect(originalResponse).toMatchObject({ status: 200, body: { outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN', replayed: false } });
      await waitForStatus(control, (snapshot) => snapshot.issuedPersistence === 0 && snapshot.writers.running === 0, 'original recognition settlement');
      expect(await client.db(database).collection<Document>(G04B_EVENTS_COLLECTION).countDocuments({
        sourceId: fixture.sourceEntryId, externalEventId: body.externalEventId,
      })).toBe(1);

      const drained = await command(control, 'DRAIN', (await status(control)).revision, { timeoutMs: 2_000 });
      expect(drained.outcome).toBe('DRAINED');
      const replay = await sendRecognition(address.port, body, 'existing-only');
      expect(replay).toMatchObject({ status: 200, body: { outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN', replayed: true } });
      // Maintenance still rejects a fresh recognition candidate at ingress;
      // it must not accidentally use the existing-only memory exception.
      await expect(sendRecognition(address.port, {
        externalEventId: 'g10a-drained-new-event', kind: 'FACE_UNKNOWN',
      })).resolves.toMatchObject({ status: 503, body: { code: 'TECHNICAL_BUSY' } });
      expect(stageCalls).toBe(1);
      expect(await client.db(database).collection<Document>(G04B_EVENTS_COLLECTION).countDocuments({
        sourceId: fixture.sourceEntryId, externalEventId: 'g10a-drained-new-event',
      })).toBe(0);
      expect(await client.db(database).collection<Document>(G04B_EVENTS_COLLECTION).countDocuments({
        sourceId: fixture.sourceEntryId, externalEventId: body.externalEventId,
      })).toBe(1);
      await expect(status(control)).resolves.toMatchObject({
        maintenance: { active: true, outcome: 'DRAINED' }, issuedPersistence: 0, writers: { queued: 0, running: 0 },
      });

      await (await owner.start()).runtimeLogSink.flush();
      const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      const recognitionAccepted = records.filter((record) => record.code === 'REQUEST_ACCEPTED' && record.route === 'RECOGNITION');
      const registration = records.filter((record) => record.code === 'OPERATION_REGISTERED' && record.route === 'RECOGNITION');
      expect(recognitionAccepted).toHaveLength(4);
      expect(registration).toHaveLength(1);
      const originalRequest = registration[0];
      if (originalRequest === undefined) throw new Error('missing original recognition registration');
      const originalRecords = records.filter((record) => record.requestUUID === originalRequest.requestUUID);
      expect(originalRecords.map((record) => record.code)).toEqual(expect.arrayContaining([
        'REQUEST_ACCEPTED', 'OPERATION_REGISTERED',
        'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
        'DRIVER_STARTED', 'DRIVER_SUCCEEDED',
      ]));
      const originalPostIngress = originalRecords.filter((record) => record.code !== 'REQUEST_ACCEPTED');
      expect(originalPostIngress.length).toBeGreaterThan(0);
      expect(originalPostIngress.every((record) =>
        record.operationUUID === originalRequest.operationUUID
        && record.ownerRef === originalRequest.ownerRef
        && record.route === 'RECOGNITION',
      )).toBe(true);
      expect(originalPostIngress.filter((record) => record.kind === 'RUNTIME' || record.kind === 'DRIVER').every((record) =>
        record.operationUUID === originalRequest.operationUUID && record.ownerRef === originalRequest.ownerRef,
      )).toBe(true);
      const retryRequestIds = recognitionAccepted.map((record) => record.requestUUID)
        .filter((requestUUID) => requestUUID !== originalRequest.requestUUID);
      expect(retryRequestIds).toHaveLength(3);
      for (const requestUUID of retryRequestIds) {
        const retryRecords = records.filter((record) => record.requestUUID === requestUUID);
        expect(retryRecords.every((record) => record.operationUUID === null && record.ownerRef === null)).toBe(true);
        expect(retryRecords.some((record) => record.code === 'OPERATION_REGISTERED' || record.kind === 'DRIVER')).toBe(false);
      }
    } finally {
      await application?.close().catch(() => undefined);
      await client.db(database).dropDatabase().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });
});
