import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  MongoClient,
  type ClientSession,
  type Db,
  type MongoError,
} from 'mongodb';

import type {
  AccessScopeContext,
  AccessQueryPort,
  FaceMappingSnapshot,
  ManagementChangePlan,
  ManagementChangeResult,
  ManagementDataPort,
  QualificationSnapshot,
  RecognitionDataPort,
  RecognitionPersistenceResult,
  RecognitionResultPlan,
  ResolvedIdentitySnapshot,
  SourceFacts,
  SourceFactsPort,
} from '../../access/ports/index.js';
import { isAccessScopeContextRetired, readAccessScopeContextClaims } from '../../shared/access-scope-context.js';
import { isComparisonArtifact, type ComparisonArtifact } from '../../access/ports/comparison-artifact.js';
import { assertExternalEventId, assertExternalSubjectId, assertProvider } from '../../access/application/comparison/recognition-input.js';
import { assertQualificationState, type AccessDecision, type QualificationState, type ReasonCode } from '../../access/domain/index.js';
import {
  ensureG04bSchema,
  assertG04bMetadataBootstrap,
  type G04bCollections,
  type G04bEventDocument,
  type G04bMetadataDocument,
  type G04bQualificationDocument,
} from './g04b-schema.js';
import { createG04bFixture, type G04bFixture } from './g04b-fixture.js';
import {
  readManagementPersistenceEnvelope,
  readRecognitionPersistenceEnvelope,
} from '../../access/ports/trusted-operation.js';

export const G04B_MONGO_VERSION = '8.0.32';
export const G04B_DEFAULT_DATABASE = 'passhub_g04b_atomic';
export const G04B_FACE_SLOT_CAPACITY = 4096;
export const G04B_TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' as const },
  readPreference: 'primary' as const,
  writeConcern: { w: 'majority' as const, j: true },
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface G04bClock {
  nowMs(): number;
}

const SYSTEM_CLOCK: G04bClock = Object.freeze({ nowMs: () => Date.now() });

export interface G04bManagementResult {
  readonly operation: 'CREATE' | 'UPDATE' | 'REVOKE';
  readonly qualificationId: string;
  readonly incarnation: string;
  readonly version: number;
  readonly summary: Readonly<{
    qualificationId: string;
    displayName: string;
    validFromMs: number;
    validUntilMs: number;
    presence: QualificationState['presence'];
  }>;
  readonly qrToken: string | null;
}

export type G04bPersistenceStatus = 'COMMITTED' | 'REPLAYED' | 'CONFLICT' | 'UNKNOWN';

export interface G04bErrorFacts {
  readonly kind: G04bTransactionErrorKind;
  readonly stage: G04bTransactionStage;
  readonly code: number | null;
  readonly labels: readonly string[];
}

export interface G04bRecognitionResult {
  readonly status: G04bPersistenceStatus;
  readonly eventId: string | null;
  readonly error: G04bErrorFacts | null;
  readonly decision: AccessDecision | null;
}

export interface G04bCanonicalSnapshot {
  readonly event: Readonly<{
    eventId: string;
    sourceId: string;
    direction: 'ENTRY' | 'EXIT';
    kind: 'QR_SCANNED' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
    outcome: 'ACCEPTED' | 'REJECTED';
    reasonCode: string;
    receivedAtMs: number;
    recordedAtMs: number;
    qualificationId: string | null;
    presenceTransition: G04bEventDocument['presenceTransition'];
  }>;
  readonly qualification: QualificationSnapshot | null;
  readonly mapping: FaceMappingSnapshot | null;
  readonly guardVersions: Readonly<{ qr: number; face: number }>;
}

export type G04bTransactionStage =
  | 'begin' | 'read' | 'guard' | 'qualification' | 'mapping' | 'event' | 'commit' | 'abort' | 'canonical';
export type G04bTransactionErrorKind =
  | 'DUPLICATE_KEY' | 'WRITE_CONFLICT' | 'SCHEMA_VALIDATION'
  | 'IDEMPOTENCY_CONFLICT' | 'TRANSACTION_ABORTED' | 'UNKNOWN_COMMIT_RESULT' | 'OTHER';

export class G04bTransactionError extends Error {
  public constructor(public readonly facts: G04bErrorFacts, cause: unknown) {
    super(`G04b transaction ${facts.kind} at ${facts.stage}`, { cause });
    this.name = 'G04bTransactionError';
  }
}

export class G04bTechnicalError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'G04bTechnicalError';
  }
}

interface TransactionState {
  readonly session: ClientSession;
  readonly datasetEpoch: string;
  readonly sourceFacts: Map<string, SourceFacts>;
  readonly sourceGuards: Map<string, { incarnation: string; version: number }>;
  readonly qualifications: Map<string, G04bQualificationDocument>;
  readonly mappings: Map<string, FaceMappingSnapshot | null>;
  stage: G04bTransactionStage;
}

