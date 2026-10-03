import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAdmissionWorkHandoffBundle,
  createAdmissionResourceLedger,
  createConfigurableFixedMinuteRateLedger,
  createHttpResponsePlanBundle,
  createUnknownRecognitionCoordinatorBundle,
  type AdmissionResourceLedger,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWorkPort,
} from '../../src/composition/internal/index.js';
import { createG10aAdmissionRuntimeComposition } from '../../src/composition/internal/g10a-admission-runtime-composition.js';
import { createG10aOperationIdentityBinding } from '../../src/composition/internal/g10a-operation-identity-binding.js';
import { createG10aIngressIdentityHandler } from '../../src/composition/internal/g10a-ingress-identity.js';
import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { dispatchRuntimeControlProtocol, type RuntimeControlProtocolFrame } from '../../src/runtime/internal/runtime-control-protocol.js';
import { validateRuntimeLogRecord } from '../../src/runtime/internal/runtime-log-schema.js';
import { RuntimeLogSink } from '../../src/runtime/internal/runtime-log-sink.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import type { NarrowHttpResponse } from '../../src/composition/internal/http-response-owner.js';
import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

class FakeResponse extends EventEmitter implements NarrowHttpResponse {
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  setHeader(): void { /* transport rendering is outside this composition seam */ }
  end(): void { this.writableEnded = true; this.emit('finish'); }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeComposition(
  workOverride?: Partial<AdmissionWorkPort>,
  validateOverride?: (input: AdmissionValidationInput) => Promise<AdmissionValidationResult>,
  onManagementContext?: (context: Parameters<AdmissionWorkPort['management']>[1]) => void,
  managementRateLimit = 10,
  compose = true,
  resourcesOverride?: AdmissionResourceLedger,
) {
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  const capabilities = createOperationRegistryCapabilityIssuer({
    registryId: 'g10a-composition-test',
    datasetEpoch: EPOCH,
    processRunId: RUN,
    ownerId: '33333333-3333-4333-8333-333333333333',
    sameArtifact: () => true,
  });
  const registry = createOperationRegistry({
    capabilities,
    writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
    assertOwnerCurrent: () => undefined,
    assertContinuationEvidence: () => undefined,
  });
  let validationCalls = 0;
  const defaultValidate = async (input: AdmissionValidationInput): Promise<AdmissionValidationResult> => {
    validationCalls += 1;
    if (input.routeId === 'QUALIFICATION_CREATE') {
      return Object.freeze({ kind: 'MANAGEMENT', accountId: 'operator-1', workInput: handoff.issuer.issue(input.routeId) });
    }
    if (input.routeId === 'QUALIFICATION_LIST') {
      return Object.freeze({ kind: 'QUERY', accountId: 'viewer-1', workInput: handoff.issuer.issue(input.routeId) });
    }
    if (input.routeId === 'AUTH_LOGIN') {
      return Object.freeze({ kind: 'LOGIN', workInput: handoff.issuer.issue(input.routeId) });
    }
    if (input.routeId === 'RECOGNITION_ATTEMPT') {
      return Object.freeze({
        kind: 'RECOGNITION',
        registryKey: capabilities.issueKey('source-1', 'event-1'),
        comparisonArtifact: capabilities.issueComparisonArtifact(Object.freeze({ digest: 'same' })),
        workInput: handoff.issuer.issue(input.routeId),
      });
    }
    return Object.freeze({ kind: 'REJECTED', response: plans.technical.issue('INVALID_REQUEST') });
  };
  const validate = validateOverride === undefined
    ? defaultValidate
    : async (input: AdmissionValidationInput): Promise<AdmissionValidationResult> => {
      validationCalls += 1;
      return validateOverride(input);
    };
  const queryDelegate = workOverride?.query
    ?? (() => Promise.resolve(plans.business.issue(200, { ok: true })));
  const query = createLegacyQueryAdmissionCapability({
    validate,
    query: queryDelegate,
  });
  const resources = resourcesOverride ?? createAdmissionResourceLedger();
  const rates = createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => 0 } }, {
    login: { perKey: 10, global: 10, maxKeys: 2 },
    query: { perKey: 10, global: 10 },
    recognition: { perKey: 10, global: 10 },
    management: { perKey: managementRateLimit, global: managementRateLimit },
  });
  const defaults: AdmissionWorkPort = {
    login: () => Promise.resolve(plans.business.issue(200, { ok: true })),
    query: query.work.query,
    management: (_input, context) => {
      onManagementContext?.(context);
      return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') });
    },
    recognition: () => Promise.resolve({
      disposition: 'BUSINESS_RESULT_PERSISTED',
      originalResponse: plans.business.issue(200, { ok: true }),
      replayResponse: plans.business.issue(200, { ok: true }),
    }),
  };
  const admission = {
    currentDatasetEpoch: EPOCH,
    registry,
    registryCapabilities: capabilities,
    responsePlans: plans,
    workHandoff: handoff,
    validator: query.validator,
    // Query provenance is nominal: overrides must be wrapped before G07 sees
    // them, rather than replacing the trusted capability method afterward.
    work: { ...defaults, ...workOverride, query: query.work.query },
    unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
    resources,
    rates,
  };
  return {
    plans,
    resources,
    rates,
    validationCalls: () => validationCalls,
    admission,
    composition: (compose ? createG10aAdmissionRuntimeComposition({
      epoch: EPOCH,
      run: RUN,
      monotonicClock: { nowMs: () => 0 },
      awaitObservation: () => undefined,
      admission,
    }) : undefined) as ReturnType<typeof createG10aAdmissionRuntimeComposition>,
  };
}

