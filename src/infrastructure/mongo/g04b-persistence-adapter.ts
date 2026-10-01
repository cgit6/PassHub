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
  ManagementQualificationSummary,
  ManagementDataPort,
  ManagementQualificationSnapshot,
  QualificationSnapshot,
  RedactedAccessEventProjection,
  RecognitionDataPort,
  RecognitionPersistenceResult,
  RecognitionResultPlan,
  ResolvedIdentitySnapshot,
  SourceFacts,
  SourceFactsPort,
  QueryDataPort,
  QuerySnapshotQualification,
  QuerySnapshotEvent,
} from '../../access/ports/index.js';
import { toRedactedAccessEventProjection } from '../../access/application/recognition-result-mapper.js';
import { isAccessScopeContextRetired, readAccessScopeContextClaims } from '../../shared/access-scope-context.js';
import { isComparisonArtifact, type ComparisonArtifact } from '../../access/ports/comparison-artifact.js';
import { assertExternalEventId, assertExternalSubjectId, assertProvider } from '../../access/application/comparison/recognition-input.js';
import { assertQualificationState, REASON_CODES, type QualificationState, type ReasonCode } from '../../access/domain/index.js';
import { compareComparisonArtifacts } from '../../access/application/comparison/comparison-capability.js';
import {
  ensureG04bSchema,
  G04B_FACE_SLOTS_COLLECTION,
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
import { bindG10aMongoCommandMonitoring } from './g10a-driver-command-monitoring.js';
import {
  captureG10bScopedPersistenceBinding,
  createG10bScopedPersistenceExecutionFacade,
  markG10bScopedTransactionBegin,
  registerG10bConcreteG04bMongoPersistenceAdapter,
  resolveG10bScopedPersistenceBinding,
  type G10bScopedPersistenceBinding,
  type G10bScopedPersistenceExecutionFacade,
} from './internal/g10b-scoped-persistence-sidecar.js';
import { createG10bPrecommitMongoTerminator } from './internal/g10b-precommit-mongo-terminator.js';

export const G04B_MONGO_VERSION = '8.0.32';
export const G04B_DEFAULT_DATABASE = 'passhub_g04b_atomic';
export const G04B_FACE_SLOT_CAPACITY = 4096;
export const G04B_TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' as const },
  readPreference: 'primary' as const,
  writeConcern: { w: 'majority' as const, j: true },
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUERY_READ_OPTIONS = Object.freeze({
  readPreference: 'primary' as const,
  readConcern: { level: 'majority' as const },
});

export interface G04bClock {
  nowMs(): number;
}

const SYSTEM_CLOCK: G04bClock = Object.freeze({ nowMs: () => Date.now() });

export interface G04bManagementResult {
  readonly operation: 'CREATE' | 'UPDATE' | 'REVOKE' | 'EXPIRE';
  readonly qualificationId: string;
  readonly incarnation: string;
  readonly version: number;
  readonly summary: ManagementQualificationSummary;
  readonly qrToken: string | null;
}

export type G04bPersistenceStatus = 'COMMITTED' | 'REPLAYED' | 'CONFLICT' | 'UNKNOWN';

export interface G04bErrorFacts {
  readonly kind: G04bTransactionErrorKind;
  readonly stage: G04bTransactionStage;
  readonly code: number | null;
  readonly labels: readonly string[];
}

export type G04bRecognitionResult =
  | {
      readonly status: 'COMMITTED' | 'REPLAYED';
      readonly event: RedactedAccessEventProjection;
      readonly replayed: boolean;
      readonly error: null;
    }
  | {
      readonly status: 'CONFLICT' | 'UNKNOWN';
      readonly event: null;
      readonly replayed: false;
      readonly error: G04bErrorFacts;
    };

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
  | 'DUPLICATE_KEY' | 'FACE_SUBJECT_ALREADY_BOUND' | 'FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED'
  | 'WRITE_CONFLICT' | 'SCHEMA_VALIDATION'
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
  readonly g10bScopedPersistenceBinding: G10bScopedPersistenceBinding | undefined;
  /** Defined only for a sidecar-attached write scope; owns its active round. */
  g10bExecutionFacade: G10bScopedPersistenceExecutionFacade | undefined;
  initialCommitInvoked: boolean;
  readonly datasetEpoch: string;
  readonly sourceFacts: Map<string, SourceFacts>;
  readonly sourceGuards: Map<string, { incarnation: string; version: number }>;
  readonly qualifications: Map<string, G04bQualificationDocument>;
  readonly mappings: Map<string, FaceMappingSnapshot | null>;
  stage: G04bTransactionStage;
}

interface QueryQualificationAggregate {
  readonly _id: unknown;
  readonly incarnation: unknown;
  readonly displayName: unknown;
  readonly validFrom: unknown;
  readonly validUntil: unknown;
  readonly presence: unknown;
  readonly enteredAt: unknown;
  readonly exitedAt: unknown;
  readonly revokedAt: unknown;
  readonly revocationReason: unknown;
  readonly expiredTerminalAt: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly faceMapping: unknown;
}

interface QueryFaceMappingAggregate {
  readonly qualificationId: unknown;
  readonly qualificationIncarnation: unknown;
  readonly mappingIncarnation: unknown;
  readonly version: unknown;
}

interface QueryEventAggregate {
  readonly _id: unknown;
  readonly sourceId: unknown;
  readonly direction: unknown;
  readonly kind: unknown;
  readonly outcome: unknown;
  readonly reasonCode: unknown;
  readonly receivedAt: unknown;
  readonly recordedAt: unknown;
  readonly qualificationId: unknown;
  readonly presenceTransition: unknown;
}

