import { SourceAuthError } from '../../src/auth/domain/index.js';
import { createSourceAuth } from '../../src/auth/application/source-auth.js';
import {
  createVerifiedComparisonPort,
  verifyStartupVectorsAndCreateComparisonCapability,
} from '../../src/access/application/comparison/index.js';
import type {
  FaceMappingSnapshot,
  QualificationSnapshot,
  RecognitionDataPort,
  RecognitionPersistenceResult,
  ResolvedIdentitySnapshot,
  SourceFactsPort,
} from '../../src/access/ports/index.js';
import {
  createOperationRegistryCapabilityIssuer,
} from '../../src/access/application/internal/operation-registry.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bRouteComposition,
  createG08bRecognitionComposition,
  createHttpResponsePlanBundle,
  createSourceBoundRecognitionExecutorFactory,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWorkToken,
  type HttpResponsePlan,
} from '../../src/composition/internal/index.js';
import {
  FIXED_COMPARISON_REFERENCE_ID,
  FIXED_STARTUP_VECTORS,
  FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const QUALIFICATION_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const RECEIVED_AT = 1_800_000_000_000;
const AUTHORIZATION = `Source entry.${'A'.repeat(43)}`;

const comparison = createVerifiedComparisonPort(
  verifyStartupVectorsAndCreateComparisonCapability({
    hmacKey: FIXED_TEST_HMAC_KEY,
    comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
    vectors: FIXED_STARTUP_VECTORS,
  }),
);

const qualification: QualificationSnapshot = Object.freeze({
  qualificationId: QUALIFICATION_ID,
  incarnation: 'qualification-incarnation',
  version: 1,
  state: Object.freeze({
    validFromMs: RECEIVED_AT - 1_000,
    validUntilMs: RECEIVED_AT + 1_000,
    presence: 'NOT_ENTERED' as const,
    enteredAtMs: null,
    exitedAtMs: null,
    revokedAtMs: null,
    revocationReason: null,
    expiredTerminalAtMs: null,
  }),
});

const mapping: FaceMappingSnapshot = Object.freeze({
  qualificationId: QUALIFICATION_ID,
  qualificationIncarnation: qualification.incarnation,
  mappingIncarnation: 'mapping-incarnation',
  version: 1,
});

class FakeRecognitionPort implements RecognitionDataPort, SourceFactsPort {
  public result: RecognitionPersistenceResult | null = null;
  public active = true;
  public direction: 'ENTRY' | 'EXIT' = 'ENTRY';
  public readonly calls: string[] = [];

  public read(): Promise<Readonly<{ sourceId: string; direction: 'ENTRY' | 'EXIT'; active: boolean }>> {
    this.calls.push('sourceFacts');
    return Promise.resolve(Object.freeze({ sourceId: SOURCE_ID, direction: this.direction, active: this.active }));
  }

  public readQualification(): Promise<QualificationSnapshot | null> {
    this.calls.push('readQualification');
    return Promise.resolve(qualification);
  }

  public readMapping(): Promise<FaceMappingSnapshot | null> {
    this.calls.push('readMapping');
    return Promise.resolve(mapping);
  }

  public resolveQr(): Promise<ResolvedIdentitySnapshot> {
    this.calls.push('resolveQr');
    return Promise.resolve({ qualification, mapping });
  }

  public resolveFace(): Promise<ResolvedIdentitySnapshot> {
    this.calls.push('resolveFace');
    return Promise.resolve({ qualification, mapping });
  }

  public stageRecognitionResult(): Promise<RecognitionPersistenceResult> {
    this.calls.push('stageRecognitionResult');
    if (this.result === null) throw new Error('test result missing');
    return Promise.resolve(this.result);
  }
}

type Body = Readonly<Record<string, unknown>>;

interface Harness {
  readonly composition: ReturnType<typeof createG08bRecognitionComposition>;
  readonly port: FakeRecognitionPort;
  readonly plans: ReturnType<typeof createHttpResponsePlanBundle>;
  readonly verified: string[];
}

function committed(body: Body, options: { status?: 'COMMITTED' | 'REPLAYED'; mismatch?: Partial<Record<string, unknown>> } = {}): RecognitionPersistenceResult {
  const kind = body.kind as 'QR_SCANNED' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
  return Object.freeze({
    status: options.status ?? 'COMMITTED',
    replayed: (options.status ?? 'COMMITTED') === 'REPLAYED',
    event: Object.freeze({
      eventId: EVENT_ID,
      sourceId: SOURCE_ID,
      direction: 'ENTRY' as const,
      kind,
      outcome: kind === 'FACE_UNKNOWN' ? 'REJECTED' as const : 'ACCEPTED' as const,
      reasonCode: kind === 'FACE_UNKNOWN' ? 'FACE_UNKNOWN' as const : 'ENTRY_GRANTED' as const,
      receivedAtMs: RECEIVED_AT,
      recordedAtMs: RECEIVED_AT + 1,
      qualificationId: kind === 'FACE_UNKNOWN' ? null : QUALIFICATION_ID,
      presenceTransition: kind === 'FACE_UNKNOWN' ? null : Object.freeze({ from: 'NOT_ENTERED' as const, to: 'INSIDE' as const }),
      ...options.mismatch,
    }),
  });
}

function harness(options: {
  verify?: (alias: string, secret: string) => Promise<Readonly<{ sourceId: string }> | null>;
} = {}): Harness {
  const port = new FakeRecognitionPort();
  const verified: string[] = [];
  const verifier = options.verify ?? ((alias: string, secret: string) => {
    verified.push(`${alias}.${secret}`);
    return Promise.resolve(Object.freeze({ sourceId: SOURCE_ID }));
  });
  const sourceAuth = createSourceAuth({ credentialVerifier: { verify: verifier } });
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  const registryCapabilities = createOperationRegistryCapabilityIssuer({
    registryId: 'g08b-unit', datasetEpoch: EPOCH, processRunId: 'run', ownerId: 'owner',
    sameArtifact: (left, right) => comparison.matches?.(
      left as Parameters<NonNullable<typeof comparison.matches>>[0],
      right as Parameters<NonNullable<typeof comparison.matches>>[1],
    ) ?? false,
  });
  const composition = createG08bRecognitionComposition({
    sourceAuth,
    comparison,
    registryCapabilities,
    recognizeAttempt: createSourceBoundRecognitionExecutorFactory({
      recognition: port, sourceFacts: port, epoch: EPOCH, comparison,
    }),
    responsePlans: plans,
    workHandoff: handoff,
  });
  return { composition, port, plans, verified };
}

function input(body: unknown, options: {
  authorization?: unknown;
  retryMode?: 'NORMAL' | 'EXISTING_ONLY';
  query?: readonly { name: string; value: string }[];
  id?: string;
} = {}): AdmissionValidationInput {
  const authorization = Object.prototype.hasOwnProperty.call(options, 'authorization')
    ? options.authorization
    : AUTHORIZATION;
  return {
    routeId: 'RECOGNITION_ATTEMPT',
    retryMode: options.retryMode ?? 'NORMAL',
    parameters: options.id === undefined ? {} : { id: options.id },
    accepted: {
      method: 'POST',
      body: body as never,
      query: options.query ?? [],
      headers: { authorization: authorization as string, datasetEpoch: EPOCH },
    },
  };
}

function render(h: Harness, plan: HttpResponsePlan): { status: number; body: Record<string, unknown> } {
  const rendered = h.plans.renderer.render(plan);
  return { status: rendered.status, body: JSON.parse(rendered.body) as Record<string, unknown> };
}

async function validate(h: Harness, body: Body, options: Parameters<typeof input>[1] = {}): Promise<AdmissionValidationResult> {
  return h.composition.validator.validate(input(body, options));
}

async function execute(h: Harness, body: Body, result: RecognitionPersistenceResult = committed(body)) {
  h.port.result = result;
  const validation = await validate(h, body);
  if (validation.kind !== 'RECOGNITION') throw new Error(`expected recognition, received ${validation.kind}`);
  return h.composition.work.recognition(validation.workInput, {
    operationId: '55555555-5555-4555-8555-555555555555',
    receivedAtMs: RECEIVED_AT,
    sequence: 1n,
  });
}

describe('G08b Source authentication and strict recognition DTOs', () => {
  test('accepts only the exact Source scheme and passes only alias.secret to Source Auth', async () => {
    const h = harness();
    const result = await validate(h, { externalEventId: 'event-1', kind: 'FACE_UNKNOWN' });
    expect(result.kind).toBe('RECOGNITION');
    expect(h.verified).toEqual([`entry.${'A'.repeat(43)}`]);
  });

  test.each([
    undefined, '', `source entry.${'A'.repeat(43)}`, `Source  entry.${'A'.repeat(43)}`,
    `Source ENTRY.${'A'.repeat(43)}`, `Source entry.${'A'.repeat(42)}`,
    `Source entry.${'A'.repeat(44)}`, `Bearer entry.${'A'.repeat(43)}`,
  ])('invalid exact Authorization value %# is 401 before dependencies', async (authorization) => {
    const h = harness();
    const result = await validate(h, { externalEventId: 'event-1', kind: 'FACE_UNKNOWN' }, { authorization });
    expect(result.kind).toBe('REJECTED');
    if (result.kind !== 'REJECTED') return;
    expect(render(h, result.response)).toMatchObject({ status: 401, body: { code: 'AUTHENTICATION_FAILED' } });
    expect(h.verified).toEqual([]);
    expect(h.port.calls).toEqual([]);
  });

  test.each([
    new SourceAuthError('SOURCE_AUTH_DEPENDENCY_FAILURE'),
    new Error('secret dependency cause'),
  ])('Source dependency failure is sanitized to 503', async (failure) => {
    const h = harness({ verify: () => Promise.reject(failure) });
    const result = await validate(h, { externalEventId: 'event-1', kind: 'FACE_UNKNOWN' });
    expect(result.kind).toBe('REJECTED');
    if (result.kind !== 'REJECTED') return;
    const response = render(h, result.response);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    expect(JSON.stringify(response)).not.toContain('secret dependency cause');
  });

  test.each([
    [{ externalEventId: 'e', kind: 'QR_SCANNED', token: 'A' }],
    [{ externalEventId: 'e', kind: 'QR_SCANNED', token: 'A'.repeat(128) }],
    [{ externalEventId: 'e', kind: 'FACE_MATCHED', provider: 'A', externalSubjectId: 'x' }],
    [{ externalEventId: 'e', kind: 'FACE_MATCHED', provider: `A${'b'.repeat(63)}`, externalSubjectId: '中🙂'.repeat(32) }],
    [{ externalEventId: 'e', kind: 'FACE_UNKNOWN' }],
  ])('accepts an exact DTO boundary %#', async (body) => {
    expect((await validate(harness(), body)).kind).toBe('RECOGNITION');
  });

  test.each([
    null, [], {},
    { externalEventId: '', kind: 'FACE_UNKNOWN' },
    { externalEventId: ' e', kind: 'FACE_UNKNOWN' },
    { externalEventId: 'e', kind: 'QR_SCANNED', token: '' },
    { externalEventId: 'e', kind: 'QR_SCANNED', token: 'A'.repeat(129) },
    { externalEventId: 'e', kind: 'QR_SCANNED', token: 'A', extra: true },
    { externalEventId: 'e', kind: 'FACE_MATCHED', provider: 'a'.repeat(65), externalSubjectId: 'x' },
    { externalEventId: 'e', kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: '' },
    { externalEventId: 'e', kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: '🙂'.repeat(65) },
    { externalEventId: 'e', kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: '\ud800' },
    { externalEventId: 'e', kind: 'FACE_UNKNOWN', token: 'A' },
    { externalEventId: 'e', kind: 'NOPE' },
    { externalEventId: 1, kind: 'FACE_UNKNOWN' },
  ])('rejects malformed/wrong-combination DTO %# without recognition persistence', async (body) => {
    const h = harness();
    const result = await h.composition.validator.validate(input(body));
    expect(result.kind).toBe('REJECTED');
    if (result.kind !== 'REJECTED') return;
    expect(render(h, result.response)).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect(h.port.calls).toEqual([]);
  });

  test.each([
    { query: [{ name: 'x', value: '1' }] },
    { id: QUALIFICATION_ID },
  ])('rejects route-level recognition extras %#', async (options) => {
    const h = harness();
    const result = await validate(h, { externalEventId: 'e', kind: 'FACE_UNKNOWN' }, options);
    expect(result.kind).toBe('REJECTED');
    if (result.kind === 'REJECTED') expect(render(h, result.response).status).toBe(400);
    expect(h.port.calls).toEqual([]);
  });
});

describe('G08b persistence outcome and Event contract', () => {
  const qr = Object.freeze({ externalEventId: 'event-qr', kind: 'QR_SCANNED', token: 'A' });

  test('COMMITTED returns exact original/replay plans and consumes work only once', async () => {
    const h = harness();
    h.port.result = committed(qr);
    const validation = await validate(h, qr);
    if (validation.kind !== 'RECOGNITION') throw new Error('expected recognition');
    const outcome = await h.composition.work.recognition(validation.workInput, {
      operationId: EVENT_ID, receivedAtMs: RECEIVED_AT, sequence: 0n,
    });
    expect(outcome.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    if (outcome.disposition !== 'BUSINESS_RESULT_PERSISTED') return;
    const original = render(h, outcome.originalResponse);
    const replay = render(h, outcome.replayResponse);
    expect(original.status).toBe(200);
    expect(Object.keys(original.body).sort()).toEqual([
      'currentDatasetEpoch', 'direction', 'eventId', 'kind', 'outcome', 'presenceTransition',
      'qualificationId', 'reasonCode', 'receivedAt', 'recordedAt', 'replayed', 'sourceId',
    ]);
    expect(original.body).toMatchObject({ replayed: false, eventId: EVENT_ID, reasonCode: 'ENTRY_GRANTED' });
    expect(replay.body).toMatchObject({ replayed: true, eventId: EVENT_ID });
    await expect(h.composition.work.recognition(validation.workInput, {
      operationId: EVENT_ID, receivedAtMs: RECEIVED_AT, sequence: 1n,
    })).rejects.toThrow(/already consumed/i);
  });

  test('REPLAYED returns replayed true in both safe plans', async () => {
    const h = harness();
    const outcome = await execute(h, qr, committed(qr, { status: 'REPLAYED' }));
    expect(outcome.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    if (outcome.disposition !== 'BUSINESS_RESULT_PERSISTED') return;
    expect(render(h, outcome.originalResponse).body.replayed).toBe(true);
    expect(render(h, outcome.replayResponse).body.replayed).toBe(true);
  });

  test('IDEMPOTENCY conflict is known 409, while other conflict and unknown are opaque 503', async () => {
    const cases: Array<[RecognitionPersistenceResult, string, number]> = [
      [Object.freeze({ status: 'CONFLICT', event: null, error: { kind: 'IDEMPOTENCY_CONFLICT', stage: 'WRITE', code: 11000, labels: [] } }), 'KNOWN_NO_EFFECT', 409],
      [Object.freeze({ status: 'CONFLICT', event: null, error: { kind: 'WRITE_CONFLICT', stage: 'WRITE', code: 112, labels: [] } }), 'UNKNOWN_EFFECT', 503],
      [Object.freeze({ status: 'UNKNOWN', event: null, error: { kind: 'UNKNOWN_COMMIT_RESULT', stage: 'COMMIT', code: null, labels: ['UnknownTransactionCommitResult'] } }), 'UNKNOWN_EFFECT', 503],
    ];
    for (const [result, disposition, status] of cases) {
      const h = harness();
      const outcome = await execute(h, qr, result);
      expect(outcome.disposition).toBe(disposition);
      if (outcome.disposition === 'BUSINESS_RESULT_PERSISTED') throw new Error('unexpected persisted outcome');
      expect(render(h, outcome.response).status).toBe(status);
      expect(JSON.stringify(render(h, outcome.response))).not.toMatch(/11000|112|UnknownTransaction|WRITE_CONFLICT/u);
    }
  });

  test.each([
    { sourceId: '99999999-9999-4999-8999-999999999999' },
    { direction: 'EXIT' },
    { kind: 'FACE_UNKNOWN' },
    { receivedAtMs: RECEIVED_AT + 1 },
  ])('Event provenance mismatch %# fails closed as unknown effect', async (mismatch) => {
    const h = harness();
    const outcome = await execute(h, qr, committed(qr, { mismatch }));
    expect(outcome.disposition).toBe('UNKNOWN_EFFECT');
    if (outcome.disposition !== 'BUSINESS_RESULT_PERSISTED') {
      expect(render(h, outcome.response)).toMatchObject({ status: 503, body: { code: 'PERSISTENCE_UNAVAILABLE' } });
    }
  });

  test('FACE_UNKNOWN is persisted as a rejected Event with no identity or transition', async () => {
    const body = Object.freeze({ externalEventId: 'unknown-1', kind: 'FACE_UNKNOWN' });
    const h = harness();
    const outcome = await execute(h, body);
    expect(outcome.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    if (outcome.disposition !== 'BUSINESS_RESULT_PERSISTED') return;
    expect(render(h, outcome.originalResponse).body).toMatchObject({
      kind: 'FACE_UNKNOWN', outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN',
      qualificationId: null, presenceTransition: null, replayed: false,
    });
  });
});

describe('G08b shared route dispatcher', () => {
  test('dispatches all four route categories to captured validators and work delegates', async () => {
    const handoff = createAdmissionWorkHandoffBundle();
    const calls: string[] = [];
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const token = (route: Parameters<typeof handoff.issuer.issue>[0]) => handoff.issuer.issue(route);
    const delegate = (name: string) => ({
      validate: (value: AdmissionValidationInput): Promise<AdmissionValidationResult> => {
        calls.push(`validate:${name}`);
        if (name === 'login') return Promise.resolve(Object.freeze({ kind: 'LOGIN', workInput: token(value.routeId) }));
        if (name === 'query') return Promise.resolve(Object.freeze({ kind: 'QUERY', accountId: 'a', workInput: token(value.routeId) }));
        if (name === 'management') return Promise.resolve(Object.freeze({ kind: 'MANAGEMENT', accountId: 'a', workInput: token(value.routeId) }));
        return Promise.resolve(Object.freeze({ kind: 'REJECTED', response: plans.technical.issue('INVALID_REQUEST') }));
      },
      login: (_input: AdmissionWorkToken) => { calls.push('work:login'); return Promise.resolve(plans.business.issue(200, { ok: true })); },
      query: (_input: AdmissionWorkToken) => { calls.push('work:query'); return Promise.resolve(plans.business.issue(200, { ok: true })); },
      management: (_input: AdmissionWorkToken) => { calls.push('work:management'); return Promise.resolve(Object.freeze({ disposition: 'KNOWN_NO_EFFECT' as const, response: plans.business.issue(409, { ok: false }) })); },
      recognition: (_input: AdmissionWorkToken) => { calls.push('work:recognition'); return Promise.resolve(Object.freeze({ disposition: 'KNOWN_NO_EFFECT' as const, response: plans.business.issue(409, { ok: false }) })); },
    });
    const login = delegate('login'); const query = delegate('query');
    const management = delegate('management'); const recognition = delegate('recognition');
    const routes = createG07bRouteComposition({ login, query, management, recognition });
    const routeInputs = [
      input({}, {}),
      { ...input({}), routeId: 'AUTH_LOGIN' as const },
      { ...input({}), routeId: 'QUALIFICATION_CREATE' as const },
      { ...input({}), routeId: 'EVENT_LIST' as const },
    ];
    await routes.validator.validate(routeInputs[0]!);
    await routes.validator.validate(routeInputs[1]!);
    await routes.validator.validate(routeInputs[2]!);
    await routes.validator.validate(routeInputs[3]!);
    expect(calls).toEqual(['validate:recognition', 'validate:login', 'validate:management', 'validate:query']);
  });
});
