import { EventEmitter } from 'node:events';

import {
  createOperationRegistry,
  createOperationRegistryCapabilityIssuer,
} from '../../src/access/application/internal/operation-registry.js';
import type { WriteOperationContext } from '../../src/access/application/internal/write-operation-coordinator.js';
import {
  createAdmissionWorkHandoffBundle,
  createConfigurableFixedMinuteRateLedger,
  createHttpResponsePlanBundle,
  createUnknownRecognitionCoordinatorBundle,
  type AdmissionWorkToken,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWorkContext,
  type AdmissionWorkPort,
} from '../../src/composition/internal/index.js';
import { createG07bAdmissionHandler } from '../../src/composition/internal/g07b-admission-handler.js';
import type {
  AdmissionManagementWriterOutcome,
  AdmissionRecognitionWriterOutcome,
} from '../../src/composition/internal/g07b-admission-handler.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import {
  createG10bOperationBudgetBindingFactory,
  type G10bOperationBudgetBindingFactory,
} from '../../src/composition/internal/g10b-operation-bridge.js';
import type { NarrowHttpResponse } from '../../src/composition/internal/http-response-owner.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';

class FakeResponse extends EventEmitter implements NarrowHttpResponse {
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  body = '';
  setHeader(): void { /* response details are not under test */ }
  end(body: string): void { this.body = body; this.writableEnded = true; this.emit('finish'); }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createFixture({
  recognitionRateLimit = 10,
  throwWhenBinding = false,
}: {
  readonly recognitionRateLimit?: number;
  readonly throwWhenBinding?: boolean;
} = {}) {
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  const registryCapabilities = createOperationRegistryCapabilityIssuer({
    registryId: 'g10b-g07-binding-test', datasetEpoch: EPOCH, processRunId: RUN,
    ownerId: '33333333-3333-4333-8333-333333333333', sameArtifact: () => true,
  });
  const registry = createOperationRegistry({
    capabilities: registryCapabilities,
    writeRunClaim: registryCapabilities.issueWriteRunClaim('WRITABLE'),
    assertOwnerCurrent: () => undefined,
    assertContinuationEvidence: () => undefined,
  });
  const bindings: Array<Readonly<{ readonly write: WriteOperationContext; readonly admission: AdmissionWorkContext }>> = [];
  const actualFactory = createG10bOperationBudgetBindingFactory({
    clock: { nowMs: () => 0 }, assertContinuationEvidence: () => undefined,
  });
  // The real factory remains the authority.  This narrow test wrapper only
  // records each real coordinator context handed to that factory.
  const factory = Object.freeze({
    bind(context: WriteOperationContext, admission: AdmissionWorkContext) {
      bindings.push(Object.freeze({ write: context, admission }));
      if (throwWhenBinding) throw new Error('injected binding factory failure');
      return actualFactory.bind(context, admission);
    },
  }) as G10bOperationBudgetBindingFactory;
  const unknown = createUnknownRecognitionCoordinatorBundle();
  const recognitionContexts: AdmissionWorkContext[] = [];
  let managementCalls = 0;
  let nextRecognitionId = 'original';

  const validate = async (input: AdmissionValidationInput): Promise<AdmissionValidationResult> => {
    if (input.routeId === 'QUALIFICATION_CREATE') {
      return Object.freeze({ kind: 'MANAGEMENT', accountId: 'operator-1', workInput: handoff.issuer.issue(input.routeId) });
    }
    if (input.routeId === 'RECOGNITION_ATTEMPT') {
      return Object.freeze({
        kind: 'RECOGNITION',
        registryKey: registryCapabilities.issueKey(SOURCE, nextRecognitionId),
        comparisonArtifact: registryCapabilities.issueComparisonArtifact(Object.freeze({ recognitionId: nextRecognitionId })),
        workInput: handoff.issuer.issue(input.routeId),
      });
    }
    return Object.freeze({ kind: 'REJECTED', response: plans.technical.issue('INVALID_REQUEST') });
  };
  const query = createLegacyQueryAdmissionCapability({
    validate,
    query: () => Promise.resolve(plans.business.issue(200, { ok: true })),
  });
  const work: AdmissionWorkPort = Object.freeze({
    login: () => Promise.resolve(plans.business.issue(200, { ok: true })),
    query: query.work.query,
    management: (): Promise<AdmissionManagementWriterOutcome> => {
      managementCalls += 1;
      return Promise.resolve(Object.freeze({ disposition: 'KNOWN_NO_EFFECT' as const, response: plans.technical.issue('INVALID_REQUEST') }));
    },
    recognition: (_input: AdmissionWorkToken, context: AdmissionWorkContext): Promise<AdmissionRecognitionWriterOutcome> => {
      recognitionContexts.push(context);
      return Promise.resolve(Object.freeze({ disposition: 'UNKNOWN_EFFECT' as const, response: plans.technical.issue('PERSISTENCE_UNAVAILABLE') }));
    },
  });
  const rates = createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => 0 } }, {
    login: { perKey: 10, global: 10, maxKeys: 2 },
    query: { perKey: 10, global: 10 },
    recognition: { perKey: recognitionRateLimit, global: recognitionRateLimit },
    management: { perKey: 1, global: 1 },
  });
  const handler = createG07bAdmissionHandler({
    currentDatasetEpoch: EPOCH, registry, registryCapabilities, responsePlans: plans,
    workHandoff: handoff, validator: query.validator, work, unknownRecognition: unknown.handler,
    rates, operationBudgetBindingFactory: factory,
  });
  return {
    handler, registry, registryCapabilities, plans, bindings, unknown, recognitionContexts,
    managementCalls: () => managementCalls,
    setRecognitionId: (value: string) => { nextRecognitionId = value; },
  };
}