export class G04bMongoPersistenceAdapter
  implements ManagementDataPort, RecognitionDataPort, SourceFactsPort, AccessQueryPort, QueryDataPort {
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
    registerG10bConcreteG04bMongoPersistenceAdapter(this);
    bindG10aMongoCommandMonitoring(client);
  }

  public static async connect(
    uri: string,
    databaseName: string = G04B_DEFAULT_DATABASE,
    clock: G04bClock = SYSTEM_CLOCK,
  ): Promise<G04bMongoPersistenceAdapter> {
    if (uri.length === 0) throw new TypeError('MongoDB URI must not be empty');
    const client = new MongoClient(uri, { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, monitorCommands: true });
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
    if (state.g10bScopedPersistenceBinding !== undefined) {
      // An invoked initial commit is the G10c confirmation boundary. No
      // native abort, endSession, map cleanup, or late command is allowed.
      if (state.initialCommitInvoked) return;
      await this.terminateAttachedPrecommit(state);
      this.transactions.delete(context as object);
      return;
    }
    this.transactions.delete(context as object);
    this.finishG10bExecutionRound(state);
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
      const found = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().sources.findOne(
        { _id: sourceId }, this.transactionDriverOptions(state, timeoutMs),
      ));
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

  public async readQualification(context: AccessScopeContext, qualificationId: string): Promise<ManagementQualificationSnapshot | null>;
  public async readQualification(qualificationId: string, observedAtMs: number): Promise<QuerySnapshotQualification | null>;
  public async readQualification(
    contextOrQualificationId: AccessScopeContext | string,
    qualificationIdOrObservedAtMs: string | number,
  ): Promise<ManagementQualificationSnapshot | QuerySnapshotQualification | null> {
    if (typeof contextOrQualificationId === 'string') {
      if (typeof qualificationIdOrObservedAtMs !== 'number') throw new TypeError('query qualification observation time is invalid');
      return this.readQueryQualification(contextOrQualificationId, qualificationIdOrObservedAtMs);
    }
    if (typeof qualificationIdOrObservedAtMs !== 'string') throw new TypeError('management qualification ID is invalid');
    const context = contextOrQualificationId;
    const qualificationId = qualificationIdOrObservedAtMs;
    const state = await this.begin(context);
    try {
      const document = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.findOne(
        { _id: qualificationId }, this.transactionDriverOptions(state, timeoutMs),
      ));
      const snapshot = document === null ? null : toQualificationSnapshot(document);
      if (document !== null) state.qualifications.set(qualificationId, document);
      return snapshot;
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async readMapping(context: AccessScopeContext, qualificationId: string, qualificationIncarnation?: string): Promise<FaceMappingSnapshot | null> {
    const state = await this.begin(context);
    try {
      const mappings = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().faceSlots.find(
        { qualificationId: { $eq: qualificationId, $type: 'string' } },
        this.transactionDriverOptions(state, timeoutMs),
      ).limit(2).toArray());
      const mapping = mappingFromSlots(mappings, qualificationId, qualificationIncarnation);
      state.mappings.set(qualificationId, mapping);
      return mapping;
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async resolveQr(context: AccessScopeContext, lookupDigest: string): Promise<ResolvedIdentitySnapshot> {
    const state = await this.begin(context);
    try {
      const document = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.findOne(
        { qrLookupDigest: lookupDigest }, this.transactionDriverOptions(state, timeoutMs),
      ));
      if (document === null) return { qualification: null, mapping: null };
      state.qualifications.set(document._id, document);
      const mapping = await this.mappingForQualification(document._id, document.incarnation, state);
      state.mappings.set(document._id, mapping);
      return { qualification: toQualificationSnapshot(document), mapping };
    } catch (error: unknown) { throw await this.fail(context, state, error); }
  }

  public async resolveFace(context: AccessScopeContext, provider: string, externalSubjectId: string): Promise<ResolvedIdentitySnapshot> {
    const state = await this.begin(context);
    try {
      const slots = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().faceSlots.find(
        { provider, subject: externalSubjectId, qualificationId: { $type: 'string' } },
        this.transactionDriverOptions(state, timeoutMs),
      ).limit(2).toArray());
      if (slots.length > 1) throw new G04bTechnicalError('face subject has multiple current mappings');
      const slot = slots[0];
      if (slot === undefined || slot.qualificationId === null || slot.qualificationIncarnation === null) return { qualification: null, mapping: null };
      const qualificationId = slot.qualificationId;
      const qualification = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.findOne(
        { _id: qualificationId }, this.transactionDriverOptions(state, timeoutMs),
      ));
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
    if (result.status === 'COMMITTED' || result.status === 'REPLAYED') {
      if (result.event === null || result.replayed !== (result.status === 'REPLAYED')) {
        throw new G04bTechnicalError('recognition persistence result is incomplete');
      }
      return { status: result.status, event: result.event, replayed: result.replayed };
    }
    if (result.error === null) throw new G04bTechnicalError('recognition persistence error facts are missing');
    return {
      status: result.status,
      event: null,
      error: result.error,
    };
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
          if (envelope === null) return { status: 'UNKNOWN', event: null, replayed: false, error: failed.facts };
          // Once the unique Event exists, replay classification is based on
          // that old Event only. Do not re-read current source, qualification,
          // or mapping state and accidentally re-judge the attempt.
          const canonicalEvent = await this.readCanonicalEventInternal(envelope.sourceId, envelope.externalEventId);
          if (canonicalEvent === null) return {
            status: 'UNKNOWN', event: null, replayed: false,
            error: failed.facts,
          };
          if (compareComparisonArtifacts(envelope.comparisonArtifact, canonicalEvent)) {
            return {
              status: 'REPLAYED',
              event: toRedactedAccessEventProjection(canonicalEvent),
              replayed: true,
              error: null,
            };
          }
          return {
            status: 'CONFLICT', event: null, replayed: false,
            error: { kind: 'IDEMPOTENCY_CONFLICT', stage: 'canonical', code: failed.facts.code, labels: failed.facts.labels },
          };
        }
        if (failed instanceof G04bTransactionError && failed.facts.kind === 'UNKNOWN_COMMIT_RESULT') {
          return { status: 'UNKNOWN', event: null, replayed: false, error: failed.facts };
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

  public async listQualifications(input: Parameters<QueryDataPort['listQualifications']>[0]): Promise<readonly QuerySnapshotQualification[]> {
    assertQueryListInput(input, false);
    const documents = await this.requireCollections().qualifications.aggregate<QueryQualificationAggregate>([
      { $match: qualificationQueryMatch(input.after, null) },
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: input.fetchLimit },
      queryFaceMappingLookup(),
      queryQualificationProjection(),
    ], QUERY_READ_OPTIONS).toArray();
    return documents.map(toQueryQualification);
  }

  public async listInside(input: Parameters<QueryDataPort['listInside']>[0]): Promise<readonly QuerySnapshotQualification[]> {
    assertQueryListInput(input, false);
    const documents = await this.requireCollections().qualifications.aggregate<QueryQualificationAggregate>([
      { $match: qualificationQueryMatch(input.after, 'INSIDE') },
      { $sort: { enteredAt: -1, _id: -1 } },
      { $limit: input.fetchLimit },
      queryFaceMappingLookup(),
      queryQualificationProjection(),
    ], QUERY_READ_OPTIONS).toArray();
    return documents.map(toQueryQualification);
  }

  public async listEvents(input: Parameters<QueryDataPort['listEvents']>[0]): Promise<readonly QuerySnapshotEvent[]> {
    assertQueryListInput(input, true);
    assertQueryEventFilters(input.filters);
    const match: Record<string, unknown>[] = [];
    const keyset = eventQueryKeyset(input.after);
    if (keyset !== null) match.push(keyset);
    if (input.filters.qualificationId !== null) match.push({ qualificationId: input.filters.qualificationId });
    if (input.filters.outcome !== null) match.push({ outcome: input.filters.outcome });
    if (input.filters.reasonCode !== null) match.push({ reasonCode: input.filters.reasonCode });
    const filter = match.length === 0 ? {} : match.length === 1 ? match[0] : { $and: match };
    const documents = await this.requireCollections().events.aggregate<QueryEventAggregate>([
      { $match: filter },
      { $sort: { receivedAt: -1, _id: -1 } },
      { $limit: input.fetchLimit },
      queryEventProjection(),
    ], QUERY_READ_OPTIONS).toArray();
    return documents.map(toQueryEvent);
  }

  private async readQueryQualification(qualificationId: string, observedAtMs: number): Promise<QuerySnapshotQualification | null> {
    assertQueryUuid(qualificationId);
    assertQueryObservedAt(observedAtMs);
    const documents = await this.requireCollections().qualifications.aggregate<QueryQualificationAggregate>([
      { $match: { _id: qualificationId } },
      { $limit: 1 },
      queryFaceMappingLookup(),
      queryQualificationProjection(),
    ], QUERY_READ_OPTIONS).toArray();
    const document = documents[0];
    return document === undefined ? null : toQueryQualification(document);
  }

  public async readEvent(eventId: string, observedAtMs: number): Promise<QuerySnapshotEvent | null> {
    assertQueryUuid(eventId);
    assertQueryObservedAt(observedAtMs);
    const documents = await this.requireCollections().events.aggregate<QueryEventAggregate>([
      { $match: { _id: eventId } },
      { $limit: 1 },
      queryEventProjection(),
    ], QUERY_READ_OPTIONS).toArray();
    const document = documents[0];
    return document === undefined ? null : toQueryEvent(document);
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

  private async readCanonicalEventInternal(
    sourceId: string,
    externalEventId: string,
  ): Promise<G04bEventDocument | null> {
    const session = this.client.startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
      const event = await this.requireCollections().events.findOne({ sourceId, externalEventId }, { session });
      await session.commitTransaction();
      return event;
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
    if (plan.operation === 'CREATE' && managementEnvelope.expectedQualification !== undefined) {
      throw new G04bTechnicalError('create management plan must not carry qualification provenance');
    }
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
      await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.insertOne(
        document, this.transactionDriverOptions(state, timeoutMs),
      ));
      await this.bumpGuard(state, 'qr');
      if (plan.faceMapping !== null && plan.faceMapping !== undefined) {
        state.stage = 'mapping';
        await this.bindNewFace(state, qualificationId, incarnation, plan.faceMapping);
        await this.bumpGuard(state, 'face');
      }
      state.stage = 'qualification';
      await this.ensureSlotCount(state);
      return this.managementSummary('CREATE', document, 0, token, plan.faceMapping !== null && plan.faceMapping !== undefined);
    }
    if (plan.qualificationId === null) throw new G04bTechnicalError('management qualificationId is required');
    const qualificationId = plan.qualificationId;
    const provenance = managementEnvelope.expectedQualification;
    if (provenance === undefined || provenance.qualificationId !== qualificationId) {
      throw new G04bTechnicalError('management plan qualification provenance is missing or mismatched');
    }
    const currentFromScope = state.qualifications.get(qualificationId);
    if (currentFromScope !== undefined &&
      (currentFromScope.incarnation !== provenance.incarnation || currentFromScope.version !== provenance.version)) {
      throw new G04bTechnicalError('management plan qualification provenance is stale');
    }
    const current = currentFromScope ?? await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.findOne({
      _id: qualificationId,
      incarnation: provenance.incarnation,
      version: provenance.version,
    }, this.transactionDriverOptions(state, timeoutMs)));
    if (current === null || current === undefined) throw new G04bTechnicalError('qualification is missing');
    const expected = { _id: qualificationId, incarnation: provenance.incarnation, version: provenance.version };
    if (plan.operation === 'EXPIRE') {
      if (current.presence !== 'NOT_ENTERED' || current.revokedAt !== null || current.expiredTerminalAt !== null || managementEnvelope.receivedAtMs < current.validUntil.getTime()) {
        throw new G04bTechnicalError('invalid qualification expiry transition');
      }
      const expiredAt = new Date(managementEnvelope.receivedAtMs);
      state.stage = 'qualification';
      const updated = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.updateOne(expected, {
        $set: { expiredTerminalAt: expiredAt, updatedAt: now }, $inc: { version: 1 },
      }, this.transactionDriverOptions(state, timeoutMs)));
      assertModified(updated.modifiedCount, 'expire qualification');
      state.stage = 'mapping';
      await this.releaseFaceForQualification(state, current._id, current.incarnation);
      await this.bumpGuard(state, 'face');
      state.stage = 'qualification';
      await this.ensureSlotCount(state);
      return this.managementSummary('EXPIRE', { ...current, expiredTerminalAt: expiredAt, updatedAt: now }, current.version + 1, null, false);
    }
    if (plan.operation === 'REVOKE') {
      const reason = requiredString(plan.revocationReason, 'revocationReason');
      const receivedAt = new Date(managementEnvelope.receivedAtMs);
      state.stage = 'qualification';
      const updated = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.updateOne(expected, {
        $set: { revokedAt: receivedAt, revocationReason: reason, updatedAt: now }, $inc: { version: 1 },
      }, this.transactionDriverOptions(state, timeoutMs)));
      assertModified(updated.modifiedCount, 'revoke qualification');
      state.stage = 'mapping';
      await this.releaseFaceForQualification(state, current._id, current.incarnation);
      await this.bumpGuard(state, 'face');
      state.stage = 'qualification';
      await this.ensureSlotCount(state);
      return this.managementSummary('REVOKE', { ...current, revokedAt: receivedAt, revocationReason: reason, updatedAt: now }, current.version + 1, null, false);
    }
    const displayName = requiredString(plan.displayName, 'displayName');
    const validFrom = new Date(requiredNumber(plan.validFromMs, 'validFromMs'));
    const validUntil = new Date(requiredNumber(plan.validUntilMs, 'validUntilMs'));
    const currentMapping = state.mappings.has(current._id)
      ? state.mappings.get(current._id) ?? null
      : await this.mappingForQualification(current._id, current.incarnation, state);
    const currentSlot = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().faceSlots.findOne({
      qualificationId: current._id,
      qualificationIncarnation: current.incarnation,
    }, this.transactionDriverOptions(state, timeoutMs)));
    if ((currentMapping === null) !== (currentSlot === null) ||
      (currentMapping !== null && (currentSlot === null ||
        currentMapping.qualificationIncarnation !== currentSlot.qualificationIncarnation ||
        currentMapping.mappingIncarnation !== currentSlot.slotIncarnation ||
        currentMapping.version !== currentSlot.version))) {
      throw new G04bTechnicalError('current face mapping snapshot is inconsistent with its qualification slot');
    }
    const mappingMode = plan.faceMappingMode ?? (plan.faceMapping === undefined ? 'KEEP' : plan.faceMapping === null ? 'REMOVE' : 'SET');
    const sameRequestedFace = mappingMode === 'SET' && plan.faceMapping !== null && plan.faceMapping !== undefined &&
      currentSlot !== null && currentSlot.provider === plan.faceMapping.provider && currentSlot.subject === plan.faceMapping.externalSubjectId;
    const mappingChanged = mappingMode !== 'KEEP' && !sameRequestedFace;
    if (mappingChanged && mappingMode === 'REMOVE' && currentMapping !== null) {
      state.stage = 'mapping';
      await this.releaseFaceForQualification(state, current._id, current.incarnation);
    }
    if (mappingChanged && mappingMode === 'SET' && plan.faceMapping !== null && plan.faceMapping !== undefined) {
      state.stage = 'mapping';
      if (currentMapping !== null) await this.releaseFaceForQualification(state, current._id, current.incarnation);
      await this.bindNewFace(state, current._id, current.incarnation, plan.faceMapping);
    }
    state.stage = 'qualification';
    const updated = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.updateOne(expected, {
      $set: { displayName, validFrom, validUntil, updatedAt: now }, $inc: { version: 1 },
    }, this.transactionDriverOptions(state, timeoutMs)));
    assertModified(updated.modifiedCount, 'update qualification');
    if (mappingChanged) await this.bumpGuard(state, 'face');
    await this.ensureSlotCount(state);
    const faceBound = mappingMode === 'KEEP'
      ? currentMapping !== null
      : mappingMode === 'SET' && plan.faceMapping !== null && plan.faceMapping !== undefined;
    return this.managementSummary('UPDATE', { ...current, displayName, validFrom, validUntil, updatedAt: now }, current.version + 1, null, faceBound);
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
    const existing = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().events.findOne(
      { sourceId, externalEventId }, this.transactionDriverOptions(state, timeoutMs),
    ));
      if (existing !== null) {
      if (!compareComparisonArtifacts(artifact, existing)) {
        return {
          status: 'CONFLICT',
          event: null,
          replayed: false,
          error: { kind: 'IDEMPOTENCY_CONFLICT', stage: 'event', code: null, labels: [] },
        };
      }
      return {
        status: 'REPLAYED',
        event: toRedactedAccessEventProjection(existing),
        replayed: true,
        error: null,
      };
    }

    let source = state.sourceFacts.get(envelope.sourceId);
    if (source === undefined) {
      const sourceDocument = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().sources.findOne(
        { _id: envelope.sourceId }, this.transactionDriverOptions(state, timeoutMs),
      ));
      if (sourceDocument === null) throw new G04bTechnicalError('source is missing');
      source = { sourceId: sourceDocument._id, direction: sourceDocument.direction, active: sourceDocument.active };
      state.sourceFacts.set(envelope.sourceId, source);
      state.sourceGuards.set(envelope.sourceId, { incarnation: sourceDocument.incarnation, version: sourceDocument.version });
    }
    if (source === undefined) throw new G04bTechnicalError('source facts are required for recognition persistence');
    const sourceGuard = state.sourceGuards.get(source.sourceId);
    if (sourceGuard === undefined) throw new G04bTechnicalError('source guard is missing');
    const guardedSource = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().sources.findOne(
      { _id: source.sourceId, incarnation: sourceGuard.incarnation, version: sourceGuard.version, direction: source.direction, active: source.active },
      this.transactionDriverOptions(state, timeoutMs),
    ));
    if (guardedSource === null) throw new G04bTechnicalError('source freshness guard failed');
    const receivedAtMs = envelope.receivedAtMs;
    const direction = envelope.direction;
    if (direction !== source.direction) throw new G04bTechnicalError('recognition direction does not match source');
    const metadata = await this.readMetadata(state);
    if (artifact.comparisonReferenceId !== metadata.comparisonReferenceId) throw new G04bTechnicalError('comparison artifact reference is incompatible with metadata');

    const sourceGuardWrite = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().sources.updateOne(
      { _id: source.sourceId, incarnation: sourceGuard.incarnation, version: sourceGuard.version, direction: source.direction, active: source.active },
      { $set: { direction: source.direction, active: source.active }, $inc: { version: 1 } },
      this.transactionDriverOptions(state, timeoutMs),
    ));
    if (sourceGuardWrite.matchedCount !== 1) throw new G04bTechnicalError('source freshness write guard failed');
    if (plan.qualificationId !== null) {
      const qualificationId = plan.qualificationId;
      const current = state.qualifications.get(qualificationId) ?? await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.findOne(
        { _id: qualificationId }, this.transactionDriverOptions(state, timeoutMs),
      ));
      if (current === null || current === undefined || current.incarnation !== plan.qualificationIncarnation || current.version !== plan.qualificationVersion) throw new G04bTechnicalError('recognition qualification guard failed');
      await this.applyQualificationEffect(state, current, plan, receivedAtMs);
      if (plan.faceMappingEffect === 'RELEASE') {
        state.stage = 'mapping';
        await this.releaseFaceForQualification(state, current._id, current.incarnation);
        state.stage = 'qualification';
      }
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
    await this.executeCrud(state, async (timeoutMs) => this.requireCollections().events.insertOne(
      document, this.transactionDriverOptions(state, timeoutMs),
    ));
    await this.ensureSlotCount(state);
    return {
      status: 'COMMITTED',
      event: toRedactedAccessEventProjection(document),
      replayed: false,
      error: null,
    };
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
    const updated = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().qualifications.updateOne(
      { _id: current._id, incarnation: current.incarnation, version: current.version },
      { $set: set, $inc: { version: 1 } },
      this.transactionDriverOptions(state, timeoutMs),
    ));
    assertModified(updated.modifiedCount, 'recognition qualification');
  }

  private async bindNewFace(state: TransactionState, qualificationId: string, qualificationIncarnation: string, mapping: Readonly<{ provider: string; externalSubjectId: string }>): Promise<void> {
    const faceSlots = this.requireCollections().faceSlots;
    const bound = await this.executeCrud(state, async (timeoutMs) => faceSlots.findOne(
      { provider: mapping.provider, subject: mapping.externalSubjectId, qualificationId: { $type: 'string' } },
      this.transactionDriverOptions(state, timeoutMs),
    ));
    if (bound !== null) {
      throw new G04bTransactionError({ kind: 'FACE_SUBJECT_ALREADY_BOUND', stage: 'mapping', code: 11000, labels: [] }, new Error('face subject is already bound'));
    }
    const empty = await this.executeCrud(state, async (timeoutMs) => faceSlots.findOne(
      { provider: mapping.provider, subject: mapping.externalSubjectId, qualificationId: null, qualificationIncarnation: null },
      this.transactionDriverOptions(state, timeoutMs),
    )) ?? await this.executeCrud(state, async (timeoutMs) => faceSlots.findOne(
      { qualificationId: null, qualificationIncarnation: null }, this.transactionDriverOptions(state, timeoutMs),
    ));
    if (empty === null) {
      const metadata = await this.readMetadata(state);
      if (metadata.slotCount >= G04B_FACE_SLOT_CAPACITY) {
        throw new G04bTransactionError({ kind: 'FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED', stage: 'mapping', code: null, labels: [] }, new Error('face slot capacity exhausted'));
      }
      await this.executeCrud(state, async (timeoutMs) => faceSlots.insertOne({
        _id: randomUUID(), provider: mapping.provider, subject: mapping.externalSubjectId,
        qualificationId, qualificationIncarnation, slotIncarnation: randomUUID(), version: 0,
      }, this.transactionDriverOptions(state, timeoutMs)));
      const countUpdate = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().metadata.updateOne(
        { _id: 'system', slotCount: metadata.slotCount }, { $inc: { slotCount: 1 } }, this.transactionDriverOptions(state, timeoutMs),
      ));
      assertModified(countUpdate.modifiedCount, 'allocate face slot count');
      return;
    }
    const updated = await this.executeCrud(state, async (timeoutMs) => faceSlots.updateOne(
      { _id: empty._id, qualificationId: null, qualificationIncarnation: null },
      { $set: { provider: mapping.provider, subject: mapping.externalSubjectId, qualificationId, qualificationIncarnation }, $inc: { version: 1 } },
      this.transactionDriverOptions(state, timeoutMs),
    ));
    assertModified(updated.modifiedCount, 'bind face slot');
  }

  private async releaseFaceForQualification(state: TransactionState, qualificationId: string, incarnation: string): Promise<void> {
    const slots = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().faceSlots.find(
      { qualificationId: { $eq: qualificationId, $type: 'string' } }, this.transactionDriverOptions(state, timeoutMs),
    ).limit(2).toArray());
    if (slots.length > 1) throw new G04bTechnicalError('qualification has multiple current face mappings');
    const slot = slots[0];
    if (slot === undefined) return;
    if (slot.qualificationIncarnation !== incarnation) throw new G04bTechnicalError('face mapping incarnation mismatch');
    const updated = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().faceSlots.updateOne(
      { _id: slot._id, qualificationId, qualificationIncarnation: incarnation, version: slot.version },
      { $set: { qualificationId: null, qualificationIncarnation: null }, $inc: { version: 1 } },
      this.transactionDriverOptions(state, timeoutMs),
    ));
    assertModified(updated.modifiedCount, 'release face slot');
  }

  private async mappingForQualification(qualificationId: string, qualificationIncarnation: string, state: TransactionState): Promise<FaceMappingSnapshot | null> {
    const slots = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().faceSlots.find(
      { qualificationId: { $eq: qualificationId, $type: 'string' } }, this.transactionDriverOptions(state, timeoutMs),
    ).limit(2).toArray());
    return mappingFromSlots(slots, qualificationId, qualificationIncarnation);
  }

  private async ensureSlotCount(state: TransactionState): Promise<void> {
    const metadata = await this.readMetadata(state);
    const count = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().faceSlots.countDocuments(
      {}, this.transactionDriverOptions(state, timeoutMs),
    ));
    if (count !== metadata.slotCount) throw new G04bTechnicalError('metadata slotCount does not match faceSlots');
  }

  private async bumpGuard(state: TransactionState, guard: 'qr' | 'face'): Promise<void> {
    const field = guard === 'qr' ? 'qrGuardVersion' : 'faceGuardVersion';
    const updated = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().metadata.updateOne(
      { _id: 'system' }, { $inc: { [field]: 1 } }, this.transactionDriverOptions(state, timeoutMs),
    ));
    assertModified(updated.modifiedCount, `${guard} guard`);
  }

  private async readMetadata(state: TransactionState): Promise<G04bMetadataDocument> {
    const metadata = await this.executeCrud(state, async (timeoutMs) => this.requireCollections().metadata.findOne(
      { _id: 'system' }, this.transactionDriverOptions(state, timeoutMs),
    ));
    if (metadata === null) throw new G04bTechnicalError('metadata system document is missing');
    if (metadata.datasetEpoch !== state.datasetEpoch) throw new G04bTechnicalError('scope dataset epoch does not match metadata');
    return metadata;
  }

  private managementSummary(operation: 'CREATE' | 'UPDATE' | 'REVOKE' | 'EXPIRE', current: G04bQualificationDocument, version: number, qrToken: string | null, faceBound: boolean): G04bManagementResult {
    return {
      operation,
      qualificationId: current._id,
      incarnation: current.incarnation,
      version,
      summary: {
        qualificationId: current._id,
        displayName: current.displayName,
        validFromMs: current.validFrom.getTime(),
        validUntilMs: current.validUntil.getTime(),
        presence: current.presence,
        revokedAtMs: nullableTime(current.revokedAt),
        revocationReason: current.revocationReason,
        expiredTerminalAtMs: nullableTime(current.expiredTerminalAt),
        faceBound,
        createdAtMs: current.createdAt.getTime(),
        updatedAtMs: current.updatedAt.getTime(),
      },
      qrToken,
    };
  }

  private async begin(context: AccessScopeContext): Promise<TransactionState> {
    if (isAccessScopeContextRetired(context)) throw new G04bTechnicalError('access scope context is retired');
    const claims = readAccessScopeContextClaims(context);
    if (claims === null) throw new G04bTechnicalError('recognition scope context claims are missing');
    const existing = this.transactions.get(context as object);
    if (existing !== undefined) return existing;
    markG10bScopedTransactionBegin(this);
    // An attached G10b resolver may fail closed here.  It must run before any
    // Mongo session or transaction exists, while unattached adapters preserve
    // the established G04b path exactly.
    const g10bScopedPersistenceBinding = resolveG10bScopedPersistenceBinding(this, context);
    captureG10bScopedPersistenceBinding(this, g10bScopedPersistenceBinding);
    const g10bExecutionFacade = createG10bScopedPersistenceExecutionFacade(g10bScopedPersistenceBinding);
    let session: ClientSession;
    try {
      session = this.client.startSession();
    } catch (error: unknown) {
      // The facade owns an active round from the point it is created.  A
      // client allocation failure has no session to clean up, but must not
      // strand that round and block the operation's later lifecycle.
      if (g10bExecutionFacade !== undefined) g10bExecutionFacade.finish();
      throw error;
    }
    const state: TransactionState = {
      session,
      g10bScopedPersistenceBinding,
      g10bExecutionFacade,
      initialCommitInvoked: false,
      datasetEpoch: claims.epoch,
      sourceFacts: new Map(), sourceGuards: new Map(), qualifications: new Map(), mappings: new Map(), stage: 'begin',
    };
    try {
      session.startTransaction(G04B_TRANSACTION_OPTIONS);
      this.transactions.set(context as object, state);
      return state;
    } catch (error: unknown) {
      if (g10bExecutionFacade !== undefined) g10bExecutionFacade.finish();
      await session.endSession();
      throw new G04bTransactionError(classifyG04bTransactionError(error, 'begin'), error);
    }
  }

  private async commit(context: AccessScopeContext, state: TransactionState): Promise<void> {
    state.stage = 'commit';
    try {
      const facade = state.g10bExecutionFacade;
      if (facade === undefined) {
        if (state.g10bScopedPersistenceBinding !== undefined) {
          throw new G04bTechnicalError('G10b initial commit facade is unavailable');
        }
        await state.session.commitTransaction();
      } else {
        try {
          await facade.executeInitialCommit(async ({ timeoutMs }) => {
            if (state.initialCommitInvoked) throw new G04bTechnicalError('initial commit was already invoked');
            state.initialCommitInvoked = true;
            await state.session.commitTransaction({ timeoutMS: timeoutMs });
          });
        } finally {
          // Admission can fail before the sender starts (for example an
          // execution deadline or owner fence). Retain its active facade so
          // the attached precommit authority can finish the round, reserve
          // cleanup, and issue the one budgeted abort. Once the sender has
          // begun, this is instead the G10c confirmation boundary.
          if (state.initialCommitInvoked) this.finishG10bExecutionRound(state);
        }
      }
      this.transactions.delete(context as object);
      await state.session.endSession();
    } catch (error: unknown) {
      const facts = classifyG04bTransactionError(error, 'commit');
      if (state.g10bScopedPersistenceBinding !== undefined && state.initialCommitInvoked) {
        // G10c owns unknown/failed initial-commit confirmation. Do not clean
        // up this session or scope from G10b's precommit-only boundary.
        throw new G04bTransactionError(facts, error);
      }
      if (state.g10bScopedPersistenceBinding !== undefined) {
        try {
          await this.terminateAttachedPrecommit(state);
          this.transactions.delete(context as object);
        } catch (terminationError: unknown) {
          throw new G04bTransactionError(classifyG04bTransactionError(terminationError, 'abort'), terminationError);
        }
        throw new G04bTransactionError(facts, error);
      }
      this.transactions.delete(context as object);
      await state.session.endSession().catch(() => undefined);
      throw new G04bTransactionError(facts, error);
    }
  }

  private async fail(context: AccessScopeContext, state: TransactionState, error: unknown): Promise<never> {
    const facts = error instanceof G04bTransactionError ? error.facts : classifyG04bTransactionError(error, state.stage);
    if (state.g10bScopedPersistenceBinding !== undefined) {
      // Once the initial sender starts, only G10c may decide confirmation or
      // cleanup. Before that point, attached transactions have no raw abort
      // fallback: their binding-owned authority owns the one abort group.
      if (state.initialCommitInvoked) {
        if (error instanceof G04bTransactionError) throw error;
        throw new G04bTransactionError(facts, error);
      }
      state.stage = 'abort';
      try {
        await this.terminateAttachedPrecommit(state);
        this.transactions.delete(context as object);
      } catch (terminationError: unknown) {
        throw new G04bTransactionError(classifyG04bTransactionError(terminationError, 'abort'), terminationError);
      }
      if (error instanceof G04bTransactionError) throw error;
      throw new G04bTransactionError(facts, error);
    }
    this.transactions.delete(context as object);
    this.finishG10bExecutionRound(state);
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

  /** Every scoped Mongo CRUD command is admitted through this one gateway. */
  private async executeCrud<T>(
    state: TransactionState,
    send: (timeoutMs: number | undefined) => Promise<T>,
  ): Promise<T> {
    const facade = state.g10bExecutionFacade;
    if (facade !== undefined) return facade.executeCrud(({ timeoutMs }) => send(timeoutMs));
    if (state.g10bScopedPersistenceBinding !== undefined) {
      throw new G04bTechnicalError('G10b execution facade is unavailable for attached transaction CRUD');
    }
    return send(undefined);
  }

  private transactionDriverOptions(
    state: TransactionState,
    timeoutMs: number | undefined,
  ): { readonly session: ClientSession; readonly timeoutMS?: number } {
    return timeoutMs === undefined
      ? { session: state.session }
      : { session: state.session, timeoutMS: timeoutMs };
  }

  private finishG10bExecutionRound(state: TransactionState): void {
    const facade = state.g10bExecutionFacade;
    if (facade === undefined) return;
    state.g10bExecutionFacade = undefined;
    facade.finish();
  }

  private async terminateAttachedPrecommit(state: TransactionState): Promise<void> {
    const facade = state.g10bExecutionFacade;
    if (facade === undefined) {
      throw new G04bTechnicalError('G10b precommit authority is unavailable for attached transaction cleanup');
    }
    const authority = facade.beginPrecommitTermination();
    const terminator = createG10bPrecommitMongoTerminator({ session: state.session, authority });
    await terminator.terminatePrecommit();
    state.g10bExecutionFacade = undefined;
  }

  private dateFromClock(): Date {
    const value = this.clock.nowMs();
    if (!Number.isSafeInteger(value)) throw new G04bTechnicalError('clock must return a safe integer');
    return new Date(value);
  }
}

