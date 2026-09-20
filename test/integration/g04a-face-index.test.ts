import { randomUUID } from 'node:crypto';

import { MongoClient, type Collection } from 'mongodb';

import {
  G04A_FACE_QUALIFICATION_INDEX,
  G04A_FACE_SLOTS_COLLECTION,
  G04A_FACE_SUBJECT_INDEX,
  type G04aFaceSlotDocument,
} from '../../src/infrastructure/mongo/g04a-face-index-schema.js';
import {
  classifyG04aTransactionError,
  createG04aFaceIndexFixture,
  G04aFaceIndexExperiment,
  G04aInjectedRollbackError,
  G04aTransactionError,
  type G04aFaceBindingInput,
  type G04aFaceIndexFixture,
  type G04aParallelSessionOutcome,
} from '../../src/infrastructure/mongo/g04a-face-index-experiment.js';

const MONGO_URI =
  process.env.G04A_MONGO_URI ??
  'mongodb://127.0.0.1:27028/?replicaSet=rs0';
const DATABASE =
  process.env.G04A_MONGO_DATABASE ??
  `passhub_g04a_jest_${process.pid}_${randomUUID().slice(0, 8)}`;
const BARRIER_TIMEOUT_MS = 8_000;

let writer: G04aFaceIndexExperiment;
let observer: G04aFaceIndexExperiment;
let rawClient: MongoClient;
let controlClient: MongoClient;
let collection: Collection<G04aFaceSlotDocument>;
let fixture: G04aFaceIndexFixture;

beforeAll(async () => {
  writer = await G04aFaceIndexExperiment.connect(MONGO_URI, DATABASE);
  observer = await G04aFaceIndexExperiment.connect(MONGO_URI, DATABASE);
  rawClient = new MongoClient(MONGO_URI, {
    retryReads: false,
    retryWrites: false,
    maxAdaptiveRetries: 0,
  });
  await rawClient.connect();
  controlClient = new MongoClient(MONGO_URI, {
    retryReads: false,
    retryWrites: false,
    maxAdaptiveRetries: 0,
  });
  await controlClient.connect();
  await writer.ensureSchema();
  await observer.ensureSchema();
  collection = rawClient.db(DATABASE).collection(G04A_FACE_SLOTS_COLLECTION);
  fixture = createG04aFaceIndexFixture();
});

afterAll(async () => {
  await rawClient?.db(DATABASE).dropCollection(G04A_FACE_SLOTS_COLLECTION);
  await controlClient?.close();
  await rawClient?.close();
  await observer?.close();
  await writer?.close();
});

beforeEach(async () => {
  await writer.clearAndSeed(fixture.slots);
});

test('requires exact MongoDB 8.0.32 rs0 writable single-member readiness', async () => {
  await writer.assertMongo8032ReplicaSet();
  const buildInfo = (await rawClient.db(DATABASE).command({
    buildInfo: 1,
  })) as { version?: unknown };
  const hello = (await rawClient.db(DATABASE).command({ hello: 1 })) as {
    setName?: unknown;
    isWritablePrimary?: unknown;
    hosts?: unknown;
  };
  expect(buildInfo.version).toBe('8.0.32');
  expect(hello.setName).toBe('rs0');
  expect(hello.isWritablePrimary).toBe(true);
  expect(hello.hosts).toEqual(['127.0.0.1:27028']);
});

test('keeps the exact unique indexes and simple comparison semantics', async () => {
  const indexes = await collection.listIndexes().toArray();
  const subjectIndex = indexes.find(
    (index) => index.name === G04A_FACE_SUBJECT_INDEX,
  );
  const qualificationIndex = indexes.find(
    (index) => index.name === G04A_FACE_QUALIFICATION_INDEX,
  );
  expect(subjectIndex).toMatchObject({
    key: { provider: 1, subject: 1 },
    unique: true,
  });
  expect(qualificationIndex).toMatchObject({
    key: { qualificationId: 1 },
    unique: true,
    partialFilterExpression: { qualificationId: { $type: 'string' } },
  });
  // Mongo omits the default simple collation from listIndexes(). Verify its
  // observable semantics by storing case variants as distinct exact keys.
  await collection.insertMany([
    emptySlot('simple-upper', 'simple.provider', 'CaseSensitive'),
    emptySlot('simple-lower', 'simple.provider', 'casesensitive'),
  ]);
  expect(
    await collection.countDocuments({ provider: 'simple.provider' }),
  ).toBe(2);
});