function invoke(handler: ReturnType<typeof createG10aAdmissionRuntimeComposition>['handler']): void {
  handler(
    Object.freeze({ method: 'POST', body: null, query: [], headers: { datasetEpoch: EPOCH } }),
    { originalUrl: '/qualifications', url: '/qualifications', socket: { remoteAddress: '127.0.0.1' } } as never,
    new FakeResponse() as never,
    (() => undefined) as never,
  );
}

function invokeQuery(handler: ReturnType<typeof createG10aAdmissionRuntimeComposition>['handler']): FakeResponse {
  const response = new FakeResponse();
  handler(
    Object.freeze({ method: 'GET', body: null, query: [], headers: { datasetEpoch: EPOCH } }),
    { originalUrl: '/qualifications', url: '/qualifications', socket: { remoteAddress: '127.0.0.1' } } as never,
    response as never,
    (() => undefined) as never,
  );
  return response;
}

function invokeLogin(handler: ReturnType<typeof createG10aAdmissionRuntimeComposition>['handler']): void {
  handler(
    Object.freeze({ method: 'POST', body: null, query: [], headers: { datasetEpoch: EPOCH } }),
    { originalUrl: '/auth/login', url: '/auth/login', socket: { remoteAddress: '127.0.0.1' } } as never,
    new FakeResponse() as never,
    (() => undefined) as never,
  );
}

function invokeRecognition(handler: ReturnType<typeof createG10aAdmissionRuntimeComposition>['handler']): void {
  handler(
    Object.freeze({ method: 'POST', body: null, query: [], headers: { datasetEpoch: EPOCH } }),
    { originalUrl: '/recognition/attempts', url: '/recognition/attempts', socket: { remoteAddress: '127.0.0.1' } } as never,
    new FakeResponse() as never,
    (() => undefined) as never,
  );
}

async function statusSnapshot(control: ReturnType<typeof createG10aAdmissionRuntimeComposition>['control']) {
  const text = `${JSON.stringify({ v: 'c1', requestControlId: '99999999-9999-4999-8999-999999999999', command: 'STATUS', epoch: EPOCH, run: RUN })}\n`;
  const frame: RuntimeControlProtocolFrame = Object.freeze({ text, utf8Valid: true, hasBom: false, singleFinalLf: true, byteLength: Buffer.byteLength(text, 'utf8') });
  const response = await dispatchRuntimeControlProtocol(control, frame);
  if (response === undefined || !response.ok || response.snapshot === null) throw new Error('expected STATUS snapshot');
  return response.snapshot;
}

