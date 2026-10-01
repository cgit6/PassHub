import {
  createOperationBudgetBindingFactory,
  type OperationBudgetBinding,
} from '../../src/access/application/internal/operation-budget-binding.js';
import {
  createWriteOperationCoordinatorBundle,
} from '../../src/access/application/internal/write-operation-coordinator.js';
import {
  createVerifiedComparisonPort,
  verifyStartupVectorsAndCreateComparisonCapability,
} from '../../src/access/application/comparison/index.js';
import { createAccessComposition } from '../../src/composition/access-composition.js';
import {
  createG08aManagementComposition,
  createG08bRecognitionComposition,
  createAdmissionWorkHandoffBundle,
  createHttpResponsePlanBundle,
  createSourceBoundRecognitionExecutorFactory,
} from '../../src/composition/internal/index.js';
import {
  G10bOperationBridgeError,
  bindG10bOperationBudget,
  readG10bOperationBudgetForScopedPersistence,
  registerG10bAdmissionWorkContext,
  type G10bOperationBridgeErrorCode,
} from '../../src/composition/internal/g10b-operation-bridge.js';
import { createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import { createSourceAuth } from '../../src/auth/application/source-auth.js';
import { HumanPrincipal, type HumanRole } from '../../src/auth/domain/index.js';
import type { HumanAuthCapability } from '../../src/auth/application/index.js';
import type {
  AccessQueryPort,
  AccessScopeContext,
  ManagementDataPort,
  RecognitionDataPort,
  RecognitionPersistenceResult,
  SourceFactsPort,
} from '../../src/access/ports/index.js';
import type { AdmissionWorkContext } from '../../src/composition/internal/g07b-admission-handler.js';
import {
  FIXED_COMPARISON_REFERENCE_ID,
  FIXED_STARTUP_VECTORS,
  FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const QUALIFICATION_INCARNATION = '66666666-6666-4666-8666-666666666666';
const AUTHORIZATION = `Source entry.${'A'.repeat(43)}`;
const RECEIVED_AT = 1_800_000_000_000;

interface LiveBudget {
  readonly admission: AdmissionWorkContext;
  readonly binding: OperationBudgetBinding;
  close(): Promise<void>;
}

function liveBudget(): Promise<LiveBudget> {
  let resolveReady!: (value: LiveBudget) => void;
  const ready = new Promise<LiveBudget>((resolve) => { resolveReady = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const bundle = createWriteOperationCoordinatorBundle({
    clock: { nowMs: () => RECEIVED_AT },
    executors: {
      managementCreate: async (_input, write, settlement) => {
        const admission = Object.freeze({
          operationId: write.operationId,
          receivedAtMs: write.receivedAtMs,
          sequence: write.sequence,
          runtimeIdentity: null,
        });
        registerG10bAdmissionWorkContext(admission, write);
        const binding = createOperationBudgetBindingFactory({
          clock: { nowMs: () => RECEIVED_AT }, assertContinuationEvidence: () => undefined,
        }).bind(write);
        resolveReady({ admission, binding, close: async () => { release(); await running; } });
        await released;
        settlement.businessResultPersisted('complete');
      },
      managementUpdate: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
      managementRevoke: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
      recognition: (_input, _context, settlement) => settlement.businessResultPersisted('unused'),
    },
  });
  const running = bundle.managementCreate.enqueue(undefined);
  return ready;
}

class OperatorAuth implements HumanAuthCapability {
  readonly operator = new HumanPrincipal();
  login(): Promise<{ accessToken: string }> { return Promise.resolve({ accessToken: 'unused' }); }
  verifyAccessToken(token: string): Promise<HumanPrincipal> {
    return token === 'operator' ? Promise.resolve(this.operator) : Promise.reject(new Error('invalid'));
  }
  facts(principal: HumanPrincipal): { userId: string; role: HumanRole } {
    if (principal !== this.operator) throw new Error('invalid');
    return { userId: ACTOR_ID, role: 'OPERATOR' };
  }
  assertRole(principal: HumanPrincipal, role: HumanRole): void {
    if (principal !== this.operator || role !== 'OPERATOR') throw new Error('forbidden');
  }
}

function managementResult() {
  return Object.freeze({
    operation: 'CREATE' as const,
    qualificationId: OPERATION_ID,
    incarnation: QUALIFICATION_INCARNATION,
    version: 1,
    summary: Object.freeze({
      qualificationId: OPERATION_ID, displayName: 'Ada', validFromMs: RECEIVED_AT - 1,
      validUntilMs: RECEIVED_AT + 1, presence: 'NOT_ENTERED' as const,
      revokedAtMs: null, revocationReason: null, expiredTerminalAtMs: null,
      faceBound: false, createdAtMs: RECEIVED_AT, updatedAtMs: RECEIVED_AT,
    }),
    qrToken: 'q'.repeat(43),
  });
}

function managementQualification() {
  return Object.freeze({
    qualificationId: OPERATION_ID,
    incarnation: QUALIFICATION_INCARNATION,
    version: 1,
    displayName: 'Ada',
    createdAtMs: RECEIVED_AT,
    updatedAtMs: RECEIVED_AT,
    state: Object.freeze({
      validFromMs: RECEIVED_AT - 1,
      validUntilMs: RECEIVED_AT + 1,
      presence: 'NOT_ENTERED' as const,
      enteredAtMs: null,
      exitedAtMs: null,
      revokedAtMs: null,
      revocationReason: null,
      expiredTerminalAtMs: null,
    }),
  });
}

function expectBridgeCode(work: () => unknown, code: G10bOperationBridgeErrorCode): void {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(G10bOperationBridgeError);
    expect((error as G10bOperationBridgeError).code).toBe(code);
    return;
  }
  throw new Error(`expected G10bOperationBridgeError ${code}`);
}

describe('G10b G08 first scoped persistence association', () => {
  test.each([
    ['QUALIFICATION_UPDATE', { displayName: 'Ada Lovelace' }, 'UPDATE'],
    ['QUALIFICATION_REVOKE', { reason: 'withdrawn' }, 'REVOKE'],
  ] as const)('bound G08 %s resolves its exact ORIGINAL binding in readQualification before continuing', async (routeId, body, operation) => {
    const calls: string[] = [];
    let observedBinding: OperationBudgetBinding | undefined;
    let admission: AdmissionWorkContext | undefined;
    const management: ManagementDataPort = Object.freeze({
      readQualification: async (context: AccessScopeContext) => {
        calls.push('readQualification');
        if (admission === undefined) throw new Error('expected bound admission before qualification read');
        observedBinding = readG10bOperationBudgetForScopedPersistence(admission, context);
        return managementQualification();
      },
      readMapping: async () => {
        calls.push('readMapping');
        return null;
      },
      stageManagementChange: async () => {
        calls.push('stageManagementChange');
        return Object.freeze({ ...managementResult(), operation, qrToken: null });
      },
    });
    const query: AccessQueryPort = Object.freeze({
      qualifications: async () => [], inside: async () => [], events: async () => [],
    });
    const access = createAccessComposition({ management, query, epoch: EPOCH });
    const handoff = createAdmissionWorkHandoffBundle();
    const composition = createG08aManagementComposition({
      auth: new OperatorAuth(), manageQualifications: access.manageQualifications,
      responsePlans: createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH }), workHandoff: handoff,
    });
    const validation = await composition.validator.validate({
      routeId, retryMode: 'NORMAL', parameters: { id: OPERATION_ID },
      accepted: { method: routeId === 'QUALIFICATION_UPDATE' ? 'PATCH' : 'POST', query: [], headers: { authorization: 'Bearer operator', datasetEpoch: EPOCH }, body },
    });
    if (validation.kind !== 'MANAGEMENT') throw new Error('expected management work');
    const live = await liveBudget();
    try {
      bindG10bOperationBudget(live.admission, live.binding);
      admission = live.admission;
      const outcome = await composition.work.management(validation.workInput, live.admission);
      expect(calls).toEqual(routeId === 'QUALIFICATION_UPDATE'
        ? ['readQualification', 'readMapping', 'stageManagementChange']
        : ['readQualification', 'stageManagementChange']);
      expect(outcome.disposition).toBe('BUSINESS_RESULT_PERSISTED');
      expect(observedBinding).toBe(live.binding);
    } finally {
      await live.close();
    }
  });

  test('unbound G08 UPDATE work preserves its normal management port calls without associating its live admission', async () => {
    const calls: string[] = [];
    let admission: AdmissionWorkContext | undefined;
    const management: ManagementDataPort = Object.freeze({
      readQualification: async (context: AccessScopeContext) => {
        calls.push('readQualification');
        if (admission === undefined) throw new Error('expected live admission');
        expectBridgeCode(
          () => readG10bOperationBudgetForScopedPersistence(admission!, context),
          'ADMISSION_NOT_BOUND',
        );
        return managementQualification();
      },
      readMapping: async () => { calls.push('readMapping'); return null; },
      stageManagementChange: async () => { calls.push('stageManagementChange'); return Object.freeze({ ...managementResult(), operation: 'UPDATE' as const, qrToken: null }); },
    });
    const access = createAccessComposition({
      management,
      query: Object.freeze({ qualifications: async () => [], inside: async () => [], events: async () => [] }),
      epoch: EPOCH,
    });
    const composition = createG08aManagementComposition({
      auth: new OperatorAuth(), manageQualifications: access.manageQualifications,
      responsePlans: createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH }), workHandoff: createAdmissionWorkHandoffBundle(),
    });
    const validation = await composition.validator.validate({
      routeId: 'QUALIFICATION_UPDATE', retryMode: 'NORMAL', parameters: { id: OPERATION_ID },
      accepted: { method: 'PATCH', query: [], headers: { authorization: 'Bearer operator', datasetEpoch: EPOCH }, body: { displayName: 'Ada Lovelace' } },
    });
    if (validation.kind !== 'MANAGEMENT') throw new Error('expected management work');
    const live = await liveBudget();
    try {
      admission = live.admission;
      const outcome = await composition.work.management(validation.workInput, live.admission);
      expect(calls).toEqual(['readQualification', 'readMapping', 'stageManagementChange']);
      expect(outcome.disposition).toBe('BUSINESS_RESULT_PERSISTED');
    } finally {
      await live.close();
    }
  });

  test.each([
    ['bound G08 recognition work resolves its exact ORIGINAL binding at source facts before persistence', true],
    ['unbound G08 recognition work preserves source-facts and persistence ports without a scope association', false],
  ] as const)('%s', async (_title, bindBudget) => {
    const contexts: object[] = [];
    let observedBinding: OperationBudgetBinding | undefined;
    let admission: AdmissionWorkContext | undefined;
    const persistence: RecognitionDataPort & SourceFactsPort = Object.freeze({
      read: async (context: AccessScopeContext) => {
        contexts.push(context);
        if (admission !== undefined) {
          if (bindBudget) {
            observedBinding = readG10bOperationBudgetForScopedPersistence(admission, context);
          } else {
            expectBridgeCode(
              () => readG10bOperationBudgetForScopedPersistence(admission!, context),
              'ADMISSION_NOT_BOUND',
            );
          }
        }
        return Object.freeze({ sourceId: SOURCE_ID, direction: 'ENTRY' as const, active: true });
      },
      readQualification: async () => null,
      readMapping: async () => null,
      resolveQr: async () => Object.freeze({ qualification: null, mapping: null }),
      resolveFace: async () => Object.freeze({ qualification: null, mapping: null }),
      stageRecognitionResult: async (context: AccessScopeContext): Promise<RecognitionPersistenceResult> => {
        contexts.push(context);
        return Object.freeze({
          status: 'COMMITTED' as const, replayed: false,
          event: Object.freeze({
            eventId: EVENT_ID, sourceId: SOURCE_ID, direction: 'ENTRY' as const, kind: 'FACE_UNKNOWN' as const,
            outcome: 'REJECTED' as const, reasonCode: 'FACE_UNKNOWN' as const, receivedAtMs: RECEIVED_AT,
            recordedAtMs: RECEIVED_AT + 1, qualificationId: null, presenceTransition: null,
          }),
        });
      },
    });
    const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
      hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS,
    }));
    const sourceAuth = createSourceAuth({ credentialVerifier: { verify: async () => Object.freeze({ sourceId: SOURCE_ID }) } });
    const registryCapabilities = createOperationRegistryCapabilityIssuer({
      registryId: 'g10b-g08-scope', datasetEpoch: EPOCH, processRunId: 'run', ownerId: 'owner', sameArtifact: () => true,
    });
    const composition = createG08bRecognitionComposition({
      sourceAuth, comparison, registryCapabilities,
      recognizeAttempt: createSourceBoundRecognitionExecutorFactory({ recognition: persistence, sourceFacts: persistence, epoch: EPOCH, comparison }),
      responsePlans: createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH }), workHandoff: createAdmissionWorkHandoffBundle(),
    });
    const validation = await composition.validator.validate({
      routeId: 'RECOGNITION_ATTEMPT', retryMode: 'NORMAL', parameters: {},
      accepted: { method: 'POST', query: [], headers: { authorization: AUTHORIZATION, datasetEpoch: EPOCH }, body: { externalEventId: 'event-1', kind: 'FACE_UNKNOWN' } },
    });
    if (validation.kind !== 'RECOGNITION') throw new Error('expected recognition work');
    const live = await liveBudget();
    try {
      if (bindBudget) bindG10bOperationBudget(live.admission, live.binding);
      admission = live.admission;
      const outcome = await composition.work.recognition(validation.workInput, live.admission);
      expect(outcome.disposition).toBe('BUSINESS_RESULT_PERSISTED');
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toBe(contexts[1]);
      if (bindBudget) expect(observedBinding).toBe(live.binding);
      else expect(observedBinding).toBeUndefined();
    } finally {
      await live.close();
    }
  });

  test('read-only access delegates directly to its query port without management persistence', async () => {
    let queryCalls = 0;
    let managementCalls = 0;
    const access = createAccessComposition({
      management: Object.freeze({
        readQualification: async () => { managementCalls += 1; return null; },
        readMapping: async () => { managementCalls += 1; return null; },
        stageManagementChange: async () => { managementCalls += 1; return managementResult(); },
      }) satisfies ManagementDataPort,
      query: Object.freeze({
        qualifications: async () => { queryCalls += 1; return []; }, inside: async () => [], events: async () => [],
      }) satisfies AccessQueryPort,
      epoch: EPOCH,
    });
    await access.readAccessData.qualifications({ limit: 1 });
    expect(queryCalls).toBe(1);
    expect(managementCalls).toBe(0);
  });
});
