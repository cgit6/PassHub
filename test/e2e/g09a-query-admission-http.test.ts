import { request as httpRequest } from 'node:http';

import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import { HumanAuthError, HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type {
  QueryDataPort,
  QuerySnapshotQualification,
} from '../../src/access/ports/index.js';
import {
  createOperationRegistry,
  createOperationRegistryCapabilityIssuer,
  type WriteOperationRegistrationReceipt,
} from '../../src/access/application/internal/index.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bAdmissionHandler,
  createG07bRouteComposition,
  createG09aQueryComposition,
  createHttpResponsePlanBundle,
  createPassHubHttpApplication,
  createQueryApplication,
  createUnknownRecognitionCoordinatorBundle,
  createWriterQuiescence,
  type AdmissionValidationResult,
  type PassHubHttpApplication,
  type WriterQuiescencePort,
} from '../../src/composition/internal/index.js';
import {
  createLegacyQueryAdmissionCapability,
  getQueryAdmissionIdentity,
} from '../../src/composition/internal/query-admission-binding.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const QUALIFICATION_ID = '33333333-3333-4333-8333-333333333333';
const INCARNATION = '44444444-4444-4444-8444-444444444444';
const NOW = Date.parse('2026-09-28T12:00:00.000Z');

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

interface HttpResult { readonly status: number; readonly body: Record<string, unknown>; }
function send(port: number, method: string, path: string, authorization = 'Bearer operator'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: {
        Authorization: authorization,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'Content-Length': '2', 'PassHub-Dataset-Epoch': EPOCH }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.once('error', reject);
    request.end(method === 'GET' ? undefined : '{}');
  });
}