describe('G10a A4 admission runtime composition', () => {
  test('opts into the concrete G10b/G10c bridge and scheduler only when an adapter is supplied', () => {
    const fixture = makeComposition(undefined, undefined, undefined, 10, false);
    const client = {
      db: jest.fn(() => ({})),
      on: jest.fn(),
    } as never;
    const adapter = new G04bMongoPersistenceAdapter(client, 'g10a_composition_g10c_wiring');
    const composed = createG10aAdmissionRuntimeComposition({
      epoch: EPOCH,
      run: RUN,
      monotonicClock: { nowMs: () => 0 },
      awaitObservation: () => undefined,
      admission: fixture.admission,
      g10cMongoAdapter: adapter,
    });
    expect(composed.recoveryScheduler?.snapshot()).toEqual({ state: 'IDLE', timerArmed: false });
    expect(makeComposition().composition.recoveryScheduler).toBeUndefined();
  });

  test('STATUS observes UNKNOWN_EFFECT produced by the real HTTP writer lifecycle', async () => {
    const fixture = makeComposition({ management: () => Promise.reject(new Error('writer unknown')) as never });
    invoke(fixture.composition.handler);
    await flush(); await flush(); await flush();
    await expect(statusSnapshot(fixture.composition.control)).resolves.toMatchObject({ writers: { unknown: 1 } });
  });

  test('STATUS observes BLOCKED when the real HTTP lifecycle cannot release its origin lease', async () => {
    const backing = createAdmissionResourceLedger();
    const resources = Object.freeze({
      ...backing,
      releaseOrigin: () => { throw new Error('origin cleanup failed'); },
    }) as AdmissionResourceLedger;
    const fixture = makeComposition(undefined, undefined, undefined, 10, true, resources);

    // The handler obtains a real writer bundle, then its own settled observer
    // reaches the injected ledger cleanup failure.  No lifecycle or metrics
    // publisher is driven by this test directly.
    invoke(fixture.composition.handler);
    await flush(); await flush(); await flush();
    await expect(statusSnapshot(fixture.composition.control)).resolves.toMatchObject({
      writers: { provisional: 0, queued: 0, running: 0, blocked: 1, unknown: 0 },
    });
  });

  test('writes one attributable OPERATION_BLOCKED only when the real handler cleanup lifecycle becomes blocked', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-admission-blocked-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const backing = createAdmissionResourceLedger();
      const resources = Object.freeze({
        ...backing,
        releaseOrigin: () => { throw new Error('origin cleanup failed'); },
      }) as AdmissionResourceLedger;
      const fixture = makeComposition(undefined, undefined, undefined, 10, false, resources);
      const composed = createG10aAdmissionRuntimeComposition({
        epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
        admission: fixture.admission, runtime: await owner.start(),
      });
      invoke(composed.handler);
      await flush(); await flush(); await flush();
      await owner.start().then((runtime) => runtime.runtimeLogSink.flush());
      const records = await readRuntimeRecords(parent);
      const blocked = records.filter((record) => record.code === 'OPERATION_BLOCKED');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).toMatchObject({
        kind: 'RUNTIME', phase: 'ADMISSION', route: 'MANAGEMENT_CREATE',
        requestUUID: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        operationUUID: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        ownerRef: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        datasetEpoch: EPOCH, processRunId: RUN,
        round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
        commandName: null, driverRequestId: null, requestControlId: null, controlId: null, revision: null,
      });
      expect(records.filter((record) => record.code === 'OPERATION_REGISTERED')).toHaveLength(1);
      await expect(statusSnapshot(composed.control)).resolves.toMatchObject({ writers: { blocked: 1 } });
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('makes the private blocked producer receipt-exact and idempotent', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-operation-blocked-bridge-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const runtime = await owner.start();
      let capturedAccepted: Parameters<ReturnType<typeof createG10aIngressIdentityHandler>>[0] | undefined;
      const ingress = createG10aIngressIdentityHandler({
        runtime,
        handler: (accepted) => { capturedAccepted = accepted; },
      });
      const accepted = Object.freeze({ method: 'POST' as const, body: null, query: [], headers: { datasetEpoch: EPOCH } });
      ingress(accepted, { originalUrl: '/qualifications', url: '/qualifications' } as never, new FakeResponse() as never, (() => undefined) as never);
      if (capturedAccepted === undefined) throw new Error('expected captured ingress');
      const receipt = Object.freeze({ operationId: '44444444-4444-4444-8444-444444444444', receivedAtMs: 0, registeredAtMonotonicMs: 0, sequence: 0n });
      const foreignReceipt = Object.freeze({ ...receipt });
      const binding = createG10aOperationIdentityBinding(runtime);
      binding.blocked(receipt); // Unregistered lifecycle facts cannot fabricate a log.
      binding.bind(capturedAccepted, receipt);
      binding.blocked(foreignReceipt); // Same operationId but not the coordinator receipt.
      binding.blocked(receipt);
      binding.blocked(receipt); // Repeated callbacks cannot duplicate the event.
      binding.settled(receipt);
      binding.blocked(receipt); // Settled operations retain no attribution state.
      await runtime.runtimeLogSink.flush();
      expect((await readRuntimeRecords(parent)).map((record) => record.code)).toEqual([
        'REQUEST_ACCEPTED', 'OPERATION_REGISTERED', 'OPERATION_BLOCKED',
      ]);
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('STATUS reads the real coordinator lifecycle counters through the nominal internal source', async () => {
    const first = deferred<{ readonly disposition: 'KNOWN_NO_EFFECT'; readonly response: unknown }>();
    const second = deferred<{ readonly disposition: 'KNOWN_NO_EFFECT'; readonly response: unknown }>();
    let calls = 0;
    const fixture = makeComposition({ management: () => (calls++ === 0 ? first.promise : second.promise) as never });

    invoke(fixture.composition.handler);
    await flush();
    await expect(statusSnapshot(fixture.composition.control)).resolves.toMatchObject({ writers: { provisional: 0, queued: 0, running: 1, blocked: 0, unknown: 0 }, registryUnknown: 0 });

    const held = fixture.composition.control.hold({
      requestControlId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', epoch: EPOCH, run: RUN, expectedRevision: '0',
    });
    invoke(fixture.composition.handler);
    await flush();
    await expect(statusSnapshot(fixture.composition.control)).resolves.toMatchObject({ writers: { provisional: 0, queued: 1, running: 1, blocked: 0, unknown: 0 }, registryUnknown: 0 });

    first.resolve({ disposition: 'KNOWN_NO_EFFECT', response: fixture.plans.technical.issue('INVALID_REQUEST') });
    await flush(); await flush();
    await expect(statusSnapshot(fixture.composition.control)).resolves.toMatchObject({ writers: { provisional: 0, queued: 1, running: 0, blocked: 0, unknown: 0 } });
    fixture.composition.control.release({
      requestControlId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch: EPOCH, run: RUN, expectedRevision: held.revision, controlId: held.controlId as string,
    });
    await flush();
    await expect(statusSnapshot(fixture.composition.control)).resolves.toMatchObject({ writers: { provisional: 0, queued: 0, running: 1, blocked: 0, unknown: 0 } });
    second.resolve({ disposition: 'KNOWN_NO_EFFECT', response: fixture.plans.technical.issue('INVALID_REQUEST') });
    await flush(); await flush();
    await expect(statusSnapshot(fixture.composition.control)).resolves.toMatchObject({ writers: { provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 0 } });
  });

  test('constructs the private runtime and its handler acquires the factory-created lease for deferred G08 work', async () => {
    const pending = deferred<{ readonly disposition: 'KNOWN_NO_EFFECT'; readonly response: unknown }>();
    const fixture = makeComposition({ management: () => pending.promise as never });

    invoke(fixture.composition.handler);
    await flush();
    expect(fixture.composition.control.snapshot().issuedPersistence).toBe(1);

    pending.resolve({ disposition: 'KNOWN_NO_EFFECT', response: fixture.plans.technical.issue('INVALID_REQUEST') });
    await flush();
    expect(fixture.composition.control.snapshot().issuedPersistence).toBe(0);
  });

  test('binds the real G07b provisional receipt to an ingress identity when an owner runtime is supplied', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-admission-operation-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const runtime = await owner.start();
      let observedContext: Parameters<AdmissionWorkPort['management']>[1] | undefined;
      const fixture = makeComposition(undefined, undefined, (context) => { observedContext = context; }, 10, false);
      const composed = createG10aAdmissionRuntimeComposition({
        epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
        admission: fixture.admission, runtime,
      });
      invoke(composed.handler);
      await flush();
      expect(observedContext?.runtimeIdentity).not.toBeNull();
      expect(runtime.identityIssuer.read(observedContext?.runtimeIdentity!)).toMatchObject({
        operationUUID: expect.any(String), route: 'MANAGEMENT_CREATE', datasetEpoch: EPOCH, processRunId: RUN,
      });
      await runtime.runtimeLogSink.flush();
      const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      expect(records.map((record) => record.code)).toEqual([
        'REQUEST_ACCEPTED', 'OPERATION_REGISTERED',
        'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
      ]);
      expect(records[1]).toMatchObject({
        requestUUID: records[0]?.requestUUID, route: 'MANAGEMENT_CREATE', phase: 'ADMISSION',
        operationUUID: expect.stringMatching(/^[0-9a-f-]{36}$/u), ownerRef: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      });
      for (const record of records.slice(2)) {
        expect(record).toMatchObject({
          kind: 'RUNTIME', phase: 'PERSISTENCE', route: 'MANAGEMENT_CREATE',
          requestUUID: records[1]?.requestUUID, operationUUID: records[1]?.operationUUID,
          ownerRef: records[1]?.ownerRef, datasetEpoch: EPOCH, processRunId: RUN,
          round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
          commandName: null, driverRequestId: null,
        });
      }
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('settles the one G08 lifecycle log and issued lease when the writer rejects asynchronously', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-admission-step-throw-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const runtime = await owner.start();
      const fixture = makeComposition({ management: () => Promise.reject(new Error('opaque asynchronous failure')) }, undefined, undefined, 10, false);
      const composed = createG10aAdmissionRuntimeComposition({
        epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
        admission: fixture.admission, runtime,
      });
      invoke(composed.handler);
      await flush();
      await runtime.runtimeLogSink.flush();
      expect(runtime.control.snapshot().issuedPersistence).toBe(0);
      const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      expect(records.map((record) => record.code)).toEqual([
        'REQUEST_ACCEPTED', 'OPERATION_REGISTERED',
        'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
      ]);
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('settles the one G08 lifecycle log and issued lease when the writer throws synchronously', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-admission-step-sync-throw-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const runtime = await owner.start();
      const fixture = makeComposition({ management: () => { throw new Error('opaque synchronous failure'); } }, undefined, undefined, 10, false);
      const composed = createG10aAdmissionRuntimeComposition({
        epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
        admission: fixture.admission, runtime,
      });
      invoke(composed.handler);
      await flush();
      await runtime.runtimeLogSink.flush();
      expect(runtime.control.snapshot().issuedPersistence).toBe(0);
      const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      expect(records.map((record) => record.code)).toEqual([
        'REQUEST_ACCEPTED', 'OPERATION_REGISTERED',
        'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
      ]);
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('only logs the first original when a second independent writer is rate-rejected before G08', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-admission-rate-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const runtime = await owner.start();
      let managementCalls = 0;
      const fixture = makeComposition({ management: () => {
        managementCalls += 1;
        return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: fixture.plans.technical.issue('INVALID_REQUEST') });
      } }, undefined, undefined, 1, false);
      const composed = createG10aAdmissionRuntimeComposition({
        epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
        admission: fixture.admission, runtime,
      });
      invoke(composed.handler);
      await flush();
      invoke(composed.handler);
      await flush();
      await runtime.runtimeLogSink.flush();
      expect(runtime.control.snapshot().issuedPersistence).toBe(0);
      const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      const registrations = records.filter((record) => record.code === 'OPERATION_REGISTERED');
      expect(records.filter((record) => record.code === 'OPERATION_BLOCKED')).toHaveLength(0);
      const steps = records.filter((record) => record.code.startsWith('BUSINESS_STEP_'));
      expect(registrations).toHaveLength(2);
      expect(registrations[0]?.operationUUID).not.toBe(registrations[1]?.operationUUID);
      expect(managementCalls).toBe(1);
      expect(steps.map((record) => record.code)).toEqual([
        'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
      ]);
      expect(new Set(steps.map((record) => record.operationUUID))).toEqual(new Set([registrations[0]?.operationUUID]));
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('does not create business-step logs in a legacy composition without an owner runtime', async () => {
    const lines: string[] = [];
    const sink = new RuntimeLogSink({ write: async (line) => { lines.push(line); } });
    let managementCalls = 0;
    const fixture = makeComposition({ management: () => {
      managementCalls += 1;
      return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: fixture.plans.technical.issue('INVALID_REQUEST') });
    } }, undefined, undefined, 10, false);
    const composed = createG10aAdmissionRuntimeComposition({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      admission: fixture.admission, runtimeLogSink: sink,
    });
    invoke(composed.handler);
    await flush();
    await sink.flush();
    expect(managementCalls).toBe(1);
    expect(lines).toEqual([]);
  });

  test('does not create business-step logs for query or login paths', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-admission-read-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const runtime = await owner.start();
      let queryCalls = 0;
      let loginCalls = 0;
      const fixture = makeComposition({
        query: () => { queryCalls += 1; return Promise.resolve(fixture.plans.business.issue(200, { query: true })); },
        login: () => { loginCalls += 1; return Promise.resolve(fixture.plans.business.issue(200, { login: true })); },
      }, undefined, undefined, 10, false);
      const composed = createG10aAdmissionRuntimeComposition({
        epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
        admission: fixture.admission, runtime,
      });
      invokeQuery(composed.handler);
      invokeLogin(composed.handler);
      await flush();
      await runtime.runtimeLogSink.flush();
      expect(queryCalls).toBe(1);
      expect(loginCalls).toBe(1);
      const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      expect(records.map((record) => record.code)).toEqual(['REQUEST_ACCEPTED', 'REQUEST_ACCEPTED']);
      expect(records.map((record) => record.route)).toEqual(['QUERY', 'LOGIN']);
      expect(records.every((record) => !record.code.startsWith('BUSINESS_STEP_'))).toBe(true);
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('records one complete lifecycle around an original recognition G08 promise', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-admission-recognition-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const runtime = await owner.start();
      const fixture = makeComposition(undefined, undefined, undefined, 10, false);
      const composed = createG10aAdmissionRuntimeComposition({
        epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
        admission: fixture.admission, runtime,
      });
      invokeRecognition(composed.handler);
      await flush();
      await runtime.runtimeLogSink.flush();
      const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
        .split('\n').filter((line) => line.length > 0)
        .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
      expect(records.map((record) => record.code)).toEqual([
        'REQUEST_ACCEPTED', 'OPERATION_REGISTERED',
        'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
      ]);
      expect(records.filter((record) => record.code.startsWith('BUSINESS_STEP_')).every((record) => record.route === 'RECOGNITION')).toBe(true);
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('separate factories do not share runtime leases', async () => {
    const firstPending = deferred<{ readonly disposition: 'KNOWN_NO_EFFECT'; readonly response: unknown }>();
    const secondPending = deferred<{ readonly disposition: 'KNOWN_NO_EFFECT'; readonly response: unknown }>();
    const first = makeComposition({ management: () => firstPending.promise as never });
    const second = makeComposition({ management: () => secondPending.promise as never });

    invoke(first.composition.handler);
    await flush();
    expect(first.composition.control.snapshot().issuedPersistence).toBe(1);
    expect(second.composition.control.snapshot().issuedPersistence).toBe(0);

    firstPending.resolve({ disposition: 'KNOWN_NO_EFFECT', response: first.plans.technical.issue('INVALID_REQUEST') });
    await flush();
    expect(first.composition.control.snapshot().issuedPersistence).toBe(0);
  });

  test('rejects epoch mismatch and a caller-supplied writer permission before it can shadow the internal binding', () => {
    const fixture = makeComposition(undefined, undefined, undefined, 10, false);
    expect(() => createG10aAdmissionRuntimeComposition({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      admission: { ...fixture.admission, currentDatasetEpoch: RUN },
    })).toThrow('G10a runtime epoch does not match G07b admission epoch');
    expect(() => createG10aAdmissionRuntimeComposition({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      // The shape is captured before G07b sees it, so even `undefined` cannot
      // smuggle a shadow capability through the composition root.
      admission: { ...fixture.admission, writerPermission: undefined } as never,
    })).toThrow('G10a admission options is invalid');
  });

  test('accepts only a nominal private runtime log sink and projects its health without expanding the handler surface', () => {
    const fixture = makeComposition(undefined, undefined, undefined, 10, false);
    const sink = new RuntimeLogSink({ write: async () => undefined });
    const composed = createG10aAdmissionRuntimeComposition({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      admission: fixture.admission, runtimeLogSink: sink,
    });
    expect(composed.control.snapshot().logging).toEqual({ status: 'HEALTHY', droppedCount: 0 });
    expect(() => createG10aAdmissionRuntimeComposition({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      admission: fixture.admission,
      runtimeLogSink: Object.freeze({ snapshot: () => ({ status: 'HEALTHY', droppedCount: 0 }) }) as never,
    })).toThrow('runtime log sink is not trusted');
  });

  test('rejects accessor-based construction options rather than reading them twice', () => {
    const fixture = makeComposition();
    const admission = { ...fixture.admission } as Record<string, unknown>;
    Object.defineProperty(admission, 'currentDatasetEpoch', {
      enumerable: true,
      get(): string { return EPOCH; },
    });
    expect(() => createG10aAdmissionRuntimeComposition({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      admission: admission as never,
    })).toThrow('G10a admission options is invalid');
  });

  test('rejects proxy and accessor construction envelopes before a handler can be built', () => {
    const fixture = makeComposition();
    const rootProxy = new Proxy({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      admission: fixture.admission,
    }, {});
    expect(() => createG10aAdmissionRuntimeComposition(rootProxy as never)).toThrow('G10a admission runtime options is invalid');

    const admissionProxy = new Proxy({ ...fixture.admission }, {});
    expect(() => createG10aAdmissionRuntimeComposition({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      admission: admissionProxy as never,
    })).toThrow('G10a admission options is invalid');

    const rootAccessor = {
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, admission: fixture.admission,
      get awaitObservation(): () => void { return () => undefined; },
    };
    expect(() => createG10aAdmissionRuntimeComposition(rootAccessor as never)).toThrow('G10a admission runtime options is invalid');
  });

  test('rejects every writer permission shadow shape before it reaches G07b', () => {
    const fixture = makeComposition();
    const accessorShadow = { ...fixture.admission } as Record<string, unknown>;
    Object.defineProperty(accessorShadow, 'writerPermission', {
      enumerable: true,
      get(): unknown { throw new Error('must not be read'); },
    });
    const dataShadow = { ...fixture.admission, writerPermission: Object.freeze({}) };
    for (const shadow of [dataShadow, accessorShadow]) {
      expect(() => createG10aAdmissionRuntimeComposition({
        epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
        admission: shadow as never,
      })).toThrow('G10a admission options is invalid');
    }
  });

  test('injects a private query permission, counts the native query work, and drain waits for it', async () => {
    const pending = deferred<unknown>();
    const fixture = makeComposition({ query: () => pending.promise as never });

    invokeQuery(fixture.composition.handler);
    await flush();
    expect(fixture.composition.control.snapshot().activeQueryReads).toBe(1);

    const drain = fixture.composition.control.drain({
      epoch: EPOCH,
      run: RUN,
      requestControlId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedRevision: '0',
      timeoutMs: 1_000,
    });
    await flush();
    expect(fixture.composition.control.snapshot().maintenance.active).toBe(true);

    pending.resolve(fixture.plans.business.issue(200, { ok: true }));
    await expect(drain).resolves.toMatchObject({ outcome: 'DRAINED' });
    expect(fixture.composition.control.snapshot().activeQueryReads).toBe(0);
  });

  test('drain does not wait for validation already in flight, but a later query work lease is vetoed', async () => {
    const validation = deferred<AdmissionValidationResult>();
    let workCalls = 0;
    const fixture = makeComposition({ query: () => {
      workCalls += 1;
      return Promise.resolve(fixture.plans.business.issue(200, { ok: true }));
    } }, () => validation.promise);

    const response = invokeQuery(fixture.composition.handler);
    await flush();
    expect(fixture.composition.control.snapshot().activeQueryReads).toBe(0);
    await expect(fixture.composition.control.drain({
      epoch: EPOCH,
      run: RUN,
      requestControlId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedRevision: '0',
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ outcome: 'DRAINED' });

    validation.resolve(Object.freeze({ kind: 'QUERY', accountId: 'viewer-1', workInput: fixture.admission.workHandoff.issuer.issue('QUALIFICATION_LIST') }));
    await flush();
    expect(fixture.composition.control.snapshot().activeQueryReads).toBe(0);
    expect(workCalls).toBe(0);
    expect(response.statusCode).toBe(503);
    expect(fixture.rates.snapshot().query.globalCount).toBe(0);
    expect(fixture.resources.snapshot().queryDb.used).toBe(0);
  });

  test('maintenance rejects a new query before query work and caller query permission cannot shadow the private binding', async () => {
    let calls = 0;
    const fixture = makeComposition({ query: () => { calls += 1; return Promise.resolve(fixture.plans.business.issue(200, { ok: true })); } });
    await expect(fixture.composition.control.drain({
      epoch: EPOCH,
      run: RUN,
      requestControlId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expectedRevision: '0',
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ outcome: 'DRAINED' });
    const response = invokeQuery(fixture.composition.handler);
    await flush();
    expect(calls).toBe(0);
    expect(response.statusCode).toBe(503);
    expect(fixture.validationCalls()).toBe(0);
    expect(fixture.rates.snapshot().query.globalCount).toBe(0);
    expect(fixture.resources.snapshot().queryDb.used).toBe(0);

    expect(() => createG10aAdmissionRuntimeComposition({
      epoch: EPOCH, run: RUN, monotonicClock: { nowMs: () => 0 }, awaitObservation: () => undefined,
      admission: { ...fixture.admission, queryPermission: undefined } as never,
    })).toThrow('G10a admission options is invalid');
  });

  test('releases the query lease after database exhaustion, synchronous throw, rejection, and rate rejection', async () => {
    const databaseExhausted = makeComposition();
    const heldDb = databaseExhausted.resources.ancillary.queryDb.tryAcquire();
    expect(heldDb).not.toBeNull();
    invokeQuery(databaseExhausted.composition.handler);
    await flush();
    expect(databaseExhausted.composition.control.snapshot().activeQueryReads).toBe(0);
    databaseExhausted.resources.ancillary.queryDb.release(heldDb!);

    const synchronousThrow = makeComposition({ query: () => { throw new Error('sync'); } });
    invokeQuery(synchronousThrow.composition.handler);
    await flush();
    expect(synchronousThrow.composition.control.snapshot().activeQueryReads).toBe(0);

    const rejected = makeComposition({ query: () => Promise.reject(new Error('reject')) as never });
    invokeQuery(rejected.composition.handler);
    await flush();
    expect(rejected.composition.control.snapshot().activeQueryReads).toBe(0);

    const rateLimited = makeComposition();
    for (let index = 0; index < 11; index += 1) {
      invokeQuery(rateLimited.composition.handler);
      await flush();
    }
    expect(rateLimited.rates.snapshot().query.globalCount).toBe(10);
    expect(rateLimited.composition.control.snapshot().activeQueryReads).toBe(0);
  });
});

async function readRuntimeRecords(parent: string) {
  return (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
    .split('\n').filter((line) => line.length > 0)
    .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
}
