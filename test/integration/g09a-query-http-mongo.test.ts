import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { MongoClient } from 'mongodb';

import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import { HumanAuthError, HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import {
  G04B_EVENTS_COLLECTION,
  G04B_QUALIFICATIONS_COLLECTION,
  G04bMongoPersistenceAdapter,
  createG04bFixture,
  type G04bEventDocument,
  type G04bQualificationDocument,
} from '../../src/infrastructure/mongo/index.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bAdmissionHandler,
  createG07bRouteComposition,
  createG09aQueryComposition,
  createHttpResponsePlanBundle,
  createPassHubHttpApplication,
  createQueryApplication,
  createQueryCursorCodec,
  createUnknownRecognitionCoordinatorBundle,
  createWriterQuiescence,
  type AdmissionValidationResult,
  type PassHubHttpApplication,
} from '../../src/composition/internal/index.js';

const uri = process.env.G09A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G09A_MONGO_DATABASE_PREFIX ?? `passhub_g09a_http_${process.pid}`;
const EPOCH = '11111111-1111-4111-8111-111111111111';
const OLD_EPOCH = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-09-28T12:00:00.000Z');

interface HttpResult { readonly status: number; readonly body: Record<string, unknown>; }
function send(port: number, path: string, token: 'operator' | 'viewer' = 'operator'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method: 'GET', path, agent: false,
      headers: { Authorization: `Bearer ${token}` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

class MongoHttpAuth implements HumanAuthCapability {
  private readonly operator = new HumanPrincipal();
  private readonly viewer = new HumanPrincipal();
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

describe('G09a true HTTP plus MongoDB query composition', () => {
  let client: MongoClient;
  let app: PassHubHttpApplication;
  let port: number;
  let databaseName: string;
  let qualificationId: string;
  let secondQualificationId: string;
  let acceptedEventId: string;
  let rejectedEventId: string;

  beforeAll(async () => {
    client = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    await client.connect();
    const buildInfo = await client.db('admin').command({ buildInfo: 1 });
    const hello = await client.db('admin').command({ hello: 1 });
    expect(buildInfo.version).toBe('8.0.32');
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });

    databaseName = `${databasePrefix}_routes`.slice(0, 63);
    const fixture = createG04bFixture(NOW);
    qualificationId = fixture.qualificationId;
    secondQualificationId = randomUUID();
    acceptedEventId = randomUUID();
    rejectedEventId = randomUUID();
    const adapter = new G04bMongoPersistenceAdapter(client, databaseName, { nowMs: () => NOW });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    const database = client.db(databaseName);
    const base = fixture.qualifications[0]!;
    const second: G04bQualificationDocument = {
      ...base,
      _id: secondQualificationId,
      incarnation: randomUUID(),
      displayName: 'Second safe qualification',
      qrLookupDigest: 'b'.repeat(64),
      createdAt: new Date(base.createdAt.getTime() - 1),
      updatedAt: new Date(base.updatedAt.getTime() - 1),
    };
    await database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).insertOne(second);
    const accepted: G04bEventDocument = {
      _id: acceptedEventId,
      sourceId: fixture.sourceEntryId,
      externalEventId: 'external-accepted-secret',
      kind: 'QR_SCANNED',
      direction: 'ENTRY',
      outcome: 'ACCEPTED',
      reasonCode: 'ENTRY_GRANTED',
      receivedAt: new Date(NOW - 2),
      recordedAt: new Date(NOW - 1),
      qualificationId,
      presenceTransition: { from: 'NOT_ENTERED', to: 'INSIDE' },
      inputHmac: 'c'.repeat(64),
      comparisonReferenceId: fixture.comparisonReferenceId,
    };
    const rejected: G04bEventDocument = {
      ...accepted,
      _id: rejectedEventId,
      externalEventId: 'external-rejected-secret',
      kind: 'FACE_UNKNOWN',
      outcome: 'REJECTED',
      reasonCode: 'FACE_UNKNOWN',
      receivedAt: new Date(NOW - 1),
      qualificationId: null,
      presenceTransition: null,
      inputHmac: 'd'.repeat(64),
    };
    await database.collection<G04bEventDocument>(G04B_EVENTS_COLLECTION).insertMany([accepted, rejected]);

    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const handoff = createAdmissionWorkHandoffBundle();
    const q = createWriterQuiescence({ clock: { nowMs: () => NOW } });
    const queryApplication = createQueryApplication({ data: adapter, writerQuiescence: q, epoch: EPOCH });
    const query = createG09aQueryComposition({
      currentDatasetEpoch: EPOCH,
      auth: new MongoHttpAuth(),
      queryApplication,
      responsePlans: plans,
      workHandoff: handoff,
      writerQuiescence: q,
    });
    const invalid = (): Promise<AdmissionValidationResult> => Promise.resolve(Object.freeze({
      kind: 'REJECTED', response: plans.technical.issue('INVALID_REQUEST'),
    }));
    const routes = createG07bRouteComposition({
      login: { validate: invalid, login: () => Promise.resolve(plans.technical.issue('INVALID_REQUEST')) },
      query,
      management: { validate: invalid, management: () => Promise.reject(new Error('unused')) },
      recognition: { validate: invalid, recognition: () => Promise.reject(new Error('unused')) },
    });
    const capabilities = createOperationRegistryCapabilityIssuer({
      registryId: 'g09a-http-mongo', datasetEpoch: EPOCH, processRunId: 'run', ownerId: 'owner', sameArtifact: () => true,
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
    app = await createPassHubHttpApplication(handler);
    await app.nestApplication.listen(0, '127.0.0.1');
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('HTTP port unavailable');
    port = address.port;
  });

  afterAll(async () => {
    if (app !== undefined) await app.nestApplication.close();
    if (client !== undefined) {
      if (databaseName !== undefined) await client.db(databaseName).dropDatabase();
      await client.close();
    }
  });

  test('all five routes serve exact safe shapes and both roles see the same data', async () => {
    const requests = [
      ['/qualifications', 'operator'],
      ['/qualifications/inside', 'viewer'],
      [`/qualifications/${qualificationId}`, 'viewer'],
      ['/events', 'operator'],
      [`/events/${acceptedEventId}`, 'viewer'],
    ] as const;
    const results: HttpResult[] = [];
    for (const [path, role] of requests) results.push(await send(port, path, role));
    expect(results.map((result) => ({ status: result.status, code: result.body.code }))).toEqual([
      { status: 200, code: undefined },
      { status: 200, code: undefined },
      { status: 200, code: undefined },
      { status: 200, code: undefined },
      { status: 200, code: undefined },
    ]);
    expect(results.map((result) => result.body.currentDatasetEpoch)).toEqual(Array(5).fill(EPOCH));
    expect(Object.keys(results[0]!.body).sort()).toEqual(['currentDatasetEpoch', 'items', 'nextCursor']);
    expect(Object.keys(results[2]!.body).sort()).toEqual([
      'createdAt', 'currentDatasetEpoch', 'displayName', 'expired', 'expiredTerminalAt', 'faceBound', 'presence',
      'qualificationId', 'revocationReason', 'revokedAt', 'updatedAt', 'validFrom', 'validUntil',
    ]);
    expect(Object.keys(results[4]!.body).sort()).toEqual([
      'currentDatasetEpoch', 'direction', 'eventId', 'kind', 'outcome', 'presenceTransition',
      'qualificationId', 'reasonCode', 'receivedAt', 'recordedAt', 'sourceId',
    ]);
    expect(JSON.stringify(results)).not.toMatch(/externalEventId|inputHmac|comparisonReference|qrLookupDigest|subject|secret/u);
  });

  test('qualification keyset continuation and event filters have no duplicate or filter leakage', async () => {
    const first = await send(port, '/qualifications?limit=1');
    const cursor = first.body.nextCursor;
    expect(typeof cursor).toBe('string');
    const second = await send(port, `/qualifications?limit=1&cursor=${String(cursor)}`);
    const ids = [...first.body.items as Array<{ qualificationId: string }>, ...second.body.items as Array<{ qualificationId: string }>]
      .map((item) => item.qualificationId);
    expect(new Set(ids)).toEqual(new Set([qualificationId, secondQualificationId]));
    expect(ids).toHaveLength(2);

    const filtered = await send(port, '/events?outcome=REJECTED&reasonCode=FACE_UNKNOWN');
    expect(filtered.body.items).toEqual([
      expect.objectContaining({ eventId: rejectedEventId, qualificationId: null, outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN' }),
    ]);
  });

  test('detail missing, malformed cursor, old epoch, and route/filter mismatch classify exactly', async () => {
    expect(await send(port, `/events/${randomUUID()}`)).toMatchObject({ status: 404, body: { code: 'RESOURCE_NOT_FOUND' } });
    expect(await send(port, '/qualifications?cursor=bad')).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    const after = Object.freeze({ lastTimeMs: NOW, lastId: qualificationId });
    const empty = Object.freeze({ qualificationId: null, outcome: null, reasonCode: null });
    const old = createQueryCursorCodec().encode(OLD_EPOCH, 'qualifications', empty, after);
    expect(await send(port, `/qualifications?cursor=${old}`)).toMatchObject({ status: 409, body: { code: 'DATASET_EPOCH_MISMATCH' } });
    const filtered = Object.freeze({ qualificationId, outcome: 'ACCEPTED' as const, reasonCode: 'ENTRY_GRANTED' as const });
    const scoped = createQueryCursorCodec().encode(EPOCH, 'events', filtered, after);
    expect(await send(port, `/events?cursor=${scoped}`)).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
  });
});
