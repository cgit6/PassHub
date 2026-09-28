import { EventEmitter } from 'node:events';

import {
  createG07bAdmissionHandler,
  createAdmissionWorkHandoffBundle,
  createHttpResponsePlanBundle,
  createUnknownRecognitionCoordinatorBundle,
  createConfigurableFixedMinuteRateLedger,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWorkPort,
} from '../../src/composition/internal/index.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import { createG10aWriterPermissionBinding } from '../../src/composition/internal/g10a-writer-permission-binding.js';
import { createRuntimeControl, createRuntimeIdentityIssuer, type RuntimeControl } from '../../src/runtime/internal/runtime-control.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import type { NarrowHttpResponse } from '../../src/composition/internal/http-response-owner.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

class FakeResponse extends EventEmitter implements NarrowHttpResponse {
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  readonly bodies: string[] = [];
  setHeader(): void { /* response-plan headers are not relevant to the seam */ }
  end(body: string): void { this.bodies.push(body); this.writableEnded = true; this.emit('finish'); }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeRuntimeControl(): RuntimeControl {
  const issuer = createRuntimeIdentityIssuer({ datasetEpoch: EPOCH, processRunId: RUN });
  return createRuntimeControl({
    epoch: EPOCH,
    run: RUN,
    identityIssuer: issuer,
    clock: { nowMs: () => 0 },
    awaitObservation: () => undefined,
  });
}

function makeHandler(
  control: RuntimeControl,
  workOverrides: Partial<AdmissionWorkPort>,
  rates?: ReturnType<typeof createConfigurableFixedMinuteRateLedger>,
  plansOverride?: ReturnType<typeof createHttpResponsePlanBundle>,
  onValidate?: () => void,
): ReturnType<typeof createG07bAdmissionHandler> {
  const plans = plansOverride ?? createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  const unknown = createUnknownRecognitionCoordinatorBundle();
  const capabilities = createOperationRegistryCapabilityIssuer({
    registryId: 'g10a-test',
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
  const standardValidate = async (input: AdmissionValidationInput): Promise<AdmissionValidationResult> => {
    onValidate?.();
    if (input.routeId === 'QUALIFICATION_CREATE' || input.routeId === 'QUALIFICATION_UPDATE' || input.routeId === 'QUALIFICATION_REVOKE') {
      return Object.freeze({ kind: 'MANAGEMENT', accountId: 'account-1', workInput: handoff.issuer.issue(input.routeId) });
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
  const queryCapability = createLegacyQueryAdmissionCapability({
    validate: standardValidate,
    query: () => Promise.resolve(plans.business.issue(200, { ok: true })),
  });
  const defaults: AdmissionWorkPort = {
    login: () => Promise.resolve(plans.business.issue(200, { ok: true })),
    query: queryCapability.work.query,
    management: () => Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') }),
    recognition: () => Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') }),
  };
  return createG07bAdmissionHandler({
    currentDatasetEpoch: EPOCH,
    registry,
    registryCapabilities: capabilities,
    responsePlans: plans,
    workHandoff: handoff,
    validator: queryCapability.validator,
    work: { ...defaults, ...workOverrides },
    unknownRecognition: unknown.handler,
    ...(rates === undefined ? {} : { rates }),
    writerPermission: createG10aWriterPermissionBinding(control),
  });
}

function invoke(handler: ReturnType<typeof createG07bAdmissionHandler>, path: string, retryMode?: 'existing-only', method = 'POST'): FakeResponse {
  const response = new FakeResponse();
  handler(
    Object.freeze({ method, body: null, query: [], headers: { datasetEpoch: EPOCH, ...(retryMode === undefined ? {} : { retryMode }) } }),
    { originalUrl: path, url: path, socket: { remoteAddress: '127.0.0.1' } } as never,
    response as never,
    (() => undefined) as never,
  );
  return response;
}

function lowRecognitionRates(): ReturnType<typeof createConfigurableFixedMinuteRateLedger> {
  return createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => 0 } }, {
    login: { perKey: 10, global: 10, maxKeys: 2 },
    query: { perKey: 10, global: 10 },
    recognition: { perKey: 1, global: 1 },
    management: { perKey: 10, global: 10 },
  });
}

describe('G10a A3 eligible-original G07b writer permission seam', () => {
  test('writer wake binding rejects foreign receivers and duplicate binding; a throwing wake cannot roll back release', () => {
    const control = makeRuntimeControl();
    const binding = createG10aWriterPermissionBinding(control);
    const bind = binding.bindWriterWake;

    expect(() => bind.call(Object.freeze({}), () => undefined)).toThrow(TypeError);
    expect(() => bind.apply(Object.freeze({ bindWriterWake: () => undefined }), [() => undefined])).toThrow(TypeError);

    let calls = 0;
    binding.bindWriterWake(() => { calls += 1; throw new Error('wake observer failed'); });
    expect(() => binding.bindWriterWake(() => undefined)).toThrow(TypeError);
    const held = control.hold({ requestControlId: '55555555-5555-4555-8555-555555555555', epoch: EPOCH, run: RUN, expectedRevision: '0' });
    expect(() => control.release({ requestControlId: '66666666-6666-4666-8666-666666666666', epoch: EPOCH, run: RUN, expectedRevision: held.revision, controlId: held.controlId as string })).not.toThrow();
    expect(calls).toBe(1);
    expect(control.snapshot()).toMatchObject({ manual: { active: false, controlId: null } });
  });

  test('a held queue has zero issued work, then release starts exactly its FIFO head', async () => {
    const control = makeRuntimeControl();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const first = deferred<{ readonly disposition: 'BUSINESS_RESULT_PERSISTED'; readonly response: unknown }>();
    let calls = 0;
    const handler = makeHandler(control, {
      management: () => {
        calls += 1;
        return calls === 1
          ? first.promise as never
          : Promise.resolve({ disposition: 'BUSINESS_RESULT_PERSISTED', response: plans.business.issue(200, { ordinal: calls }) }) as never;
      },
    }, undefined, plans);
    const held = control.hold({ requestControlId: '66666666-6666-4666-8666-666666666666', epoch: EPOCH, run: RUN, expectedRevision: '0' });

    invoke(handler, '/qualifications');
    invoke(handler, '/qualifications/qualification-2', undefined, 'PATCH');
    await flush();
    // READY work may be registered, but neither G08 nor its issued lease has
    // started while the manual hold is active.
    expect(calls).toBe(0);
    expect(control.snapshot().issuedPersistence).toBe(0);

    control.release({ requestControlId: '77777777-7777-4777-8777-777777777777', epoch: EPOCH, run: RUN, expectedRevision: held.revision, controlId: held.controlId as string });
    await flush();
    expect(calls).toBe(1);
    expect(control.snapshot().issuedPersistence).toBe(1);

    first.resolve({ disposition: 'BUSINESS_RESULT_PERSISTED', response: plans.business.issue(200, { ordinal: 1 }) });
    await flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await flush();
    expect(calls).toBe(2);
  });

  test('manual hold blocks READY writers until release, then wakes the FIFO head', async () => {
    const control = makeRuntimeControl();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const first = deferred<{ readonly disposition: 'BUSINESS_RESULT_PERSISTED'; readonly response: unknown }>();
    let calls = 0;
    const handler = makeHandler(control, {
      management: () => { calls += 1; return first.promise as never; },
    }, undefined, plans);
    const held = control.hold({ requestControlId: '77777777-7777-4777-8777-777777777777', epoch: EPOCH, run: RUN, expectedRevision: '0' });
    invoke(handler, '/qualifications');
    await flush();
    expect(calls).toBe(0);
    control.release({ requestControlId: '88888888-8888-4888-8888-888888888888', epoch: EPOCH, run: RUN, expectedRevision: held.revision, controlId: held.controlId as string });
    await flush();
    expect(calls).toBe(1);
    first.resolve({ disposition: 'BUSINESS_RESULT_PERSISTED', response: plans.business.issue(200, { ok: true }) });
    await flush();
  });

  test('held existing-only recognition uses the established memory path and never enters the writer gate', async () => {
    const control = makeRuntimeControl();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    let recognitionCalls = 0;
    const handler = makeHandler(control, {
      recognition: () => {
        recognitionCalls += 1;
        return Promise.resolve({
          disposition: 'BUSINESS_RESULT_PERSISTED' as const,
          originalResponse: plans.business.issue(200, { ok: true }),
          replayResponse: plans.business.issue(200, { ok: true }),
        });
      },
    }, undefined, plans);

    // Establish the canonical recognition operation before the hold.
    invoke(handler, '/recognition/attempts');
    await flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await flush();
    expect(recognitionCalls).toBe(1);
    expect(control.snapshot().issuedPersistence).toBe(0);

    control.hold({ requestControlId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch: EPOCH, run: RUN, expectedRevision: '0' });
    const response = invoke(handler, '/recognition/attempts', 'existing-only');
    await flush();
    expect(response.statusCode).toBe(200);
    expect(recognitionCalls).toBe(1);
    expect(control.snapshot()).toMatchObject({
      manual: { active: true },
      issuedPersistence: 0,
    });
  });

  test('a hold after the first writer started never interrupts it, but blocks the FIFO second writer', async () => {
    const control = makeRuntimeControl();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const first = deferred<{ readonly disposition: 'BUSINESS_RESULT_PERSISTED'; readonly response: unknown }>();
    let calls = 0;
    const handler = makeHandler(control, {
      management: () => { calls += 1; return first.promise as never; },
    }, undefined, plans);
    invoke(handler, '/qualifications');
    await flush();
    expect(calls).toBe(1);
    const held = control.hold({ requestControlId: '99999999-9999-4999-8999-999999999999', epoch: EPOCH, run: RUN, expectedRevision: '0' });
    invoke(handler, '/qualifications');
    await flush();
    expect(calls).toBe(1);
    first.resolve({ disposition: 'BUSINESS_RESULT_PERSISTED', response: plans.business.issue(200, { ok: true }) });
    await flush();
    expect(calls).toBe(1);
    control.release({ requestControlId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', epoch: EPOCH, run: RUN, expectedRevision: held.revision, controlId: held.controlId as string });
    await flush();
    expect(calls).toBe(2);
  });

  test('existing-only joins an already-started recognition during a later hold without another G08 invocation or lease', async () => {
    const control = makeRuntimeControl();
    const work = deferred<never>();
    let calls = 0;
    const handler = makeHandler(control, {
      recognition: () => { calls += 1; return work.promise; },
    });

    invoke(handler, '/recognition/attempts');
    await flush();
    expect(calls).toBe(1);
    expect(control.snapshot().issuedPersistence).toBe(1);

    control.hold({ requestControlId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch: EPOCH, run: RUN, expectedRevision: '0' });
    invoke(handler, '/recognition/attempts', 'existing-only');
    await flush();
    expect(calls).toBe(1);
    expect(control.snapshot().issuedPersistence).toBe(1);

    work.reject(new Error('finish original after join'));
    await flush();
    expect(control.snapshot().issuedPersistence).toBe(0);
  });

  test('management holds issued lease while G08 work is pending and releases after resolve', async () => {
    const control = makeRuntimeControl();
    const work = deferred<{ readonly disposition: 'BUSINESS_RESULT_PERSISTED'; readonly response: ReturnType<typeof createHttpResponsePlanBundle> extends never ? never : unknown }>();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const handler = makeHandler(control, {
      management: () => work.promise as never,
    });
    invoke(handler, '/qualifications');
    await flush();
    expect(control.snapshot().issuedPersistence).toBe(1);
    work.resolve({ disposition: 'BUSINESS_RESULT_PERSISTED', response: plans.business.issue(200, { ok: true }) });
    await flush();
    expect(control.snapshot().issuedPersistence).toBe(0);
  });

  test('recognition REGISTERED holds lease through rejection, while validation reject never leases', async () => {
    const control = makeRuntimeControl();
    const work = deferred<never>();
    const handler = makeHandler(control, { recognition: () => work.promise });
    invoke(handler, '/recognition/attempts');
    await flush();
    expect(control.snapshot().issuedPersistence).toBe(1);
    work.reject(new Error('writer failed'));
    await flush();
    expect(control.snapshot().issuedPersistence).toBe(0);

    const rejectedControl = makeRuntimeControl();
    let validationRejectedCalls = 0;
    const rejectedHandler = makeHandler(rejectedControl, {
      management: () => {
        validationRejectedCalls += 1;
        return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH }).technical.issue('INVALID_REQUEST') });
      },
    });
    invoke(rejectedHandler, '/events');
    await flush();
    expect(rejectedControl.snapshot().issuedPersistence).toBe(0);
    expect(validationRejectedCalls).toBe(0);

    const throwingControl = makeRuntimeControl();
    const throwingHandler = makeHandler(throwingControl, {
      management: () => { throw new Error('sync writer failure'); },
    });
    invoke(throwingHandler, '/qualifications');
    await flush();
    expect(throwingControl.snapshot().issuedPersistence).toBe(0);
  });

  test('JOINED and existing-only recognition never acquire a second lease or invoke G08', async () => {
    const control = makeRuntimeControl();
    const work = deferred<never>();
    let recognitionCalls = 0;
    const handler = makeHandler(control, {
      recognition: () => { recognitionCalls += 1; return work.promise; },
    });

    invoke(handler, '/recognition/attempts');
    await flush();
    expect(recognitionCalls).toBe(1);
    expect(control.snapshot().issuedPersistence).toBe(1);

    invoke(handler, '/recognition/attempts', 'existing-only');
    await flush();
    expect(recognitionCalls).toBe(1);
    expect(control.snapshot().issuedPersistence).toBe(1);

    work.reject(new Error('original rejected'));
    await flush();
    expect(control.snapshot().issuedPersistence).toBe(0);
  });

  test('canonical replay, absent existing-only, and rate rejection stay outside issued persistence', async () => {
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const replayControl = makeRuntimeControl();
    let replayCalls = 0;
    const replayHandler = makeHandler(replayControl, {
      recognition: () => {
        replayCalls += 1;
        return Promise.resolve({
          disposition: 'KNOWN_NO_EFFECT',
          response: plans.technical.issue('INVALID_REQUEST'),
        });
      },
    });
    invoke(replayHandler, '/recognition/attempts');
    await flush();
    invoke(replayHandler, '/recognition/attempts');
    await flush();
    expect(replayCalls).toBe(1);
    expect(replayControl.snapshot().issuedPersistence).toBe(0);

    const absentControl = makeRuntimeControl();
    let absentCalls = 0;
    const absentHandler = makeHandler(absentControl, {
      recognition: () => { absentCalls += 1; return Promise.resolve({
        disposition: 'KNOWN_NO_EFFECT',
        response: plans.technical.issue('INVALID_REQUEST'),
      }); },
    });
    invoke(absentHandler, '/recognition/attempts', 'existing-only');
    await flush();
    expect(absentCalls).toBe(0);
    expect(absentControl.snapshot().issuedPersistence).toBe(0);

    const rateControl = makeRuntimeControl();
    let rateCalls = 0;
    const rateHandler = makeHandler(rateControl, {
      recognition: () => { rateCalls += 1; return Promise.resolve({
        disposition: 'KNOWN_NO_EFFECT',
        response: plans.technical.issue('INVALID_REQUEST'),
      }); },
    }, lowRecognitionRates());
    invoke(rateHandler, '/recognition/attempts');
    await flush();
    invoke(rateHandler, '/recognition/attempts');
    await flush();
    expect(rateCalls).toBe(1);
    expect(rateControl.snapshot().issuedPersistence).toBe(0);
  });

  test('maintenance synchronously rejects NEW writers before epoch, validation, rate, registry reservation, or G08 work', async () => {
    const control = makeRuntimeControl();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    let validationCalls = 0;
    let managementCalls = 0;
    let recognitionCalls = 0;
    const handler = makeHandler(
      control,
      {
        management: () => {
          managementCalls += 1;
          return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') });
        },
        recognition: () => {
          recognitionCalls += 1;
          return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') });
        },
      },
      undefined,
      plans,
      () => { validationCalls += 1; },
    );
    const drained = await control.drain({
      requestControlId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', epoch: EPOCH, run: RUN, expectedRevision: '0', timeoutMs: 1,
    });
    expect(drained.outcome).toBe('DRAINED');

    // An invalid epoch proves the maintenance veto is earlier than epoch
    // checking; neither route reaches any admission dependency.
    const management = new FakeResponse();
    handler(
      Object.freeze({ method: 'POST', body: null, query: [], headers: { datasetEpoch: RUN } }),
      { originalUrl: '/qualifications', url: '/qualifications', socket: { remoteAddress: '127.0.0.1' } } as never,
      management as never,
      (() => undefined) as never,
    );
    const recognition = invoke(handler, '/recognition/attempts');
    await flush();

    for (const response of [management, recognition]) {
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.bodies[0] as string)).toMatchObject({ code: 'TECHNICAL_BUSY', currentDatasetEpoch: EPOCH });
    }
    expect(validationCalls).toBe(0);
    expect(managementCalls).toBe(0);
    expect(recognitionCalls).toBe(0);
    expect(control.snapshot()).toMatchObject({ maintenance: { active: true, outcome: 'DRAINED' }, issuedPersistence: 0 });

    // Reads and login are deliberately outside the new-writer veto.  This
    // fixture rejects them in validation, but they must not be rewritten as a
    // maintenance 503 and must reach the established non-writer path.
    const query = invoke(handler, '/qualifications', undefined, 'GET');
    const login = invoke(handler, '/auth/login');
    await flush();
    expect(query.statusCode).not.toBe(503);
    expect(login.statusCode).not.toBe(503);
    expect(validationCalls).toBe(2);
  });

  test('maintenance WAITING vetoes new management and recognition before every admission dependency', async () => {
    const control = makeRuntimeControl();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const lease = control.acquireIssuedPersistence();
    const drain = control.drain({
      requestControlId: 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1', epoch: EPOCH, run: RUN, expectedRevision: '0', timeoutMs: 1_000,
    });
    await flush();
    expect(control.snapshot()).toMatchObject({ maintenance: { active: true, outcome: 'WAITING' }, issuedPersistence: 1 });

    let validationCalls = 0;
    let managementCalls = 0;
    let recognitionCalls = 0;
    const rates = lowRecognitionRates();
    const handler = makeHandler(control, {
      management: () => {
        managementCalls += 1;
        return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') });
      },
      recognition: () => {
        recognitionCalls += 1;
        return Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') });
      },
    }, rates, plans, () => { validationCalls += 1; });

    // Invalid epochs make the ordering observable: a maintenance 503 proves
    // neither request got as far as epoch, validation, rate, registry, G08,
    // reservation, or an issued lease.
    const management = new FakeResponse();
    handler(
      Object.freeze({ method: 'POST', body: null, query: [], headers: { datasetEpoch: RUN } }),
      { originalUrl: '/qualifications', url: '/qualifications', socket: { remoteAddress: '127.0.0.1' } } as never,
      management as never,
      (() => undefined) as never,
    );
    const recognition = invoke(handler, '/recognition/attempts');
    await flush();
    for (const response of [management, recognition]) {
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.bodies[0] as string)).toMatchObject({ code: 'TECHNICAL_BUSY', currentDatasetEpoch: EPOCH });
    }
    expect(validationCalls).toBe(0);
    expect(managementCalls).toBe(0);
    expect(recognitionCalls).toBe(0);
    expect(control.snapshot().issuedPersistence).toBe(1);

    lease.release();
    await expect(drain).resolves.toMatchObject({ outcome: 'DRAINED', snapshot: { maintenance: { active: true, outcome: 'DRAINED' } } });
  });

  test('maintenance preserves EXISTING_ONLY recognition replay and does not invoke a second writer', async () => {
    const control = makeRuntimeControl();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    let recognitionCalls = 0;
    const handler = makeHandler(control, {
      recognition: () => {
        recognitionCalls += 1;
        return Promise.resolve({
          disposition: 'BUSINESS_RESULT_PERSISTED' as const,
          originalResponse: plans.business.issue(200, { ok: true }),
          replayResponse: plans.business.issue(200, { ok: true }),
        });
      },
    }, undefined, plans);
    invoke(handler, '/recognition/attempts');
    await flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await flush();
    expect(recognitionCalls).toBe(1);

    await control.drain({
      requestControlId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', epoch: EPOCH, run: RUN, expectedRevision: '0', timeoutMs: 1,
    });
    const replay = invoke(handler, '/recognition/attempts', 'existing-only');
    await flush();
    expect(replay.statusCode).toBe(200);
    expect(recognitionCalls).toBe(1);
    expect(control.snapshot()).toMatchObject({ maintenance: { active: true, outcome: 'DRAINED' }, issuedPersistence: 0 });
  });
});
