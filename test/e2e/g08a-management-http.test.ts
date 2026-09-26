import { request as httpRequest } from 'node:http';

import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import { HumanAuthError, HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type {
  CreateQualificationCommand,
  ManageQualifications,
  RevokeQualificationCommand,
  UpdateQualificationCommand,
} from '../../src/access/application/index.js';
import type { ManagementPublicChangeResult } from '../../src/access/ports/index.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bAdmissionHandler,
  createG08aManagementComposition,
  createHttpResponsePlanBundle,
  createPassHubHttpApplication,
  createUnknownRecognitionCoordinatorBundle,
  type HttpResponsePlan,
  type PassHubHttpApplication,
} from '../../src/composition/internal/index.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const QUALIFICATION_ID = '33333333-3333-4333-8333-333333333333';
const VALID_FROM = '2026-09-26T00:00:00.000Z';
const VALID_UNTIL = '2026-09-27T00:00:00.000Z';

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function send(
  port: number,
  method: string,
  path: string,
  body: Record<string, unknown>,
  authorization = 'Bearer operator',
): Promise<HttpResult> {
  const wire = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(wire)),
        Authorization: authorization,
        'PassHub-Dataset-Epoch': EPOCH,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
      });
    });
    request.once('error', reject);
    request.end(wire);
  });
}

class HttpAuth implements HumanAuthCapability {
  public readonly operator = new HumanPrincipal();
  public readonly viewer = new HumanPrincipal();
  public dependencyFailure = false;
  public readonly tokenGates = new Map<string, Deferred<HumanPrincipal>>();

  public login(): Promise<{ accessToken: string }> {
    return Promise.resolve({ accessToken: 'unused' });
  }

  public verifyAccessToken(token: string): Promise<HumanPrincipal> {
    const pending = this.tokenGates.get(token);
    if (pending !== undefined) return pending.promise;
    if (this.dependencyFailure) return Promise.reject(new HumanAuthError('AUTH_DEPENDENCY_FAILURE'));
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

function summary(revoked = false) {
  return {
    qualificationId: QUALIFICATION_ID,
    displayName: 'Demo',
    validFromMs: Date.parse(VALID_FROM),
    validUntilMs: Date.parse(VALID_UNTIL),
    presence: 'NOT_ENTERED' as const,
    revokedAtMs: revoked ? Date.parse('2026-09-26T12:00:00.000Z') : null,
    revocationReason: revoked ? 'done' : null,
    expiredTerminalAtMs: null,
    faceBound: false,
    createdAtMs: Date.parse(VALID_FROM),
    updatedAtMs: Date.parse('2026-09-26T12:00:01.000Z'),
  };
}

class HttpManagement implements ManageQualifications {
  public readonly calls: Array<CreateQualificationCommand | UpdateQualificationCommand | RevokeQualificationCommand> = [];

  public create(input: CreateQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.calls.push(input);
    return Promise.resolve({
      operation: 'CREATE', qualificationId: QUALIFICATION_ID, summary: summary(), qrToken: 'z'.repeat(43),
      incarnation: 'must-not-leak', version: 9,
    } as unknown as ManagementPublicChangeResult);
  }

  public update(input: UpdateQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.calls.push(input);
    return Promise.resolve({
      operation: 'UPDATE', qualificationId: QUALIFICATION_ID, summary: summary(), qrToken: 'must-not-leak',
      incarnation: 'must-not-leak', version: 10,
    } as unknown as ManagementPublicChangeResult);
  }

  public revoke(input: RevokeQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.calls.push(input);
    return Promise.resolve({
      operation: 'REVOKE', qualificationId: QUALIFICATION_ID, summary: summary(true), qrToken: 'must-not-leak',
      incarnation: 'must-not-leak', version: 11,
    } as unknown as ManagementPublicChangeResult);
  }
}

interface Harness {
  readonly app: PassHubHttpApplication;
  readonly port: number;
  readonly auth: HttpAuth;
  readonly management: HttpManagement;
}

async function createHarness(): Promise<Harness> {
  const auth = new HttpAuth();
  const management = new HttpManagement();
  const responsePlans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const workHandoff = createAdmissionWorkHandoffBundle();
  const g08a = createG08aManagementComposition({ auth, manageQualifications: management, responsePlans, workHandoff });
  const capabilities = createOperationRegistryCapabilityIssuer({
    registryId: 'g08a-http', datasetEpoch: EPOCH, processRunId: 'run', ownerId: 'owner', sameArtifact: () => true,
  });
  const registry = createOperationRegistry({
    capabilities,
    writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
    assertOwnerCurrent: () => undefined,
    assertContinuationEvidence: () => undefined,
  });
  const fallback = (): Promise<HttpResponsePlan> => Promise.resolve(responsePlans.technical.issue('INVALID_REQUEST'));
  const handler = createG07bAdmissionHandler({
    currentDatasetEpoch: EPOCH,
    registry,
    registryCapabilities: capabilities,
    responsePlans,
    workHandoff,
    unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
    validator: g08a.validator,
    work: {
      login: fallback,
      query: fallback,
      management: g08a.work.management,
      recognition: async () => ({ disposition: 'KNOWN_NO_EFFECT', response: await fallback() }),
    },
  });
  const app = await createPassHubHttpApplication(handler);
  await app.nestApplication.listen(0, '127.0.0.1');
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP server did not bind a port');
  return { app, port: address.port, auth, management };
}

describe('G08a true Node/Nest/Express HTTP management', () => {
  const apps: PassHubHttpApplication[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.nestApplication.close()));
  });

