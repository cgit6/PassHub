import { request as httpRequest } from 'node:http';

import { HumanAuthError, HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import { createSourceAuth } from '../../src/auth/application/source-auth.js';
import type { ManageQualifications } from '../../src/access/application/index.js';
import {
  createVerifiedComparisonPort,
  verifyStartupVectorsAndCreateComparisonCapability,
} from '../../src/access/application/comparison/index.js';
import type {
  FaceMappingSnapshot, ManagementPublicChangeResult, QualificationSnapshot,
  RecognitionDataPort, RecognitionPersistenceResult, ResolvedIdentitySnapshot, SourceFactsPort,
} from '../../src/access/ports/index.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bAdmissionHandler,
  createG07bRouteComposition,
  createG08aManagementComposition,
  createG08bRecognitionComposition,
  createHttpResponsePlanBundle,
  createPassHubHttpApplication,
  createSourceBoundRecognitionExecutorFactory,
  createUnknownRecognitionCoordinatorBundle,
  type AdmissionValidationResult,
  type HttpResponsePlan,
  type PassHubHttpApplication,
} from '../../src/composition/internal/index.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import {
  FIXED_COMPARISON_REFERENCE_ID, FIXED_STARTUP_VECTORS, FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const EXIT_ID = '33333333-3333-4333-8333-333333333333';
const QUALIFICATION_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const ENTRY_AUTH = `Source entry.${'A'.repeat(43)}`;
const EXIT_AUTH = `Source exit.${'B'.repeat(43)}`;
const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
  hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
}));

interface HttpResult { readonly status: number; readonly body: Record<string, unknown> }

function send(port: number, body: Record<string, unknown>, authorization = ENTRY_AUTH, extra: Record<string, string> = {}): Promise<HttpResult> {
  const wire = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/recognition/attempts', agent: false,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(wire)),
        Authorization: authorization, 'PassHub-Dataset-Epoch': EPOCH, ...extra,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }));
    });
    request.once('error', reject);
    request.end(wire);
  });
}

class HumanAuthStub implements HumanAuthCapability {
  private readonly principal = new HumanPrincipal();
  public login(): Promise<{ accessToken: string }> { return Promise.resolve({ accessToken: 'unused' }); }
  public verifyAccessToken(): Promise<HumanPrincipal> { return Promise.resolve(this.principal); }
  public facts(): { userId: string; role: HumanRole } { return { userId: ENTRY_ID, role: 'OPERATOR' }; }
  public assertRole(): void { /* fixed Operator */ }
}

const managementStub: ManageQualifications = Object.freeze({
  create: (): Promise<ManagementPublicChangeResult> => Promise.reject(new HumanAuthError('ROLE_FORBIDDEN')),
  update: (): Promise<ManagementPublicChangeResult> => Promise.reject(new HumanAuthError('ROLE_FORBIDDEN')),
  revoke: (): Promise<ManagementPublicChangeResult> => Promise.reject(new HumanAuthError('ROLE_FORBIDDEN')),
});

const qualification: QualificationSnapshot = Object.freeze({
  qualificationId: QUALIFICATION_ID, incarnation: 'incarnation', version: 1,
  state: Object.freeze({
    validFromMs: 0, validUntilMs: 8_000_000_000_000_000, presence: 'NOT_ENTERED' as const,
    enteredAtMs: null, exitedAtMs: null, revokedAtMs: null, revocationReason: null, expiredTerminalAtMs: null,
  }),
});
const mapping: FaceMappingSnapshot = Object.freeze({
  qualificationId: QUALIFICATION_ID, qualificationIncarnation: 'incarnation', mappingIncarnation: 'mapping', version: 1,
});

class HttpRecognitionPort implements RecognitionDataPort, SourceFactsPort {
  public calls = 0;
  public lastSourceId = ENTRY_ID;
  public lastDirection: 'ENTRY' | 'EXIT' = 'ENTRY';
  public active = true;
  public nextResult: RecognitionPersistenceResult | null = null;

