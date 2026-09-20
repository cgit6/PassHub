import {
  defaultComparisonPort,
  type ComparisonPort,
  type RecognitionComparisonInput,
} from './comparison/comparison-port.js';
import {
  type ManagementScope,
  type RecognitionScope,
} from './access-scopes.js';
import {
  createManagementChangePlan,
  createRecognitionResultPlan,
} from './internal-plans.js';
import {
  decideAccess,
  decideQualificationRevocation,
  decideQualificationUpdate,
  decideQualificationWindow,
  type AccessDecision,
  type IdentityResolution,
} from '../domain/index.js';
import type {
  RedactedAccessEventProjection,
  RedactedQualificationProjection,
} from '../ports/index.js';

export interface ReadAccessData {
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

export interface CreateQualificationCommand {
  readonly displayName: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly faceMapping:
    | Readonly<{ provider: string; externalSubjectId: string }>
    | null;
  readonly receivedAtMs: number;
}

export interface UpdateQualificationCommand {
  readonly qualificationId: string;
  readonly displayName: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly faceMapping:
    | Readonly<{ provider: string; externalSubjectId: string }>
    | null
    | undefined;
  readonly receivedAtMs: number;
}

export interface RevokeQualificationCommand {
  readonly qualificationId: string;
  readonly reason: string;
  readonly receivedAtMs: number;
}

export interface ManageQualifications {
  create(input: CreateQualificationCommand): Promise<void>;
  update(input: UpdateQualificationCommand): Promise<void>;
  revoke(input: RevokeQualificationCommand): Promise<void>;
}

/** Management has no transition setter; every write is a complete plan. */
export class ManageQualificationsImplementation implements ManageQualifications {
  public constructor(private readonly openScope: () => ManagementScope) {}

  public async create(input: CreateQualificationCommand): Promise<void> {
    const window = decideQualificationWindow({
      validFromMs: input.validFromMs,
      validUntilMs: input.validUntilMs,
      receivedAtMs: input.receivedAtMs,
    });
    if (!window.allowed) {
      throw new Error(window.reason);
    }
    const scope = this.openScope();
    try {
      await scope.stageManagementChange(
        createManagementChangePlan({
          operation: 'CREATE',
          qualificationId: null,
          displayName: input.displayName,
          validFromMs: input.validFromMs,
          validUntilMs: input.validUntilMs,
          faceMapping: input.faceMapping,
          revocationReason: null,
        }),
      );
    } finally {
      scope.close();
    }
  }

  public async update(input: UpdateQualificationCommand): Promise<void> {
    const scope = this.openScope();
    try {
      const current = await scope.readQualification(input.qualificationId);
      if (current === null) {
        throw new Error('QUALIFICATION_NOT_FOUND');
      }
      const decision = decideQualificationUpdate({
        qualification: current.state,
        proposedValidFromMs: input.validFromMs,
        proposedValidUntilMs: input.validUntilMs,
        receivedAtMs: input.receivedAtMs,
      });
      if (!decision.allowed) {
        throw new Error(decision.reason);
      }
      await scope.stageManagementChange(
        createManagementChangePlan({
          operation: 'UPDATE',
          qualificationId: input.qualificationId,
          displayName: input.displayName,
          validFromMs: input.validFromMs,
          validUntilMs: input.validUntilMs,
          faceMapping: input.faceMapping,
          revocationReason: null,
        }),
      );
    } finally {
      scope.close();
    }
  }

  public async revoke(input: RevokeQualificationCommand): Promise<void> {
    const scope = this.openScope();
    try {
      const current = await scope.readQualification(input.qualificationId);
      if (current === null) {
        throw new Error('QUALIFICATION_NOT_FOUND');
      }
      const decision = decideQualificationRevocation({
        qualification: current.state,
        receivedAtMs: input.receivedAtMs,
        reason: input.reason,
      });
      if (!decision.allowed) {
        throw new Error(decision.reason);
      }
      await scope.stageManagementChange(
        createManagementChangePlan({
          operation: 'REVOKE',
          qualificationId: input.qualificationId,
          displayName: null,
          validFromMs: null,
          validUntilMs: null,
          faceMapping: null,
          revocationReason: input.reason,
        }),
      );
    } finally {
      scope.close();
    }
  }
}

export interface RecognitionAttemptCommand {
  readonly input: RecognitionComparisonInput;
  readonly receivedAtMs: number;
}

/**
 * The use case owns source facts, identity resolution, the pure domain
 * decision, and staging. Persistence remains behind the scope port.
 */
export interface RecognizeAttempt {
  execute(input: RecognitionAttemptCommand): Promise<AccessDecision>;
}

export class RecognizeAttemptImplementation implements RecognizeAttempt {
  public constructor(
    private readonly openScope: (sourceId: string) => RecognitionScope,
    private readonly sourceId: string,
    private readonly comparison: ComparisonPort = defaultComparisonPort,
  ) {}

  public async execute(input: RecognitionAttemptCommand): Promise<AccessDecision> {
    this.comparison.validate(input.input);
    if (!Number.isSafeInteger(input.receivedAtMs)) {
      throw new TypeError('receivedAtMs must be a safe integer instant');
    }
    const scope = this.openScope(this.sourceId);
    try {
      const sourceFacts = await scope.readSourceFacts();
      const { handle, qualification, resolution } = await this.resolve(
        scope,
        input.input,
      );
      if (qualification === null && resolution.kind === 'RESOLVED') {
        throw new Error('resolved handle lost its qualification snapshot');
      }
      const decision = decideAccess({
        direction: sourceFacts.direction,
        sourceActive: sourceFacts.active,
        resolution,
        receivedAtMs: input.receivedAtMs,
      });
      await scope.stageRecognitionResult(
        handle,
        createRecognitionResultPlan(handle, decision),
      );
      return decision;
    } finally {
      scope.close();
    }
  }

  private async resolve(
    scope: RecognitionScope,
    input: RecognitionComparisonInput,
  ): Promise<{
    readonly handle: import('./resolution-handle.js').ResolutionHandle;
    readonly qualification: Awaited<ReturnType<RecognitionScope['readQualification']>>;
    readonly resolution: IdentityResolution;
  }> {
    if (input.kind === 'QR_SCANNED') {
      const handle = await scope.resolveQr(
        this.comparison.qrCredential.lookupDigest(input.token),
      );
      const qualification = await scope.readQualification(handle);
      return {
        handle,
        qualification,
        resolution:
          qualification === null
            ? { kind: 'INVALID_QR_CREDENTIAL' }
            : { kind: 'RESOLVED', qualification: qualification.state },
      };
    }
    if (input.kind === 'FACE_MATCHED') {
      const handle = await scope.resolveFace(
        input.provider,
        input.externalSubjectId,
      );
      const qualification = await scope.readQualification(handle);
      return {
        handle,
        qualification,
        resolution:
          qualification === null
            ? { kind: 'FACE_SUBJECT_NOT_MAPPED' }
            : { kind: 'RESOLVED', qualification: qualification.state },
      };
    }
    const handle = await scope.resolveFace({ kind: 'UNKNOWN' });
    return {
      handle,
      qualification: null,
      resolution: { kind: 'FACE_UNKNOWN' },
    };
  }
}
