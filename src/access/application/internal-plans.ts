import type {
  ManagementChangePlan,
  RecognitionResultPlan,
} from '../ports/index.js';
import type { AccessDecision } from '../domain/index.js';
import {
  readResolutionHandleClaims,
  type ResolutionHandle,
} from './resolution-handle.js';
import { AccessScopeError } from './scope-errors.js';

const managementPlans = new WeakSet<object>();
const recognitionPlans = new WeakSet<object>();

export interface ManagementChangeInput {
  readonly operation: 'CREATE' | 'UPDATE' | 'REVOKE';
  readonly qualificationId: string | null;
  readonly displayName: string | null;
  readonly validFromMs: number | null;
  readonly validUntilMs: number | null;
  readonly faceMapping:
    | Readonly<{ provider: string; externalSubjectId: string }>
    | null
    | undefined;
  readonly revocationReason: string | null;
}

export function createManagementChangePlan(
  input: ManagementChangeInput,
): ManagementChangePlan {
  assertManagementChangePlanShape(input);
  const faceMapping =
    input.faceMapping === null || input.faceMapping === undefined
      ? input.faceMapping
      : Object.freeze({
          provider: input.faceMapping.provider,
          externalSubjectId: input.faceMapping.externalSubjectId,
        });
  const plan = Object.freeze({
    operation: input.operation,
    qualificationId: input.qualificationId,
    displayName: input.displayName,
    validFromMs: input.validFromMs,
    validUntilMs: input.validUntilMs,
    faceMapping,
    revocationReason: input.revocationReason,
  }) as unknown as ManagementChangePlan;
  managementPlans.add(plan);
  return plan;
}

export function createRecognitionResultPlan(
  handle: ResolutionHandle,
  decision: AccessDecision,
): RecognitionResultPlan {
  const claims = readResolutionHandleClaims(handle);
  if (claims === null) {
    throw new AccessScopeError(
      'INVALID_HANDLE',
      'recognition plan requires a handle issued by the access scope',
    );
  }
  const presenceTransition =
    decision.presenceTransition === null
      ? null
      : Object.freeze({
          from: decision.presenceTransition.from,
          to: decision.presenceTransition.to,
        });
  const plan = Object.freeze({
    media: claims.media,
    resolution: claims.resolution,
    qualificationId: claims.qualificationId,
    qualificationIncarnation: claims.qualificationIncarnation,
    qualificationVersion: claims.qualificationVersion,
    mappingIncarnation: claims.mappingIncarnation,
    mappingVersion: claims.mappingVersion,
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    presenceTransition,
    qualificationEffect: decision.qualificationEffect,
    faceMappingEffect: decision.faceMappingEffect,
  }) as unknown as RecognitionResultPlan;
  recognitionPlans.add(plan);
  return plan;
}

export function assertManagementChangePlan(
  plan: ManagementChangePlan,
): void {
  assertManagementChangePlanShape(plan);
  if (
    (typeof plan !== 'object' || plan === null) ||
    !managementPlans.has(plan)
  ) {
    throw new AccessScopeError(
      'INVALID_MANAGEMENT_PLAN',
      'management stage accepts only an internal trusted plan',
    );
  }
}

export function assertRecognitionResultPlan(
  plan: RecognitionResultPlan,
): void {
  assertRecognitionResultPlanShape(plan);
  if (
    (typeof plan !== 'object' || plan === null) ||
    !recognitionPlans.has(plan)
  ) {
    throw new AccessScopeError(
      'INVALID_RECOGNITION_PLAN',
      'recognition stage accepts only an internal trusted plan',
    );
  }
}

function assertManagementChangePlanShape(
  plan: ManagementChangeInput,
): void {
  if (typeof plan !== 'object' || plan === null) {
    throw new AccessScopeError(
      'INVALID_MANAGEMENT_PLAN',
      'management plan must be an object',
    );
  }
  if (!['CREATE', 'UPDATE', 'REVOKE'].includes(plan.operation)) {
    throw new AccessScopeError(
      'INVALID_MANAGEMENT_PLAN',
      'unknown management operation',
    );
  }
  if (
    plan.operation === 'REVOKE' &&
    (plan.qualificationId === null || plan.revocationReason === null)
  ) {
    throw new AccessScopeError(
      'INVALID_MANAGEMENT_PLAN',
      'revoke requires a qualification and reason',
    );
  }
  if (plan.operation !== 'REVOKE' && plan.revocationReason !== null) {
    throw new AccessScopeError(
      'INVALID_MANAGEMENT_PLAN',
      'only revoke may contain a reason',
    );
  }
}

function assertRecognitionResultPlanShape(
  plan: RecognitionResultPlan,
): void {
  if (typeof plan !== 'object' || plan === null) {
    throw new AccessScopeError(
      'INVALID_RECOGNITION_PLAN',
      'recognition plan must be an object',
    );
  }
  if (!['QR', 'FACE_MATCHED', 'FACE_UNKNOWN'].includes(plan.media)) {
    throw new AccessScopeError(
      'INVALID_RECOGNITION_PLAN',
      'unknown recognition media',
    );
  }
  if (
    !['RESOLVED', 'INVALID_QR_CREDENTIAL', 'FACE_UNKNOWN', 'FACE_SUBJECT_NOT_MAPPED', 'SOURCE_INACTIVE'].includes(
      plan.resolution,
    )
  ) {
    throw new AccessScopeError(
      'INVALID_RECOGNITION_PLAN',
      'unknown identity resolution',
    );
  }
  if (!['ACCEPTED', 'REJECTED'].includes(plan.outcome)) {
    throw new AccessScopeError(
      'INVALID_RECOGNITION_PLAN',
      'unknown recognition outcome',
    );
  }
  if (typeof plan.reasonCode !== 'string' || plan.reasonCode.length === 0) {
    throw new AccessScopeError(
      'INVALID_RECOGNITION_PLAN',
      'reason code is required',
    );
  }
}