function invoke(
  handler: ReturnType<typeof createG07bAdmissionHandler>,
  path: '/qualifications' | '/recognition/attempts' | '/unsupported',
): FakeResponse {
  const response = new FakeResponse();
  handler(
    Object.freeze({
      method: 'POST', body: null, query: [],
      headers: { datasetEpoch: EPOCH },
    }),
    { originalUrl: path, url: path, socket: { remoteAddress: '127.0.0.1' } } as never,
    response as never,
    (() => undefined) as never,
  );
  return response;
}

function registerOriginal(
  fixture: ReturnType<typeof createFixture>,
  eventId: string,
): void {
  const reservation = fixture.registry.reserveCandidate();
  const registered = fixture.registry.registerReserved(
    reservation,
    fixture.registryCapabilities.issueKey(SOURCE, eventId),
    fixture.registryCapabilities.issueComparisonArtifact(Object.freeze({ eventId })),
    fixture.registryCapabilities.issueObservationReference(),
  );
  if (registered.kind !== 'REGISTERED') throw new Error('expected registered fixture operation');
}

function registerReplay(
  fixture: ReturnType<typeof createFixture>,
  eventId: string,
): void {
  const reservation = fixture.registry.reserveCandidate();
  const registered = fixture.registry.registerReserved(
    reservation,
    fixture.registryCapabilities.issueKey(SOURCE, eventId),
    fixture.registryCapabilities.issueComparisonArtifact(Object.freeze({ eventId })),
    fixture.registryCapabilities.issueObservationReference(),
  );
  if (registered.kind !== 'REGISTERED') throw new Error('expected registered fixture operation');
  fixture.registry.completeCanonical(registered.lease, fixture.registryCapabilities.issueResultReference());
}

describe('G10b G07 original-work budget association', () => {
  test('creates exactly one binding for allowed management and none for its rate-rejected successor', async () => {
    const fixture = createFixture();

    invoke(fixture.handler, '/qualifications');
    await flush();
    invoke(fixture.handler, '/qualifications');
    await flush();

    expect(fixture.managementCalls()).toBe(1);
    expect(fixture.bindings).toHaveLength(1);
    expect(fixture.bindings[0]?.write.sequence).toBe(0n);
  });

  test('binds one ORIGINAL recognition context and reuses that exact object for G08 and observation recovery', async () => {
    const fixture = createFixture();

    invoke(fixture.handler, '/recognition/attempts');
    await flush();

    expect(fixture.bindings).toHaveLength(1);
    expect(fixture.recognitionContexts).toHaveLength(1);
    expect(fixture.recognitionContexts[0]).toBe(fixture.bindings[0]?.admission);
    expect(fixture.recognitionContexts[0]).toMatchObject({
      operationId: fixture.bindings[0]!.write.operationId,
      receivedAtMs: fixture.bindings[0]!.write.receivedAtMs,
      sequence: fixture.bindings[0]!.write.sequence,
    });
  });

  test('does not bind a recognition attempt rejected by the rate ledger', async () => {
    const fixture = createFixture({ recognitionRateLimit: 1 });

    invoke(fixture.handler, '/recognition/attempts');
    await flush();
    fixture.setRecognitionId('rate-rejected');
    invoke(fixture.handler, '/recognition/attempts');
    await flush();

    expect(fixture.bindings).toHaveLength(1);
    expect(fixture.recognitionContexts).toHaveLength(1);
  });

  test('does not bind JOINED, replayed, or invalid recognition paths', async () => {
    const fixture = createFixture();
    registerOriginal(fixture, 'joined');
    registerReplay(fixture, 'replay');

    fixture.setRecognitionId('joined');
    invoke(fixture.handler, '/recognition/attempts');
    await flush();
    fixture.setRecognitionId('replay');
    invoke(fixture.handler, '/recognition/attempts');
    await flush();
    invoke(fixture.handler, '/unsupported');
    await flush();

    expect(fixture.bindings).toHaveLength(0);
    expect(fixture.recognitionContexts).toHaveLength(0);
  });

  test('moves a registered ORIGINAL to unknown and offers recovery when its G10b factory throws', async () => {
    const fixture = createFixture({ throwWhenBinding: true });

    const original = invoke(fixture.handler, '/recognition/attempts');
    await flush();

    expect(original.statusCode).toBe(503);
    expect(fixture.bindings).toHaveLength(1);
    expect(fixture.recognitionContexts).toHaveLength(0);
    const [receipt] = fixture.unknown.drain.drain();
    expect(receipt).toBeDefined();
    const recovery = fixture.unknown.drain.take(receipt!);
    expect(recovery.operation).toEqual({
      operationId: fixture.bindings[0]!.admission.operationId,
      receivedAtMs: fixture.bindings[0]!.admission.receivedAtMs,
      sequence: fixture.bindings[0]!.admission.sequence,
    });
    const registered = fixture.registry.lookupExisting(
      fixture.registryCapabilities.issueKey(SOURCE, 'original'),
      fixture.registryCapabilities.issueComparisonArtifact(Object.freeze({ retry: 'original' })),
    );
    expect(registered.kind).toBe('JOINED');
    if (registered.kind !== 'JOINED') throw new Error('expected the registered original to remain joinable');
    expect(registered.observationReference).toBe(recovery.observationReference);

    const joined = invoke(fixture.handler, '/recognition/attempts');
    await flush();

    expect(fixture.bindings).toHaveLength(1);
    expect(fixture.recognitionContexts).toHaveLength(0);
    expect(JSON.parse(joined.body)).toMatchObject({ code: 'REQUEST_STATUS_UNCONFIRMED' });
    expect(joined.statusCode).toBe(503);
  });
});
