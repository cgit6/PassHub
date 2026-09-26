import type {
  ComparisonPort,
  RecognitionComparisonInput,
} from './comparison/comparison-port.js';
import {
  type ManagementScope,
  type RecognitionScope,
} from './access-scopes.js';
import {
  createManagementChangePlan,
  createRecognitionResultPlan,
} from './internal-plans.js';
import { assertExternalEventId, assertExternalSubjectId, assertProvider } from '../ports/recognition-validation.js';
import {
  decideAccess,
  decideQualificationRevocation,
  decideQualificationUpdate,
  decideQualificationWindow,
  type AccessDecision,
  type IdentityResolution,
} from '../domain/index.js';
import { ManagementApplicationError } from './management-errors.js';
import { toManagementPublicChangeResult } from './management-result-mapper.js';
import type {
  RedactedAccessEventProjection,
  RedactedQualificationProjection,
  ManagementPublicChangeResult,
} from '../ports/index.js';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  readonly actorId: string;
}

export interface UpdateQualificationCommand {
  readonly qualificationId: string;
  readonly displayName?: string;
  readonly validFromMs?: number;
  readonly validUntilMs?: number;
  readonly faceMapping?:
    | Readonly<{ provider: string; externalSubjectId: string }>
    | null;
  readonly receivedAtMs: number;
  readonly actorId: string;
}

export interface RevokeQualificationCommand {
  readonly qualificationId: string;
  readonly reason: string;
  readonly receivedAtMs: number;
  readonly actorId: string;
}

export interface ManageQualifications {
  create(input: CreateQualificationCommand): Promise<ManagementPublicChangeResult>;
  update(input: UpdateQualificationCommand): Promise<ManagementPublicChangeResult>;
  revoke(input: RevokeQualificationCommand): Promise<ManagementPublicChangeResult>;
}

/** Management has no transition setter; every write is a complete plan. */
export class ManageQualificationsImplementation implements ManageQualifications {
  public constructor(private readonly openScope: () => ManagementScope) {}

  private assertActorId(actorId: unknown): asserts actorId is string {
    if (typeof actorId !== 'string' || !UUID_V4_PATTERN.test(actorId)) {
      throw new TypeError('actorId must be a canonical UUID v4');
    }
  }

  private assertFaceMapping(input: Readonly<{ provider: string; externalSubjectId: string }> | null | undefined): void {
    if (input === null || input === undefined) return;
    assertProvider(input.provider);
    assertExternalSubjectId(input.externalSubjectId);
  }

  private hasOwn(input: UpdateQualificationCommand, key: keyof UpdateQualificationCommand): boolean {
    return Object.prototype.hasOwnProperty.call(input, key);
  }

  public async create(input: CreateQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.assertActorId(input.actorId);
    const window = decideQualificationWindow({
      validFromMs: input.validFromMs,
      validUntilMs: input.validUntilMs,
      receivedAtMs: input.receivedAtMs,
    });
    if (!window.allowed) {
      throw new ManagementApplicationError(window.reason);
    }
    this.assertFaceMapping(input.faceMapping);
    const scope = this.openScope();
    try {
      return toManagementPublicChangeResult(await scope.stageManagementChange(
        createManagementChangePlan({
          operation: 'CREATE',
          qualificationId: null,
          displayName: input.displayName,
          validFromMs: input.validFromMs,
          validUntilMs: input.validUntilMs,
          faceMapping: input.faceMapping,
          revocationReason: null,
          receivedAtMs: input.receivedAtMs,
          actorId: input.actorId,
        }),
      ));
    } finally {
      await scope.closeAsync();
    }
  }