function queryFaceMappingLookup(): Record<string, unknown> {
  return {
    $lookup: {
      from: G04B_FACE_SLOTS_COLLECTION,
      let: { qualificationId: '$_id', qualificationIncarnation: '$incarnation' },
      pipeline: [
        { $match: { $expr: { $and: [
          { $eq: ['$qualificationId', '$$qualificationId'] },
          { $eq: ['$qualificationIncarnation', '$$qualificationIncarnation'] },
        ] } } },
        { $sort: { _id: 1 } },
        { $limit: 1 },
        { $project: { _id: 0, qualificationId: 1, qualificationIncarnation: 1, mappingIncarnation: '$slotIncarnation', version: 1 } },
      ],
      as: 'faceMapping',
    },
  };
}

function queryQualificationProjection(): Record<string, unknown> {
  return { $project: {
    _id: 1, incarnation: 1, displayName: 1, validFrom: 1, validUntil: 1,
    presence: 1, enteredAt: 1, exitedAt: 1, revokedAt: 1, revocationReason: 1,
    expiredTerminalAt: 1, createdAt: 1, updatedAt: 1, faceMapping: 1,
  } };
}

function queryEventProjection(): Record<string, unknown> {
  return { $project: {
    _id: 1, sourceId: 1, direction: 1, kind: 1, outcome: 1, reasonCode: 1,
    receivedAt: 1, recordedAt: 1, qualificationId: 1, presenceTransition: 1,
  } };
}

