import { randomUUID } from 'node:crypto';

import type {
  AccessScopeContext,
  FaceMappingSnapshot,
  ManagementChangePlan,
  ManagementChangeResult,
  QualificationSnapshot,
  RecognitionResultPlan,
  RecognitionPersistenceResult,
  ResolvedIdentitySnapshot,
  SourceFacts,
  SourceFactsPort,
  ManagementDataPort,
  RecognitionDataPort,
} from '../ports/index.js';
import { createAccessScopeContext, retireAccessScopeContext } from '../../shared/access-scope-context.js';
import { AccessScopeError } from './scope-errors.js';
import {
  assertManagementChangePlan,
  assertRecognitionResultPlan,
} from './internal-plans.js';
import {
  createResolutionHandle,
  readResolutionHandleClaims,
  snapshotToHandleClaims,
  type ResolutionHandle,
  type ResolutionHandleClaims,
  type ResolutionMedia,
} from './resolution-handle.js';

export { AccessScopeError } from './scope-errors.js';

export interface ManagementScope {
  readQualification(qualificationId: string): Promise<QualificationSnapshot | null>;
  readMapping(qualificationId: string): Promise<FaceMappingSnapshot | null>;
  stageManagementChange(plan: ManagementChangePlan): Promise<ManagementChangeResult>;
  closeAsync(): Promise<void>;
}

export interface RecognitionScope {
  readSourceFacts(): Promise<SourceFacts>;
  resolveQr(lookupDigest: string): Promise<ResolutionHandle>;
  resolveFace(
    provider: string,
    externalSubjectId: string,
  ): Promise<ResolutionHandle>;
  resolveFace(input: Readonly<{ kind: 'UNKNOWN' }>): Promise<ResolutionHandle>;
  readQualification(handle: ResolutionHandle): Promise<QualificationSnapshot | null>;
  stageRecognitionResult(
    handle: ResolutionHandle,
    plan: RecognitionResultPlan,
  ): Promise<RecognitionPersistenceResult>;
  closeAsync(): Promise<void>;
}

export interface ScopeOptions {
  readonly epoch: string;
  readonly scopeId?: string;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function makeContext(
  options: ScopeOptions,
  owner: string,
  generation: string,
): AccessScopeContext {
  assertNonEmpty(options.epoch, 'epoch');
  return createAccessScopeContext({ epoch: options.epoch, owner, generation });
}

abstract class ScopeBase {
  #closed = false;
  protected readonly scopeToken: object = Object.freeze({});
  protected readonly context: AccessScopeContext;
  protected readonly scopeId: string;
  protected readonly owner: string;
  protected readonly generation: string;
  protected readonly epoch: string;

  protected constructor(options: ScopeOptions) {
    this.scopeId = options.scopeId ?? randomUUID();
    this.owner = randomUUID();
    this.generation = randomUUID();
    this.epoch = options.epoch;
    this.context = makeContext(options, this.owner, this.generation);
  }

  protected assertOpen(): void {
    if (this.#closed) {
      throw new AccessScopeError(
        'SCOPE_CLOSED',
        `access scope ${this.scopeId} is closed`,
      );
    }
  }

  protected async discardPersistence(): Promise<void> {
    return;
  }