  public read(_context: object, sourceId: string) {
    this.lastSourceId = sourceId;
    this.lastDirection = sourceId === EXIT_ID ? 'EXIT' : 'ENTRY';
    return Promise.resolve(Object.freeze({ sourceId, direction: this.lastDirection, active: this.active }));
  }
  public readQualification(): Promise<QualificationSnapshot | null> { return Promise.resolve(qualification); }
  public readMapping(): Promise<FaceMappingSnapshot | null> { return Promise.resolve(mapping); }
  public resolveQr(): Promise<ResolvedIdentitySnapshot> { return Promise.resolve({ qualification, mapping }); }
  public resolveFace(): Promise<ResolvedIdentitySnapshot> { return Promise.resolve({ qualification, mapping }); }
  public stageRecognitionResult(_context: object, plan: Parameters<RecognitionDataPort['stageRecognitionResult']>[1]): Promise<RecognitionPersistenceResult> {
    this.calls += 1;
    if (this.nextResult !== null) return Promise.resolve(this.nextResult);
    const kind = plan.media === 'QR' ? 'QR_SCANNED' : plan.media;
    return Promise.resolve(Object.freeze({
      status: 'COMMITTED', replayed: false,
      event: Object.freeze({
        eventId: EVENT_ID, sourceId: this.lastSourceId, direction: this.lastDirection, kind,
        outcome: plan.outcome, reasonCode: plan.reasonCode,
        receivedAtMs: 1_800_000_000_000, recordedAtMs: 1_800_000_000_001,
        qualificationId: plan.qualificationId,
        presenceTransition: plan.presenceTransition,
      }),
    }));
  }
}

interface Harness { readonly app: PassHubHttpApplication; readonly port: number; readonly persistence: HttpRecognitionPort }

async function createHarness(): Promise<Harness> {
  const persistence = new HttpRecognitionPort();
  const sourceAuth = createSourceAuth({ credentialVerifier: {
    verify: (alias, secret) => Promise.resolve(
      alias === 'entry' && secret === 'A'.repeat(43) ? Object.freeze({ sourceId: ENTRY_ID })
        : alias === 'exit' && secret === 'B'.repeat(43) ? Object.freeze({ sourceId: EXIT_ID }) : null,
    ),
  } });
  const responsePlans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const workHandoff = createAdmissionWorkHandoffBundle();
  const capabilities = createOperationRegistryCapabilityIssuer({
    registryId: 'g08b-http', datasetEpoch: EPOCH, processRunId: 'run', ownerId: 'owner',
    sameArtifact: (left, right) => {
      const a = left as Readonly<{ inputHmac?: unknown; comparisonReferenceId?: unknown }>;
      const b = right as Readonly<{ inputHmac?: unknown; comparisonReferenceId?: unknown }>;
      return a.inputHmac === b.inputHmac && a.comparisonReferenceId === b.comparisonReferenceId;
    },
  });
  const recognition = createG08bRecognitionComposition({
    sourceAuth, comparison, registryCapabilities: capabilities,
    recognizeAttempt: createSourceBoundRecognitionExecutorFactory({ recognition: persistence, sourceFacts: persistence, epoch: EPOCH, comparison }),
    responsePlans, workHandoff,
  });
  const management = createG08aManagementComposition({
    auth: new HumanAuthStub(), manageQualifications: managementStub, responsePlans, workHandoff,
  });
  const fallback = {
    validate: (): Promise<AdmissionValidationResult> => Promise.resolve(Object.freeze({ kind: 'REJECTED', response: responsePlans.technical.issue('INVALID_REQUEST') })),
    login: (): Promise<HttpResponsePlan> => Promise.resolve(responsePlans.technical.issue('INVALID_REQUEST')),
    query: (): Promise<HttpResponsePlan> => Promise.resolve(responsePlans.technical.issue('INVALID_REQUEST')),
  };
  const routes = createG07bRouteComposition({
    login: fallback,
    query: createLegacyQueryAdmissionCapability(fallback),
    management: Object.freeze({ ...management.validator, ...management.work }),
    recognition: Object.freeze({ ...recognition.validator, ...recognition.work }),
  });
  const registry = createOperationRegistry({
    capabilities, writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
    assertOwnerCurrent: () => undefined, assertContinuationEvidence: () => undefined,
  });
  const handler = createG07bAdmissionHandler({
    currentDatasetEpoch: EPOCH, registry, registryCapabilities: capabilities, responsePlans, workHandoff,
    unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
    validator: routes.validator, work: routes.work,
    wallClock: { nowMs: () => 1_800_000_000_000 },
  });
  const app = await createPassHubHttpApplication(handler);
  await app.nestApplication.listen(0, '127.0.0.1');
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP server did not bind');
  return { app, port: address.port, persistence };
}