function qualificationQueryMatch(after: { readonly lastTimeMs: number; readonly lastId: string } | null, presence: 'INSIDE' | null): Record<string, unknown> {
  const keyset = after === null ? null : queryKeyset(after, presence === 'INSIDE' ? 'enteredAt' : 'createdAt');
  if (presence === null && keyset === null) return {};
  if (presence !== null && keyset === null) return { presence };
  if (presence === null) return keyset as Record<string, unknown>;
  return { $and: [{ presence }, keyset] };
}

function eventQueryKeyset(after: { readonly lastTimeMs: number; readonly lastId: string } | null): Record<string, unknown> | null {
  return after === null ? null : queryKeyset(after, 'receivedAt');
}

function queryKeyset(after: { readonly lastTimeMs: number; readonly lastId: string }, field: 'createdAt' | 'enteredAt' | 'receivedAt'): Record<string, unknown> {
  const time = new Date(after.lastTimeMs);
  return { $or: [
    { [field]: { $lt: time } },
    { [field]: time, _id: { $lt: after.lastId } },
  ] };
}

function assertQueryListInput(value: unknown, withFilters: boolean): asserts value is { readonly fetchLimit: number; readonly after: { readonly lastTimeMs: number; readonly lastId: string } | null; readonly observedAtMs: number; readonly filters?: unknown } {
  assertExactPlainRecord(value, withFilters ? ['after', 'fetchLimit', 'filters', 'observedAtMs'] : ['after', 'fetchLimit', 'observedAtMs']);
  const record = value as Record<string, unknown>;
  assertQueryFetchLimit(record.fetchLimit);
  assertQueryObservedAt(record.observedAtMs);
  assertQueryAfter(record.after);
}