  public async update(input: UpdateQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.assertActorId(input.actorId);
    if (!this.hasOwn(input, 'displayName') && !this.hasOwn(input, 'validFromMs') &&
      !this.hasOwn(input, 'validUntilMs') && !this.hasOwn(input, 'faceMapping')) {
      throw new ManagementApplicationError('UPDATE_FIELD_REQUIRED');
    }
    if (this.hasOwn(input, 'faceMapping')) this.assertFaceMapping(input.faceMapping);
    const scope = this.openScope();
    try {
      const current = await scope.readQualification(input.qualificationId);
      if (current === null) {
        throw new ManagementApplicationError('QUALIFICATION_NOT_FOUND');
      }
      // Keep the qualification and mapping reads inside the same management scope.
      // The mapping is intentionally omitted from the plan when PATCH omitted it.
      await scope.readMapping(input.qualificationId, current.incarnation);
      const displayName = this.hasOwn(input, 'displayName') ? input.displayName! : current.displayName;
      const validFromMs = this.hasOwn(input, 'validFromMs') ? input.validFromMs! : current.state.validFromMs;
      const validUntilMs = this.hasOwn(input, 'validUntilMs') ? input.validUntilMs! : current.state.validUntilMs;
      const faceMapping = this.hasOwn(input, 'faceMapping')
        ? input.faceMapping!
        : null;
      const faceMappingMode = this.hasOwn(input, 'faceMapping')
        ? input.faceMapping === null ? 'REMOVE' as const : 'SET' as const
        : 'KEEP' as const;
      const decision = decideQualificationUpdate({
        qualification: current.state,
        proposedValidFromMs: validFromMs,
        proposedValidUntilMs: validUntilMs,
        receivedAtMs: input.receivedAtMs,
      });
      if (!decision.allowed) {
        if (decision.reason === 'QUALIFICATION_ALREADY_EXPIRED' && this.needsTerminalExpiry(current.state, input.receivedAtMs)) {
          await this.stageExpiry(scope, current, input.receivedAtMs, input.actorId);
          throw new ManagementApplicationError(decision.reason, 'EXPIRED_TERMINAL_PERSISTED');
        }
        throw new ManagementApplicationError(decision.reason);
      }
      return toManagementPublicChangeResult(await scope.stageManagementChange(
        createManagementChangePlan({
          operation: 'UPDATE',
          qualificationId: input.qualificationId,
          displayName,
          validFromMs,
          validUntilMs,
          faceMapping,
          faceMappingMode,
          revocationReason: null,
          receivedAtMs: input.receivedAtMs,
          actorId: input.actorId,
          expectedQualification: {
            qualificationId: current.qualificationId,
            incarnation: current.incarnation,
            version: current.version,
          },
        }),
      ));
    } finally {
      await scope.closeAsync();
    }
  }

  private needsTerminalExpiry(
    state: import('../domain/index.js').QualificationState,
    receivedAtMs: number,
  ): boolean {
    return state.presence === 'NOT_ENTERED' && state.revokedAtMs === null &&
      state.expiredTerminalAtMs === null && receivedAtMs >= state.validUntilMs;
  }

  private async stageExpiry(
    scope: ManagementScope,
    current: import('../ports/index.js').ManagementQualificationSnapshot,
    receivedAtMs: number,
    actorId: string,
  ): Promise<void> {
    await scope.stageManagementChange(createManagementChangePlan({
      operation: 'EXPIRE',
      qualificationId: current.qualificationId,
      displayName: null,
      validFromMs: null,
      validUntilMs: null,
      faceMapping: null,
      faceMappingMode: 'REMOVE',
      revocationReason: null,
      receivedAtMs,
      actorId,
      expectedQualification: {
        qualificationId: current.qualificationId,
        incarnation: current.incarnation,
        version: current.version,
      },
    }));
  }

  public async revoke(input: RevokeQualificationCommand): Promise<ManagementPublicChangeResult> {
    this.assertActorId(input.actorId);
    const scope = this.openScope();
    try {
      const current = await scope.readQualification(input.qualificationId);
      if (current === null) {
        throw new ManagementApplicationError('QUALIFICATION_NOT_FOUND');
      }
      const decision = decideQualificationRevocation({
        qualification: current.state,
        receivedAtMs: input.receivedAtMs,
        reason: input.reason,
      });
      if (!decision.allowed) {
        if (decision.reason === 'QUALIFICATION_ALREADY_EXPIRED' && this.needsTerminalExpiry(current.state, input.receivedAtMs)) {
          await this.stageExpiry(scope, current, input.receivedAtMs, input.actorId);
          throw new ManagementApplicationError(decision.reason, 'EXPIRED_TERMINAL_PERSISTED');
        }
        throw new ManagementApplicationError(decision.reason);
      }
      return toManagementPublicChangeResult(await scope.stageManagementChange(
        createManagementChangePlan({
          operation: 'REVOKE',
          qualificationId: input.qualificationId,
          displayName: null,
          validFromMs: null,
          validUntilMs: null,
          faceMapping: null,
          revocationReason: input.reason,
          receivedAtMs: input.receivedAtMs,
          actorId: input.actorId,
          expectedQualification: {
            qualificationId: current.qualificationId,
            incarnation: current.incarnation,
            version: current.version,
          },
        }),
      ));
    } finally {
      await scope.closeAsync();
    }
  }
}

export interface RecognitionAttemptCommand {
  readonly input: RecognitionComparisonInput;
  readonly receivedAtMs: number;
  readonly externalEventId: string;
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
    private readonly comparison: ComparisonPort,
  ) {}

  public async execute(input: RecognitionAttemptCommand): Promise<AccessDecision> {
    assertExternalEventId(input.externalEventId);
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
      const comparisonArtifact = this.comparison.artifact.create(input.input);
      const persisted = await scope.stageRecognitionResult(
        handle,
        createRecognitionResultPlan(handle, decision, {
          externalEventId: input.externalEventId,
          receivedAtMs: input.receivedAtMs,
          sourceId: sourceFacts.sourceId,
          direction: sourceFacts.direction,
          comparisonArtifact,
        }),
      );
      return persisted.decision;
    } finally {
      await scope.closeAsync();
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