describe('G08b true Node/Nest/Express HTTP recognition composition', () => {
  const apps: PassHubHttpApplication[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.nestApplication.close())); });
  const use = async () => { const value = await createHarness(); apps.push(value.app); return value; };

  test.each([
    [{ externalEventId: 'qr-http', kind: 'QR_SCANNED', token: 'A' }, 'QR_SCANNED'],
    [{ externalEventId: 'face-http', kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: '中🙂' }, 'FACE_MATCHED'],
    [{ externalEventId: 'unknown-http', kind: 'FACE_UNKNOWN' }, 'FACE_UNKNOWN'],
  ])('persists and returns an exact safe response for %s', async (body, kind) => {
    const h = await use();
    const result = await send(h.port, body);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind, sourceId: ENTRY_ID, direction: 'ENTRY', eventId: EVENT_ID, replayed: false });
    expect(Object.keys(result.body).sort()).toEqual([
      'currentDatasetEpoch', 'direction', 'eventId', 'kind', 'outcome', 'presenceTransition',
      'qualificationId', 'reasonCode', 'receivedAt', 'recordedAt', 'replayed', 'sourceId',
    ]);
    expect(JSON.stringify(result.body)).not.toMatch(/token|externalSubject|inputHmac|comparisonReference|Source entry/u);
  });

  test('same source/event/body replays true without a second effect; different body conflicts', async () => {
    const h = await use();
    const first = await send(h.port, { externalEventId: 'same-http', kind: 'QR_SCANNED', token: 'A' });
    const replay = await send(h.port, { externalEventId: 'same-http', kind: 'QR_SCANNED', token: 'A' });
    const conflict = await send(h.port, { externalEventId: 'same-http', kind: 'FACE_UNKNOWN' });
    expect(first).toMatchObject({ status: 200, body: { replayed: false } });
    expect(replay).toMatchObject({ status: 200, body: { replayed: true, eventId: EVENT_ID } });
    expect(conflict).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(h.persistence.calls).toBe(1);
  });

  test('same external ID belongs to each authenticated Source independently', async () => {
    const h = await use();
    const entry = await send(h.port, { externalEventId: 'cross-source', kind: 'FACE_UNKNOWN' }, ENTRY_AUTH);
    const exit = await send(h.port, { externalEventId: 'cross-source', kind: 'FACE_UNKNOWN' }, EXIT_AUTH);
    expect(entry).toMatchObject({ status: 200, body: { sourceId: ENTRY_ID, direction: 'ENTRY', replayed: false } });
    expect(exit).toMatchObject({ status: 200, body: { sourceId: EXIT_ID, direction: 'EXIT', replayed: false } });
    expect(h.persistence.calls).toBe(2);
  });

  test('existing-only absent, invalid Source auth, and DTO extras never invoke persistence', async () => {
    const h = await use();
    const absent = await send(h.port, { externalEventId: 'absent', kind: 'FACE_UNKNOWN' }, ENTRY_AUTH, { 'PassHub-Retry-Mode': 'existing-only' });
    const auth = await send(h.port, { externalEventId: 'auth', kind: 'FACE_UNKNOWN' }, 'Bearer operator');
    const extra = await send(h.port, { externalEventId: 'extra', kind: 'FACE_UNKNOWN', direction: 'ENTRY' });
    expect(absent).toMatchObject({ status: 503, body: { code: 'REQUEST_STATUS_UNCONFIRMED' } });
    expect(auth).toMatchObject({ status: 401, body: { code: 'AUTHENTICATION_FAILED' } });
    expect(extra).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect(h.persistence.calls).toBe(0);
  });
});