export class G04bMongoPersistenceAdapter
  implements ManagementDataPort, RecognitionDataPort, SourceFactsPort, AccessQueryPort {
  private readonly database: Db;
  private collections: G04bCollections | null = null;
  private readonly transactions = new WeakMap<object, TransactionState>();

  public constructor(
    private readonly client: MongoClient,
    databaseName: string = G04B_DEFAULT_DATABASE,
    private readonly clock: G04bClock = SYSTEM_CLOCK,
  ) {
    if (databaseName.length === 0) throw new TypeError('G04b database name must not be empty');
    this.database = client.db(databaseName);
  }

  public static async connect(
    uri: string,
    databaseName: string = G04B_DEFAULT_DATABASE,
    clock: G04bClock = SYSTEM_CLOCK,
  ): Promise<G04bMongoPersistenceAdapter> {
    if (uri.length === 0) throw new TypeError('MongoDB URI must not be empty');
    const client = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    await client.connect();
    const adapter = new G04bMongoPersistenceAdapter(client, databaseName, clock);
    try {
      await adapter.assertMongo8032ReplicaSet();
      return adapter;
    } catch (error: unknown) {
      await client.close();
      throw error;
    }
  }

  public async close(): Promise<void> { await this.client.close(); }

  /** Scope lifecycle hook: abort at most once, then end the session. */
  public async discard(context: AccessScopeContext): Promise<void> {
    const state = this.transactions.get(context as object);
    if (state === undefined) return;
    this.transactions.delete(context as object);
    let abortError: unknown = null;
    if (state.session.inTransaction()) {
      state.stage = 'abort';
      try { await state.session.abortTransaction(); } catch (error: unknown) { abortError = error; }
    }
    await state.session.endSession().catch(() => undefined);
    if (abortError !== null) throw new G04bTransactionError(classifyG04bTransactionError(abortError, 'abort'), abortError);
  }

  public async assertMongo8032ReplicaSet(): Promise<void> {
    const buildInfo = await this.database.command({ buildInfo: 1 }) as { version?: unknown };
    if (buildInfo.version !== G04B_MONGO_VERSION) throw new G04bTechnicalError(`G04b requires MongoDB ${G04B_MONGO_VERSION}`);
    const hello = await this.database.command({ hello: 1 }) as { setName?: unknown; isWritablePrimary?: unknown; hosts?: unknown };
    if (hello.setName !== 'rs0' || hello.isWritablePrimary !== true || !Array.isArray(hello.hosts) || hello.hosts.length !== 1) {
      throw new G04bTechnicalError('G04b requires an rs0 writable single-member replica set');
    }
  }

  public async ensureSchema(): Promise<G04bCollections> {
    await this.assertMongo8032ReplicaSet();
    this.collections = await ensureG04bSchema(this.database);
    return this.collections;
  }

  /** Destructive fixture setup, intentionally outside business transactions. */
  public async clearAndSeed(fixture: G04bFixture = createG04bFixture()): Promise<void> {
    const collections = this.requireCollections();
    assertG04bMetadataBootstrap(fixture.metadata);
    await collections.events.deleteMany({});
    await collections.qualifications.deleteMany({});
    await collections.faceSlots.deleteMany({});
    await collections.users.deleteMany({});
    await collections.sources.deleteMany({});
    await collections.metadata.deleteMany({});
    if (fixture.events.length > 0) await collections.events.insertMany([...fixture.events]);
    if (fixture.qualifications.length > 0) await collections.qualifications.insertMany([...fixture.qualifications]);
    if (fixture.faceSlots.length > 0) await collections.faceSlots.insertMany([...fixture.faceSlots]);
    if (fixture.users.length > 0) await collections.users.insertMany([...fixture.users]);
    if (fixture.sources.length > 0) await collections.sources.insertMany([...fixture.sources]);
    await collections.metadata.insertOne(fixture.metadata);
  }

  public async readSourceFacts(context: AccessScopeContext, sourceId: string): Promise<SourceFacts> {
    const state = await this.begin(context);
    try {
      const found = await this.requireCollections().sources.findOne({ _id: sourceId }, { session: state.session });
      if (found === null) throw new G04bTechnicalError('source is missing');
      const facts: SourceFacts = { sourceId: found._id, direction: found.direction, active: found.active };
      state.sourceFacts.set(sourceId, facts);
      state.sourceGuards.set(sourceId, { incarnation: found.incarnation, version: found.version });
      return facts;
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async read(context: AccessScopeContext, sourceId: string): Promise<SourceFacts> {
    return this.readSourceFacts(context, sourceId);
  }

  public async readQualification(context: AccessScopeContext, qualificationId: string): Promise<QualificationSnapshot | null> {
    const state = await this.begin(context);
    try {
      const document = await this.requireCollections().qualifications.findOne({ _id: qualificationId }, { session: state.session });
      const snapshot = document === null ? null : toQualificationSnapshot(document);
      if (document !== null) state.qualifications.set(qualificationId, document);
      return snapshot;
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async readMapping(context: AccessScopeContext, qualificationId: string): Promise<FaceMappingSnapshot | null> {
    const state = await this.begin(context);
    try {
      const mappings = await this.requireCollections().faceSlots.find({
        qualificationId: { $eq: qualificationId, $type: 'string' },
      }, { session: state.session }).toArray();
      const mapping = mappingFromSlots(mappings, qualificationId);
      state.mappings.set(qualificationId, mapping);
      return mapping;
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async resolveQr(context: AccessScopeContext, lookupDigest: string): Promise<ResolvedIdentitySnapshot> {
    const state = await this.begin(context);
    try {
      const document = await this.requireCollections().qualifications.findOne({ qrLookupDigest: lookupDigest }, { session: state.session });
      if (document === null) return { qualification: null, mapping: null };
      state.qualifications.set(document._id, document);
      const mapping = await this.mappingForQualification(document._id, state);
      state.mappings.set(document._id, mapping);
      return { qualification: toQualificationSnapshot(document), mapping };
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async resolveFace(context: AccessScopeContext, provider: string, externalSubjectId: string): Promise<ResolvedIdentitySnapshot> {
    const state = await this.begin(context);
    try {
      const slots = await this.requireCollections().faceSlots.find({ provider, subject: externalSubjectId, qualificationId: { $type: 'string' } }, { session: state.session }).toArray();
      if (slots.length > 1) throw new G04bTechnicalError('face subject has multiple current mappings');
      const slot = slots[0];
      if (slot === undefined || slot.qualificationId === null || slot.qualificationIncarnation === null) return { qualification: null, mapping: null };
      const qualification = await this.requireCollections().qualifications.findOne({ _id: slot.qualificationId }, { session: state.session });
      if (qualification === null || qualification.incarnation !== slot.qualificationIncarnation) throw new G04bTechnicalError('face mapping points to a missing or stale qualification');
      const mapping = mappingFromSlot(slot);
      state.qualifications.set(qualification._id, qualification);
      state.mappings.set(qualification._id, mapping);
      return { qualification: toQualificationSnapshot(qualification), mapping };
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async stageManagementChange(context: AccessScopeContext, plan: ManagementChangePlan): Promise<ManagementChangeResult> {
    return this.stageManagementChangeWithResult(context, plan);
  }

  public async stageManagementChangeWithResult(context: AccessScopeContext, plan: ManagementChangePlan): Promise<G04bManagementResult> {
    if (plan.faceMapping !== null && plan.faceMapping !== undefined) {
      assertProvider(plan.faceMapping.provider);
      assertExternalSubjectId(plan.faceMapping.externalSubjectId);
    }
    const state = await this.begin(context);
    try {
      const result = await this.applyManagementChange(state, plan);
      await this.commit(context, state);
      return result;
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async stageRecognitionResult(context: AccessScopeContext, plan: RecognitionResultPlan): Promise<RecognitionPersistenceResult> {
    const result = await this.stageRecognitionResultWithResult(context, plan);
    if (result.status !== 'COMMITTED' && result.status !== 'REPLAYED') {
      throw new G04bTransactionError(
        result.error ?? { kind: 'OTHER', stage: 'event', code: null, labels: [] },
        result.error,
      );
    }
    if (result.eventId === null || result.decision === null) {
      throw new G04bTechnicalError('recognition persistence result is incomplete');
    }
    return { status: result.status, eventId: result.eventId, decision: result.decision };
  }

  public async stageRecognitionResultWithResult(context: AccessScopeContext, plan: RecognitionResultPlan): Promise<G04bRecognitionResult> {
    const state = await this.begin(context);
    try {
      const result = await this.applyRecognitionResult(state, plan);
      await this.commit(context, state);
      return result;
    } catch (error: unknown) {
      try {
        await this.fail(context, state, error);
      } catch (failed: unknown) {
        if (failed instanceof G04bTransactionError &&
            (failed.facts.kind === 'DUPLICATE_KEY' || failed.facts.kind === 'WRITE_CONFLICT')) {
          const envelope = readRecognitionPersistenceEnvelope(plan as object);
          if (envelope === null) return { status: 'UNKNOWN', eventId: null, error: failed.facts, decision: null };
          const canonical = await this.readCanonicalSnapshotInternal(envelope.sourceId, envelope.externalEventId);
          if (canonical === null) return {
            status: 'UNKNOWN', eventId: null,
            error: failed.facts,
            decision: null,
          };
          if (canonical.event.inputHmac === envelope.comparisonArtifact.inputHmac && canonical.event.comparisonReferenceId === envelope.comparisonArtifact.comparisonReferenceId) {
            return { status: 'REPLAYED', eventId: canonical.event._id, error: null, decision: decisionFromEvent(canonical.event) };
          }
          return {
            status: 'CONFLICT', eventId: canonical.event._id,
            error: { kind: 'IDEMPOTENCY_CONFLICT', stage: 'canonical', code: failed.facts.code, labels: failed.facts.labels },
            decision: null,
          };
        }
        if (failed instanceof G04bTransactionError && failed.facts.kind === 'UNKNOWN_COMMIT_RESULT') {
          return { status: 'UNKNOWN', eventId: null, error: failed.facts, decision: null };
        }
        throw failed;
      }
      throw error;
    }
  }

  /** Read-only snapshot lookup used after an unknown/competing commit. */
  public async readCanonicalSnapshot(sourceId: string, externalEventId: string): Promise<G04bCanonicalSnapshot | null> {
    const result = await this.readCanonicalSnapshotInternal(sourceId, externalEventId);
    return result === null ? null : redactCanonical(result);
  }

  /** Compatibility primitive: only the redacted event projection is returned. */
  public async readCanonicalEvent(sourceId: string, externalEventId: string): Promise<G04bCanonicalSnapshot['event'] | null> {
    const result = await this.readCanonicalSnapshot(sourceId, externalEventId);
    return result?.event ?? null;
  }

  public async qualifications(input: Readonly<{ limit: number; cursor?: string }>): Promise<readonly import('../../access/ports/index.js').RedactedQualificationProjection[]> {
    const limit = queryLimit(input.limit);
    const documents = await this.requireCollections().qualifications.find({}, { readPreference: 'primary', readConcern: { level: 'majority' } }).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
    return this.redactQualifications(documents);
  }

  public async inside(input: Readonly<{ limit: number; cursor?: string }>): Promise<readonly import('../../access/ports/index.js').RedactedQualificationProjection[]> {
    const limit = queryLimit(input.limit);
    const documents = await this.requireCollections().qualifications.find({ presence: 'INSIDE' }, { readPreference: 'primary', readConcern: { level: 'majority' } }).sort({ enteredAt: -1, _id: -1 }).limit(limit).toArray();
    return this.redactQualifications(documents);
  }

  public async events(input: Readonly<{ limit: number; cursor?: string; qualificationId?: string; outcome?: 'ACCEPTED' | 'REJECTED'; reasonCode?: string }>): Promise<readonly import('../../access/ports/index.js').RedactedAccessEventProjection[]> {
    const limit = queryLimit(input.limit);
    const filter: Record<string, unknown> = {};
    if (input.qualificationId !== undefined) filter.qualificationId = input.qualificationId;
    if (input.outcome !== undefined) filter.outcome = input.outcome;
    if (input.reasonCode !== undefined) filter.reasonCode = input.reasonCode;
    const documents = await this.requireCollections().events.find(filter, { readPreference: 'primary', readConcern: { level: 'majority' } }).sort({ receivedAt: -1, _id: -1 }).limit(limit).toArray();
    return documents.map((event) => ({
      eventId: event._id, sourceId: event.sourceId, direction: event.direction, kind: event.kind,
      outcome: event.outcome, reasonCode: event.reasonCode as import('../../access/domain/index.js').ReasonCode,
      receivedAtMs: event.receivedAt.getTime(), recordedAtMs: event.recordedAt.getTime(),
      qualificationId: event.qualificationId, presenceTransition: event.presenceTransition,
    }));
  }

  private async redactQualifications(documents: readonly G04bQualificationDocument[]): Promise<readonly import('../../access/ports/index.js').RedactedQualificationProjection[]> {
    const result: import('../../access/ports/index.js').RedactedQualificationProjection[] = [];
    for (const document of documents) {
      const faceBound = await this.requireCollections().faceSlots.countDocuments({ qualificationId: document._id, qualificationIncarnation: document.incarnation }, { readPreference: 'primary', readConcern: { level: 'majority' } }) > 0;
      result.push({
        qualificationId: document._id, displayName: document.displayName, validFromMs: document.validFrom.getTime(), validUntilMs: document.validUntil.getTime(),
        presence: document.presence, revokedAtMs: nullableTime(document.revokedAt), revocationReason: document.revocationReason,
        expiredTerminalAtMs: nullableTime(document.expiredTerminalAt), faceBound, createdAtMs: document.createdAt.getTime(), updatedAtMs: document.updatedAt.getTime(),
      });
    }
    return result;
  }

  private async readCanonicalSnapshotInternal(sourceId: string, externalEventId: string): Promise<{
    readonly event: G04bEventDocument;
    readonly qualification: QualificationSnapshot | null;
    readonly mapping: FaceMappingSnapshot | null;
    readonly guardVersions: Readonly<{ qr: number; face: number }>;
  } | null> {
    const session = this.client.startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
      const collections = this.requireCollections();
      const event = await collections.events.findOne({ sourceId, externalEventId }, { session });
      if (event === null) {
        await session.commitTransaction();
        return null;
      }
      const qualificationDocument = event.qualificationId === null
        ? null
        : await collections.qualifications.findOne({ _id: event.qualificationId }, { session });
      const qualification = qualificationDocument === null ? null : toQualificationSnapshot(qualificationDocument);
      const mapping = event.qualificationId === null
        ? null
        : mappingFromSlots(await collections.faceSlots.find({ qualificationId: { $eq: event.qualificationId, $type: 'string' } }, { session }).toArray(), event.qualificationId);
      const metadata = await collections.metadata.findOne({ _id: 'system' }, { session });
      if (metadata === null) throw new G04bTechnicalError('metadata system document is missing');
      await session.commitTransaction();
      return { event, qualification, mapping, guardVersions: { qr: metadata.qrGuardVersion, face: metadata.faceGuardVersion } };
    } catch (error: unknown) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
      throw error;
    } finally {
      await session.endSession();
    }
  }

  private async applyManagementChange(state: TransactionState, plan: ManagementChangePlan): Promise<G04bManagementResult> {
    state.stage = 'guard';
    const now = this.dateFromClock();
    const managementEnvelope = readManagementPersistenceEnvelope(plan as object);
    if (managementEnvelope === null || !Number.isSafeInteger(managementEnvelope.receivedAtMs)) throw new G04bTechnicalError('management trusted envelope is required');
    if (!UUID_V4.test(managementEnvelope.actorId)) throw new G04bTechnicalError('management actorId must be a canonical UUID v4');
    if (plan.operation === 'CREATE') {
      const qualificationId = randomUUID();
      const incarnation = randomUUID();
      const token = randomUuidToken();
      const validFrom = new Date(requiredNumber(plan.validFromMs, 'validFromMs'));
      const validUntil = new Date(requiredNumber(plan.validUntilMs, 'validUntilMs'));
      const document: G04bQualificationDocument = {
        _id: qualificationId, incarnation, version: 0,
        displayName: requiredString(plan.displayName, 'displayName'), validFrom, validUntil,
        createdBy: managementEnvelope.actorId, qrLookupDigest: sha256Lookup(token), presence: 'NOT_ENTERED',
        enteredAt: null, exitedAt: null, revokedAt: null, revocationReason: null, expiredTerminalAt: null,
        createdAt: now, updatedAt: now,
      };
      state.stage = 'qualification';
      await this.requireCollections().qualifications.insertOne(document, { session: state.session });
      await this.bumpGuard(state, 'qr');
      if (plan.faceMapping !== null && plan.faceMapping !== undefined) {
        await this.bindNewFace(state, qualificationId, incarnation, plan.faceMapping);
        await this.bumpGuard(state, 'face');
      }
      await this.ensureSlotCount(state);
      return {
        operation: 'CREATE', qualificationId, incarnation, version: 0,
        summary: { qualificationId, displayName: document.displayName, validFromMs: validFrom.getTime(), validUntilMs: validUntil.getTime(), presence: document.presence },
        qrToken: token,
      };
    }
    if (plan.qualificationId === null) throw new G04bTechnicalError('management qualificationId is required');
    const current = state.qualifications.get(plan.qualificationId) ?? await this.requireCollections().qualifications.findOne({ _id: plan.qualificationId }, { session: state.session });
    if (current === null || current === undefined) throw new G04bTechnicalError('qualification is missing');
    const expected = { _id: current._id, incarnation: current.incarnation, version: current.version };
    if (plan.operation === 'REVOKE') {
      const reason = requiredString(plan.revocationReason, 'revocationReason');
      const updated = await this.requireCollections().qualifications.updateOne(expected, {
        $set: { revokedAt: now, revocationReason: reason, updatedAt: now }, $inc: { version: 1 },
      }, { session: state.session });
      assertModified(updated.modifiedCount, 'revoke qualification');
      await this.releaseFaceForQualification(state, current._id, current.incarnation);
      await this.bumpGuard(state, 'face');
      await this.ensureSlotCount(state);
      return this.managementSummary('REVOKE', current, current.version + 1, null);
    }
    const displayName = requiredString(plan.displayName, 'displayName');
    const validFrom = new Date(requiredNumber(plan.validFromMs, 'validFromMs'));
    const validUntil = new Date(requiredNumber(plan.validUntilMs, 'validUntilMs'));
    const currentMapping = state.mappings.has(current._id) ? state.mappings.get(current._id) ?? null : await this.mappingForQualification(current._id, state);
    const mappingChanged = plan.faceMapping !== undefined;
    if (mappingChanged && plan.faceMapping === null && currentMapping !== null) await this.releaseFaceForQualification(state, current._id, current.incarnation);
    if (mappingChanged && plan.faceMapping !== null && plan.faceMapping !== undefined) {
      if (currentMapping !== null && (currentMapping as FaceMappingSnapshot).mappingIncarnation !== undefined) await this.releaseFaceForQualification(state, current._id, current.incarnation);
      await this.bindNewFace(state, current._id, current.incarnation, plan.faceMapping);
    }
    const updated = await this.requireCollections().qualifications.updateOne(expected, {
      $set: { displayName, validFrom, validUntil, updatedAt: now }, $inc: { version: 1 },
    }, { session: state.session });
    assertModified(updated.modifiedCount, 'update qualification');
    if (mappingChanged) await this.bumpGuard(state, 'face');
    await this.ensureSlotCount(state);
    return this.managementSummary('UPDATE', { ...current, displayName, validFrom, validUntil }, current.version + 1, null);
  }

  private async applyRecognitionResult(state: TransactionState, plan: RecognitionResultPlan): Promise<G04bRecognitionResult> {
    state.stage = 'guard';
    const envelope = readRecognitionPersistenceEnvelope(plan as object);
    if (envelope === null || !Number.isSafeInteger(envelope.receivedAtMs)) throw new G04bTechnicalError('recognition trusted envelope is required');
    const sourceId = requiredString(envelope.sourceId, 'sourceId');
    if (!UUID_V4.test(sourceId)) throw new G04bTechnicalError('sourceId must be a canonical UUID v4');
    const externalEventId = requiredString(envelope.externalEventId, 'externalEventId');
    try { assertExternalEventId(externalEventId); } catch (error: unknown) { throw new G04bTechnicalError('externalEventId violates its fixed grammar', error); }
    if (envelope.direction !== 'ENTRY' && envelope.direction !== 'EXIT') throw new G04bTechnicalError('recognition direction is invalid');
    const artifact = requireArtifact(envelope.comparisonArtifact);

    // The envelope is an internal WeakMap trusted boundary; G04b has no HTTP/auth layer.
    // Once the source+external key and artifact are safely validated, persisted Event is canonical.
    const existing = await this.requireCollections().events.findOne({ sourceId, externalEventId }, { session: state.session });
    if (existing !== null) {
      if (existing.inputHmac !== artifact.inputHmac || existing.comparisonReferenceId !== artifact.comparisonReferenceId) {
        return {
          status: 'CONFLICT',
          eventId: existing._id,
          error: { kind: 'IDEMPOTENCY_CONFLICT', stage: 'event', code: null, labels: [] },
          decision: null,
        };
      }
      return { status: 'REPLAYED', eventId: existing._id, error: null, decision: decisionFromEvent(existing) };
    }

    let source = state.sourceFacts.get(envelope.sourceId);
    if (source === undefined) {
      const sourceDocument = await this.requireCollections().sources.findOne({ _id: envelope.sourceId }, { session: state.session });
      if (sourceDocument === null) throw new G04bTechnicalError('source is missing');
      source = { sourceId: sourceDocument._id, direction: sourceDocument.direction, active: sourceDocument.active };
      state.sourceFacts.set(envelope.sourceId, source);
      state.sourceGuards.set(envelope.sourceId, { incarnation: sourceDocument.incarnation, version: sourceDocument.version });
    }
    if (source === undefined) throw new G04bTechnicalError('source facts are required for recognition persistence');
    const sourceGuard = state.sourceGuards.get(source.sourceId);
    if (sourceGuard === undefined) throw new G04bTechnicalError('source guard is missing');
    const guardedSource = await this.requireCollections().sources.findOne({ _id: source.sourceId, incarnation: sourceGuard.incarnation, version: sourceGuard.version, direction: source.direction, active: source.active }, { session: state.session });
    if (guardedSource === null) throw new G04bTechnicalError('source freshness guard failed');
    const receivedAtMs = envelope.receivedAtMs;
    const direction = envelope.direction;
    if (direction !== source.direction) throw new G04bTechnicalError('recognition direction does not match source');
    const metadata = await this.readMetadata(state);
    if (artifact.comparisonReferenceId !== metadata.comparisonReferenceId) throw new G04bTechnicalError('comparison artifact reference is incompatible with metadata');

    const sourceGuardWrite = await this.requireCollections().sources.updateOne(
      { _id: source.sourceId, incarnation: sourceGuard.incarnation, version: sourceGuard.version, direction: source.direction, active: source.active },
      { $set: { direction: source.direction, active: source.active }, $inc: { version: 1 } },
      { session: state.session },
    );
    if (sourceGuardWrite.matchedCount !== 1) throw new G04bTechnicalError('source freshness write guard failed');
    if (plan.qualificationId !== null) {
      const current = state.qualifications.get(plan.qualificationId) ?? await this.requireCollections().qualifications.findOne({ _id: plan.qualificationId }, { session: state.session });
      if (current === null || current === undefined || current.incarnation !== plan.qualificationIncarnation || current.version !== plan.qualificationVersion) throw new G04bTechnicalError('recognition qualification guard failed');
      await this.applyQualificationEffect(state, current, plan, receivedAtMs);
      if (plan.faceMappingEffect === 'RELEASE') await this.releaseFaceForQualification(state, current._id, current.incarnation);
    }
    if (plan.media === 'QR') await this.bumpGuard(state, 'qr');
    else await this.bumpGuard(state, 'face');

    state.stage = 'event';
    const eventId = randomUUID();
    const document: G04bEventDocument = {
      _id: eventId, sourceId: source.sourceId, externalEventId, kind: plan.media === 'QR' ? 'QR_SCANNED' : plan.media,
      direction, outcome: plan.outcome, reasonCode: plan.reasonCode,
      receivedAt: new Date(receivedAtMs), recordedAt: this.dateFromClock(), qualificationId: plan.qualificationId,
      presenceTransition: plan.presenceTransition, inputHmac: artifact.inputHmac, comparisonReferenceId: artifact.comparisonReferenceId,
    };
    await this.requireCollections().events.insertOne(document, { session: state.session });
    await this.ensureSlotCount(state);
    return { status: 'COMMITTED', eventId, error: null, decision: decisionFromPlan(plan) };
  }

  private async applyQualificationEffect(state: TransactionState, current: G04bQualificationDocument, plan: RecognitionResultPlan, receivedAtMs: number): Promise<void> {
    state.stage = 'qualification';
    const set: Record<string, unknown> = { updatedAt: this.dateFromClock() };
    if (plan.presenceTransition !== null) {
      if (plan.presenceTransition.from !== current.presence) throw new G04bTechnicalError('presence guard failed');
      set.presence = plan.presenceTransition.to;
      if (plan.presenceTransition.to === 'INSIDE') set.enteredAt = new Date(receivedAtMs);
      if (plan.presenceTransition.to === 'EXITED') set.exitedAt = new Date(receivedAtMs);
    }
    if (plan.qualificationEffect === 'EXPIRE_NOT_ENTERED') set.expiredTerminalAt = new Date(receivedAtMs);
    const updated = await this.requireCollections().qualifications.updateOne({ _id: current._id, incarnation: current.incarnation, version: current.version }, { $set: set, $inc: { version: 1 } }, { session: state.session });
    assertModified(updated.modifiedCount, 'recognition qualification');
  }

  private async bindNewFace(state: TransactionState, qualificationId: string, qualificationIncarnation: string, mapping: Readonly<{ provider: string; externalSubjectId: string }>): Promise<void> {
    const empty = await this.requireCollections().faceSlots.findOne({ qualificationId: null, qualificationIncarnation: null }, { session: state.session });
    if (empty === null) {
      const metadata = await this.readMetadata(state);
      if (metadata.slotCount >= G04B_FACE_SLOT_CAPACITY) throw new G04bTechnicalError('FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED');
      await this.requireCollections().faceSlots.insertOne({
        _id: randomUUID(), provider: mapping.provider, subject: mapping.externalSubjectId,
        qualificationId, qualificationIncarnation, slotIncarnation: randomUUID(), version: 0,
      }, { session: state.session });
      const countUpdate = await this.requireCollections().metadata.updateOne({ _id: 'system', slotCount: metadata.slotCount }, { $inc: { slotCount: 1 } }, { session: state.session });
      assertModified(countUpdate.modifiedCount, 'allocate face slot count');
      return;
    }
    const updated = await this.requireCollections().faceSlots.updateOne({ _id: empty._id, qualificationId: null, qualificationIncarnation: null }, { $set: { provider: mapping.provider, subject: mapping.externalSubjectId, qualificationId, qualificationIncarnation }, $inc: { version: 1 } }, { session: state.session });
    assertModified(updated.modifiedCount, 'bind face slot');
  }

  private async releaseFaceForQualification(state: TransactionState, qualificationId: string, incarnation: string): Promise<void> {
    const slots = await this.requireCollections().faceSlots.find({ qualificationId: { $eq: qualificationId, $type: 'string' } }, { session: state.session }).toArray();
    if (slots.length > 1) throw new G04bTechnicalError('qualification has multiple current face mappings');
    const slot = slots[0];
    if (slot === undefined) return;
    if (slot.qualificationIncarnation !== incarnation) throw new G04bTechnicalError('face mapping incarnation mismatch');
    const updated = await this.requireCollections().faceSlots.updateOne({ _id: slot._id, qualificationId, qualificationIncarnation: incarnation, version: slot.version }, { $set: { qualificationId: null, qualificationIncarnation: null }, $inc: { version: 1 } }, { session: state.session });
    assertModified(updated.modifiedCount, 'release face slot');
  }

  private async mappingForQualification(qualificationId: string, state: TransactionState): Promise<FaceMappingSnapshot | null> {
    const slots = await this.requireCollections().faceSlots.find({ qualificationId: { $eq: qualificationId, $type: 'string' } }, { session: state.session }).toArray();
    return mappingFromSlots(slots, qualificationId);
  }

  private async ensureSlotCount(state: TransactionState): Promise<void> {
    const metadata = await this.readMetadata(state);
    const count = await this.requireCollections().faceSlots.countDocuments({}, { session: state.session });
    if (count !== metadata.slotCount) throw new G04bTechnicalError('metadata slotCount does not match faceSlots');
  }

  private async bumpGuard(state: TransactionState, guard: 'qr' | 'face'): Promise<void> {
    const field = guard === 'qr' ? 'qrGuardVersion' : 'faceGuardVersion';
    const updated = await this.requireCollections().metadata.updateOne({ _id: 'system' }, { $inc: { [field]: 1 } }, { session: state.session });
    assertModified(updated.modifiedCount, `${guard} guard`);
  }

  private async readMetadata(state: TransactionState): Promise<G04bMetadataDocument> {
    const metadata = await this.requireCollections().metadata.findOne({ _id: 'system' }, { session: state.session });
    if (metadata === null) throw new G04bTechnicalError('metadata system document is missing');
    if (metadata.datasetEpoch !== state.datasetEpoch) throw new G04bTechnicalError('scope dataset epoch does not match metadata');
    return metadata;
  }

  private managementSummary(operation: 'UPDATE' | 'REVOKE', current: G04bQualificationDocument, version: number, qrToken: string | null): G04bManagementResult {
    return { operation, qualificationId: current._id, incarnation: current.incarnation, version, summary: { qualificationId: current._id, displayName: current.displayName, validFromMs: current.validFrom.getTime(), validUntilMs: current.validUntil.getTime(), presence: current.presence }, qrToken };
  }

  private async begin(context: AccessScopeContext): Promise<TransactionState> {
    if (isAccessScopeContextRetired(context)) throw new G04bTechnicalError('access scope context is retired');
    const claims = readAccessScopeContextClaims(context);
    if (claims === null) throw new G04bTechnicalError('recognition scope context claims are missing');
    const existing = this.transactions.get(context as object);
    if (existing !== undefined) return existing;
    const session = this.client.startSession();
    const state: TransactionState = { session, datasetEpoch: claims.epoch, sourceFacts: new Map(), sourceGuards: new Map(), qualifications: new Map(), mappings: new Map(), stage: 'begin' };
    try {
      session.startTransaction(G04B_TRANSACTION_OPTIONS);
      this.transactions.set(context as object, state);
      return state;
    } catch (error: unknown) {
      await session.endSession();
      throw new G04bTransactionError(classifyG04bTransactionError(error, 'begin'), error);
    }
  }

  private async commit(context: AccessScopeContext, state: TransactionState): Promise<void> {
    state.stage = 'commit';
    try {
      await state.session.commitTransaction();
      this.transactions.delete(context as object);
      await state.session.endSession();
    } catch (error: unknown) {
      const facts = classifyG04bTransactionError(error, 'commit');
      this.transactions.delete(context as object);
      await state.session.endSession().catch(() => undefined);
      throw new G04bTransactionError(facts, error);
    }
  }

  private async fail(context: AccessScopeContext, state: TransactionState, error: unknown): Promise<never> {
    const facts = error instanceof G04bTransactionError ? error.facts : classifyG04bTransactionError(error, state.stage);
    this.transactions.delete(context as object);
    let abortError: unknown = null;
    if (state.session.inTransaction() && facts.kind !== 'UNKNOWN_COMMIT_RESULT') {
      state.stage = 'abort';
      try { await state.session.abortTransaction(); } catch (candidate: unknown) { abortError = candidate; }
    }
    await state.session.endSession().catch(() => undefined);
    if (abortError !== null) throw new G04bTransactionError(classifyG04bTransactionError(abortError, 'abort'), abortError);
    if (error instanceof G04bTransactionError) throw error;
    throw new G04bTransactionError(facts, error);
  }

  private requireCollections(): G04bCollections {
    if (this.collections === null) throw new G04bTechnicalError('G04b schema has not been initialized');
    return this.collections;
  }

  private dateFromClock(): Date {
    const value = this.clock.nowMs();
    if (!Number.isSafeInteger(value)) throw new G04bTechnicalError('clock must return a safe integer');
    return new Date(value);
  }
}

export function classifyG04bTransactionError(error: unknown, stage: G04bTransactionStage): G04bErrorFacts {
  const candidate = error as Partial<MongoError> & { code?: unknown; errorLabels?: unknown };
  const code = typeof candidate.code === 'number' ? candidate.code : null;
  const labels = Array.isArray(candidate.errorLabels) ? candidate.errorLabels.filter((label): label is string => typeof label === 'string') : [];
  let kind: G04bTransactionErrorKind = 'OTHER';
  if (code === 11000 || code === 11001) kind = 'DUPLICATE_KEY';
  else if (code === 112) kind = 'WRITE_CONFLICT';
  else if (code === 121) kind = 'SCHEMA_VALIDATION';
  else if (stage === 'commit' && code === 251) kind = 'UNKNOWN_COMMIT_RESULT';
  else if (code === 251) kind = 'TRANSACTION_ABORTED';
  else if (labels.includes('UnknownTransactionCommitResult')) kind = 'UNKNOWN_COMMIT_RESULT';
  else if (stage === 'commit') kind = 'UNKNOWN_COMMIT_RESULT';
  return { kind, stage, code, labels };
}

function toQualificationSnapshot(document: G04bQualificationDocument): QualificationSnapshot {
  const state: QualificationState = {
    validFromMs: document.validFrom.getTime(), validUntilMs: document.validUntil.getTime(), presence: document.presence,
    enteredAtMs: nullableTime(document.enteredAt), exitedAtMs: nullableTime(document.exitedAt), revokedAtMs: nullableTime(document.revokedAt),
    revocationReason: document.revocationReason, expiredTerminalAtMs: nullableTime(document.expiredTerminalAt),
  };
  assertQualificationState(state);
  return { qualificationId: document._id, incarnation: document.incarnation, version: document.version, state };
}

function mappingFromSlots(slots: readonly { qualificationId: string | null; qualificationIncarnation: string | null; slotIncarnation: string; version: number }[], qualificationId: string): FaceMappingSnapshot | null {
  if (slots.length > 1) throw new G04bTechnicalError(`qualification ${qualificationId} has multiple face mappings`);
  const slot = slots[0];
  return slot === undefined || slot.qualificationId === null || slot.qualificationIncarnation === null ? null : {
    qualificationId: slot.qualificationId, qualificationIncarnation: slot.qualificationIncarnation, mappingIncarnation: slot.slotIncarnation, version: slot.version,
  };
}
function mappingFromSlot(slot: { qualificationId: string | null; qualificationIncarnation: string | null; slotIncarnation: string; version: number }): FaceMappingSnapshot | null {
  return slot.qualificationId === null || slot.qualificationIncarnation === null ? null : { qualificationId: slot.qualificationId, qualificationIncarnation: slot.qualificationIncarnation, mappingIncarnation: slot.slotIncarnation, version: slot.version };
}
function redactCanonical(input: {
  readonly event: G04bEventDocument;
  readonly qualification: QualificationSnapshot | null;
  readonly mapping: FaceMappingSnapshot | null;
  readonly guardVersions: Readonly<{ qr: number; face: number }>;
}): G04bCanonicalSnapshot {
  return {
    event: {
      eventId: input.event._id,
      sourceId: input.event.sourceId,
      direction: input.event.direction,
      kind: input.event.kind,
      outcome: input.event.outcome,
      reasonCode: input.event.reasonCode,
      receivedAtMs: input.event.receivedAt.getTime(),
      recordedAtMs: input.event.recordedAt.getTime(),
      qualificationId: input.event.qualificationId,
      presenceTransition: input.event.presenceTransition,
    },
    qualification: input.qualification,
    mapping: input.mapping,
    guardVersions: input.guardVersions,
  };
}
function nullableTime(value: Date | null): number | null { return value === null ? null : value.getTime(); }
function requiredNumber(value: number | null | undefined, label: string): number { if (value === null || value === undefined || !Number.isSafeInteger(value)) throw new G04bTechnicalError(`${label} is required`); return value; }
function requiredString(value: string | null | undefined, label: string): string { if (value === null || value === undefined || typeof value !== 'string' || value.length === 0) throw new G04bTechnicalError(`${label} is required`); return value; }
function queryLimit(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new G04bTechnicalError('query limit must be an integer from 1 to 100'); return value; }
function assertModified(count: number, label: string): void { if (count !== 1) throw new G04bTechnicalError(`${label} did not match exactly one document`); }
function requireArtifact(value: ComparisonArtifact | undefined): ComparisonArtifact {
  if (value === undefined || !isComparisonArtifact(value)) throw new G04bTechnicalError('verified comparison artifact is required');
  if (!/^[0-9a-f]{64}$/u.test(value.inputHmac) || !UUID_V4.test(value.comparisonReferenceId)) {
    throw new G04bTechnicalError('verified comparison artifact fields are malformed');
  }
  return value;
}
function decisionFromPlan(plan: RecognitionResultPlan): AccessDecision {
  return {
    outcome: plan.outcome,
    reasonCode: plan.reasonCode,
    presenceTransition: plan.presenceTransition,
    qualificationEffect: plan.qualificationEffect,
    faceMappingEffect: plan.faceMappingEffect,
  };
}
function decisionFromEvent(event: G04bEventDocument): AccessDecision {
  return {
    outcome: event.outcome,
    reasonCode: event.reasonCode as ReasonCode,
    presenceTransition: event.presenceTransition,
    qualificationEffect: event.reasonCode === 'QUALIFICATION_EXPIRED' ? 'EXPIRE_NOT_ENTERED' : 'NONE',
    faceMappingEffect: event.reasonCode === 'QUALIFICATION_EXPIRED' || event.reasonCode === 'EXIT_RECORDED' ? 'RELEASE' : 'KEEP',
  };
}
function randomUuidToken(): string { return randomBytes(32).toString('base64url'); }
function sha256Lookup(token: string): string { return createHash('sha256').update(Buffer.from('PassHub/qr-lookup/v1\0', 'utf8')).update(Buffer.from(token, 'utf8')).digest('hex'); }