function assertQueryEventFilters(value: unknown): asserts value is { readonly qualificationId: string | null; readonly outcome: 'ACCEPTED' | 'REJECTED' | null; readonly reasonCode: ReasonCode | null } {
  assertExactPlainRecord(value, ['qualificationId', 'outcome', 'reasonCode']);
  const record = value as Record<string, unknown>;
  if (record.qualificationId !== null && !isQueryUuid(record.qualificationId)) throw new TypeError('query qualification filter is invalid');
  if (record.outcome !== null && record.outcome !== 'ACCEPTED' && record.outcome !== 'REJECTED') throw new TypeError('query outcome filter is invalid');
  if (record.reasonCode !== null && (typeof record.reasonCode !== 'string' || !REASON_CODES.includes(record.reasonCode as ReasonCode))) throw new TypeError('query reason filter is invalid');
}

function assertQueryFetchLimit(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 101) throw new TypeError('query fetch limit is invalid');
}

function assertQueryObservedAt(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value)) throw new TypeError('query observed time is invalid');
}

function assertQueryUuid(value: unknown): asserts value is string {
  if (!isQueryUuid(value)) throw new TypeError('query UUID is invalid');
}

function assertQueryAfter(value: unknown): asserts value is { readonly lastTimeMs: number; readonly lastId: string } | null {
  if (value === null) return;
  assertExactPlainRecord(value, ['lastId', 'lastTimeMs']);
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.lastTimeMs) || !isQueryUuid(record.lastId)) throw new TypeError('query after key is invalid');
}

