import type {
  Direction,
  QualificationState,
  ReasonCode,
  AccessDecision,
} from '../domain/index.js';
import type { AccessScopeContext } from '../../shared/access-scope-context.js';
export type { AccessScopeContext } from '../../shared/access-scope-context.js';

/**
 * The only persistence-facing shapes exposed to the application layer.
 * Implementations may be backed by Mongo later, but the access application
 * never receives a client, collection, or session.
 */
export interface QualificationSnapshot {
  readonly qualificationId: string;
  readonly incarnation: string;
  readonly version: number;
  readonly state: QualificationState;
}

export interface FaceMappingSnapshot {
  readonly qualificationId: string;
  readonly qualificationIncarnation: string;
  readonly mappingIncarnation: string;
  readonly version: number;
}

export interface ResolvedIdentitySnapshot {
  readonly qualification: QualificationSnapshot | null;
  readonly mapping: FaceMappingSnapshot | null;
}

export interface SourceFacts {
  readonly sourceId: string;
  readonly direction: Direction;
  readonly active: boolean;
}

export interface SourceFactsPort {
  read(
    context: AccessScopeContext,
    sourceId: string,
  ): Promise<SourceFacts>;
}

const managementPlanBrand: unique symbol = Symbol('ManagementChangePlan');
const recognitionPlanBrand: unique symbol = Symbol('RecognitionResultPlan');

export interface ManagementChangePlan {
  readonly [managementPlanBrand]: true;
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

export interface ManagementChangeResult {
  readonly operation: 'CREATE' | 'UPDATE' | 'REVOKE';
  readonly qualificationId: string;
  readonly incarnation: string;
  readonly version: number;
  readonly summary: Readonly<{
    readonly qualificationId: string;
    readonly displayName: string;
    readonly validFromMs: number;
    readonly validUntilMs: number;
    readonly presence: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  }>;
  readonly qrToken: string | null;
}

export interface RecognitionResultPlan {
  readonly [recognitionPlanBrand]: true;
  readonly media: 'QR' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
  readonly resolution:
    | 'RESOLVED'
    | 'INVALID_QR_CREDENTIAL'
    | 'FACE_UNKNOWN'
    | 'FACE_SUBJECT_NOT_MAPPED'
    | 'SOURCE_INACTIVE';
  readonly qualificationId: string | null;
  readonly qualificationIncarnation: string | null;
  readonly qualificationVersion: number | null;
  readonly mappingIncarnation: string | null;
  readonly mappingVersion: number | null;
  readonly outcome: 'ACCEPTED' | 'REJECTED';
  readonly reasonCode: ReasonCode;
  readonly presenceTransition: Readonly<{
    from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
    to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  }> | null;
  readonly qualificationEffect: 'NONE' | 'EXPIRE_NOT_ENTERED';
  readonly faceMappingEffect: 'KEEP' | 'RELEASE';
}

export interface RecognitionPersistenceResult {
  readonly status: 'COMMITTED' | 'REPLAYED';
  readonly eventId: string;
  readonly decision: AccessDecision;
}

export interface ManagementDataPort {
  readQualification(
    context: AccessScopeContext,
    qualificationId: string,
  ): Promise<QualificationSnapshot | null>;
  readMapping(
    context: AccessScopeContext,
    qualificationId: string,
  ): Promise<FaceMappingSnapshot | null>;
  stageManagementChange(
    context: AccessScopeContext,
    plan: ManagementChangePlan,
  ): Promise<ManagementChangeResult>;
  discard?(context: AccessScopeContext): Promise<void>;
}

export interface RecognitionDataPort {
  readQualification(
    context: AccessScopeContext,
    qualificationId: string,
  ): Promise<QualificationSnapshot | null>;
  readMapping(
    context: AccessScopeContext,
    qualificationId: string,
  ): Promise<FaceMappingSnapshot | null>;
  resolveQr(
    context: AccessScopeContext,
    lookupDigest: string,
  ): Promise<ResolvedIdentitySnapshot>;
  resolveFace(
    context: AccessScopeContext,
    provider: string,
    externalSubjectId: string,
  ): Promise<ResolvedIdentitySnapshot>;
  stageRecognitionResult(
    context: AccessScopeContext,
    plan: RecognitionResultPlan,
  ): Promise<RecognitionPersistenceResult>;
  discard?(context: AccessScopeContext): Promise<void>;
}

export interface RedactedQualificationProjection {
  readonly qualificationId: string;
  readonly displayName: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly presence: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  readonly revokedAtMs: number | null;
  readonly revocationReason: string | null;
  readonly expiredTerminalAtMs: number | null;
  readonly faceBound: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RedactedAccessEventProjection {
  readonly eventId: string;
  readonly sourceId: string;
  readonly direction: Direction;
  readonly kind: 'QR_SCANNED' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
  readonly outcome: 'ACCEPTED' | 'REJECTED';
  readonly reasonCode: ReasonCode;
  readonly receivedAtMs: number;
  readonly recordedAtMs: number;
  readonly qualificationId: string | null;
  readonly presenceTransition: Readonly<{
    from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
    to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  }> | null;
}

export interface AccessQueryPort {
  qualifications(
    input: Readonly<{ limit: number; cursor?: string }>,
  ): Promise<readonly RedactedQualificationProjection[]>;
  inside(
    input: Readonly<{ limit: number; cursor?: string }>,
  ): Promise<readonly RedactedQualificationProjection[]>;
  events(
    input: Readonly<{
      limit: number;
      cursor?: string;
      qualificationId?: string;
      outcome?: 'ACCEPTED' | 'REJECTED';
      reasonCode?: string;
    }>,
  ): Promise<readonly RedactedAccessEventProjection[]>;
}
