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
): ReturnType<typeof createG07bAdmissionHandler> {
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
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
    if (input.routeId === 'QUALIFICATION_CREATE') {
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

function invoke(handler: ReturnType<typeof createG07bAdmissionHandler>, path: string, retryMode?: 'existing-only'): FakeResponse {
  const response = new FakeResponse();
  handler(
    Object.freeze({ method: 'POST', body: null, query: [], headers: { datasetEpoch: EPOCH, ...(retryMode === undefined ? {} : { retryMode }) } }),
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
});
