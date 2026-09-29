import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAdmissionWorkHandoffBundle,
  createAdmissionResourceLedger,
  createConfigurableFixedMinuteRateLedger,
  createHttpResponsePlanBundle,
  createUnknownRecognitionCoordinatorBundle,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWorkPort,
} from '../../src/composition/internal/index.js';
import { createG10aAdmissionRuntimeComposition } from '../../src/composition/internal/g10a-admission-runtime-composition.js';
import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { validateRuntimeLogRecord } from '../../src/runtime/internal/runtime-log-schema.js';
import { RuntimeLogSink } from '../../src/runtime/internal/runtime-log-sink.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import type { NarrowHttpResponse } from '../../src/composition/internal/http-response-owner.js';

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
  const resources = createAdmissionResourceLedger();
  const rates = createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => 0 } }, {
    login: { perKey: 10, global: 10, maxKeys: 2 },
    query: { perKey: 10, global: 10 },
    recognition: { perKey: 10, global: 10 },
    management: { perKey: 10, global: 10 },
  });
  const defaults: AdmissionWorkPort = {
    login: () => Promise.resolve(plans.business.issue(200, { ok: true })),
    query: query.work.query,
    management: (_input, context) => {
      onManagementContext?.(context);
      return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') });
    },
    recognition: () => Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') }),
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
    composition: createG10aAdmissionRuntimeComposition({
      epoch: EPOCH,
      run: RUN,
      monotonicClock: { nowMs: () => 0 },
      awaitObservation: () => undefined,
      admission,
    }),
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

describe('G10a A4 admission runtime composition', () => {
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
      const fixture = makeComposition(undefined, undefined, (context) => { observedContext = context; });
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
      expect(records.map((record) => record.code)).toEqual(['REQUEST_ACCEPTED', 'OPERATION_REGISTERED']);
      expect(records[1]).toMatchObject({
        requestUUID: records[0]?.requestUUID, route: 'MANAGEMENT_CREATE', phase: 'ADMISSION',
        operationUUID: expect.stringMatching(/^[0-9a-f-]{36}$/u), ownerRef: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      });
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
    const fixture = makeComposition();
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
    const fixture = makeComposition();
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