function row(): QuerySnapshotQualification {
  return Object.freeze({
    qualificationId: QUALIFICATION_ID,
    displayName: 'HTTP Demo',
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

class HttpQueryData implements QueryDataPort {
  public readonly calls: string[] = [];
  public delay: Deferred<readonly QuerySnapshotQualification[]> | null = null;
  public listQualifications() {
    this.calls.push('listQualifications');
    return this.delay?.promise ?? Promise.resolve([row()]);
  }
  public listInside() { this.calls.push('listInside'); return Promise.resolve([]); }
  public listEvents() { this.calls.push('listEvents'); return Promise.resolve([]); }
  public readQualification() { this.calls.push('readQualification'); return Promise.resolve(row()); }
  public readEvent() { this.calls.push('readEvent'); return Promise.resolve(null); }
}

class HttpQueryAuth implements HumanAuthCapability {
  public readonly operator = new HumanPrincipal();
  public readonly viewer = new HumanPrincipal();
  public login() { return Promise.resolve({ accessToken: 'unused' }); }
  public verifyAccessToken(token: string) {
    if (token === 'operator') return Promise.resolve(this.operator);
    if (token === 'viewer') return Promise.resolve(this.viewer);
    return Promise.reject(new HumanAuthError('INVALID_TOKEN'));
  }
  public facts(principal: HumanPrincipal): { userId: string; role: HumanRole } {
    if (principal === this.operator) return { userId: ACCOUNT_ID, role: 'OPERATOR' };
    if (principal === this.viewer) return { userId: ACCOUNT_ID, role: 'VIEWER' };
    throw new HumanAuthError('INVALID_TOKEN');
  }
  public assertRole(principal: HumanPrincipal, role: HumanRole): void {
    if (this.facts(principal).role !== role) throw new HumanAuthError('ROLE_FORBIDDEN');
  }
}

interface Harness {
  readonly app: PassHubHttpApplication;
  readonly port: number;
  readonly data: HttpQueryData;
  readonly q: WriterQuiescencePort;
  readonly writerCalls: string[];
}

async function createHarness(q = createWriterQuiescence({ clock: { nowMs: () => NOW } })): Promise<Harness> {
  const data = new HttpQueryData();
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  const queryApplication = createQueryApplication({ data, writerQuiescence: q, epoch: EPOCH });
  const query = createG09aQueryComposition({
    currentDatasetEpoch: EPOCH,
    auth: new HttpQueryAuth(),
    queryApplication,
    responsePlans: plans,
    workHandoff: handoff,
    writerQuiescence: q,
  });
  const writerCalls: string[] = [];
  const invalid = (): Promise<AdmissionValidationResult> => Promise.resolve(Object.freeze({
    kind: 'REJECTED', response: plans.technical.issue('INVALID_REQUEST'),
  }));
  const management = {
    validate: () => Promise.resolve(Object.freeze({
      kind: 'MANAGEMENT' as const,
      accountId: ACCOUNT_ID,
      workInput: handoff.issuer.issue('QUALIFICATION_CREATE'),
    })),
    management: (_token: unknown, context: { sequence: bigint }) => {
      writerCalls.push(`writer:${context.sequence}`);
      return Promise.resolve(Object.freeze({
        disposition: 'BUSINESS_RESULT_PERSISTED' as const,
        response: plans.business.issue(200, { operation: 'writer' }),
      }));
    },
  };
  const routes = createG07bRouteComposition({
    login: { validate: invalid, login: () => Promise.resolve(plans.technical.issue('INVALID_REQUEST')) },
    query,
    management,
    recognition: {
      validate: invalid,
      recognition: () => Promise.resolve(Object.freeze({
        disposition: 'KNOWN_NO_EFFECT' as const,
        response: plans.technical.issue('INVALID_REQUEST'),
      })),
    },
  });
  const capabilities = createOperationRegistryCapabilityIssuer({
    registryId: 'g09a-http', datasetEpoch: EPOCH, processRunId: 'run', ownerId: 'owner', sameArtifact: () => true,
  });
  const registry = createOperationRegistry({
    capabilities,
    writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
    assertOwnerCurrent: () => undefined,
    assertContinuationEvidence: () => undefined,
  });
  const handler = createG07bAdmissionHandler({
    currentDatasetEpoch: EPOCH,
    registry,
    registryCapabilities: capabilities,
    responsePlans: plans,
    workHandoff: handoff,
    unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
    validator: routes.validator,
    work: routes.work,
    writerQuiescence: q,
  });
  const app = await createPassHubHttpApplication(handler);
  await app.nestApplication.listen(0, '127.0.0.1');
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP port unavailable');
  return { app, port: address.port, data, q, writerCalls };
}

function receipt(label: string): WriteOperationRegistrationReceipt {
  return Object.freeze({ operationId: `writer-${label}`, receivedAtMs: NOW, registeredAtMonotonicMs: 1, sequence: 0n });
}

describe('G09a true HTTP query admission binding', () => {
  const applications: PassHubHttpApplication[] = [];
  afterEach(async () => { await Promise.all(applications.splice(0).map((app) => app.nestApplication.close())); });
  const use = async (q?: WriterQuiescencePort) => {
    const h = await createHarness(q);
    applications.push(h.app);
    return h;
  };

  test.each(['PROVISIONAL', 'QUEUED', 'RUNNING', 'UNKNOWN', 'BLOCKED'] as const)(
    '%s writer returns query TECHNICAL_BUSY/503 with DB0',
    async (state) => {
      const q = createWriterQuiescence({ clock: { nowMs: () => NOW } });
      const value = receipt(state);
      q.lifecycle.registered(value);
      if (state === 'QUEUED' || state === 'RUNNING') q.lifecycle.queued(value);
      if (state === 'RUNNING') q.lifecycle.started(value);
      if (state === 'UNKNOWN') q.lifecycle.settled(value, 'UNKNOWN_EFFECT');
      if (state === 'BLOCKED') q.lifecycle.blocked(value);
      const h = await use(q);
      expect(await send(h.port, 'GET', '/qualifications')).toEqual({
        status: 503,
        body: { code: 'TECHNICAL_BUSY', currentDatasetEpoch: EPOCH },
      });
      expect(h.data.calls).toEqual([]);
    },
  );

  test('a delayed real query permits timer/I/O, holds later writers, then releases them FIFO exactly once', async () => {
    const h = await use();
    const pending = deferred<readonly QuerySnapshotQualification[]>();
    h.data.delay = pending;
    const query = send(h.port, 'GET', '/qualifications');
    for (let index = 0; index < 50 && h.data.calls.length === 0; index += 1) await new Promise((done) => setTimeout(done, 2));
    expect(h.data.calls).toEqual(['listQualifications']);
    let timerAdvanced = false;
    setTimeout(() => { timerAdvanced = true; }, 0);
    const first = send(h.port, 'POST', '/qualifications');
    const second = send(h.port, 'POST', '/qualifications');
    await new Promise((done) => setTimeout(done, 20));
    expect(timerAdvanced).toBe(true);
    expect(h.writerCalls).toEqual([]);
    pending.resolve([row()]);
    expect((await query).status).toBe(200);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);
    expect(h.writerCalls).toEqual(['writer:0', 'writer:1']);
  });
});

describe('G09a quiescence provenance at G07b construction', () => {
  function composition(q: WriterQuiescencePort) {
    const data = new HttpQueryData();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const handoff = createAdmissionWorkHandoffBundle();
    const app = createQueryApplication({ data, writerQuiescence: q, epoch: EPOCH });
    return { plans, handoff, value: createG09aQueryComposition({
      currentDatasetEpoch: EPOCH, auth: new HttpQueryAuth(), queryApplication: app,
      responsePlans: plans, workHandoff: handoff, writerQuiescence: q,
    }) };
  }

  test('query application and composition reject a mismatched writer quiescence', () => {
    const first = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const second = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const data = new HttpQueryData();
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    expect(() => createG09aQueryComposition({
      currentDatasetEpoch: EPOCH,
      auth: new HttpQueryAuth(),
      queryApplication: createQueryApplication({ data, writerQuiescence: first, epoch: EPOCH }),
      responsePlans: plans,
      workHandoff: createAdmissionWorkHandoffBundle(),
      writerQuiescence: second,
    })).toThrow(/quiescence|provenance/u);
  });

  test('mixed validator/work provenance and wrapper-erased provenance are rejected', () => {
    const q1 = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const a = composition(q1).value;
    const b = composition(q1).value;
    const invalid = { validate: a.validator.validate, login: () => Promise.reject(new Error('unused')) };
    const management = { validate: a.validator.validate, management: () => Promise.reject(new Error('unused')) };
    const recognition = { validate: a.validator.validate, recognition: () => Promise.reject(new Error('unused')) };
    expect(() => createG07bRouteComposition({
      login: invalid,
      query: { validator: a.validator, work: b.work } as never,
      management,
      recognition,
    })).toThrow(/capability|provenance|mismatch/u);
    expect(() => createG07bRouteComposition({
      login: invalid,
      query: {
        validator: { validate: (value: Parameters<typeof a.validator.validate>[0]) => a.validator.validate(value) },
        work: { query: (value: Parameters<typeof a.work.query>[0]) => a.work.query(value) },
      } as never,
      management,
      recognition,
    })).toThrow(/capability|provenance|mismatch/u);
  });

  test('only exact formal or exact legacy capabilities are accepted; flat/spread/cross-identity copies are rejected', () => {
    const q = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const formal = composition(q).value;
    const invalid = { validate: formal.validator.validate, login: () => Promise.reject(new Error('unused')) };
    const management = { validate: formal.validator.validate, management: () => Promise.reject(new Error('unused')) };
    const recognition = { validate: formal.validator.validate, recognition: () => Promise.reject(new Error('unused')) };
    const legacy = createLegacyQueryAdmissionCapability({
      validate: formal.validator.validate,
      query: formal.work.query,
    });
    expect(() => createG07bRouteComposition({ login: invalid, query: formal, management, recognition })).not.toThrow();
    expect(() => createG07bRouteComposition({ login: invalid, query: legacy, management, recognition })).not.toThrow();
    const secondLegacy = createLegacyQueryAdmissionCapability({
      validate: formal.validator.validate,
      query: formal.work.query,
    });
    for (const forged of [
      { validator: formal.validator, work: formal.work },
      { ...formal },
      { validator: formal.validator, work: legacy.work },
      { validator: legacy.validator, work: formal.work },
      { validator: legacy.validator, work: secondLegacy.work },
    ]) {
      expect(() => createG07bRouteComposition({
        login: invalid,
        query: forged as never,
        management,
        recognition,
      })).toThrow(/capability|provenance|mismatch/u);
    }
    expect(() => createG07bRouteComposition({
      login: invalid,
      query: { validate: formal.validator.validate, query: formal.work.query } as never,
      management,
      recognition,
    })).toThrow();
  });

  test.each(['nested accessor', 'nested proxy'] as const)(
    'hostile unbranded capability with %s is rejected before traps with a generic secret-free TypeError',
    (kind) => {
      const q = createWriterQuiescence({ clock: { nowMs: () => NOW } });
      const formal = composition(q).value;
      const invalid = { validate: formal.validator.validate, login: () => Promise.reject(new Error('unused')) };
      const management = { validate: formal.validator.validate, management: () => Promise.reject(new Error('unused')) };
      const recognition = { validate: formal.validator.validate, recognition: () => Promise.reject(new Error('unused')) };
      let traps = 0;
      const canary = 'nested-query-capability-secret-canary';
      const trap = () => { traps += 1; throw new Error(canary); };
      let query: object;
      if (kind === 'nested accessor') {
        query = {};
        Object.defineProperties(query, {
          validator: { enumerable: true, get: trap },
          work: { enumerable: true, get: trap },
        });
      } else {
        const nested = new Proxy({ validate: formal.validator.validate }, {
          get: trap,
          getPrototypeOf: trap,
          getOwnPropertyDescriptor: trap,
          ownKeys: trap,
        });
        query = { validator: nested, work: { query: formal.work.query } };
      }
      let caught: unknown;
      try {
        createG07bRouteComposition({ login: invalid, query: query as never, management, recognition });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect(String(caught)).toBe('TypeError: invalid query admission capability');
      expect(String(caught)).not.toContain(canary);
      expect(Object.hasOwn(caught as object, 'cause')).toBe(false);
      expect(traps).toBe(0);
    },
  );

  test('G07b route composition captures the exact query capability before its options object is swapped', () => {
    const first = composition(createWriterQuiescence({ clock: { nowMs: () => NOW } })).value;
    const second = composition(createWriterQuiescence({ clock: { nowMs: () => NOW } })).value;
    const invalid = { validate: first.validator.validate, login: () => Promise.reject(new Error('unused')) };
    const management = { validate: first.validator.validate, management: () => Promise.reject(new Error('unused')) };
    const recognition = { validate: first.validator.validate, recognition: () => Promise.reject(new Error('unused')) };
    const options = { login: invalid, query: first, management, recognition };
    const routes = createG07bRouteComposition(options);
    options.query = second;
    expect(getQueryAdmissionIdentity(routes.validator.validate)).toBe(getQueryAdmissionIdentity(first.validator.validate));
    expect(getQueryAdmissionIdentity(routes.validator.validate)).not.toBe(getQueryAdmissionIdentity(second.validator.validate));
  });

  test('handler direct construction rejects plain, wrapper, formal cross-instance, legacy mix, and formal/legacy mix', () => {
    const q = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const formalA = composition(q).value;
    const formalB = composition(q).value;
    const legacyA = createLegacyQueryAdmissionCapability({
      validate: formalA.validator.validate,
      query: formalA.work.query,
    });
    const legacyB = createLegacyQueryAdmissionCapability({
      validate: formalA.validator.validate,
      query: formalA.work.query,
    });
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const handoff = createAdmissionWorkHandoffBundle();
    const capabilities = createOperationRegistryCapabilityIssuer({
      registryId: 'g09a-direct-construction', datasetEpoch: EPOCH,
      processRunId: 'run', ownerId: 'owner', sameArtifact: () => true,
    });
    const registry = createOperationRegistry({
      capabilities,
      writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: () => undefined,
      assertContinuationEvidence: () => undefined,
    });
    const construct = (
      validate: typeof formalA.validator.validate,
      query: typeof formalA.work.query,
      writerQuiescence?: WriterQuiescencePort,
    ) => createG07bAdmissionHandler({
      currentDatasetEpoch: EPOCH,
      registry,
      registryCapabilities: capabilities,
      responsePlans: plans,
      workHandoff: handoff,
      unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
      validator: { validate },
      work: {
        login: () => Promise.resolve(plans.technical.issue('INVALID_REQUEST')),
        query,
        management: () => Promise.resolve(Object.freeze({
          disposition: 'KNOWN_NO_EFFECT' as const,
          response: plans.technical.issue('INVALID_REQUEST'),
        })),
        recognition: () => Promise.resolve(Object.freeze({
          disposition: 'KNOWN_NO_EFFECT' as const,
          response: plans.technical.issue('INVALID_REQUEST'),
        })),
      },
      ...(writerQuiescence === undefined ? {} : { writerQuiescence }),
    });

    expect(() => construct(legacyA.validator.validate, legacyA.work.query)).not.toThrow();
    expect(() => construct(
      (value) => formalA.validator.validate(value),
      (value) => formalA.work.query(value),
      q,
    )).toThrow(/provenance|mismatch/u);
    expect(() => construct(
      (() => Promise.reject(new Error('plain'))) as typeof formalA.validator.validate,
      (() => Promise.reject(new Error('plain'))) as typeof formalA.work.query,
    )).toThrow(/provenance|mismatch/u);
    expect(() => construct(formalA.validator.validate, formalB.work.query, q)).toThrow(/provenance|mismatch/u);
    expect(() => construct(legacyA.validator.validate, legacyB.work.query)).toThrow(/provenance|mismatch/u);
    expect(() => construct(formalA.validator.validate, legacyA.work.query, q)).toThrow(/provenance|mismatch/u);
  });
});
