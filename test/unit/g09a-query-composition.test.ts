import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import { HumanAuthError, HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type {
  QueryDataPort,
  QuerySnapshotEvent,
  QuerySnapshotQualification,
} from '../../src/access/ports/index.js';
import {
  createAdmissionWorkHandoffBundle,
  createG09aQueryComposition,
  createHttpResponsePlanBundle,
  createQueryApplication,
  createQueryCursorCodec,
  createWriterQuiescence,
  type AdmissionValidationInput,
  type HttpResponsePlan,
  type HttpResponsePlanBundle,
} from '../../src/composition/internal/index.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const OLD_EPOCH = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const QUALIFICATION_ID = '44444444-4444-4444-8444-444444444444';
const INCARNATION = '55555555-5555-4555-8555-555555555555';
const EVENT_ID = '66666666-6666-4666-8666-666666666666';
const SOURCE_ID = '77777777-7777-4777-8777-777777777777';
const NOW = Date.parse('2026-09-28T12:00:00.000Z');

function qualification(displayName = 'Demo'): QuerySnapshotQualification {
  return Object.freeze({
    qualificationId: QUALIFICATION_ID,
    displayName,
    validFromMs: NOW - 10_000,
    validUntilMs: NOW + 10_000,
    presence: 'NOT_ENTERED',
    enteredAtMs: null,
    exitedAtMs: null,
    revokedAtMs: null,
    revocationReason: null,
    expiredTerminalAtMs: null,
    createdAtMs: NOW - 20_000,
    updatedAtMs: NOW - 5_000,
    qualificationIncarnation: INCARNATION,
    faceMapping: null,
  });
}

function event(): QuerySnapshotEvent {
  return Object.freeze({
    eventId: EVENT_ID,
    sourceId: SOURCE_ID,
    direction: 'ENTRY',
    kind: 'QR_SCANNED',
    outcome: 'ACCEPTED',
    reasonCode: 'ENTRY_GRANTED',
    receivedAtMs: NOW - 2_000,
    recordedAtMs: NOW - 1_000,
    qualificationId: QUALIFICATION_ID,
    presenceTransition: Object.freeze({ from: 'NOT_ENTERED', to: 'INSIDE' }),
  });
}

class QueryDataStub implements QueryDataPort {
  public qualifications: readonly QuerySnapshotQualification[] = [qualification()];
  public inside: readonly QuerySnapshotQualification[] = [qualification()];
  public events: readonly QuerySnapshotEvent[] = [event()];
  public qualification: QuerySnapshotQualification | null = qualification();
  public event: QuerySnapshotEvent | null = event();
  public failure: unknown = null;
  public readonly calls: Array<{ readonly method: string; readonly input: unknown }> = [];

  private result<T>(value: T): Promise<T> {
    return this.failure === null ? Promise.resolve(value) : Promise.reject(this.failure);
  }

  public listQualifications(input: Parameters<QueryDataPort['listQualifications']>[0]) {
    this.calls.push({ method: 'listQualifications', input });
    return this.result(this.qualifications);
  }
  public listInside(input: Parameters<QueryDataPort['listInside']>[0]) {
    this.calls.push({ method: 'listInside', input });
    return this.result(this.inside);
  }
  public listEvents(input: Parameters<QueryDataPort['listEvents']>[0]) {
    this.calls.push({ method: 'listEvents', input });
    return this.result(this.events);
  }
  public readQualification(id: string, observedAtMs: number) {
    this.calls.push({ method: 'readQualification', input: { id, observedAtMs } });
    return this.result(this.qualification);
  }
  public readEvent(id: string, observedAtMs: number) {
    this.calls.push({ method: 'readEvent', input: { id, observedAtMs } });
    return this.result(this.event);
  }
}

class QueryAuthStub implements HumanAuthCapability {
  public readonly operator = new HumanPrincipal();
  public readonly viewer = new HumanPrincipal();
  public role: HumanRole | 'FORBIDDEN' = 'OPERATOR';
  public failure: HumanAuthError | null = null;
  public readonly tokens: string[] = [];

  public login(): Promise<{ accessToken: string }> { return Promise.resolve({ accessToken: 'unused' }); }
  public verifyAccessToken(token: string): Promise<HumanPrincipal> {
    this.tokens.push(token);
    if (this.failure !== null) return Promise.reject(this.failure);
    if (token === 'operator') return Promise.resolve(this.operator);
    if (token === 'viewer') return Promise.resolve(this.viewer);
    return Promise.reject(new HumanAuthError('INVALID_TOKEN'));
  }
  public facts(principal: HumanPrincipal): { userId: string; role: HumanRole } {
    if (this.role === 'FORBIDDEN') return { userId: ACCOUNT_ID, role: 'OPERATOR' };
    if (principal === this.operator) return { userId: ACCOUNT_ID, role: this.role };
    if (principal === this.viewer) return { userId: ACCOUNT_ID, role: 'VIEWER' };
    throw new HumanAuthError('INVALID_TOKEN');
  }
  public assertRole(principal: HumanPrincipal, role: HumanRole): void {
    if (this.role === 'FORBIDDEN' || this.facts(principal).role !== role) throw new HumanAuthError('ROLE_FORBIDDEN');
  }
}

interface Harness {
  readonly auth: QueryAuthStub;
  readonly data: QueryDataStub;
  readonly plans: HttpResponsePlanBundle;
  readonly quiescence: ReturnType<typeof createWriterQuiescence>;
  readonly composition: ReturnType<typeof createG09aQueryComposition>;
}

function harness(): Harness {
  const auth = new QueryAuthStub();
  const data = new QueryDataStub();
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const quiescence = createWriterQuiescence({ clock: { nowMs: () => NOW } });
  const queryApplication = createQueryApplication({ data, writerQuiescence: quiescence, epoch: EPOCH });
  const composition = createG09aQueryComposition({
    currentDatasetEpoch: EPOCH,
    auth,
    queryApplication,
    responsePlans: plans,
    workHandoff: createAdmissionWorkHandoffBundle(),
    writerQuiescence: quiescence,
  });
  return { auth, data, plans, quiescence, composition };
}

type QueryRoute = 'QUALIFICATION_LIST' | 'QUALIFICATION_INSIDE_LIST' | 'QUALIFICATION_DETAIL' | 'EVENT_LIST' | 'EVENT_DETAIL';

function input(
  routeId: QueryRoute,
  options: Readonly<{
    authorization?: string;
    body?: Record<string, unknown> | null;
    id?: string;
    query?: readonly Readonly<{ name: string; value: string }>[];
  }> = {},
): AdmissionValidationInput {
  const detail = routeId === 'QUALIFICATION_DETAIL' || routeId === 'EVENT_DETAIL';
  return {
    routeId,
    retryMode: 'NORMAL',
    parameters: detail ? { id: options.id ?? (routeId === 'EVENT_DETAIL' ? EVENT_ID : QUALIFICATION_ID) } : {},
    accepted: {
      method: 'GET',
      body: (options.body ?? null) as never,
      query: options.query ?? [],
      headers: options.authorization === undefined ? { authorization: 'Bearer operator' } : { authorization: options.authorization },
    },
  };
}

function render(plans: HttpResponsePlanBundle, plan: HttpResponsePlan): { status: number; body: Record<string, unknown> } {
  const rendered = plans.renderer.render(plan);
  return { status: rendered.status, body: JSON.parse(rendered.body) as Record<string, unknown> };
}

async function execute(h: Harness, value: AdmissionValidationInput) {
  const validation = await h.composition.validator.validate(value);
  if (validation.kind === 'REJECTED') return render(h.plans, validation.response);
  if (validation.kind !== 'QUERY') throw new Error(`expected query, received ${validation.kind}`);
  return render(h.plans, await h.composition.work.query(validation.workInput));
}

describe('G09a query composition strict validation and projection', () => {
  test.each([
    ['QUALIFICATION_LIST', 'listQualifications'],
    ['QUALIFICATION_INSIDE_LIST', 'listInside'],
    ['QUALIFICATION_DETAIL', 'readQualification'],
    ['EVENT_LIST', 'listEvents'],
    ['EVENT_DETAIL', 'readEvent'],
  ] as const)('%s invokes only %s and returns an exact epoch-bearing response', async (routeId, method) => {
    const h = harness();
    const result = await execute(h, input(routeId));
    expect(result.status).toBe(200);
    expect(result.body.currentDatasetEpoch).toBe(EPOCH);
    expect(h.data.calls.map((call) => call.method)).toEqual([method]);
    expect(Object.keys(result.body).sort()).toEqual(routeId.endsWith('LIST')
      ? ['currentDatasetEpoch', 'items', 'nextCursor']
      : routeId.startsWith('QUALIFICATION')
        ? ['createdAt', 'currentDatasetEpoch', 'displayName', 'expired', 'expiredTerminalAt', 'faceBound', 'presence', 'qualificationId', 'revocationReason', 'revokedAt', 'updatedAt', 'validFrom', 'validUntil']
        : ['currentDatasetEpoch', 'direction', 'eventId', 'kind', 'outcome', 'presenceTransition', 'qualificationId', 'reasonCode', 'receivedAt', 'recordedAt', 'sourceId']);
  });

  test('default/lexical limits and all event filters are preserved exactly', async () => {
    const h = harness();
    await execute(h, input('QUALIFICATION_LIST'));
    await execute(h, input('QUALIFICATION_LIST', { query: [{ name: 'limit', value: '100' }] }));
    await execute(h, input('EVENT_LIST', { query: [
      { name: 'qualificationId', value: QUALIFICATION_ID },
      { name: 'outcome', value: 'REJECTED' },
      { name: 'reasonCode', value: 'QUALIFICATION_EXPIRED' },
      { name: 'limit', value: '1' },
    ] }));
    await execute(h, input('EVENT_LIST', { query: [{ name: 'limit', value: '01' }] }));
    expect((h.data.calls[0]!.input as { fetchLimit: number }).fetchLimit).toBe(21);
    expect((h.data.calls[1]!.input as { fetchLimit: number }).fetchLimit).toBe(101);
    expect(h.data.calls[2]!.input).toMatchObject({
      fetchLimit: 2,
      filters: { qualificationId: QUALIFICATION_ID, outcome: 'REJECTED', reasonCode: 'QUALIFICATION_EXPIRED' },
    });
    expect(h.data.calls).toHaveLength(3);
  });

  test.each([
    input('QUALIFICATION_LIST', { body: {} }),
    { ...input('QUALIFICATION_LIST'), parameters: { id: QUALIFICATION_ID } },
    input('QUALIFICATION_DETAIL', { query: [{ name: 'limit', value: '1' }] }),
    input('QUALIFICATION_DETAIL', { id: 'bad' }),
    input('QUALIFICATION_LIST', { query: [{ name: 'unknown', value: '1' }] }),
    input('QUALIFICATION_LIST', { query: [{ name: 'limit', value: '1' }, { name: 'limit', value: '2' }] }),
    input('QUALIFICATION_LIST', { query: [{ name: 'cursor', value: '' }] }),
    input('QUALIFICATION_LIST', { query: [{ name: 'limit', value: '0' }] }),
    input('QUALIFICATION_LIST', { query: [{ name: 'limit', value: '01' }] }),
    input('EVENT_LIST', { query: [{ name: 'outcome', value: 'accepted' }] }),
  ])('malformed body/path/query is INVALID_REQUEST with DB0 %#', async (value) => {
    const h = harness();
    expect(await execute(h, value as AdmissionValidationInput)).toEqual({
      status: 400,
      body: { code: 'INVALID_REQUEST', currentDatasetEpoch: EPOCH },
    });
    expect(h.data.calls).toEqual([]);
  });

  test.each([
    [undefined, 'AUTHENTICATION_FAILED', 401],
    ['', 'AUTHENTICATION_FAILED', 401],
    ['Basic operator', 'AUTHENTICATION_FAILED', 401],
    ['Source source-key', 'AUTHENTICATION_FAILED', 401],
    ['Bearer bad', 'AUTHENTICATION_FAILED', 401],
  ] as const)('bad authorization %# is %s/%i with DB0', async (authorization, code, status) => {
    const h = harness();
    const base = input('QUALIFICATION_LIST');
    const value = authorization === undefined
      ? { ...base, accepted: { ...base.accepted, headers: {} } }
      : input('QUALIFICATION_LIST', { authorization });
    expect(await execute(h, value)).toEqual({ status, body: { code, currentDatasetEpoch: EPOCH } });
    expect(h.data.calls).toEqual([]);
  });

  test('Operator and Viewer receive the same query projection', async () => {
    const operator = harness();
    const viewer = harness();
    expect(await execute(operator, input('QUALIFICATION_LIST', { authorization: 'Bearer operator' })))
      .toEqual(await execute(viewer, input('QUALIFICATION_LIST', { authorization: 'Bearer viewer' })));
  });

  test('forbidden and auth dependency errors map to 403/503 with DB0', async () => {
    const forbidden = harness();
    forbidden.auth.role = 'FORBIDDEN';
    expect(await execute(forbidden, input('QUALIFICATION_LIST'))).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(forbidden.data.calls).toEqual([]);
    const unavailable = harness();
    unavailable.auth.failure = new HumanAuthError('AUTH_DEPENDENCY_FAILURE');
    expect(await execute(unavailable, input('QUALIFICATION_LIST'))).toMatchObject({ status: 503, body: { code: 'AUTH_UNAVAILABLE' } });
    expect(unavailable.data.calls).toEqual([]);
  });

  test('one-use work token, dependency capture, and 400/404/409/503 mappings fail closed', async () => {
    const h = harness();
    h.auth.verifyAccessToken = () => Promise.reject(new Error('replacement'));
    const validation = await h.composition.validator.validate(input('QUALIFICATION_LIST'));
    if (validation.kind !== 'QUERY') throw new Error('expected query');
    h.data.listQualifications = () => Promise.reject(new Error('replacement'));
    expect(render(h.plans, await h.composition.work.query(validation.workInput)).status).toBe(200);
    await expect(h.composition.work.query(validation.workInput)).rejects.toThrow(/consumed/u);

    h.data.qualification = null;
    expect(await execute(h, input('QUALIFICATION_DETAIL'))).toMatchObject({ status: 404, body: { code: 'RESOURCE_NOT_FOUND' } });
    expect(await execute(h, input('QUALIFICATION_LIST', { query: [{ name: 'cursor', value: 'bad' }] })))
      .toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    const oldCursor = createQueryCursorCodec().encode(OLD_EPOCH, 'qualifications', Object.freeze({ qualificationId: null, outcome: null, reasonCode: null }), Object.freeze({
      lastTimeMs: NOW,
      lastId: QUALIFICATION_ID,
    }));
    expect(await execute(h, input('QUALIFICATION_LIST', { query: [{ name: 'cursor', value: oldCursor }] })))
      .toMatchObject({ status: 409, body: { code: 'DATASET_EPOCH_MISMATCH' } });
    h.data.failure = new Error('secret persistence failure');
    expect(await execute(h, input('EVENT_LIST'))).toMatchObject({ status: 503, body: { code: 'PERSISTENCE_UNAVAILABLE' } });
  });

  test('oversize response fails closed as 503 without a partial result or secret', async () => {
    const h = harness();
    h.data.qualifications = [qualification(`canary-${'x'.repeat(262_144)}`)];
    const result = await execute(h, input('QUALIFICATION_LIST'));
    expect(result).toEqual({ status: 503, body: { code: 'PERSISTENCE_UNAVAILABLE', currentDatasetEpoch: EPOCH } });
    expect(JSON.stringify(result)).not.toContain('canary');
  });
});

describe('G09a raw query construction attacks', () => {
  test('Proxy query pair is rejected without invoking any user trap', async () => {
    const h = harness();
    let traps = 0;
    const pair = new Proxy({ name: 'limit', value: '1' }, {
      getPrototypeOf: () => { traps += 1; throw new Error('must not execute'); },
      ownKeys: () => { traps += 1; throw new Error('must not execute'); },
      getOwnPropertyDescriptor: () => { traps += 1; throw new Error('must not execute'); },
    });
    const result = await execute(h, input('QUALIFICATION_LIST', { query: [pair] }));
    expect(result).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect(traps).toBe(0);
    expect(h.data.calls).toEqual([]);
  });

  test('accessor query pair is rejected without evaluating the accessor', async () => {
    const h = harness();
    let reads = 0;
    const pair = Object.defineProperty({ value: '1' }, 'name', { enumerable: true, get: () => { reads += 1; return 'limit'; } });
    expect(await execute(h, input('QUALIFICATION_LIST', { query: [pair as never] })))
      .toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect(reads).toBe(0);
    expect(h.data.calls).toEqual([]);
  });

  test.each(['proxy prototype', 'proxy method'] as const)('%s is rejected with one generic error and no secret', (kind) => {
    const q = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const data = new QueryDataStub();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const auth = new QueryAuthStub();
    const trap = () => { throw new Error('construction-secret-canary'); };
    const attacked = kind === 'proxy prototype'
      ? Object.create(new Proxy(Object.getPrototypeOf(auth) as object, { getOwnPropertyDescriptor: trap })) as HumanAuthCapability
      : Object.assign(auth, { verifyAccessToken: new Proxy(auth.verifyAccessToken, { apply: trap }) });
    expect(() => createG09aQueryComposition({
      currentDatasetEpoch: EPOCH,
      auth: attacked,
      queryApplication: createQueryApplication({ data, writerQuiescence: q, epoch: EPOCH }),
      responsePlans: plans,
      workHandoff: createAdmissionWorkHandoffBundle(),
      writerQuiescence: q,
    })).toThrow(/^invalid construction capability$/u);
    try {
      createG09aQueryComposition({
        currentDatasetEpoch: EPOCH,
        auth: attacked,
        queryApplication: createQueryApplication({ data, writerQuiescence: q, epoch: EPOCH }),
        responsePlans: plans,
        workHandoff: createAdmissionWorkHandoffBundle(),
        writerQuiescence: q,
      });
    } catch (error: unknown) {
      expect(String(error)).not.toContain('construction-secret-canary');
    }
  });

  test('frozen class delegates remain valid construction capabilities', () => {
    const q = createWriterQuiescence({ clock: Object.freeze({ nowMs: () => NOW }) });
    const data = Object.freeze(new QueryDataStub());
    const auth = Object.freeze(new QueryAuthStub());
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    expect(() => createG09aQueryComposition({
      currentDatasetEpoch: EPOCH,
      auth,
      queryApplication: createQueryApplication({ data, writerQuiescence: q, epoch: EPOCH }),
      responsePlans: plans,
      workHandoff: createAdmissionWorkHandoffBundle(),
      writerQuiescence: q,
    })).not.toThrow();
  });

  test('QueryApplication captures its construction quiescence before the options object is swapped', async () => {
    const first = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const second = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const data = new QueryDataStub();
    const options = { data, writerQuiescence: first, epoch: EPOCH };
    const application = createQueryApplication(options);
    options.writerQuiescence = second;
    second.lifecycle.registered(Object.freeze({
      operationId: 'swapped-writer', receivedAtMs: NOW, registeredAtMonotonicMs: 1, sequence: 0n,
    }));
    await expect(application.listQualifications({ limit: 1 })).resolves.toMatchObject({
      items: [expect.objectContaining({ qualificationId: QUALIFICATION_ID })],
    });
  });
});
