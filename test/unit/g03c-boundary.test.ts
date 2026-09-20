import * as publicApi from '../../src/index.js';
import * as publicApplicationApi from '../../src/access/application/index.js';
import {
  ManagementAccessScope,
  RecognitionAccessScope,
} from '../../src/access/application/access-scopes.js';
import {
  createManagementChangePlan,
  createRecognitionResultPlan,
} from '../../src/access/application/internal-plans.js';
import { decideAccess, type AccessDecision } from '../../src/access/domain/index.js';
import {
  createVerifiedComparisonPort,
  verifyStartupVectorsAndCreateComparisonCapability,
} from '../../src/access/application/comparison/index.js';
import {
  FIXED_COMPARISON_REFERENCE_ID,
  FIXED_STARTUP_VECTORS,
  FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';
import { createAccessComposition } from '../../src/composition/access-composition.js';
import type {
  AccessQueryPort,
  FaceMappingSnapshot,
  ManagementChangeResult,
  ManagementDataPort,
  QualificationSnapshot,
  RecognitionDataPort,
  RecognitionPersistenceResult,
  SourceFacts,
  SourceFactsPort,
  ResolvedIdentitySnapshot,
} from '../../src/access/ports/index.js';
import type { ResolutionHandle } from '../../src/access/application/resolution-handle.js';

const TEST_COMPARISON = createVerifiedComparisonPort(
  verifyStartupVectorsAndCreateComparisonCapability({
    hmacKey: FIXED_TEST_HMAC_KEY,
    comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
    vectors: FIXED_STARTUP_VECTORS,
  }),
);

const QUALIFICATION: QualificationSnapshot = {
  qualificationId: 'q-1',
  incarnation: 'q-inc-1',
  version: 1,
  state: {
    validFromMs: 1_000,
    validUntilMs: 2_000,
    presence: 'NOT_ENTERED',
    enteredAtMs: null,
    exitedAtMs: null,
    revokedAtMs: null,
    revocationReason: null,
    expiredTerminalAtMs: null,
  },
};

const MAPPING: FaceMappingSnapshot = {
  qualificationId: 'q-1',
  qualificationIncarnation: 'q-inc-1',
  mappingIncarnation: 'map-inc-1',
  version: 1,
};

function entryDecision(): AccessDecision {
  return decideAccess({
    direction: 'ENTRY',
    sourceActive: true,
    resolution: { kind: 'RESOLVED', qualification: QUALIFICATION.state },
    receivedAtMs: 1_000,
  });
}

function unknownDecision(): AccessDecision {
  return decideAccess({
    direction: 'ENTRY',
    sourceActive: true,
    resolution: { kind: 'FACE_UNKNOWN' },
    receivedAtMs: 1_000,
  });
}

class FakeManagementPort implements ManagementDataPort {
  public readonly calls: string[] = [];
  public staged: unknown[] = [];

  public async readQualification(): Promise<QualificationSnapshot | null> {
    this.calls.push('readQualification');
    return QUALIFICATION;
  }

  public async readMapping(): Promise<FaceMappingSnapshot | null> {
    this.calls.push('readMapping');
    return MAPPING;
  }

  public async stageManagementChange(
    _context: Parameters<ManagementDataPort['stageManagementChange']>[0],
    plan: Parameters<ManagementDataPort['stageManagementChange']>[1],
  ): Promise<ManagementChangeResult> {
    this.calls.push('stageManagementChange');
    this.staged.push(plan);
    return {
      operation: plan.operation,
      qualificationId: plan.qualificationId ?? 'q-fake',
      incarnation: 'inc-fake',
      version: 0,
      summary: {
        qualificationId: plan.qualificationId ?? 'q-fake',
        displayName: plan.displayName ?? 'fake',
        validFromMs: plan.validFromMs ?? 0,
        validUntilMs: plan.validUntilMs ?? 0,
        presence: 'NOT_ENTERED',
      },
      qrToken: plan.operation === 'CREATE' ? 'fake-token' : null,
    };
  }
}

class FakeSourceFactsPort implements SourceFactsPort {
  public readonly calls: string[] = [];

  public constructor(public active = true, public direction: SourceFacts['direction'] = 'ENTRY') {}

  public async read(
    _context: Parameters<SourceFactsPort['read']>[0],
    sourceId: string,
  ): Promise<SourceFacts> {
    this.calls.push(sourceId);
    return { sourceId, direction: this.direction, active: this.active };
  }
}

class FakeRecognitionPort implements RecognitionDataPort {
  public qualification: QualificationSnapshot | null = QUALIFICATION;
  public mapping: FaceMappingSnapshot | null = MAPPING;
  public readonly calls: string[] = [];
  public readonly contexts: object[] = [];
  public readonly staged: Array<Record<string, unknown>> = [];

  public async readQualification(
    context: Parameters<RecognitionDataPort['readQualification']>[0],
  ): Promise<QualificationSnapshot | null> {
    this.calls.push('readQualification');
    this.contexts.push(context);
    return this.qualification;
  }

  public async readMapping(
    context: Parameters<RecognitionDataPort['readMapping']>[0],
  ): Promise<FaceMappingSnapshot | null> {
    this.calls.push('readMapping');
    this.contexts.push(context);
    return this.mapping;
  }

  public async resolveQr(
    context: Parameters<RecognitionDataPort['resolveQr']>[0],
    _lookupDigest: string,
  ): Promise<ResolvedIdentitySnapshot> {
    this.calls.push('resolveQr');
    this.contexts.push(context);
    return { qualification: this.qualification, mapping: this.mapping };
  }

  public async resolveFace(
    context: Parameters<RecognitionDataPort['resolveFace']>[0],
    _provider: string,
    _externalSubjectId: string,
  ): Promise<ResolvedIdentitySnapshot> {
    this.calls.push('resolveFace');
    this.contexts.push(context);
    return { qualification: this.qualification, mapping: this.mapping };
  }

  public async stageRecognitionResult(
    context: Parameters<RecognitionDataPort['stageRecognitionResult']>[0],
    plan: Parameters<RecognitionDataPort['stageRecognitionResult']>[1],
  ): Promise<RecognitionPersistenceResult> {
    this.calls.push('stageRecognitionResult');
    this.contexts.push(context);
    this.staged.push(plan as unknown as Record<string, unknown>);
    return {
      status: 'COMMITTED',
      eventId: 'event-fake',
      decision: {
        outcome: plan.outcome,
        reasonCode: plan.reasonCode,
        presenceTransition: plan.presenceTransition,
        qualificationEffect: plan.qualificationEffect,
        faceMappingEffect: plan.faceMappingEffect,
      },
    };
  }
}

class FakeQueryPort implements AccessQueryPort {
  public readonly calls: string[] = [];
  public lastInput: unknown;

  public async qualifications(input: Readonly<{ limit: number; cursor?: string }>) {
    this.calls.push('qualifications');
    this.lastInput = input;
    return [{
      qualificationId: 'q-1', displayName: 'Demo', validFromMs: 1,
      validUntilMs: 2, presence: 'NOT_ENTERED' as const, revokedAtMs: null,
      revocationReason: null, expiredTerminalAtMs: null, faceBound: false,
      createdAtMs: 1, updatedAtMs: 1,
    }];
  }

  public async inside(input: Readonly<{ limit: number; cursor?: string }>) {
    this.calls.push('inside');
    this.lastInput = input;
    return [];
  }

  public async events(input: Readonly<{
    limit: number; cursor?: string; qualificationId?: string;
    outcome?: 'ACCEPTED' | 'REJECTED'; reasonCode?: string;
  }>) {
    this.calls.push('events');
    this.lastInput = input;
    return [];
  }
}

function newRecognition(
  persistence: FakeRecognitionPort,
  facts = new FakeSourceFactsPort(),
  options: { epoch: string; scopeId?: string } = { epoch: 'epoch-1' },
): RecognitionAccessScope {
  return new RecognitionAccessScope(persistence, facts, 'source-1', options);
}

async function resolvedQr(
  scope: RecognitionAccessScope,
): Promise<ResolutionHandle> {
  await scope.readSourceFacts();
  return scope.resolveQr('lookup-digest');
}

test('composition exposes three distinct wrappers and keeps write capabilities separated', async () => {
  const management = new FakeManagementPort();
  const recognition = new FakeRecognitionPort();
  const facts = new FakeSourceFactsPort();
  const query = new FakeQueryPort();
  const composition = createAccessComposition({
    management,
    recognition,
    sourceFacts: facts,
    query,
    epoch: 'epoch-1',
    sourceId: 'source-1',
    comparison: TEST_COMPARISON,
  });

  expect(Object.keys(composition).sort()).toEqual([
    'manageQualifications', 'readAccessData', 'recognizeAttempt',
  ]);
  expect(composition.manageQualifications).not.toBe(composition.recognizeAttempt);
  expect(composition.manageQualifications).not.toBe(composition.readAccessData);

  await composition.manageQualifications.create({
    displayName: 'Demo', validFromMs: 1_000, validUntilMs: 2_000,
    faceMapping: null, receivedAtMs: 1_000,
    actorId: '22222222-2222-4222-8222-222222222222',
  });
  await composition.recognizeAttempt.execute({
    input: { kind: 'FACE_UNKNOWN' }, receivedAtMs: 1_000,
    externalEventId: 'unit-composition-face-unknown',
  });
  await composition.readAccessData.qualifications({ limit: 10 });

  expect(management.calls).toEqual(['stageManagementChange']);
  expect(recognition.calls).toEqual(['stageRecognitionResult']);
  expect(facts.calls).toEqual(['source-1']);
  expect(query.calls).toEqual(['qualifications']);
});

test('opaque handles reject fakes, cross-scope owners/contexts, and closed scopes', async () => {
  const port = new FakeRecognitionPort();
  const scopeA = newRecognition(port, new FakeSourceFactsPort(), { epoch: 'epoch-1', scopeId: 'same' });
  const scopeB = newRecognition(port, new FakeSourceFactsPort(), { epoch: 'epoch-1', scopeId: 'same' });
  const handle = await resolvedQr(scopeA);
  await expect(scopeA.readQualification({} as ResolutionHandle)).rejects.toMatchObject({ code: 'INVALID_HANDLE' });
  await expect(scopeB.readQualification(handle)).rejects.toMatchObject({ code: 'HANDLE_SCOPE_MISMATCH' });
  await scopeA.closeAsync();
  await expect(scopeA.readSourceFacts()).rejects.toMatchObject({ code: 'SCOPE_CLOSED' });
});

test('handles and plans reject cross-media and A/B mismatch', async () => {
  const port = new FakeRecognitionPort();
  const scope = newRecognition(port);
  const qrHandle = await resolvedQr(scope);
  const faceHandle = await scope.resolveFace('DemoFace', 'subject-1');
  const facePlan = createRecognitionResultPlan(faceHandle, entryDecision());
  await expect(scope.stageRecognitionResult(qrHandle, facePlan)).rejects.toMatchObject({ code: 'PLAN_HANDLE_MISMATCH' });

  const firstPlan = createRecognitionResultPlan(qrHandle, entryDecision());
  port.qualification = { ...QUALIFICATION, version: 2 };
  const secondHandle = await scope.resolveQr('lookup-digest-2');
  await expect(scope.stageRecognitionResult(secondHandle, firstPlan)).rejects.toMatchObject({ code: 'PLAN_HANDLE_MISMATCH' });
});

test('qualification and mapping freshness fail closed after resolution', async () => {
  const qualificationPort = new FakeRecognitionPort();
  const qualificationScope = newRecognition(qualificationPort);
  const qualificationHandle = await resolvedQr(qualificationScope);
  qualificationPort.qualification = { ...QUALIFICATION, version: 2 };
  await expect(qualificationScope.readQualification(qualificationHandle)).rejects.toMatchObject({ code: 'HANDLE_RESOLUTION_MISMATCH' });

  const mappingPort = new FakeRecognitionPort();
  const mappingScope = newRecognition(mappingPort);
  const mappingHandle = await resolvedQr(mappingScope);
  mappingPort.mapping = { ...MAPPING, version: 2 };
  await expect(mappingScope.stageRecognitionResult(
    mappingHandle,
    createRecognitionResultPlan(mappingHandle, entryDecision()),
  )).rejects.toMatchObject({ code: 'HANDLE_RESOLUTION_MISMATCH' });
});

test('face matched with no mapping becomes unmapped and inconsistent mappings reject', async () => {
  const missingPort = new FakeRecognitionPort();
  missingPort.mapping = null;
  const missingScope = newRecognition(missingPort);
  await missingScope.readSourceFacts();
  const missingHandle = await missingScope.resolveFace('DemoFace', 'subject-1');
  expect(await missingScope.readQualification(missingHandle)).toBeNull();
  await missingScope.stageRecognitionResult(
    missingHandle,
    createRecognitionResultPlan(missingHandle, {
      outcome: 'REJECTED', reasonCode: 'FACE_SUBJECT_NOT_MAPPED',
      presenceTransition: null, qualificationEffect: 'NONE', faceMappingEffect: 'KEEP',
    }),
  );
  expect(missingPort.staged[0]).toMatchObject({
    resolution: 'FACE_SUBJECT_NOT_MAPPED', qualificationId: null,
  });

  const inconsistentPort = new FakeRecognitionPort();
  inconsistentPort.mapping = { ...MAPPING, qualificationId: 'q-other' };
  const inconsistentScope = newRecognition(inconsistentPort);
  await inconsistentScope.readSourceFacts();
  await expect(inconsistentScope.resolveFace('DemoFace', 'subject-1')).rejects.toMatchObject({ code: 'HANDLE_RESOLUTION_MISMATCH' });
});

test('UNKNOWN has no qualification or mapping effect, while EXIT stages RELEASE', async () => {
  const unknownPort = new FakeRecognitionPort();
  const unknownScope = newRecognition(unknownPort);
  await unknownScope.readSourceFacts();
  const unknownHandle = await unknownScope.resolveFace({ kind: 'UNKNOWN' });
  expect(await unknownScope.readQualification(unknownHandle)).toBeNull();
  await unknownScope.stageRecognitionResult(
    unknownHandle,
    createRecognitionResultPlan(unknownHandle, unknownDecision()),
  );
  expect(unknownPort.calls).toEqual(['stageRecognitionResult']);
  expect(unknownPort.staged[0]).toMatchObject({
    qualificationId: null, presenceTransition: null,
    qualificationEffect: 'NONE', faceMappingEffect: 'KEEP',
  });

  const exitPort = new FakeRecognitionPort();
  const exitScope = newRecognition(exitPort, new FakeSourceFactsPort(true, 'EXIT'));
  await exitScope.readSourceFacts();
  const exitHandle = await exitScope.resolveFace('DemoFace', 'subject-1');
  const exitDecision = decideAccess({
    direction: 'EXIT', sourceActive: true,
    resolution: { kind: 'RESOLVED', qualification: { ...QUALIFICATION.state, presence: 'INSIDE', enteredAtMs: 1_500 } },
    receivedAtMs: 3_000,
  });
  await exitScope.stageRecognitionResult(
    exitHandle,
    createRecognitionResultPlan(exitHandle, exitDecision),
  );
  expect(exitPort.staged[0]).toMatchObject({ faceMappingEffect: 'RELEASE', resolution: 'RESOLVED' });
});

test('inactive sources perform zero identity resolution and still stage SOURCE_INACTIVE', async () => {
  const port = new FakeRecognitionPort();
  const facts = new FakeSourceFactsPort(false);
  const scope = newRecognition(port, facts);
  await scope.readSourceFacts();
  const handle = await scope.resolveQr('lookup-digest');
  await scope.stageRecognitionResult(
    handle,
    createRecognitionResultPlan(handle, {
      outcome: 'REJECTED', reasonCode: 'SOURCE_INACTIVE',
      presenceTransition: null, qualificationEffect: 'NONE', faceMappingEffect: 'KEEP',
    }),
  );
  expect(port.calls).toEqual(['stageRecognitionResult']);
  expect(port.staged[0]).toMatchObject({ resolution: 'SOURCE_INACTIVE' });
});

test('redacted query wrapper exposes no token, subject, HMAC, or comparison reference', async () => {
  const query = new FakeQueryPort();
  const composition = createAccessComposition({
    management: new FakeManagementPort(), recognition: new FakeRecognitionPort(),
    sourceFacts: new FakeSourceFactsPort(), query, epoch: 'epoch-1', sourceId: 'source-1',
    comparison: TEST_COMPARISON,
  });
  const result = await composition.readAccessData.qualifications({ limit: 10, cursor: 'cursor-1' });
  const serialized = JSON.stringify(result);
  for (const secretName of ['token', 'externalSubjectId', 'inputHmac', 'comparisonReferenceId', 'hmac']) {
    expect(serialized).not.toContain(secretName);
  }
  expect(Object.keys(result[0] ?? {}).sort()).toEqual([
    'createdAtMs', 'displayName', 'expiredTerminalAtMs', 'faceBound',
    'presence', 'qualificationId', 'revocationReason', 'revokedAtMs',
    'updatedAtMs', 'validFromMs', 'validUntilMs',
  ]);
  expect(query.lastInput).toEqual({ limit: 10, cursor: 'cursor-1' });
});

test('plan factories are not public and plain forged plans are rejected', async () => {
  expect(Object.keys(publicApi).sort()).toEqual(['composeAccess', 'createAccessComposition']);
  expect(Object.keys(publicApplicationApi)).toEqual([]);

  const management = new ManagementAccessScope(new FakeManagementPort(), { epoch: 'epoch-1' });
  const plainManagementPlan = {
    operation: 'CREATE', qualificationId: null, displayName: 'Demo',
    validFromMs: 1_000, validUntilMs: 2_000, faceMapping: null, revocationReason: null,
  };
  await expect(management.stageManagementChange(plainManagementPlan as never)).rejects.toMatchObject({ code: 'INVALID_MANAGEMENT_PLAN' });

  const recognitionPort = new FakeRecognitionPort();
  const recognition = newRecognition(recognitionPort);
  const handle = await resolvedQr(recognition);
  const plainRecognitionPlan = {
    media: 'QR', resolution: 'RESOLVED', qualificationId: 'q-1',
    qualificationIncarnation: 'q-inc-1', qualificationVersion: 1,
    mappingIncarnation: 'map-inc-1', mappingVersion: 1,
    outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED', presenceTransition: null,
    qualificationEffect: 'NONE', faceMappingEffect: 'KEEP',
  };
  await expect(recognition.stageRecognitionResult(handle, plainRecognitionPlan as never)).rejects.toMatchObject({ code: 'INVALID_RECOGNITION_PLAN' });

  const trustedManagementPlan = createManagementChangePlan({
    ...plainManagementPlan,
    operation: 'CREATE',
  });
  expect(trustedManagementPlan.operation).toBe('CREATE');
  expect(trustedManagementPlan).not.toBe(plainManagementPlan);
});

test('management wrapper only stages trusted complete plans and closes its scope', async () => {
  const port = new FakeManagementPort();
  const scope = new ManagementAccessScope(port, { epoch: 'epoch-1' });
  await scope.stageManagementChange(createManagementChangePlan({
    operation: 'REVOKE', qualificationId: 'q-1', displayName: null,
    validFromMs: null, validUntilMs: null, faceMapping: null,
    revocationReason: 'cancelled',
  }));
  expect(port.staged[0]).toMatchObject({ operation: 'REVOKE', revocationReason: 'cancelled' });
  await scope.closeAsync();
  await expect(scope.stageManagementChange(createManagementChangePlan({
    operation: 'CREATE', qualificationId: null, displayName: 'Demo',
    validFromMs: 1_000, validUntilMs: 2_000, faceMapping: null, revocationReason: null,
  }))).rejects.toMatchObject({ code: 'SCOPE_CLOSED' });
});

test('scope contexts are opaque and distinct per live scope owner', async () => {
  const port = new FakeRecognitionPort();
  const a = newRecognition(port);
  const b = newRecognition(port);
  await resolvedQr(a);
  await resolvedQr(b);
  expect(port.contexts[0]).not.toBe(port.contexts[1]);
  expect(Object.keys(port.contexts[0] ?? {})).toEqual([]);
  expect(() => Object.defineProperty(port.contexts[0], 'forged', { value: true })).toThrow();
});
