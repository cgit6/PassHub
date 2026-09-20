import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const {
  G04aFaceIndexExperiment,
  G04aInjectedRollbackError,
  G04aTransactionError,
  createG04aFaceIndexFixture,
} = await import('../dist/src/infrastructure/mongo/g04a-face-index-experiment.js');

const uri =
  process.env.G04A_MONGO_URI ??
  'mongodb://127.0.0.1:27028/?replicaSet=rs0';
const database = process.env.G04A_MONGO_DATABASE ?? 'passhub_g04a_experiment';
const fixture = createG04aFaceIndexFixture();
const writer = await G04aFaceIndexExperiment.connect(uri, database);
const observer = await G04aFaceIndexExperiment.connect(uri, database);

const seed = async () => writer.clearAndSeed(fixture.slots);
const emptySlots = async () =>
  (await writer.listSlots()).filter((slot) => slot.qualificationId === null);

try {
  await writer.ensureSchema();
  await observer.ensureSchema();

  // reverse bind-first: qualification partial unique must reject before release
  await seed();
  await assert.rejects(
    writer.bindReplacementFirstInTransaction({
      oldSlotId: fixture.oldSlotId,
      replacementSlotId: fixture.replacementSlotId,
      qualificationId: fixture.qualificationId,
      qualificationIncarnation: fixture.qualificationIncarnation,
      replacementProvider: fixture.replacementProvider,
      replacementSubject: fixture.replacementSubject,
    }),
    (error) =>
      error instanceof G04aTransactionError &&
      error.classification.kind === 'DUPLICATE_KEY' &&
      error.classification.stage === 'reverse-bind-first',
  );
  const reverseState = await writer.listSlots();
  assert.equal(
    reverseState.find((slot) => slot._id === fixture.oldSlotId)?.qualificationId,
    fixture.qualificationId,
  );
  assert.equal(
    reverseState.find((slot) => slot._id === fixture.replacementSlotId)?.qualificationId,
    null,
  );

  // release -> reuse plus writer-session read and majority read after commit
  await seed();
  const writerRead = await writer.replaceFaceWithWriterSessionRead({
    oldSlotId: fixture.oldSlotId,
    replacementSlotId: fixture.replacementSlotId,
    qualificationId: fixture.qualificationId,
    qualificationIncarnation: fixture.qualificationIncarnation,
    replacementProvider: fixture.replacementProvider,
    replacementSubject: fixture.replacementSubject,
  });
  assert.equal(writerRead.oldSlot?.qualificationId, null);
  assert.equal(writerRead.replacementSlot?.qualificationId, fixture.qualificationId);
  const committedState = await writer.listSlots();
  assert.equal(
    committedState.find((slot) => slot._id === fixture.replacementSlotId)?.qualificationId,
    fixture.qualificationId,
  );

  // observer on another client/session sees only committed majority state
  await seed();
  const observed = await writer.replaceFaceWithBeforeCommitObserver(
    {
      oldSlotId: fixture.oldSlotId,
      replacementSlotId: fixture.replacementSlotId,
      qualificationId: fixture.qualificationId,
      qualificationIncarnation: fixture.qualificationIncarnation,
      replacementProvider: fixture.replacementProvider,
      replacementSubject: fixture.replacementSubject,
    },
    async () => ({
      oldSlot: await observer.resolveMappedFace(fixture.oldProvider, fixture.oldSubject),
      replacementSlot: await observer.resolveMappedFace(
        fixture.replacementProvider,
        fixture.replacementSubject,
      ),
    }),
  );
  assert.equal(observed.observerBeforeCommit.oldSlot?._id, fixture.oldSlotId);
  assert.equal(observed.observerBeforeCommit.replacementSlot, null);
  assert.equal(
    observed.afterCommit.find((slot) => slot._id === fixture.replacementSlotId)
      ?.qualificationId,
    fixture.qualificationId,
  );

  // duplicate(provider, subject) is classified separately from reverse duplicate
  await seed();
  await assert.rejects(
    writer.bindEmptySlotInTransaction({
      slotId: fixture.replacementSlotId,
      qualificationId: randomUUID(),
      qualificationIncarnation: randomUUID(),
      provider: fixture.oldProvider,
      subject: fixture.oldSubject,
    }),
    (error) =>
      error instanceof G04aTransactionError &&
      error.classification.kind === 'DUPLICATE_KEY' &&
      error.classification.stage === 'bind',
  );

  // injected failure after release proves no partial transaction state
  await seed();
  await assert.rejects(
    writer.replaceFaceInTransaction({
      oldSlotId: fixture.oldSlotId,
      replacementSlotId: fixture.replacementSlotId,
      qualificationId: fixture.qualificationId,
      qualificationIncarnation: fixture.qualificationIncarnation,
      replacementProvider: fixture.replacementProvider,
      replacementSubject: fixture.replacementSubject,
      abortAfterRelease: true,
    }),
    G04aInjectedRollbackError,
  );
  const rollbackState = await writer.listSlots();
  assert.equal(
    rollbackState.find((slot) => slot._id === fixture.oldSlotId)?.qualificationId,
    fixture.qualificationId,
  );

  // Two independent writer sessions pass a barrier before colliding on one subject key.
  await seed();
  const [emptyA, emptyB] = await emptySlots();
  assert.ok(emptyA?._id);
  assert.ok(emptyB?._id);
  const parallel = await writer.bindTwoSessionsWithBarrier({
    first: {
      slotId: emptyA._id,
      qualificationId: randomUUID(),
      qualificationIncarnation: randomUUID(),
      provider: 'fixture.parallel',
      subject: 'fixture.parallel.subject',
    },
    second: {
      slotId: emptyB._id,
      qualificationId: randomUUID(),
      qualificationIncarnation: randomUUID(),
      provider: 'fixture.parallel',
      subject: 'fixture.parallel.subject',
    },
  });
  assert.equal(parallel.filter((outcome) => outcome.committed).length, 1);
  assert.equal(
    parallel.filter(
      (outcome) =>
        outcome.error?.kind === 'DUPLICATE_KEY' ||
        outcome.error?.kind === 'WRITE_CONFLICT',
    ).length,
    1,
  );
  process.stdout.write('G04a face-index transaction probes passed\n');
} finally {
  await observer.close();
  await writer.close();
}
