import {
  MongoClient,
  type ClientSession,
  type Collection,
  type Db,
  type UpdateResult,
} from 'mongodb';

import {
  ensureG04aFaceSlotsCollection,
  type G04aFaceSlotDocument,
} from './g04a-face-index-schema.js';
import {
  createG04aFaceIndexFixture,
  type G04aFaceIndexFixture,
} from './g04a-face-index-fixture.js';

export const G04A_MONGO_VERSION = '8.0.32';
export const G04A_DEFAULT_DATABASE = 'passhub_g04a_experiment';

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const, j: true },
  readPreference: 'primary' as const,
});

export interface G04aFaceReplacementInput {
  readonly oldSlotId: string;
  readonly replacementSlotId: string;
  readonly qualificationId: string;
  readonly qualificationIncarnation: string;
  readonly replacementProvider: string;
  readonly replacementSubject: string;
  readonly abortAfterRelease?: boolean;
}

export interface G04aFaceBindingInput {
  readonly slotId: string;
  readonly qualificationId: string;
  readonly qualificationIncarnation: string;
  readonly provider: string;
  readonly subject: string;
}

export interface G04aWriterSessionRead {
  readonly oldSlot: G04aFaceSlotDocument | null;
  readonly replacementSlot: G04aFaceSlotDocument | null;
}

export interface G04aParallelBindingInput {
  readonly first: G04aFaceBindingInput;
  readonly second: G04aFaceBindingInput;
}

export interface G04aParallelSessionOutcome {
  readonly committed: boolean;
  readonly error: G04aTransactionErrorClassification | null;
}

export class G04aInjectedRollbackError extends Error {
  public constructor() {
    super('G04a injected failure after releasing the old face slot');
    this.name = 'G04aInjectedRollbackError';
  }
}

export class G04aMongoVersionError extends Error {
  public constructor(actual: string) {
    super(`G04a requires MongoDB ${G04A_MONGO_VERSION}; received ${actual}`);
    this.name = 'G04aMongoVersionError';
  }
}

export class G04aMongoTopologyError extends Error {
  public constructor() {
    super('G04a requires a MongoDB replica set or sharded deployment');
    this.name = 'G04aMongoTopologyError';
  }
}

export type G04aTransactionStage =
  | 'release'
  | 'bind'
  | 'reverse-bind-first'
  | 'writer-read'
  | 'commit'
  | 'abort'
  | 'observer-before-commit'
  | 'observer-after-commit';

export type G04aTransactionErrorKind =
  | 'DUPLICATE_KEY'
  | 'WRITE_CONFLICT'
  | 'TRANSACTION_ABORTED'
  | 'UNKNOWN_COMMIT_RESULT'
  | 'OTHER';

export interface G04aTransactionErrorClassification {
  readonly kind: G04aTransactionErrorKind;
  readonly stage: G04aTransactionStage;
  readonly code: number | null;
  readonly labels: readonly string[];
}

export class G04aTransactionError extends Error {
  public constructor(
    public readonly classification: G04aTransactionErrorClassification,
    cause: unknown,
  ) {
    super(
      `G04a transaction ${classification.kind} at ${classification.stage}`,
      { cause },
    );
    this.name = 'G04aTransactionError';
  }
}

/**
 * A deliberately narrow, real-driver experiment for the G04a design gate.
 * It exposes only face-slot fixture setup and transaction probes. It is not a
 * ManagementDataPort, RecognitionDataPort, Event repository, HTTP adapter, or
 * complete PassHub persistence implementation.
 */
export class G04aFaceIndexExperiment {
  private readonly database: Db;
  private collection: Collection<G04aFaceSlotDocument> | null = null;

  public constructor(
    private readonly client: MongoClient,
    databaseName: string = G04A_DEFAULT_DATABASE,
  ) {
    if (databaseName.length === 0) {
      throw new TypeError('G04a database name must not be empty');
    }
    this.database = client.db(databaseName);
  }