function assertExactPlainRecord(value: unknown, expectedKeys: readonly string[]): void {
  if (typeof value !== 'object' || value === null) throw new TypeError('query record is invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('query record prototype is invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string') || expectedKeys.some((key) => !keys.includes(key))) throw new TypeError('query record keys are invalid');
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError('query record property is invalid');
  }
}

function toQueryQualification(value: QueryQualificationAggregate): QuerySnapshotQualification {
  assertExactPlainRecord(value, ['_id', 'incarnation', 'displayName', 'validFrom', 'validUntil', 'presence', 'enteredAt', 'exitedAt', 'revokedAt', 'revocationReason', 'expiredTerminalAt', 'createdAt', 'updatedAt', 'faceMapping']);
  if (!isQueryUuid(value._id) || !isQueryUuid(value.incarnation) || typeof value.displayName !== 'string'
    || !isDate(value.validFrom) || !isDate(value.validUntil) || !isDateOrNull(value.enteredAt)
    || !isDateOrNull(value.exitedAt) || !isDateOrNull(value.revokedAt) || !isDateOrNull(value.expiredTerminalAt)
    || (value.revocationReason !== null && typeof value.revocationReason !== 'string')
    || !isDate(value.createdAt) || !isDate(value.updatedAt)
    || (value.presence !== 'NOT_ENTERED' && value.presence !== 'INSIDE' && value.presence !== 'EXITED')
    || !Array.isArray(value.faceMapping) || value.faceMapping.length > 1) throw new TypeError('qualification query document is invalid');
  const mappingDocument = value.faceMapping[0];
  let faceMapping: QuerySnapshotQualification['faceMapping'] = null;
  if (mappingDocument !== undefined) {
    assertExactPlainRecord(mappingDocument, ['qualificationId', 'qualificationIncarnation', 'mappingIncarnation', 'version']);
    const mapping = mappingDocument as QueryFaceMappingAggregate;
    if (!isQueryUuid(mapping.qualificationId) || mapping.qualificationId !== value._id
      || !isQueryUuid(mapping.qualificationIncarnation) || mapping.qualificationIncarnation !== value.incarnation
      || !isQueryUuid(mapping.mappingIncarnation) || !Number.isSafeInteger(mapping.version) || (mapping.version as number) < 0) throw new TypeError('qualification mapping is invalid');
    faceMapping = Object.freeze({ qualificationId: mapping.qualificationId, qualificationIncarnation: mapping.qualificationIncarnation, mappingIncarnation: mapping.mappingIncarnation, version: mapping.version as number });
  }
  return Object.freeze({
    qualificationId: value._id, displayName: value.displayName,
    validFromMs: dateMs(value.validFrom), validUntilMs: dateMs(value.validUntil),
    presence: value.presence, enteredAtMs: nullableDateMs(value.enteredAt), exitedAtMs: nullableDateMs(value.exitedAt),
    revokedAtMs: nullableDateMs(value.revokedAt), revocationReason: value.revocationReason,
    expiredTerminalAtMs: nullableDateMs(value.expiredTerminalAt), createdAtMs: dateMs(value.createdAt), updatedAtMs: dateMs(value.updatedAt),
    qualificationIncarnation: value.incarnation, faceMapping,
  });
}

