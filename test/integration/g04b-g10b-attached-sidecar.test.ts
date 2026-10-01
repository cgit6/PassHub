import { EventEmitter } from 'node:events';

import { jest } from '@jest/globals';
import {
  MongoClient,
  type CommandStartedEvent,
  type MongoClientOptions,
} from 'mongodb';

import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import { createAccessComposition } from '../../src/composition/access-composition.js';
import {
  createAdmissionWorkHandoffBundle,
  createG07bRouteComposition,
  createG08aManagementComposition,
  createHttpResponsePlanBundle,
  createUnknownRecognitionCoordinatorBundle,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWorkContext,
  type HttpResponsePlan,
  type NarrowHttpResponse,
} from '../../src/composition/internal/index.js';
import { createG07bAdmissionHandler } from '../../src/composition/internal/g07b-admission-handler.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import {
  createG10bOperationBudgetBindingFactory,
  readG10bOperationBudgetForScopedPersistence,
  type G10bOperationBudgetBindingFactory,
} from '../../src/composition/internal/g10b-operation-bridge.js';
import { attachG10bG04bPersistenceSidecar } from '../../src/composition/internal/g10b-g04b-persistence-wire.js';
import { observeG10bScopedPersistenceBindingCapture } from '../../src/infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.js';
import type { OperationBudgetBinding } from '../../src/access/application/internal/operation-budget-binding.js';
import type { WriteOperationContext } from '../../src/access/application/internal/write-operation-coordinator.js';
import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import { HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type { AccessScopeContext } from '../../src/access/ports/index.js';
import {
  G04B_QUALIFICATIONS_COLLECTION,
  G04bMongoPersistenceAdapter,
  createG04bFixture,
  type G04bQualificationDocument,
} from '../../src/infrastructure/mongo/index.js';

const uri = process.env.G04B_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G04B_MONGO_DATABASE_PREFIX ?? `passhub_g04b_g10b_${process.pid}`;
const NOW = 1_800_000_000_000;
const RUN = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

class OperatorAuth implements HumanAuthCapability {
  readonly operator = new HumanPrincipal();

  login(): Promise<{ accessToken: string }> { return Promise.resolve({ accessToken: 'unused' }); }
  verifyAccessToken(token: string): Promise<HumanPrincipal> {
    return token === 'operator' ? Promise.resolve(this.operator) : Promise.reject(new Error('invalid token'));
  }
  facts(principal: HumanPrincipal): { userId: string; role: HumanRole } {
    if (principal !== this.operator) throw new Error('invalid principal');
    return { userId: ACTOR, role: 'OPERATOR' };
  }
  assertRole(principal: HumanPrincipal, role: HumanRole): void {
    if (principal !== this.operator || role !== 'OPERATOR') throw new Error('forbidden');
  }
}

class FakeResponse extends EventEmitter implements NarrowHttpResponse {
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  body = '';

  setHeader(): void { /* response headers are not evidence for this test */ }
  end(body: string): void {
    this.body = body;
    this.writableEnded = true;
    this.emit('finish');
  }
}

describe('G10b attached G04b sidecar on MongoDB 8.0.32', () => {
  let client: MongoClient;
  const databases: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(uri, {
      monitorCommands: true,
      retryReads: false,
      retryWrites: false,
      maxAdaptiveRetries: 0,
    } satisfies MongoClientOptions);
    await client.connect();
    const [buildInfo, hello] = await Promise.all([
      client.db('admin').command({ buildInfo: 1 }),
      client.db('admin').command({ hello: 1 }),
    ]);
    expect(buildInfo.version).toBe('8.0.32');
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });

  afterEach(async () => {
    const databaseName = databases.pop();
    if (databaseName !== undefined) await client.db(databaseName).dropDatabase();
  });

  afterAll(async () => { await client.close(); });

  test('G07/G08 composition lets G04b capture the exact resolved binding before real Mongo session allocation, then commit', async () => {
    const databaseName = `${databasePrefix}_attached_${databases.length}`.slice(0, 63);
    databases.push(databaseName);
    const fixture = createG04bFixture(NOW);
    const adapter = new G04bMongoPersistenceAdapter(client, databaseName, { nowMs: () => NOW });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    attachG10bG04bPersistenceSidecar(adapter);

    const timeline: string[] = [];
    let admission: AdmissionWorkContext | undefined;
    let binding: OperationBudgetBinding | undefined;
    let scopedBinding: OperationBudgetBinding | undefined;
    let capturedBinding: OperationBudgetBinding | undefined;
    const actualBindingFactory = createG10bOperationBudgetBindingFactory({
      clock: { nowMs: () => NOW },
      assertContinuationEvidence: () => undefined,
    });
    const bindingFactory: G10bOperationBudgetBindingFactory = Object.freeze({
      bind(write: WriteOperationContext, createdAdmission: AdmissionWorkContext): OperationBudgetBinding {
        const created = actualBindingFactory.bind(write, createdAdmission);
        admission = createdAdmission;
        binding = created;
        timeline.push('g07-binding');
        return created;
      },
    });

    const scopedAdapter = adapter as unknown as Pick<
      import('../../src/access/ports/index.js').ManagementDataPort,
      'readQualification'
    >;
    const originalReadQualification = scopedAdapter.readQualification.bind(scopedAdapter);
    const readQualification = jest.spyOn(scopedAdapter, 'readQualification').mockImplementation(async (
      context: AccessScopeContext,
      qualificationId: string,
    ) => {
      if (admission === undefined) throw new Error('G07 admission context was not created');
      scopedBinding = readG10bOperationBudgetForScopedPersistence(admission, context);
      timeline.push('g08-scope-resolver-seam');
      return originalReadQualification(context, qualificationId);
    });
    const removeCaptureObservation = observeG10bScopedPersistenceBindingCapture(adapter, (captured) => {
      capturedBinding = captured as OperationBudgetBinding;
      timeline.push('g04b-binding-captured');
    });
    const originalStartSession = client.startSession.bind(client);
    const startSession = jest.spyOn(client, 'startSession').mockImplementation((options) => {
      timeline.push('mongo-startSession');
      expect(scopedBinding).toBe(binding);
      return originalStartSession(options);
    });
    const started = (event: CommandStartedEvent): void => {
      if (!timeline.some((entry) => entry.startsWith('mongo-command:'))) {
        timeline.push(`mongo-command:${event.commandName}`);
      }
    };
    client.on('commandStarted', started);

    try {
      const responsePlans = createHttpResponsePlanBundle({ currentDatasetEpoch: fixture.datasetEpoch });
      const workHandoff = createAdmissionWorkHandoffBundle();
      const access = createAccessComposition({ management: adapter, query: adapter, epoch: fixture.datasetEpoch });
      const g08a = createG08aManagementComposition({
        auth: new OperatorAuth(),
        manageQualifications: access.manageQualifications,
        responsePlans,
        workHandoff,
      });
      const capabilities = createOperationRegistryCapabilityIssuer({
        registryId: 'g10b-g04b-attached', datasetEpoch: fixture.datasetEpoch,
        processRunId: RUN, ownerId: OWNER, sameArtifact: () => true,
      });
      const registry = createOperationRegistry({
        capabilities,
        writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
        assertOwnerCurrent: () => undefined,
        assertContinuationEvidence: () => undefined,
      });
      const rejected = async (_input: AdmissionValidationInput): Promise<AdmissionValidationResult> =>
        Object.freeze({ kind: 'REJECTED', response: responsePlans.technical.issue('INVALID_REQUEST') });
      const fallback = (): Promise<HttpResponsePlan> => Promise.resolve(responsePlans.technical.issue('INVALID_REQUEST'));
      const query = createLegacyQueryAdmissionCapability({ validate: rejected, query: fallback });
      const login = Object.freeze({ validate: rejected, login: fallback });
      const recognition = Object.freeze({
        validate: rejected,
        recognition: async () => Object.freeze({ disposition: 'KNOWN_NO_EFFECT' as const, response: await fallback() }),
      });
      const management = Object.freeze({ validate: g08a.validator.validate, management: g08a.work.management });
      const routes = createG07bRouteComposition({ login, query, management, recognition });
      const handler = createG07bAdmissionHandler({
        currentDatasetEpoch: fixture.datasetEpoch,
        registry,
        registryCapabilities: capabilities,
        responsePlans,
        workHandoff,
        unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
        validator: routes.validator,
        work: routes.work,
        operationBudgetBindingFactory: bindingFactory,
      });

      const response = new FakeResponse();
      const finished = new Promise<void>((resolve) => { response.once('finish', resolve); });
      handler(Object.freeze({
        method: 'PATCH',
        body: { displayName: 'G10b attached sidecar commit' },
        query: [],
        headers: { authorization: 'Bearer operator', datasetEpoch: fixture.datasetEpoch },
      }), {
        originalUrl: `/qualifications/${fixture.qualificationId}`,
        url: `/qualifications/${fixture.qualificationId}`,
        socket: { remoteAddress: '127.0.0.1' },
      } as never, response as never, (() => undefined) as never);
      await finished;

      expect(response.statusCode).toBe(200);
      expect(binding).toBeDefined();
      expect(scopedBinding).toBe(binding);
      expect(capturedBinding).toBe(binding);
      expect(startSession).toHaveBeenCalledTimes(1);
      const seamIndex = timeline.indexOf('g08-scope-resolver-seam');
      const captureIndex = timeline.indexOf('g04b-binding-captured');
      const sessionIndex = timeline.indexOf('mongo-startSession');
      const commandIndex = timeline.findIndex((entry) => entry.startsWith('mongo-command:'));
      expect(seamIndex).toBeGreaterThanOrEqual(0);
      expect(captureIndex).toBeGreaterThan(seamIndex);
      expect(sessionIndex).toBeGreaterThan(captureIndex);
      expect(commandIndex).toBeGreaterThan(sessionIndex);
      expect(await client.db(databaseName).collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION)
        .findOne({ _id: fixture.qualificationId }))
        .toMatchObject({ displayName: 'G10b attached sidecar commit', version: 1 });
    } finally {
      client.off('commandStarted', started);
      startSession.mockRestore();
      readQualification.mockRestore();
      removeCaptureObservation();
    }
  });
});