test('retains multiple null empty slots and rejects invalid document shapes', async () => {
  const seeded = await writer.listSlots();
  expect(seeded.filter((slot) => slot.qualificationId === null)).toHaveLength(2);

  const validBase = emptySlot('shape-base', 'shape.provider', 'shape.subject');
  const invalidDocuments: readonly Record<string, unknown>[] = [
    { ...validBase, _id: 'shape-array', qualificationId: ['q'] },
    { ...validBase, _id: 'shape-missing-id', qualificationId: undefined },
    { ...validBase, _id: 'shape-missing-incarnation', qualificationIncarnation: undefined },
    { ...validBase, _id: 'shape-null-incarnation', qualificationId: 'q' },
    { ...validBase, _id: 'shape-null-id', qualificationIncarnation: 'inc' },
  ];
  for (const document of invalidDocuments) {
    const candidate = { ...document };
    for (const [key, value] of Object.entries(candidate)) {
      if (value === undefined) {
        delete candidate[key];
      }
    }
    await expect(
      collection.insertOne(candidate as unknown as G04aFaceSlotDocument),
    ).rejects.toMatchObject({
      code: 121,
    });
  }
});

test('release-first exposes writer state, old observer state, then majority committed state', async () => {
  const writerRead = await writer.replaceFaceWithWriterSessionRead(replacementInput());
  expect(writerRead.oldSlot).toMatchObject({
    _id: fixture.oldSlotId,
    qualificationId: null,
    qualificationIncarnation: null,
  });
  expect(writerRead.replacementSlot).toMatchObject({
    _id: fixture.replacementSlotId,
    qualificationId: fixture.qualificationId,
    qualificationIncarnation: fixture.qualificationIncarnation,
  });

  await writer.clearAndSeed(fixture.slots);
  const observed = await writer.replaceFaceWithBeforeCommitObserver(
    replacementInput(),
    async () => ({
      oldSlot: await observer.resolveMappedFace(
        fixture.oldProvider,
        fixture.oldSubject,
      ),
      replacementSlot: await observer.resolveMappedFace(
        fixture.replacementProvider,
        fixture.replacementSubject,
      ),
    }),
  );
  expect(observed.observerBeforeCommit.oldSlot?._id).toBe(fixture.oldSlotId);
  expect(observed.observerBeforeCommit.replacementSlot).toBeNull();
  expect(
    observed.afterCommit.find((slot) => slot._id === fixture.oldSlotId),
  ).toMatchObject({ qualificationId: null, qualificationIncarnation: null });
  expect(
    observed.afterCommit.find(
      (slot) => slot._id === fixture.replacementSlotId,
    ),
  ).toMatchObject({
    qualificationId: fixture.qualificationId,
    qualificationIncarnation: fixture.qualificationIncarnation,
  });
});