function toQueryEvent(value: QueryEventAggregate): QuerySnapshotEvent {
  assertExactPlainRecord(value, ['_id', 'sourceId', 'direction', 'kind', 'outcome', 'reasonCode', 'receivedAt', 'recordedAt', 'qualificationId', 'presenceTransition']);
  if (!isQueryUuid(value._id) || !isQueryUuid(value.sourceId) || !isDate(value.receivedAt) || !isDate(value.recordedAt)
    || (value.direction !== 'ENTRY' && value.direction !== 'EXIT')
    || (value.kind !== 'QR_SCANNED' && value.kind !== 'FACE_MATCHED' && value.kind !== 'FACE_UNKNOWN')
    || (value.outcome !== 'ACCEPTED' && value.outcome !== 'REJECTED')
    || typeof value.reasonCode !== 'string' || !REASON_CODES.includes(value.reasonCode as ReasonCode)
    || (value.qualificationId !== null && !isQueryUuid(value.qualificationId))) throw new TypeError('event query document is invalid');
  let presenceTransition: QuerySnapshotEvent['presenceTransition'] = null;
  if (value.presenceTransition !== null) {
    assertExactPlainRecord(value.presenceTransition, ['from', 'to']);
    const transition = value.presenceTransition as { readonly from: unknown; readonly to: unknown };
    if (!['NOT_ENTERED', 'INSIDE', 'EXITED'].includes(transition.from as string) || !['NOT_ENTERED', 'INSIDE', 'EXITED'].includes(transition.to as string)) throw new TypeError('event transition is invalid');
    presenceTransition = Object.freeze({ from: transition.from as 'NOT_ENTERED' | 'INSIDE' | 'EXITED', to: transition.to as 'NOT_ENTERED' | 'INSIDE' | 'EXITED' });
  }
  return Object.freeze({ eventId: value._id, sourceId: value.sourceId, direction: value.direction, kind: value.kind, outcome: value.outcome, reasonCode: value.reasonCode as ReasonCode, receivedAtMs: dateMs(value.receivedAt), recordedAtMs: dateMs(value.recordedAt), qualificationId: value.qualificationId, presenceTransition });
}