  public async closeAsync(): Promise<void> {
    this.#closed = true;
    retireAccessScopeContext(this.context);
    await this.discardPersistence();
  }
}

export class ManagementAccessScope
  extends ScopeBase
  implements ManagementScope
{
  public constructor(
    private readonly persistence: ManagementDataPort,
    options: ScopeOptions,
  ) {
    super(options);
  }

  public async readQualification(
    qualificationId: string,
  ): Promise<QualificationSnapshot | null> {
    this.assertOpen();
    assertNonEmpty(qualificationId, 'qualificationId');
    const result = await this.persistence.readQualification(
      this.context,
      qualificationId,
    );
    this.assertOpen();
    return result;
  }

  public async readMapping(
    qualificationId: string,
  ): Promise<FaceMappingSnapshot | null> {
    this.assertOpen();
    assertNonEmpty(qualificationId, 'qualificationId');
    const result = await this.persistence.readMapping(
      this.context,
      qualificationId,
    );
    this.assertOpen();
    return result;
  }

  public async stageManagementChange(plan: ManagementChangePlan): Promise<ManagementChangeResult> {
    this.assertOpen();
    assertManagementChangePlan(plan);
    const result = await this.persistence.stageManagementChange(this.context, plan);
    this.assertOpen();
    return result;
  }

  protected override async discardPersistence(): Promise<void> {
    await this.persistence.discard?.(this.context);
  }
}

export class RecognitionAccessScope
  extends ScopeBase
  implements RecognitionScope
{
  #sourceActive: boolean | undefined;

  public constructor(
    private readonly persistence: RecognitionDataPort,
    private readonly sourceFacts: SourceFactsPort,
    private readonly sourceId: string,
    options: ScopeOptions,
  ) {
    super(options);
    assertNonEmpty(sourceId, 'sourceId');
  }

  public async readSourceFacts(): Promise<SourceFacts> {
    this.assertOpen();
    const result = await this.sourceFacts.read(this.context, this.sourceId);
    this.assertOpen();
    this.#sourceActive = result.active;
    return result;
  }

  public async resolveQr(lookupDigest: string): Promise<ResolutionHandle> {
    this.assertOpen();
    assertNonEmpty(lookupDigest, 'lookupDigest');
    this.assertSourceActiveForResolution();
    if (this.#sourceActive === false) {
      return this.makeInactiveHandle('QR');
    }
    const resolved = await this.persistence.resolveQr(
      this.context,
      lookupDigest,
    );
    this.assertOpen();
    return this.makeHandle('QR', resolved);
  }

  public async resolveFace(
    providerOrUnknown: string | Readonly<{ kind: 'UNKNOWN' }>,
    externalSubjectId?: string,
  ): Promise<ResolutionHandle> {
    this.assertOpen();
    this.assertSourceActiveForResolution();
    if (this.#sourceActive === false) {
      return this.makeInactiveHandle(
        typeof providerOrUnknown === 'object' ? 'FACE_UNKNOWN' : 'FACE_MATCHED',
      );
    }
    if (typeof providerOrUnknown === 'object') {
      if (providerOrUnknown.kind !== 'UNKNOWN' || externalSubjectId !== undefined) {
        throw new TypeError('FACE_UNKNOWN does not accept a subject');
      }
      return this.makeHandle('FACE_UNKNOWN', {
        qualification: null,
        mapping: null,
      });
    }
    assertNonEmpty(providerOrUnknown, 'provider');
    if (externalSubjectId === undefined) {
      throw new TypeError('FACE_MATCHED requires an external subject');
    }
    assertNonEmpty(externalSubjectId, 'externalSubjectId');
    const resolved = await this.persistence.resolveFace(
      this.context,
      providerOrUnknown,
      externalSubjectId,
    );
    this.assertOpen();
    return this.makeHandle('FACE_MATCHED', resolved);
  }

  public async readQualification(
    handle: ResolutionHandle,
  ): Promise<QualificationSnapshot | null> {
    const claims = this.assertHandle(handle);
    if (claims.qualificationId === null) {
      return null;
    }
    const qualification = await this.persistence.readQualification(
      this.context,
      claims.qualificationId,
    );
    this.assertOpen();
    if (qualification === null) {
      throw new AccessScopeError(
        'HANDLE_RESOLUTION_MISMATCH',
        'resolved qualification is no longer available in this scope',
      );
    }
    this.assertQualificationIdentity(claims, qualification);
    return qualification;
  }

  public async stageRecognitionResult(
    handle: ResolutionHandle,
    plan: RecognitionResultPlan,
  ): Promise<RecognitionPersistenceResult> {
    const claims = this.assertHandle(handle);
    assertRecognitionResultPlan(plan);
    if (plan.media !== claims.media || plan.resolution !== claims.resolution) {
      throw new AccessScopeError(
        'PLAN_HANDLE_MISMATCH',
        'recognition plan does not belong to the resolved media and result',
      );
    }
    if (
      plan.qualificationId !== claims.qualificationId ||
      plan.qualificationIncarnation !== claims.qualificationIncarnation ||
      plan.qualificationVersion !== claims.qualificationVersion ||
      plan.mappingIncarnation !== claims.mappingIncarnation ||
      plan.mappingVersion !== claims.mappingVersion
    ) {
      throw new AccessScopeError(
        'PLAN_HANDLE_MISMATCH',
        'recognition plan does not belong to the resolved qualification snapshot',
      );
    }
    if (claims.qualificationId === null) {
      if (
        plan.presenceTransition !== null ||
        plan.qualificationEffect !== 'NONE' ||
        plan.faceMappingEffect !== 'KEEP'
      ) {
        throw new AccessScopeError(
          'PLAN_HANDLE_MISMATCH',
          'an identity without a qualification cannot carry qualification effects',
        );
      }
    }
    await this.assertResolutionFreshness(claims);
    const result = await this.persistence.stageRecognitionResult(this.context, plan);
    this.assertOpen();
    return result;
  }

  protected override async discardPersistence(): Promise<void> {
    await this.persistence.discard?.(this.context);
  }

  private makeHandle(
    media: ResolutionMedia,
    resolved: ResolvedIdentitySnapshot,
    resolutionOverride?: ResolutionHandleClaims['resolution'],
  ): ResolutionHandle {
    let normalized = resolved;
    const qualification = resolved.qualification;
    const mapping = resolved.mapping;
    if (
      mapping !== null &&
      (qualification === null ||
        mapping.qualificationId !== qualification.qualificationId ||
        mapping.qualificationIncarnation !== qualification.incarnation)
    ) {
      throw new AccessScopeError(
        'HANDLE_RESOLUTION_MISMATCH',
        'resolved mapping does not belong to the resolved qualification',
      );
    }
    if (media === 'FACE_MATCHED' && qualification !== null && mapping === null) {
      normalized = { qualification: null, mapping: null };
    }
    return createResolutionHandle(
      snapshotToHandleClaims(
        this.scopeToken,
        this.context,
        this.epoch,
        this.owner,
        this.generation,
        media,
        normalized,
        resolutionOverride,
      ),
    );
  }

  private makeInactiveHandle(media: ResolutionMedia): ResolutionHandle {
    return this.makeHandle(media, { qualification: null, mapping: null }, 'SOURCE_INACTIVE');
  }

  private assertSourceActiveForResolution(): void {
    if (this.#sourceActive === undefined) {
      throw new AccessScopeError(
        'SOURCE_FACTS_REQUIRED',
        'source facts must be read before identity resolution',
      );
    }
  }

  private assertHandle(handle: ResolutionHandle): ResolutionHandleClaims {
    this.assertOpen();
    const claims = readResolutionHandleClaims(handle);
    if (claims === null) {
      throw new AccessScopeError(
        'INVALID_HANDLE',
        'resolution handle was not issued by PassHub access composition',
      );
    }
    if (claims.scopeToken !== this.scopeToken) {
      throw new AccessScopeError(
        'HANDLE_SCOPE_MISMATCH',
        'resolution handle belongs to another operation scope',
      );
    }
    if (
      claims.context !== this.context ||
      claims.epoch !== this.epoch ||
      claims.owner !== this.owner ||
      claims.generation !== this.generation
    ) {
      throw new AccessScopeError(
        'HANDLE_SCOPE_MISMATCH',
        'resolution handle belongs to another scope epoch or owner',
      );
    }
    return claims;
  }

  private assertQualificationIdentity(
    claims: ResolutionHandleClaims,
    qualification: QualificationSnapshot,
  ): void {
    if (
      qualification.qualificationId !== claims.qualificationId ||
      qualification.incarnation !== claims.qualificationIncarnation ||
      qualification.version !== claims.qualificationVersion
    ) {
      throw new AccessScopeError(
        'HANDLE_RESOLUTION_MISMATCH',
        'qualification changed after identity resolution',
      );
    }
  }

  private async assertResolutionFreshness(
    claims: ResolutionHandleClaims,
  ): Promise<void> {
    if (claims.qualificationId === null) {
      return;
    }
    const qualification = await this.persistence.readQualification(
      this.context,
      claims.qualificationId,
    );
    this.assertOpen();
    if (qualification === null) {
      throw new AccessScopeError(
        'HANDLE_RESOLUTION_MISMATCH',
        'qualification disappeared before result staging',
      );
    }
    this.assertQualificationIdentity(claims, qualification);
    const mapping = await this.persistence.readMapping(
      this.context,
      claims.qualificationId,
    );
    this.assertOpen();
    if (mapping === null) {
      if (claims.mappingIncarnation !== null || claims.mappingVersion !== null) {
        throw new AccessScopeError(
          'HANDLE_RESOLUTION_MISMATCH',
          'face mapping disappeared before result staging',
        );
      }
      return;
    }
    if (
      claims.mappingIncarnation === null ||
      claims.mappingVersion === null ||
      mapping.qualificationId !== claims.qualificationId ||
      mapping.qualificationIncarnation !== claims.qualificationIncarnation ||
      mapping.mappingIncarnation !== claims.mappingIncarnation ||
      mapping.version !== claims.mappingVersion
    ) {
      throw new AccessScopeError(
        'HANDLE_RESOLUTION_MISMATCH',
        'face mapping changed before result staging',
      );
    }
  }
}