test('bind-first reports actual E11000 at reverse-bind-first and fully rolls back', async () => {
  let thrown: unknown;
  try {
    await writer.bindReplacementFirstInTransaction(replacementInput());
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(G04aTransactionError);
  expect((thrown as G04aTransactionError).classification).toMatchObject({
    kind: 'DUPLICATE_KEY',
    stage: 'reverse-bind-first',
    code: 11000,
  });
  await expectSeedUnchanged();
});

test('provider+subject and qualification duplicates are E11000 bind failures with rollback', async () => {
  const duplicateProviderSubject: G04aFaceBindingInput = {
    slotId: fixture.replacementSlotId,
    qualificationId: randomUUID(),
    qualificationIncarnation: randomUUID(),
    provider: fixture.oldProvider,
    subject: fixture.oldSubject,
  };
  await expect(writer.bindEmptySlotInTransaction(duplicateProviderSubject)).rejects.toMatchObject({
    classification: { kind: 'DUPLICATE_KEY', stage: 'bind', code: 11000 },
  });
  await expectSeedUnchanged();

  const duplicateQualification: G04aFaceBindingInput = {
    slotId: fixture.replacementSlotId,
    qualificationId: fixture.qualificationId,
    qualificationIncarnation: fixture.qualificationIncarnation,
    provider: 'different.provider',
    subject: 'different.subject',
  };
  await expect(writer.bindEmptySlotInTransaction(duplicateQualification)).rejects.toMatchObject({
    classification: { kind: 'DUPLICATE_KEY', stage: 'bind', code: 11000 },
  });
  await expectSeedUnchanged();
});

test('injected abort rolls back release and preserves all versions', async () => {
  await expect(
    writer.replaceFaceInTransaction({
      ...replacementInput(),
      abortAfterRelease: true,
    }),
  ).rejects.toBeInstanceOf(G04aInjectedRollbackError);
  await expectSeedUnchanged();
});

test('two real sessions use a bounded barrier: at most one commit and one final binding', async () => {
  const emptySlots = (await writer.listSlots()).filter(
    (slot) => slot.qualificationId === null,
  );
  const first = emptySlots[0];
  const second = emptySlots[1];
  expect(first?._id).toBeDefined();
  expect(second?._id).toBeDefined();
  const parallelInputs = {
    first: parallelInput(first?._id ?? ''),
    second: parallelInput(second?._id ?? ''),
  };
  const outcomes = await withTimeout(
    writer.bindTwoSessionsWithBarrier(parallelInputs),
    BARRIER_TIMEOUT_MS,
  );
  expect(outcomes.filter((outcome) => outcome.committed)).toHaveLength(1);
  expect(outcomes.filter((outcome) => !outcome.committed)).toHaveLength(1);
  assertParallelClassification(outcomes);
  const finalBindings = (await writer.listSlots()).filter(
    (slot) =>
      slot.provider === 'parallel.provider' &&
      slot.subject === 'parallel.subject' &&
      slot.qualificationId !== null,
  );
  expect(finalBindings).toHaveLength(1);
});

test('classifies a real server-aborted transaction as code 251 at commit', async () => {
  const session = rawClient.startSession();
  let thrown: unknown;
  try {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority', j: true },
      readPreference: 'primary',
    });
    await collection.insertOne(emptySlot('server-aborted', 'aborted.provider', 'aborted.subject'), {
      session,
    });
    await controlClient.db('admin').command({ killSessions: [session.id] });
    try {
      await session.commitTransaction();
    } catch (error: unknown) {
      thrown = error;
    }
  } finally {
    await session.endSession().catch(() => undefined);
  }
  expect(thrown).toMatchObject({
    code: 251,
    errorLabels: expect.arrayContaining(['TransientTransactionError']),
  });
  expect(classifyG04aTransactionError(thrown, 'commit')).toEqual({
    kind: 'TRANSACTION_ABORTED',
    stage: 'commit',
    code: 251,
    labels: ['TransientTransactionError'],
  });
});

function replacementInput() {
  return {
    oldSlotId: fixture.oldSlotId,
    replacementSlotId: fixture.replacementSlotId,
    qualificationId: fixture.qualificationId,
    qualificationIncarnation: fixture.qualificationIncarnation,
    replacementProvider: fixture.replacementProvider,
    replacementSubject: fixture.replacementSubject,
  };
}

async function expectSeedUnchanged(): Promise<void> {
  expect(await writer.listSlots()).toEqual(
    [...fixture.slots].sort((left, right) => left._id.localeCompare(right._id)),
  );
}

function parallelInput(slotId: string): G04aFaceBindingInput {
  return {
    slotId,
    qualificationId: randomUUID(),
    qualificationIncarnation: randomUUID(),
    provider: 'parallel.provider',
    subject: 'parallel.subject',
  };
}

function emptySlot(
  _idLabel: string,
  provider: string,
  subject: string,
): G04aFaceSlotDocument {
  return {
    _id: randomUUID(),
    provider,
    subject,
    qualificationId: null,
    qualificationIncarnation: null,
    slotIncarnation: randomUUID(),
    version: 0,
  };
}

function assertParallelClassification(
  outcomes: readonly [G04aParallelSessionOutcome, G04aParallelSessionOutcome],
): void {
  for (const outcome of outcomes) {
    if (outcome.committed) {
      expect(outcome.error).toBeNull();
      continue;
    }
    expect(outcome.error).not.toBeNull();
    const error = outcome.error;
    expect(error?.stage).toBe('bind');
    if (error?.code === 112) {
      expect(error.kind).toBe('WRITE_CONFLICT');
      expect(error.labels).toContain('TransientTransactionError');
    } else if (error?.code === 251) {
      expect(error.kind).toBe('TRANSACTION_ABORTED');
    } else if (error?.code === 11000) {
      expect(error.kind).toBe('DUPLICATE_KEY');
    } else {
      throw new Error(`unexpected parallel classification: ${JSON.stringify(error)}`);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`G04a barrier timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
