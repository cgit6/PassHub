import { HumanAuthError, HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import type {
  ManageQualifications,
  CreateQualificationCommand,
  UpdateQualificationCommand,
  RevokeQualificationCommand,
} from '../../src/access/application/index.js';
import { createManagementChangePlan } from '../../src/access/application/internal-plans.js';
import { ManagementApplicationError } from '../../src/access/application/management-errors.js';
import type { ManagementPublicChangeResult } from '../../src/access/ports/index.js';
import { readManagementPersistenceEnvelope } from '../../src/access/ports/trusted-operation.js';
import {
  createAdmissionWorkHandoffBundle,
  createG08aManagementComposition,
  createHttpResponsePlanBundle,
  type AdmissionValidationInput,
  type AdmissionWriterOutcome,
  type HttpResponsePlanBundle,
} from '../../src/composition/internal/index.js';
import {
  G04bTransactionError,
  type G04bTransactionErrorKind,
} from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const QUALIFICATION_ID = '33333333-3333-4333-8333-333333333333';
const INCARNATION = '44444444-4444-4444-8444-444444444444';
const VALID_FROM = '2026-09-26T00:00:00.000Z';
const VALID_UNTIL = '2026-09-27T00:00:00.000Z';

function summary() {
  return {
    qualificationId: QUALIFICATION_ID,
    displayName: 'Demo',
    validFromMs: Date.parse(VALID_FROM),
    validUntilMs: Date.parse(VALID_UNTIL),
    presence: 'NOT_ENTERED' as const,
    revokedAtMs: null,
    revocationReason: null,
    expiredTerminalAtMs: null,
    faceBound: false,
    createdAtMs: Date.parse(VALID_FROM),
    updatedAtMs: Date.parse(VALID_FROM),
  };
}

function publicResult(operation: 'CREATE' | 'UPDATE' | 'REVOKE'): ManagementPublicChangeResult {
  if (operation === 'CREATE') {
    return { operation, qualificationId: QUALIFICATION_ID, summary: summary(), qrToken: 'q'.repeat(43) };
  }
  return { operation, qualificationId: QUALIFICATION_ID, summary: summary() };
}

class FakeAuth implements HumanAuthCapability {
  public readonly operator = new HumanPrincipal();
  public readonly viewer = new HumanPrincipal();
  public verifyFailure: HumanAuthError | null = null;
  public factsFailure: HumanAuthError | null = null;
  public readonly verified: string[] = [];

  public login(): Promise<{ accessToken: string }> {
    return Promise.resolve({ accessToken: 'unused' });
  }

  public verifyAccessToken(token: string): Promise<HumanPrincipal> {
    this.verified.push(token);
    if (this.verifyFailure !== null) return Promise.reject(this.verifyFailure);
    if (token === 'operator') return Promise.resolve(this.operator);
    if (token === 'viewer') return Promise.resolve(this.viewer);
    return Promise.reject(new HumanAuthError('INVALID_TOKEN'));
  }

  public facts(principal: HumanPrincipal): { userId: string; role: HumanRole } {
    if (this.factsFailure !== null) throw this.factsFailure;
    if (principal === this.operator) return { userId: ACCOUNT_ID, role: 'OPERATOR' };
    if (principal === this.viewer) return { userId: ACCOUNT_ID, role: 'VIEWER' };
    throw new HumanAuthError('INVALID_TOKEN');
  }

  public assertRole(principal: HumanPrincipal, role: HumanRole): void {
    if (this.facts(principal).role !== role) throw new HumanAuthError('ROLE_FORBIDDEN');
  }
}

class FakeManagement implements ManageQualifications {
  public readonly calls: Array<CreateQualificationCommand | UpdateQualificationCommand | RevokeQualificationCommand> = [];
  public failure: unknown = null;

  private respond<T extends ManagementPublicChangeResult>(result: T): Promise<T> {
    return this.failure === null ? Promise.resolve(result) : Promise.reject(this.failure);
  }

  public create(input: CreateQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.calls.push(input);
    return this.respond(publicResult('CREATE'));
  }

  public update(input: UpdateQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.calls.push(input);
    return this.respond(publicResult('UPDATE'));
  }

  public revoke(input: RevokeQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.calls.push(input);
    return this.respond(publicResult('REVOKE'));
  }
}

interface Harness {
  readonly auth: FakeAuth;
  readonly management: FakeManagement;
  readonly plans: HttpResponsePlanBundle;
  readonly composition: ReturnType<typeof createG08aManagementComposition>;
}

function harness(): Harness {
  const auth = new FakeAuth();
  const management = new FakeManagement();
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const composition = createG08aManagementComposition({
    auth,
    manageQualifications: management,
    responsePlans: plans,
    workHandoff: createAdmissionWorkHandoffBundle(),
  });
  return { auth, management, plans, composition };
}

function input(
  routeId: 'QUALIFICATION_CREATE' | 'QUALIFICATION_UPDATE' | 'QUALIFICATION_REVOKE',
  body: Record<string, unknown>,
  options: { authorization?: string; id?: string; query?: readonly { name: string; value: string }[] } = {},
): AdmissionValidationInput {
  return {
    routeId,
    retryMode: 'NORMAL',
    parameters: routeId === 'QUALIFICATION_CREATE' ? {} : { id: options.id ?? QUALIFICATION_ID },
    accepted: {
      method: routeId === 'QUALIFICATION_UPDATE' ? 'PATCH' : 'POST',
      body: body as never,
      query: options.query ?? [],
      headers: { authorization: options.authorization ?? 'Bearer operator', datasetEpoch: EPOCH },
    },
  };
}

async function execute(h: Harness, validationInput: AdmissionValidationInput): Promise<AdmissionWriterOutcome> {
  const validation = await h.composition.validator.validate(validationInput);
  if (validation.kind !== 'MANAGEMENT') throw new Error(`expected MANAGEMENT, received ${validation.kind}`);
  return h.composition.work.management(validation.workInput, {
    operationId: '55555555-5555-4555-8555-555555555555',
    receivedAtMs: Date.parse('2026-09-26T12:00:00.000Z'),
    sequence: 7n,
  });
}

function rendered(h: Harness, outcome: AdmissionWriterOutcome): { status: number; body: Record<string, unknown> } {
  const response = h.plans.renderer.render(outcome.response);
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
}

describe('G08a management composition', () => {
  test.each([
    null,
    { provider: 'DemoFace.v1', externalSubjectId: ' subject 中文🙂 ' },
    { provider: `A${'b'.repeat(63)}`, externalSubjectId: 'a'.repeat(256) },
  ])('CREATE requires and preserves an explicit strict face value %#', async (face) => {
    const h = harness();
    const outcome = await execute(h, input('QUALIFICATION_CREATE', {
      displayName: ' Demo visitor ', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face,
    }));
    expect(rendered(h, outcome)).toMatchObject({ status: 201, body: { operation: 'CREATE', qrToken: 'q'.repeat(43) } });
    expect(h.management.calls[0]).toMatchObject({
      displayName: ' Demo visitor ', faceMapping: face, actorId: ACCOUNT_ID,
      receivedAtMs: Date.parse('2026-09-26T12:00:00.000Z'),
    });
  });

  test.each([
    [{ provider: '', externalSubjectId: 's' }, 'empty provider'],
    [{ provider: '1Demo', externalSubjectId: 's' }, 'provider first character'],
    [{ provider: `A${'b'.repeat(64)}`, externalSubjectId: 's' }, 'provider over 64 chars'],
    [{ provider: 'Demo Face', externalSubjectId: 's' }, 'provider grammar'],
    [{ provider: 'Demo', externalSubjectId: '' }, 'empty subject'],
    [{ provider: 'Demo', externalSubjectId: 'a'.repeat(257) }, 'subject over 256 UTF-8 bytes'],
    [{ provider: 'Demo', externalSubjectId: '😀'.repeat(65) }, 'emoji subject over 256 UTF-8 bytes'],
    [{ provider: 'Demo', externalSubjectId: 'bad\nsubject' }, 'subject control'],
    [{ provider: 'Demo', externalSubjectId: 'bad\u2028subject' }, 'subject U+2028'],
    [{ provider: 'Demo', externalSubjectId: '\ud800' }, 'unpaired surrogate'],
  ])('rejects strict Face DTO value: %s (%s)', async (face, _label) => {
    const h = harness();
    const result = await h.composition.validator.validate(input('QUALIFICATION_CREATE', {
      displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face,
    }));
    expect(result.kind).toBe('REJECTED');
    expect(h.auth.verified).toEqual(['operator']);
    expect(h.management.calls).toHaveLength(0);
  });

  test.each([
    [{ displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL }, 'missing face'],
    [{ displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null, extra: true }, 'root extra'],
    [{ displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: { provider: 'Demo', externalSubjectId: 's', extra: true } }, 'nested extra'],
    [{ displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: { provider: 'Demo' } }, 'nested missing'],
  ])('rejects strict CREATE DTO: %s (%s)', async (body, _label) => {
    const h = harness();
    const result = await h.composition.validator.validate(input('QUALIFICATION_CREATE', body as Record<string, unknown>));
    expect(result.kind).toBe('REJECTED');
    if (result.kind === 'REJECTED') expect(JSON.parse(h.plans.renderer.render(result.response).body)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(h.management.calls).toHaveLength(0);
  });

  test.each([
    [{ displayName: 'renamed' }, { displayName: 'renamed' }],
    [{ face: null }, { faceMapping: null }],
    [{ face: { provider: 'Demo.v2', externalSubjectId: 'subject' } }, { faceMapping: { provider: 'Demo.v2', externalSubjectId: 'subject' } }],
    [{ validUntil: VALID_UNTIL }, { validUntilMs: Date.parse(VALID_UNTIL) }],
  ])('PATCH forwards only the supplied subset %#', async (body, expected) => {
    const h = harness();
    await execute(h, input('QUALIFICATION_UPDATE', body));
    expect(h.management.calls[0]).toEqual(expect.objectContaining(expected));
    const command = h.management.calls[0] as unknown as Record<string, unknown>;
    for (const key of ['displayName', 'faceMapping', 'validFromMs', 'validUntilMs']) {
      if (!Object.hasOwn(expected, key)) expect(command).not.toHaveProperty(key);
    }
  });

  test.each([
    [input('QUALIFICATION_UPDATE', {}, {}), 'empty subset'],
    [input('QUALIFICATION_UPDATE', { displayName: 'x', extra: true }), 'extra field'],
    [input('QUALIFICATION_UPDATE', { displayName: 'x' }, { id: 'not-a-uuid' }), 'invalid UUID'],
    [input('QUALIFICATION_UPDATE', { displayName: 'x' }, { query: [{ name: 'x', value: '1' }] }), 'query'],
    [input('QUALIFICATION_CREATE', { displayName: 'x', validFrom: '2026-09-26T00:00:00Z', validUntil: VALID_UNTIL, face: null }), 'noncanonical ISO'],
    [input('QUALIFICATION_CREATE', { displayName: 'x\n', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null }), 'control text'],
    [input('QUALIFICATION_CREATE', { displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null }, { authorization: 'bearer operator' }), 'Bearer case'],
    [input('QUALIFICATION_CREATE', { displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null }, { authorization: 'Bearer  operator' }), 'Bearer whitespace'],
  ])('rejects management boundary violation: %s (%s)', async (request) => {
    const h = harness();
    const result = await h.composition.validator.validate(request);
    expect(result.kind).toBe('REJECTED');
  });

  test.each([
    ['Bearer viewer', null, 403, 'FORBIDDEN'],
    ['Bearer invalid', null, 401, 'AUTHENTICATION_FAILED'],
    ['Bearer operator', new HumanAuthError('AUTH_DEPENDENCY_FAILURE'), 503, 'AUTH_UNAVAILABLE'],
  ])('maps auth failure without invoking management: %s', async (authorization, failure, status, code) => {
    const h = harness();
    h.auth.verifyFailure = failure;
    const result = await h.composition.validator.validate(input('QUALIFICATION_CREATE', {
      displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    }, { authorization }));
    expect(result.kind).toBe('REJECTED');
    if (result.kind === 'REJECTED') {
      const response = h.plans.renderer.render(result.response);
      expect(response.status).toBe(status);
      expect(JSON.parse(response.body)).toMatchObject({ code });
    }
    expect(h.management.calls).toHaveLength(0);
  });

  test('captures mutable dependency methods at construction', async () => {
    const h = harness();
    h.auth.verifyAccessToken = () => Promise.reject(new Error('mutated auth method'));
    h.management.create = () => Promise.reject(new Error('mutated management method'));
    const outcome = await execute(h, input('QUALIFICATION_CREATE', {
      displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    }));
    expect(rendered(h, outcome).status).toBe(201);
    expect(h.management.calls).toHaveLength(1);
  });

  test.each([
    ['FACE_SUBJECT_ALREADY_BOUND', 409, 'KNOWN_NO_EFFECT'],
    ['FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED', 507, 'KNOWN_NO_EFFECT'],
    ['DUPLICATE_KEY', 503, 'UNKNOWN_EFFECT'],
    ['SCHEMA_VALIDATION', 503, 'UNKNOWN_EFFECT'],
    ['WRITE_CONFLICT', 503, 'UNKNOWN_EFFECT'],
  ] as const)('classifies Mongo %s without pretending non-face failures are known', async (kind, status, disposition) => {
    const h = harness();
    h.management.failure = transactionError(kind);
    const outcome = await execute(h, input('QUALIFICATION_CREATE', {
      displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    }));
    expect(outcome.disposition).toBe(disposition);
    expect(rendered(h, outcome).status).toBe(status);
  });

  test('application conflicts preserve persisted lazy-expiry disposition', async () => {
    const h = harness();
    h.management.failure = new ManagementApplicationError('QUALIFICATION_ALREADY_EXPIRED', 'EXPIRED_TERMINAL_PERSISTED');
    const outcome = await execute(h, input('QUALIFICATION_REVOKE', { reason: 'late' }));
    expect(outcome.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    expect(rendered(h, outcome)).toMatchObject({ status: 409, body: { code: 'QUALIFICATION_ALREADY_EXPIRED' } });
  });

  test.each([
    'QUALIFICATION_NOT_FOUND',
    'VALID_UNTIL_NOT_AFTER_VALID_FROM',
    'VALID_UNTIL_NOT_AFTER_RECEIVED_AT',
    'QUALIFICATION_ALREADY_ENTERED',
    'QUALIFICATION_ALREADY_USED',
    'QUALIFICATION_ALREADY_REVOKED',
    'REVOCATION_REASON_REQUIRED',
    'UPDATE_FIELD_REQUIRED',
  ] as const)('maps business rejection %s to 409 KNOWN_NO_EFFECT', async (code) => {
    const h = harness();
    h.management.failure = new ManagementApplicationError(code);
    const outcome = await execute(h, input('QUALIFICATION_CREATE', {
      displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    }));
    expect(outcome.disposition).toBe('KNOWN_NO_EFFECT');
    expect(rendered(h, outcome)).toMatchObject({ status: 409, body: { code } });
  });

  test.each([
    'TRANSACTION_ABORTED', 'UNKNOWN_COMMIT_RESULT', 'OTHER',
  ] as const)('maps uncertain Mongo %s to sanitized 503 UNKNOWN_EFFECT', async (kind) => {
    const h = harness();
    h.management.failure = transactionError(kind);
    const outcome = await execute(h, input('QUALIFICATION_CREATE', {
      displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    }));
    expect(outcome.disposition).toBe('UNKNOWN_EFFECT');
    expect(rendered(h, outcome)).toEqual({
      status: 503,
      body: { code: 'PERSISTENCE_UNAVAILABLE', currentDatasetEpoch: EPOCH },
    });
  });

  test('unknown ordinary dependency failure is sanitized as 503 UNKNOWN_EFFECT', async () => {
    const h = harness();
    h.management.failure = new Error('database secret must not leak');
    const outcome = await execute(h, input('QUALIFICATION_CREATE', {
      displayName: 'x', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    }));
    expect(outcome.disposition).toBe('UNKNOWN_EFFECT');
    expect(rendered(h, outcome)).toEqual({
      status: 503,
      body: { code: 'PERSISTENCE_UNAVAILABLE', currentDatasetEpoch: EPOCH },
    });
  });
});

test('trusted management envelope copies and freezes nested qualification provenance', () => {
  const expected = { qualificationId: QUALIFICATION_ID, incarnation: INCARNATION, version: 4 };
  const plan = createManagementChangePlan({
    operation: 'UPDATE', qualificationId: QUALIFICATION_ID, displayName: 'x',
    validFromMs: 1, validUntilMs: 2, faceMapping: null, faceMappingMode: 'KEEP',
    revocationReason: null, receivedAtMs: 1, actorId: ACCOUNT_ID, expectedQualification: expected,
  });
  expected.incarnation = '66666666-6666-4666-8666-666666666666';
  expected.version = 99;
  const stored = readManagementPersistenceEnvelope(plan as object);
  expect(stored?.expectedQualification).toEqual({ qualificationId: QUALIFICATION_ID, incarnation: INCARNATION, version: 4 });
  expect(Object.isFrozen(stored)).toBe(true);
  expect(Object.isFrozen(stored?.expectedQualification)).toBe(true);
});

function transactionError(kind: G04bTransactionErrorKind): G04bTransactionError {
  return new G04bTransactionError({ kind, stage: 'mapping', code: null, labels: [] }, new Error('hidden cause'));
}