  async function use(): Promise<Harness> {
    const harness = await createHarness();
    apps.push(harness.app);
    return harness;
  }

  test('Operator create/update/revoke uses public discriminated DTOs and reveals QR exactly once', async () => {
    const h = await use();
    const create = await send(h.port, 'POST', '/qualifications', {
      displayName: 'Demo', validFrom: VALID_FROM, validUntil: VALID_UNTIL,
      face: { provider: 'DemoFace.v1', externalSubjectId: 'subject' },
    });
    expect(create).toMatchObject({ status: 201, body: { operation: 'CREATE', qualificationId: QUALIFICATION_ID, qrToken: 'z'.repeat(43) } });
    expect(Object.keys(create.body).sort()).toEqual(['currentDatasetEpoch', 'operation', 'qrToken', 'qualificationId', 'summary']);
    expect(Object.keys(create.body.summary as Record<string, unknown>).sort()).toEqual([
      'createdAtMs', 'displayName', 'expiredTerminalAtMs', 'faceBound', 'presence', 'qualificationId',
      'revocationReason', 'revokedAtMs', 'updatedAtMs', 'validFromMs', 'validUntilMs',
    ]);
    expect(create.body).not.toHaveProperty('incarnation');
    expect(create.body).not.toHaveProperty('version');

    const update = await send(h.port, 'PATCH', `/qualifications/${QUALIFICATION_ID}`, { displayName: 'Renamed' });
    expect(update).toMatchObject({ status: 200, body: { operation: 'UPDATE', qualificationId: QUALIFICATION_ID } });
    expect(update.body).not.toHaveProperty('qrToken');
    expect(update.body).not.toHaveProperty('incarnation');
    expect(update.body).not.toHaveProperty('version');
    expect(Object.keys(update.body).sort()).toEqual(['currentDatasetEpoch', 'operation', 'qualificationId', 'summary']);

    const revoke = await send(h.port, 'POST', `/qualifications/${QUALIFICATION_ID}/revoke`, { reason: 'done' });
    expect(revoke).toMatchObject({ status: 200, body: { operation: 'REVOKE', qualificationId: QUALIFICATION_ID } });
    expect(Object.keys(revoke.body).sort()).toEqual(['currentDatasetEpoch', 'operation', 'qualificationId', 'summary']);
    expect(revoke.body).not.toHaveProperty('qrToken');
    expect(JSON.stringify([update.body, revoke.body])).not.toContain('must-not-leak');
  });

  test.each([
    ['Bearer viewer', 403, 'FORBIDDEN'],
    ['Bearer invalid', 401, 'AUTHENTICATION_FAILED'],
  ])('HTTP auth maps %s to %s', async (authorization, status, code) => {
    const h = await use();
    const response = await send(h.port, 'POST', '/qualifications', {
      displayName: 'Demo', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    }, authorization);
    expect(response).toMatchObject({ status, body: { code } });
    expect(h.management.calls).toHaveLength(0);
  });

  test('HTTP auth dependency failure is a sanitized 503', async () => {
    const h = await use();
    h.auth.dependencyFailure = true;
    const response = await send(h.port, 'POST', '/qualifications', {
      displayName: 'Demo', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    });
    expect(response).toMatchObject({ status: 503, body: { code: 'AUTH_UNAVAILABLE' } });
  });

  test.each([
    [{ displayName: 'Demo', validFrom: VALID_FROM, validUntil: VALID_UNTIL }, '/qualifications'],
    [{ displayName: 'Demo', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null, extra: true }, '/qualifications'],
    [{ displayName: 'Demo', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: { provider: 'Demo', externalSubjectId: 's', extra: true } }, '/qualifications'],
    [{ displayName: 'Demo', validFrom: '2026-09-26T00:00:00Z', validUntil: VALID_UNTIL, face: null }, '/qualifications'],
    [{ displayName: 'bad\nname', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null }, '/qualifications'],
    [{ displayName: 'x' }, '/qualifications/not-a-uuid'],
    [{}, `/qualifications/${QUALIFICATION_ID}`],
  ])('HTTP strict DTO rejects %#', async (body, path) => {
    const h = await use();
    const response = await send(h.port, path === '/qualifications' ? 'POST' : 'PATCH', path, body);
    expect(response).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect(h.management.calls).toHaveLength(0);
  });

  test('FIFO holds later management behind slower earlier auth and keeps receipt order', async () => {
    const h = await use();
    const slow = deferred<HumanPrincipal>();
    h.auth.tokenGates.set('slow', slow);
    const first = send(h.port, 'POST', '/qualifications', {
      displayName: 'first', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    }, 'Bearer slow');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = send(h.port, 'POST', '/qualifications', {
      displayName: 'second', validFrom: VALID_FROM, validUntil: VALID_UNTIL, face: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.management.calls).toHaveLength(0);
    slow.resolve(h.auth.operator);
    await Promise.all([first, second]);
    expect(h.management.calls.map((call) => 'displayName' in call ? call.displayName : '')).toEqual(['first', 'second']);
    const received = h.management.calls.map((call) => call.receivedAtMs);
    expect(received[0]).toBeLessThanOrEqual(received[1]!);
  });
});
