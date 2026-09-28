import { EventEmitter } from 'node:events';

import {
  createAdmissionWorkHandoffBundle,
  createConfigurableFixedMinuteRateLedger,
  createHttpResponsePlanBundle,
  createUnknownRecognitionCoordinatorBundle,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWorkPort,
} from '../../src/composition/internal/index.js';
import { createG10aAdmissionRuntimeComposition } from '../../src/composition/internal/g10a-admission-runtime-composition.js';
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

function makeComposition(workOverride?: Partial<AdmissionWorkPort>) {
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
  const validate = async (input: AdmissionValidationInput): Promise<AdmissionValidationResult> => {
    if (input.routeId === 'QUALIFICATION_CREATE') {
      return Object.freeze({ kind: 'MANAGEMENT', accountId: 'operator-1', workInput: handoff.issuer.issue(input.routeId) });
    }
    return Object.freeze({ kind: 'REJECTED', response: plans.technical.issue('INVALID_REQUEST') });
  };
  const query = createLegacyQueryAdmissionCapability({
    validate,
    query: () => Promise.resolve(plans.business.issue(200, { ok: true })),
  });
  const defaults: AdmissionWorkPort = {
    login: () => Promise.resolve(plans.business.issue(200, { ok: true })),
    query: query.work.query,
    management: () => Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') }),
    recognition: () => Promise.resolve({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') }),
  };
  const admission = {
    currentDatasetEpoch: EPOCH,
    registry,
    registryCapabilities: capabilities,
    responsePlans: plans,
    workHandoff: handoff,
    validator: query.validator,
    work: { ...defaults, ...workOverride },
    unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
    rates: createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => 0 } }, {
      login: { perKey: 10, global: 10, maxKeys: 2 },
      query: { perKey: 10, global: 10 },
      recognition: { perKey: 10, global: 10 },
      management: { perKey: 10, global: 10 },
    }),
  };
  return {
    plans,
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
});
