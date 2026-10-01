import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MongoClient } from 'mongodb';

import { createAccessComposition } from '../../src/composition/access-composition.js';
import { HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import type { ManagementDataPort } from '../../src/access/ports/access-ports.js';
import type { QueryDataPort } from '../../src/access/ports/query-ports.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bRouteComposition,
  createG08aManagementComposition,
  createG09aQueryComposition,
  createHttpResponsePlanBundle,
  createQueryApplication,
  createUnknownRecognitionCoordinatorBundle,
  createWriterQuiescence,
} from '../../src/composition/internal/index.js';
import { createG10aAdmissionRuntimeComposition } from '../../src/composition/internal/g10a-admission-runtime-composition.js';
import { createG10aRuntimeHttpApplication } from '../../src/composition/internal/g10a-runtime-http-application.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import { G04B_QUALIFICATIONS_COLLECTION, G04bMongoPersistenceAdapter, createG04bFixture } from '../../src/infrastructure/mongo/index.js';
import { createG10aDriverLogBinding } from '../../src/composition/internal/g10a-driver-log-binding.js';
import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { validateRuntimeLogRecord } from '../../src/runtime/internal/runtime-log-schema.js';
import { dispatchRuntimeControlProtocol, type RuntimeControlProtocolFrame } from '../../src/runtime/internal/runtime-control-protocol.js';
import type { RuntimeControl } from '../../src/runtime/internal/runtime-control.js';

const URI = process.env.G10A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