function isDate(value: unknown): value is Date { return value instanceof Date && Number.isSafeInteger(value.getTime()); }
function isDateOrNull(value: unknown): value is Date | null { return value === null || isDate(value); }
function dateMs(value: Date): number { if (!isDate(value)) throw new TypeError('query date is invalid'); return value.getTime(); }
function nullableDateMs(value: Date | null): number | null { return value === null ? null : dateMs(value); }
function isQueryUuid(value: unknown): value is string { return typeof value === 'string' && UUID_V4.test(value); }

export function classifyG04bTransactionError(error: unknown, stage: G04bTransactionStage): G04bErrorFacts {
  const candidate = error as Partial<MongoError> & { code?: unknown; errorLabels?: unknown; index?: unknown; keyPattern?: unknown };
  const code = typeof candidate.code === 'number' ? candidate.code : null;
  const labels = Array.isArray(candidate.errorLabels) ? candidate.errorLabels.filter((label): label is string => typeof label === 'string') : [];
  let kind: G04bTransactionErrorKind = 'OTHER';
  const keyPattern = candidate.keyPattern;
  const faceSubjectKey = typeof keyPattern === 'object' && keyPattern !== null &&
    Object.keys(keyPattern as Record<string, unknown>).sort().join(',') === 'provider,subject';
  if ((code === 11000 || code === 11001) && stage === 'mapping' &&
    (candidate.index === 'g04a_face_subject_unique_v1' || faceSubjectKey)) kind = 'FACE_SUBJECT_ALREADY_BOUND';
  else if (code === 11000 || code === 11001) kind = 'DUPLICATE_KEY';
  else if (code === 112) kind = 'WRITE_CONFLICT';
  else if (code === 121) kind = 'SCHEMA_VALIDATION';
  else if (stage === 'commit' && code === 251) kind = 'UNKNOWN_COMMIT_RESULT';
  else if (code === 251) kind = 'TRANSACTION_ABORTED';
  else if (labels.includes('UnknownTransactionCommitResult')) kind = 'UNKNOWN_COMMIT_RESULT';
  else if (stage === 'commit') kind = 'UNKNOWN_COMMIT_RESULT';
  return { kind, stage, code, labels };
}

function toQualificationSnapshot(document: G04bQualificationDocument): ManagementQualificationSnapshot {
  const state: QualificationState = {
    validFromMs: document.validFrom.getTime(), validUntilMs: document.validUntil.getTime(), presence: document.presence,
    enteredAtMs: nullableTime(document.enteredAt), exitedAtMs: nullableTime(document.exitedAt), revokedAtMs: nullableTime(document.revokedAt),
    revocationReason: document.revocationReason, expiredTerminalAtMs: nullableTime(document.expiredTerminalAt),
  };
  assertQualificationState(state);
  return {
    qualificationId: document._id,
    incarnation: document.incarnation,
    version: document.version,
    displayName: document.displayName,
    createdAtMs: document.createdAt.getTime(),
    updatedAtMs: document.updatedAt.getTime(),
    state,
  };
}

function mappingFromSlots(
  slots: readonly { qualificationId: string | null; qualificationIncarnation: string | null; slotIncarnation: string; version: number; provider: string; subject: string }[],
  qualificationId: string,
  expectedQualificationIncarnation?: string,
): FaceMappingSnapshot | null {
  if (slots.length > 1) throw new G04bTechnicalError(`qualification ${qualificationId} has multiple face mappings`);
  const slot = slots[0];
  if (slot !== undefined && slot.qualificationId !== null && slot.qualificationIncarnation !== null &&
    expectedQualificationIncarnation !== undefined && slot.qualificationIncarnation !== expectedQualificationIncarnation) {
    throw new G04bTechnicalError(`face mapping for qualification ${qualificationId} has a stale incarnation`);
  }
  return slot === undefined || slot.qualificationId === null || slot.qualificationIncarnation === null ? null : {
    qualificationId: slot.qualificationId, qualificationIncarnation: slot.qualificationIncarnation, mappingIncarnation: slot.slotIncarnation, version: slot.version,
  };
}
function mappingFromSlot(slot: { qualificationId: string | null; qualificationIncarnation: string | null; slotIncarnation: string; version: number; provider: string; subject: string }): FaceMappingSnapshot | null {
  return slot.qualificationId === null || slot.qualificationIncarnation === null ? null : {
    qualificationId: slot.qualificationId,
    qualificationIncarnation: slot.qualificationIncarnation,
    mappingIncarnation: slot.slotIncarnation,
    version: slot.version,
  };
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
function randomUuidToken(): string { return randomBytes(32).toString('base64url'); }
function sha256Lookup(token: string): string { return createHash('sha256').update(Buffer.from('PassHub/qr-lookup/v1\0', 'utf8')).update(Buffer.from(token, 'utf8')).digest('hex'); }