  public static async connect(
    uri: string,
    databaseName: string = G04A_DEFAULT_DATABASE,
  ): Promise<G04aFaceIndexExperiment> {
    if (uri.length === 0) {
      throw new TypeError('MongoDB URI must not be empty');
    }
    const client = new MongoClient(uri, {
      retryReads: false,
      retryWrites: false,
      maxAdaptiveRetries: 0,
    });
    await client.connect();
    const experiment = new G04aFaceIndexExperiment(client, databaseName);
    try {
      await experiment.assertMongo8032ReplicaSet();
      return experiment;
    } catch (error: unknown) {
      await client.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  public async assertMongo8032ReplicaSet(): Promise<void> {
    const buildInfo = (await this.database.command({
      buildInfo: 1,
    })) as { version?: unknown };
    const version = buildInfo.version;
    if (typeof version !== 'string') {
      throw new G04aMongoVersionError(String(version));
    }
    if (version !== G04A_MONGO_VERSION) {
      throw new G04aMongoVersionError(version);
    }

    const hello = (await this.database.command({ hello: 1 })) as {
      setName?: unknown;
      isWritablePrimary?: unknown;
      hosts?: unknown;
    };
    if (
      hello.setName !== 'rs0' ||
      hello.isWritablePrimary !== true ||
      !Array.isArray(hello.hosts) ||
      hello.hosts.length !== 1 ||
      typeof hello.hosts[0] !== 'string'
    ) {
      throw new G04aMongoTopologyError();
    }
  }

  public async ensureSchema(): Promise<void> {
    await this.assertMongo8032ReplicaSet();
    this.collection = await ensureG04aFaceSlotsCollection(this.database);
  }

  /** Destructive test-only setup, scoped to faceSlots in this experiment DB. */
  public async clearAndSeed(
    slots: readonly G04aFaceSlotDocument[] =
      createG04aFaceIndexFixture().slots,
  ): Promise<void> {
    const collection = this.requireCollection();
    await collection.deleteMany({});
    if (slots.length > 0) {
      await collection.insertMany([...slots], { ordered: true });
    }
  }

  public async listSlots(): Promise<readonly G04aFaceSlotDocument[]> {
    const collection = this.requireCollection();
    return collection
      .find({}, { readConcern: { level: 'majority' } })
      .sort({ _id: 1 })
      .toArray();
  }

  /**
   * Read only the currently mapped slot. A retained empty slot is deliberately
   * excluded by the same scalar qualification predicate as the reverse
   * partial index; callers can run this probe concurrently with a bind in a
   * tester without turning it into an application resolution port.
   */
  public async resolveMappedFace(
    provider: string,
    subject: string,
  ): Promise<G04aFaceSlotDocument | null> {
    return this.requireCollection().findOne(
      {
        provider,
        subject,
        qualificationId: { $type: 'string' },
      },
      { readConcern: { level: 'majority' } },
    );
  }

  /**
   * Release the old reference and reuse a retained empty slot in one
   * transaction. MongoDB's reverse partial unique index is intentionally left
   * in place during this operation; this is the G04a blocking experiment.
   */
  public async replaceFaceInTransaction(
    input: G04aFaceReplacementInput,
  ): Promise<void> {
    await this.executeTransaction(async (session, setStage) => {
      await this.replaceCore(input, session, setStage);
    });
  }

  /** Performs the same write then reads both documents inside the writer session. */
  public async replaceFaceWithWriterSessionRead(
    input: G04aFaceReplacementInput,
  ): Promise<G04aWriterSessionRead> {
    return this.executeTransaction(async (session, setStage) => {
      await this.replaceCore(input, session, setStage);
      setStage('writer-read');
      return {
        oldSlot: await this.readSlotInSession(input.oldSlotId, session),
        replacementSlot: await this.readSlotInSession(
          input.replacementSlotId,
          session,
        ),
      };
    });
  }

  /**
   * Holds the writer transaction open while another client/session observes
   * majority-visible state, then returns a second majority read after commit.
   */
  public async replaceFaceWithBeforeCommitObserver<T>(
    input: G04aFaceReplacementInput,
    observer: () => Promise<T>,
  ): Promise<Readonly<{ observerBeforeCommit: T; afterCommit: readonly G04aFaceSlotDocument[] }>> {
    const transactionResult = await this.executeTransaction(
      async (session, setStage) => {
        await this.replaceCore(input, session, setStage);
        setStage('writer-read');
        const writerRead = {
          oldSlot: await this.readSlotInSession(input.oldSlotId, session),
          replacementSlot: await this.readSlotInSession(
            input.replacementSlotId,
            session,
          ),
        };
        setStage('observer-before-commit');
        const observerBeforeCommit = await observer();
        return { observerBeforeCommit, writerRead };
      },
    );
    const afterCommit = await this.listSlots();
    return { observerBeforeCommit: transactionResult.observerBeforeCommit, afterCommit };
  }

  /** Reverse bind-first probe: the qualification unique index must reject before old release. */
  public async bindReplacementFirstInTransaction(
    input: G04aFaceReplacementInput,
  ): Promise<void> {
    await this.executeTransaction(async (session, setStage) => {
      setStage('reverse-bind-first');
      const bound = await this.collectionUpdate(
        {
          _id: input.replacementSlotId,
          qualificationId: null,
          qualificationIncarnation: null,
        },
        {
          $set: {
            provider: input.replacementProvider,
            subject: input.replacementSubject,
            qualificationId: input.qualificationId,
            qualificationIncarnation: input.qualificationIncarnation,
          },
          $inc: { version: 1 },
        },
        session,
      );
      assertExactlyOne(bound, 'bind replacement face slot first');
      setStage('release');
      const released = await this.collectionUpdate(
        {
          _id: input.oldSlotId,
          qualificationId: input.qualificationId,
          qualificationIncarnation: input.qualificationIncarnation,
        },
        { $set: { qualificationId: null, qualificationIncarnation: null }, $inc: { version: 1 } },
        session,
      );
      assertExactlyOne(released, 'release old face slot after bind');
    });
  }

  /** Binds an existing retained empty slot, preserving the unique indexes. */
  public async bindEmptySlotInTransaction(
    input: G04aFaceBindingInput,
  ): Promise<void> {
    await this.executeTransaction(async (session, setStage) => {
      setStage('bind');
      const result = await this.collectionUpdate(
        {
          _id: input.slotId,
          qualificationId: null,
          qualificationIncarnation: null,
        },
        {
          $set: {
            provider: input.provider,
            subject: input.subject,
            qualificationId: input.qualificationId,
            qualificationIncarnation: input.qualificationIncarnation,
          },
          $inc: { version: 1 },
        },
        session,
      );
      assertExactlyOne(result, 'bind empty face slot');
    });
  }

  /** Runs two independent writer sessions through one barrier. */
  public async bindTwoSessionsWithBarrier(
    input: G04aParallelBindingInput,
  ): Promise<readonly [G04aParallelSessionOutcome, G04aParallelSessionOutcome]> {
    const barrier = new TwoSessionBarrier();
    const first = this.bindOneSession(input.first, barrier);
    const second = this.bindOneSession(input.second, barrier);
    const outcomes = await Promise.all([first, second]);
    return [outcomes[0], outcomes[1]];
  }

  private async executeTransaction<T>(
    work: (
      session: ClientSession,
      setStage: (stage: G04aTransactionStage) => void,
    ) => Promise<T>,
  ): Promise<T> {
    const session = this.client.startSession();
    let stage: G04aTransactionStage = 'release';
    const setStage = (next: G04aTransactionStage): void => {
      stage = next;
    };
    try {
      session.startTransaction(TRANSACTION_OPTIONS);
      const result = await work(session, setStage);
      setStage('commit');
      await session.commitTransaction();
      return result;
    } catch (error: unknown) {
      const classification = classifyG04aTransactionError(error, stage);
      let abortFailure: unknown = null;
      if (
        session.inTransaction() &&
        classification.kind !== 'UNKNOWN_COMMIT_RESULT' &&
        classification.stage !== 'commit'
      ) {
        setStage('abort');
        try {
          await session.abortTransaction();
        } catch (abortError: unknown) {
          abortFailure = abortError;
        }
      }
      if (abortFailure !== null) {
        throw new G04aTransactionError(
          classifyG04aTransactionError(abortFailure, 'abort'),
          abortFailure,
        );
      }
      if (error instanceof G04aInjectedRollbackError) {
        throw error;
      }
      throw new G04aTransactionError(classification, error);
    } finally {
      await session.endSession();
    }
  }

  private async replaceCore(
    input: G04aFaceReplacementInput,
    session: ClientSession,
    setStage: (stage: G04aTransactionStage) => void,
  ): Promise<void> {
    setStage('release');
    const released = await this.collectionUpdate(
      {
        _id: input.oldSlotId,
        qualificationId: input.qualificationId,
        qualificationIncarnation: input.qualificationIncarnation,
      },
      {
        $set: { qualificationId: null, qualificationIncarnation: null },
        $inc: { version: 1 },
      },
      session,
    );
    assertExactlyOne(released, 'release old face slot');

    if (input.abortAfterRelease === true) {
      throw new G04aInjectedRollbackError();
    }

    setStage('bind');
    const reused = await this.collectionUpdate(
      {
        _id: input.replacementSlotId,
        qualificationId: null,
        qualificationIncarnation: null,
      },
      {
        $set: {
          provider: input.replacementProvider,
          subject: input.replacementSubject,
          qualificationId: input.qualificationId,
          qualificationIncarnation: input.qualificationIncarnation,
        },
        $inc: { version: 1 },
      },
      session,
    );
    assertExactlyOne(reused, 'reuse replacement face slot');
  }

  private async readSlotInSession(
    slotId: string,
    session: ClientSession,
  ): Promise<G04aFaceSlotDocument | null> {
    return this.requireCollection().findOne({ _id: slotId }, { session });
  }

  private async bindOneSession(
    input: G04aFaceBindingInput,
    barrier: TwoSessionBarrier,
  ): Promise<G04aParallelSessionOutcome> {
    const session = this.client.startSession();
    let stage: G04aTransactionStage = 'bind';
    try {
      session.startTransaction(TRANSACTION_OPTIONS);
      await barrier.arrive();
      const result = await this.collectionUpdate(
        {
          _id: input.slotId,
          qualificationId: null,
          qualificationIncarnation: null,
        },
        {
          $set: {
            provider: input.provider,
            subject: input.subject,
            qualificationId: input.qualificationId,
            qualificationIncarnation: input.qualificationIncarnation,
          },
          $inc: { version: 1 },
        },
        session,
      );
      assertExactlyOne(result, 'parallel bind face slot');
      stage = 'commit';
      await session.commitTransaction();
      return { committed: true, error: null };
    } catch (error: unknown) {
      const classification = classifyG04aTransactionError(error, stage);
      let abortFailure: unknown = null;
      if (
        session.inTransaction() &&
        classification.kind !== 'UNKNOWN_COMMIT_RESULT' &&
        stage !== 'commit'
      ) {
        stage = 'abort';
        try {
          await session.abortTransaction();
        } catch (abortError: unknown) {
          abortFailure = abortError;
        }
      }
      return {
        committed: false,
        error:
          abortFailure === null
            ? classification
            : classifyG04aTransactionError(abortFailure, 'abort'),
      };
    } finally {
      await session.endSession();
    }
  }

  private async collectionUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    session: ClientSession,
  ): Promise<UpdateResult<G04aFaceSlotDocument>> {
    return this.requireCollection().updateOne(filter, update, { session });
  }

  private requireCollection(): Collection<G04aFaceSlotDocument> {
    if (this.collection === null) {
      throw new Error('G04a schema is not initialized; call ensureSchema()');
    }
    return this.collection;
  }
}

export function isMongoDuplicateKeyError(error: unknown): boolean {
  if (
    error instanceof G04aTransactionError &&
    error.classification.kind === 'DUPLICATE_KEY'
  ) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export function classifyG04aTransactionError(
  error: unknown,
  stage: G04aTransactionStage,
): G04aTransactionErrorClassification {
  const code = readMongoErrorCode(error);
  const labels = readMongoErrorLabels(error);
  if (code === 11000) {
    return { kind: 'DUPLICATE_KEY', stage, code, labels };
  }
  if (labels.includes('UnknownTransactionCommitResult')) {
    return { kind: 'UNKNOWN_COMMIT_RESULT', stage, code, labels };
  }
  if (code === 112 && labels.includes('TransientTransactionError')) {
    return { kind: 'WRITE_CONFLICT', stage, code, labels };
  }
  if (code === 251) {
    return { kind: 'TRANSACTION_ABORTED', stage, code, labels };
  }
  return { kind: 'OTHER', stage, code, labels };
}

function readMongoErrorCode(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'number'
  ) {
    return (error as { code: number }).code;
  }
  return null;
}

function readMongoErrorLabels(error: unknown): readonly string[] {
  if (
    typeof error === 'object' &&
    error !== null &&
    'errorLabels' in error &&
    Array.isArray((error as { errorLabels?: unknown }).errorLabels)
  ) {
    return (
      (error as { errorLabels: unknown[] }).errorLabels.filter(
        (label): label is string => typeof label === 'string',
      )
    );
  }
  return [];
}

class TwoSessionBarrier {
  private arrived = 0;
  private readonly waiters: Array<() => void> = [];

  public async arrive(): Promise<void> {
    this.arrived += 1;
    if (this.arrived === 2) {
      for (const release of this.waiters) {
        release();
      }
      this.waiters.length = 0;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function assertExactlyOne(
  result: UpdateResult<G04aFaceSlotDocument>,
  operation: string,
): void {
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error(`${operation} expected exactly one modified slot`);
  }
}

export { createG04aFaceIndexFixture };
export type { G04aFaceIndexFixture, G04aFaceSlotDocument };