class HarnessAuth implements HumanAuthCapability {
  readonly operator = new HumanPrincipal();
  login(): Promise<{ accessToken: string }> { return Promise.resolve({ accessToken: 'unused' }); }
  verifyAccessToken(value: string): Promise<HumanPrincipal> { return value === 'operator' ? Promise.resolve(this.operator) : Promise.reject(new Error('invalid token')); }
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

async function waitForSnapshot(
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

async function mutateControl(
  control: RuntimeControl,
  command: 'HOLD' | 'RELEASE' | 'DRAIN',
  expectedRevision: string,
  extra: Readonly<Record<string, unknown>> = Object.freeze({}),
): Promise<Extract<Awaited<ReturnType<typeof dispatchRuntimeControlProtocol>>, { readonly ok: true }>> {
  const payload = Object.freeze({
    v: 'c1', requestControlId: randomUUID(), command, epoch: EPOCH, run: RUN, expectedRevision, ...extra,
  });
  const text = `${JSON.stringify(payload)}\n`;
  const frame: RuntimeControlProtocolFrame = Object.freeze({
    text, utf8Valid: true, hasBom: false, singleFinalLf: true, byteLength: Buffer.byteLength(text),
  });
  const result = await dispatchRuntimeControlProtocol(control, frame);
  if (result === undefined || !result.ok) throw new Error(`control ${command} was rejected`);
  return result;
}

function sendHttp(port: number, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const wire = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: {
        Authorization: 'Bearer operator',
        ...(wire === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(wire)) }),
        ...(method === 'POST' ? { 'PassHub-Dataset-Epoch': EPOCH } : {}),
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
  const text = `${JSON.stringify({ v: 'c1', requestControlId: '99999999-9999-4999-8999-999999999999', command: 'STATUS', epoch: EPOCH, run: RUN })}\n`;
  const frame: RuntimeControlProtocolFrame = Object.freeze({ text, utf8Valid: true, hasBom: false, singleFinalLf: true, byteLength: Buffer.byteLength(text) });
  const response = await dispatchRuntimeControlProtocol(control, frame);
  if (response === undefined || !response.ok || response.snapshot === null) throw new Error('expected STATUS snapshot');
  return response.snapshot;
}

/**
 * This is intentionally an independent true-driver integration seam, not a
 * G10a evidence run.  It proves that official Mongo command-monitoring events
 * (rather than a hand-emitted EventEmitter fixture) can be attributed by the
 * private runtime binding.  The future G10a integration runner owns Docker,
 * evidence manifest, and broader G07/G08 flow coverage.
 */
describe('G10a true MongoDB driver command monitoring', () => {
  let parent: string;
  let client: MongoClient;
  let owner: ReturnType<typeof createG10aRuntimeOwner>;
  let databaseName: string;

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-driver-log-'));
    databaseName = `passhub_g10a_driver_${process.pid}`.slice(0, 63);
    client = new MongoClient(URI, { monitorCommands: true, retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
    owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    await owner.start();
    // Construction binds the real client's official command events exactly once.
    new G04bMongoPersistenceAdapter(client, databaseName);
  });

  afterAll(async () => {
    await client.db(databaseName).dropDatabase().catch(() => undefined);
    await client.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });

  test('attributes real insert/find command lifecycle to writer and read identities without command payloads', async () => {
    const runtime = await owner.start();
    const binding = createG10aDriverLogBinding(runtime);
    const writerToken = runtime.identityIssuer.issueBusinessToken({ operationUUID: randomUUID(), ownerRef: randomUUID() });
    const writer = runtime.identityIssuer.issue({ requestUUID: randomUUID(), operationToken: writerToken, route: 'MANAGEMENT_CREATE' });
    const reader = runtime.identityIssuer.issue({ requestUUID: randomUUID(), operationToken: null, operationUUID: null, ownerRef: null, route: 'QUERY' });
    const collection = client.db(databaseName).collection<{ readonly _id: string }>('g10a_driver_probe');

    await binding.run(writer, async () => {
      await collection.insertOne({ _id: 'writer-probe' });
      await collection.findOne({ _id: 'writer-probe' });
      // A malformed raw `find` reaches the server, so the real driver emits
      // commandFailed (unlike duplicate-key writeErrors in a succeeded insert reply).
      await expect(client.db(databaseName).command({ find: 'g10a_driver_probe', filter: 'not-a-document' })).rejects.toBeDefined();
      // `ping` is a genuine driver command but intentionally outside D184's allowlist.
      await client.db(databaseName).command({ ping: 1 });
    });
    await binding.run(reader, async () => { await collection.findOne({ _id: 'reader-probe' }); });
    await binding.run(reader, async () => {
      await Promise.all(Array.from({ length: 12 }, (_, index) => collection.findOne({ _id: `parallel-${index}` })));
    });
    await runtime.runtimeLogSink.flush();

    const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
      .split('\n').filter((line) => line.length > 0)
      .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown))
      .filter((record) => record.kind === 'DRIVER');
    expect(records.length).toBeGreaterThanOrEqual(8);
    expect(records.every((record) => ['find', 'aggregate', 'insert', 'update', 'delete', 'findAndModify', 'commitTransaction', 'abortTransaction', 'endSessions'].includes(record.commandName!))).toBe(true);
    expect(records.filter((record) => record.route === 'MANAGEMENT_CREATE').every((record) =>
      record.requestUUID === runtime.identityIssuer.read(writer).requestUUID
      && record.operationUUID === runtime.identityIssuer.read(writer).operationUUID
      && record.ownerRef === runtime.identityIssuer.read(writer).ownerRef
      && record.phase === 'DRIVER' && record.driverRequestId !== null,
    )).toBe(true);
    expect(records.filter((record) => record.route === 'QUERY').every((record) =>
      record.requestUUID === runtime.identityIssuer.read(reader).requestUUID
      && record.operationUUID === null && record.ownerRef === null,
    )).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_STARTED' && record.commandName === 'insert')).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_SUCCEEDED' && record.commandName === 'insert')).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_FAILED' && record.commandName === 'find')).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_STARTED' && record.commandName === 'find')).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_SUCCEEDED' && record.commandName === 'find')).toBe(true);
    const starts = records.filter((record) => record.code === 'DRIVER_STARTED');
    const terminals = records.filter((record) => record.code === 'DRIVER_SUCCEEDED' || record.code === 'DRIVER_FAILED');
    expect(starts).toHaveLength(terminals.length);
    // connectionId is intentionally absent from the on-disk contract, so the
    // displayed requestId is diagnostic only and cannot prove the bridge's
    // private composite key. Concurrent real finds instead prove that each
    // emitted read record retains the read identity and lifecycle balances.
    expect(records.filter((record) => record.route === 'QUERY' && record.commandName === 'find' && record.code === 'DRIVER_STARTED').length).toBeGreaterThanOrEqual(13);
  });

  test('closes one true HTTP G07→G08→G04b management path and a true query path under the same G10 owner', async () => {
    const runtimeParent = await mkdtemp(join(tmpdir(), 'passhub-g10a-http-mongo-'));
    const database = `passhub_g10a_http_closed_loop_${process.pid}`.slice(0, 63);
    const now = Date.now();
    const adapter = new G04bMongoPersistenceAdapter(client, database, { nowMs: () => Date.now() });
    await adapter.ensureSchema();
    const seeded = createG04bFixture(now);
    const fixture = Object.freeze({
      ...seeded,
      datasetEpoch: EPOCH,
      metadata: Object.freeze({ ...seeded.metadata, datasetEpoch: EPOCH }),
    });
    await adapter.clearAndSeed(fixture);
    const heldFirstEntered = deferred<void>();
    const heldFirstRelease = deferred<void>();
    const heldSecondEntered = deferred<void>();
    const heldSecondRelease = deferred<void>();
    const drainWriterEntered = deferred<void>();
    const drainWriterRelease = deferred<void>();
    const stageStarts: string[] = [];
    const stageGates = new Map<string, { readonly entered: { resolve(value: void): void }; readonly release: { readonly promise: Promise<void> } }>([
      ['G10a held writer one', { entered: heldFirstEntered, release: heldFirstRelease }],
      ['G10a held writer two', { entered: heldSecondEntered, release: heldSecondRelease }],
      ['G10a drain writer', { entered: drainWriterEntered, release: drainWriterRelease }],
    ]);
    const managementPort: ManagementDataPort = Object.freeze({
      readQualification: adapter.readQualification.bind(adapter),
      readMapping: adapter.readMapping.bind(adapter),
      async stageManagementChange(...args: Parameters<ManagementDataPort['stageManagementChange']>) {
        const [context, plan] = args;
        stageStarts.push(plan.displayName ?? '<non-create>');
        const gate = plan.displayName === null ? undefined : stageGates.get(plan.displayName);
        if (gate !== undefined) { gate.entered.resolve(); await gate.release.promise; }
        return adapter.stageManagementChange(context, plan);
      },
      discard: adapter.discard.bind(adapter),
    });
    const auth = new HarnessAuth();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const handoff = createAdmissionWorkHandoffBundle();
    const quiescence = createWriterQuiescence({ clock: { nowMs: Date.now } });
    const access = createAccessComposition({ management: managementPort, query: adapter, epoch: EPOCH });
    const management = createG08aManagementComposition({ auth, manageQualifications: access.manageQualifications, responsePlans: plans, workHandoff: handoff });
    const query = createG09aQueryComposition({
      currentDatasetEpoch: EPOCH,
      auth,
      queryApplication: createQueryApplication({ data: adapter, writerQuiescence: quiescence, epoch: EPOCH }),
      responsePlans: plans,
      workHandoff: handoff,
      writerQuiescence: quiescence,
    });
    const rejected = async () => Object.freeze({ kind: 'REJECTED' as const, response: plans.technical.issue('INVALID_REQUEST') });
    const routes = createG07bRouteComposition({
      login: Object.freeze({ validate: rejected, login: async () => plans.technical.issue('INVALID_REQUEST') }),
      query,
      management: Object.freeze({ validate: management.validator.validate, management: management.work.management }),
      recognition: Object.freeze({ validate: rejected, recognition: async () => ({ disposition: 'KNOWN_NO_EFFECT' as const, response: plans.technical.issue('INVALID_REQUEST') }) }),
    });
    const capabilities = createOperationRegistryCapabilityIssuer({
      registryId: `g10a-http-${process.pid}`,
      datasetEpoch: EPOCH,
      processRunId: RUN,
      ownerId: '44444444-4444-4444-8444-444444444444',
      sameArtifact: () => true,
    });
    const registry = createOperationRegistry({
      capabilities,
      writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: () => undefined,
      assertContinuationEvidence: () => undefined,
    });
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(runtimeParent, 'logs'),
      controlDirectory: join(runtimeParent, 'control'),
      controlSocketPath: join(runtimeParent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() },
      awaitObservation: () => new Promise<void>((resolve) => { setTimeout(resolve, 5); }),
    });
    let control: RuntimeControl | undefined;
    let runtimeHttp: Awaited<ReturnType<typeof createG10aRuntimeHttpApplication>> | undefined;
    try {
      runtimeHttp = await createG10aRuntimeHttpApplication({
        runtimeOwner: owner,
        createAcceptedHandler: (runtime) => {
          const composed = createG10aAdmissionRuntimeComposition({
            epoch: EPOCH, run: RUN,
            monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
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
      await runtimeHttp.application.nestApplication.listen(0, '127.0.0.1');
      const address = runtimeHttp.application.server.address();
      if (address === null || typeof address === 'string') throw new Error('HTTP server did not bind a port');
      if (control === undefined) throw new Error('runtime control was not captured');
      const qualification = (displayName: string): Record<string, unknown> => Object.freeze({
        displayName,
        validFrom: new Date(Date.now() + 1_000).toISOString(),
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
        face: null,
      });
      const queryResponse = await sendHttp(address.port, 'GET', '/qualifications');
      expect(queryResponse.status).toBe(200);
      const held = await mutateControl(control, 'HOLD', (await status(control)).revision);
      expect(held.outcome).toBe('HELD');
      const heldControlId = held.controlId;
      if (heldControlId === null) throw new Error('HOLD did not issue a control id');

      // Send in a known order and observe each request as READY before the
      // next arrives.  The post-release stage gates then prove FIFO start,
      // not merely eventual completion in a convenient order.
      const heldFirst = sendHttp(address.port, 'POST', '/qualifications', qualification('G10a held writer one'));
      await waitForSnapshot(control, (snapshot) => snapshot.writers.queued === 1 && snapshot.issuedPersistence === 0, 'first writer queued by HOLD');
      const heldSecond = sendHttp(address.port, 'POST', '/qualifications', qualification('G10a held writer two'));
      await waitForSnapshot(control, (snapshot) => snapshot.writers.queued === 2 && snapshot.issuedPersistence === 0, 'second writer queued by HOLD');
      const released = await mutateControl(control, 'RELEASE', (await status(control)).revision, { controlId: heldControlId });
      expect(released.outcome).toBe('RELEASED');
      await heldFirstEntered.promise;
      await waitForSnapshot(control, (snapshot) => snapshot.issuedPersistence === 1 && snapshot.writers.running === 1 && snapshot.writers.queued === 1, 'only first FIFO writer invoked');
      expect(stageStarts).toEqual(['G10a held writer one']);
      heldFirstRelease.resolve();
      await expect(heldFirst).resolves.toMatchObject({ status: 201, body: { operation: 'CREATE' } });
      await heldSecondEntered.promise;
      expect(stageStarts).toEqual(['G10a held writer one', 'G10a held writer two']);
      heldSecondRelease.resolve();
      await expect(heldSecond).resolves.toMatchObject({ status: 201, body: { operation: 'CREATE' } });
      await waitForSnapshot(control, (snapshot) => snapshot.issuedPersistence === 0 && snapshot.writers.queued === 0 && snapshot.writers.running === 0, 'FIFO writer settlement');
      expect(await client.db(database).collection(G04B_QUALIFICATIONS_COLLECTION).countDocuments({ displayName: { $in: ['G10a held writer one', 'G10a held writer two'] } })).toBe(2);

      // A writer that has crossed the exact G08 invocation seam must finish;
      // DRAIN vetoes later ingress but never pretends this admitted work was
      // not already in flight.
      const running = sendHttp(address.port, 'POST', '/qualifications', qualification('G10a drain writer'));
      await drainWriterEntered.promise;
      await waitForSnapshot(control, (snapshot) => snapshot.issuedPersistence === 1 && snapshot.writers.running === 1, 'admitted writer at G08 persistence seam');
      const drainPromise = mutateControl(control, 'DRAIN', (await status(control)).revision, { timeoutMs: 2_000 });
      await waitForSnapshot(control, (snapshot) => snapshot.maintenance.active && snapshot.maintenance.outcome === 'WAITING' && snapshot.issuedPersistence === 1, 'DRAIN maintenance veto');
      await expect(sendHttp(address.port, 'POST', '/qualifications', qualification('G10a maintenance blocked writer'))).resolves.toMatchObject({ status: 503 });
      await expect(sendHttp(address.port, 'GET', '/qualifications')).resolves.toMatchObject({ status: 503 });
      drainWriterRelease.resolve();
      await expect(running).resolves.toMatchObject({ status: 201, body: { operation: 'CREATE' } });
      const drained = await drainPromise;
      expect(drained.outcome).toBe('DRAINED');
      await expect(status(control)).resolves.toMatchObject({
        maintenance: { active: true, outcome: 'DRAINED' }, issuedPersistence: 0, activeQueryReads: 0,
      });
      expect(await client.db(database).collection(G04B_QUALIFICATIONS_COLLECTION).countDocuments({ displayName: 'G10a drain writer' })).toBe(1);

      // The earlier non-maintenance query closes the query-driver provenance
      // route.  During maintenance the same endpoint is intentionally busy.
      // Create side effects above use the true Mongo collection, not a port
      // test double.
      const runtime = await owner.start();
      await runtime.runtimeLogSink.flush();
      const records = (await readFile(join(runtimeParent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      expect(records.map((record) => record.code)).toEqual(expect.arrayContaining([
        'HOLD_ACKNOWLEDGED', 'RELEASE_ACKNOWLEDGED', 'DRAIN_STARTED', 'DRAINED',
      ]));
      const registered = records.find((record) => record.code === 'OPERATION_REGISTERED');
      if (registered === undefined) throw new Error('missing operation registration');
      const writer = records.filter((record) => record.requestUUID === registered.requestUUID);
      expect(writer.map((record) => record.code)).toEqual(expect.arrayContaining([
        'REQUEST_ACCEPTED', 'OPERATION_REGISTERED',
        'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
        'DRIVER_STARTED', 'DRIVER_SUCCEEDED',
      ]));
      expect(writer.every((record) => record.operationUUID === null || record.operationUUID === registered.operationUUID)).toBe(true);
      expect(writer.filter((record) => record.code !== 'REQUEST_ACCEPTED').every((record) => record.ownerRef === registered.ownerRef)).toBe(true);
      expect(writer.filter((record) => record.kind === 'DRIVER').length).toBeGreaterThan(0);
      const queryDriver = records.filter((record) => record.kind === 'DRIVER' && record.route === 'QUERY');
      expect(queryDriver.length).toBeGreaterThan(0);
      expect(queryDriver.every((record) => record.requestUUID !== null && record.operationUUID === null && record.ownerRef === null)).toBe(true);
    } finally {
      await runtimeHttp?.close().catch(() => undefined);
      await client.db(database).dropDatabase().catch(() => undefined);
      await rm(runtimeParent, { recursive: true, force: true });
    }
  });

  test('DRAIN waits for a query that already reached G09 native Mongo work, then keeps the maintenance veto', async () => {
    const runtimeParent = await mkdtemp(join(tmpdir(), 'passhub-g10a-http-query-drain-'));
    const database = `passhub_g10a_http_query_drain_${process.pid}`.slice(0, 63);
    const adapter = new G04bMongoPersistenceAdapter(client, database, { nowMs: () => Date.now() });
    await adapter.ensureSchema();
    const seeded = createG04bFixture(Date.now());
    await adapter.clearAndSeed(Object.freeze({
      ...seeded, datasetEpoch: EPOCH, metadata: Object.freeze({ ...seeded.metadata, datasetEpoch: EPOCH }),
    }));
    const queryEntered = deferred<void>();
    const queryRelease = deferred<void>();
    const queryPort: QueryDataPort = Object.freeze({
      readQualification: adapter.readQualification.bind(adapter),
      readEvent: adapter.readEvent.bind(adapter),
      listInside: adapter.listInside.bind(adapter),
      listEvents: adapter.listEvents.bind(adapter),
      async listQualifications(...args: Parameters<QueryDataPort['listQualifications']>) {
        queryEntered.resolve();
        await queryRelease.promise;
        return adapter.listQualifications(...args);
      },
    });
    const auth = new HarnessAuth();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const handoff = createAdmissionWorkHandoffBundle();
    const quiescence = createWriterQuiescence({ clock: { nowMs: Date.now } });
    const access = createAccessComposition({ management: adapter, query: adapter, epoch: EPOCH });
    const management = createG08aManagementComposition({ auth, manageQualifications: access.manageQualifications, responsePlans: plans, workHandoff: handoff });
    const query = createG09aQueryComposition({
      currentDatasetEpoch: EPOCH,
      auth,
      queryApplication: createQueryApplication({ data: queryPort, writerQuiescence: quiescence, epoch: EPOCH }),
      responsePlans: plans,
      workHandoff: handoff,
      writerQuiescence: quiescence,
    });
    const rejected = async () => Object.freeze({ kind: 'REJECTED' as const, response: plans.technical.issue('INVALID_REQUEST') });
    const routes = createG07bRouteComposition({
      login: Object.freeze({ validate: rejected, login: async () => plans.technical.issue('INVALID_REQUEST') }),
      query,
      management: Object.freeze({ validate: management.validator.validate, management: management.work.management }),
      recognition: Object.freeze({ validate: rejected, recognition: async () => ({ disposition: 'KNOWN_NO_EFFECT' as const, response: plans.technical.issue('INVALID_REQUEST') }) }),
    });
    const capabilities = createOperationRegistryCapabilityIssuer({
      registryId: `g10a-http-query-drain-${process.pid}`,
      datasetEpoch: EPOCH,
      processRunId: RUN,
      ownerId: '55555555-5555-4555-8555-555555555555',
      sameArtifact: () => true,
    });
    const registry = createOperationRegistry({
      capabilities,
      writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: () => undefined,
      assertContinuationEvidence: () => undefined,
    });
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(runtimeParent, 'logs'),
      controlDirectory: join(runtimeParent, 'control'),
      controlSocketPath: join(runtimeParent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() },
      awaitObservation: () => new Promise<void>((resolve) => { setTimeout(resolve, 5); }),
    });
    let control: RuntimeControl | undefined;
    let runtimeHttp: Awaited<ReturnType<typeof createG10aRuntimeHttpApplication>> | undefined;
    try {
      runtimeHttp = await createG10aRuntimeHttpApplication({
        runtimeOwner: owner,
        createAcceptedHandler: (runtime) => {
          const composed = createG10aAdmissionRuntimeComposition({
            epoch: EPOCH, run: RUN,
            monotonicClock: { nowMs: () => performance.now() },
            awaitObservation: () => new Promise<void>((resolve) => { setTimeout(resolve, 5); }),
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
      await runtimeHttp.application.nestApplication.listen(0, '127.0.0.1');
      const address = runtimeHttp.application.server.address();
      if (address === null || typeof address === 'string' || control === undefined) throw new Error('G10a HTTP control fixture did not start');
      const activeQuery = sendHttp(address.port, 'GET', '/qualifications');
      await queryEntered.promise;
      await waitForSnapshot(control, (snapshot) => snapshot.activeQueryReads === 1 && snapshot.issuedPersistence === 0, 'query at the invoked G09 query-work seam');
      const drain = mutateControl(control, 'DRAIN', (await status(control)).revision, { timeoutMs: 2_000 });
      await waitForSnapshot(control, (snapshot) => snapshot.maintenance.active && snapshot.maintenance.outcome === 'WAITING' && snapshot.activeQueryReads === 1, 'DRAIN waiting for admitted query');
      await expect(sendHttp(address.port, 'GET', '/qualifications')).resolves.toMatchObject({ status: 503 });
      queryRelease.resolve();
      await expect(activeQuery).resolves.toMatchObject({ status: 200 });
      await expect(drain).resolves.toMatchObject({ outcome: 'DRAINED' });
      await expect(status(control)).resolves.toMatchObject({
        maintenance: { active: true, outcome: 'DRAINED' }, activeQueryReads: 0, issuedPersistence: 0,
      });
      const runtime = await owner.start();
      await runtime.runtimeLogSink.flush();
      const records = (await readFile(join(runtimeParent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      expect(records.map((record) => record.code)).toEqual(expect.arrayContaining(['DRAIN_STARTED', 'DRAINED', 'DRIVER_STARTED', 'DRIVER_SUCCEEDED']));
      expect(records.some((record) => record.kind === 'DRIVER' && record.route === 'QUERY' && record.requestUUID !== null && record.operationUUID === null && record.ownerRef === null)).toBe(true);
    } finally {
      await runtimeHttp?.close().catch(() => undefined);
      await client.db(database).dropDatabase().catch(() => undefined);
      await rm(runtimeParent, { recursive: true, force: true });
    }
  });
});
