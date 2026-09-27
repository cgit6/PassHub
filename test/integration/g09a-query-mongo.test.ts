import { randomUUID } from 'node:crypto';

import {
  MongoClient,
  type CommandStartedEvent,
  type Collection,
  type Document,
} from 'mongodb';

import type { QuerySnapshotQualification } from '../../src/access/ports/index.js';
import {
  G04A_FACE_SLOTS_COLLECTION,
  G04B_EVENTS_COLLECTION,
  G04B_QUALIFICATIONS_COLLECTION,
  G04bMongoPersistenceAdapter,
  createG04bFixture,
  type G04aFaceSlotDocument,
  type G04bEventDocument,
  type G04bQualificationDocument,
} from '../../src/infrastructure/mongo/index.js';
import {
  G04B_EVENT_QUALIFICATION_INDEX,
  G04B_EVENT_RECEIVED_INDEX,
  G04B_QUALIFICATION_CREATED_INDEX,
  G04B_QUALIFICATION_INSIDE_INDEX,
} from '../../src/infrastructure/mongo/g04b-schema.js';

const uri = process.env.G09A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const databasePrefix = process.env.G09A_MONGO_DATABASE_PREFIX ?? `passhub_g09a_query_${process.pid}`;
const NOW = Date.parse('2026-09-28T00:00:00.000Z');

interface StringIdDocument extends Document { _id: string }

describe('G09a true MongoDB QueryDataPort', () => {
  let client: MongoClient;
  const databases: string[] = [];
  const commands: CommandStartedEvent[] = [];

  beforeAll(async () => {
    client = new MongoClient(uri, {
      retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, monitorCommands: true,
    });
    client.on('commandStarted', (event) => commands.push(event));
    await client.connect();
    const buildInfo = await client.db('admin').command({ buildInfo: 1 });
    const hello = await client.db('admin').command({ hello: 1 });
    expect(buildInfo.version).toBe('8.0.32');
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });

  afterEach(async () => {
    const databaseName = databases.pop();
    if (databaseName !== undefined) await client.db(databaseName).dropDatabase();
    commands.length = 0;
  });
  afterAll(async () => { await client.close(); });

  async function setup(label: string) {
    const databaseName = `${databasePrefix}_${label}_${databases.length}`.slice(0, 63);
    databases.push(databaseName);
    const fixture = createG04bFixture(NOW);
    const adapter = new G04bMongoPersistenceAdapter(client, databaseName, { nowMs: () => NOW });
    await adapter.ensureSchema();
    await adapter.clearAndSeed(fixture);
    commands.length = 0;
    return { adapter, fixture, database: client.db(databaseName) };
  }

  function qualification(
    base: G04bQualificationDocument,
    id: string,
    createdAt: Date,
    options: { presence?: 'NOT_ENTERED' | 'INSIDE'; enteredAt?: Date | null } = {},
  ): G04bQualificationDocument {
    const presence = options.presence ?? 'NOT_ENTERED';
    return {
      ...base,
      _id: id,
      incarnation: randomUUID(),
      displayName: `qualification-${id.slice(0, 8)}`,
      qrLookupDigest: id.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      presence,
      enteredAt: presence === 'INSIDE' ? options.enteredAt ?? createdAt : null,
      createdAt,
      updatedAt: createdAt,
    };
  }

  function event(
    fixture: ReturnType<typeof createG04bFixture>,
    input: Readonly<{
      id: string; externalEventId: string; receivedAt: Date;
      qualificationId: string | null; outcome: 'ACCEPTED' | 'REJECTED';
      reasonCode: G04bEventDocument['reasonCode'];
    }>,
  ): G04bEventDocument {
    const accepted = input.outcome === 'ACCEPTED';
    return {
      _id: input.id,
      sourceId: fixture.sourceEntryId,
      externalEventId: input.externalEventId,
      kind: accepted ? 'QR_SCANNED' : 'FACE_UNKNOWN',
      direction: 'ENTRY',
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      receivedAt: input.receivedAt,
      recordedAt: new Date(input.receivedAt.getTime() + 1),
      qualificationId: input.qualificationId,
      presenceTransition: accepted ? { from: 'NOT_ENTERED', to: 'INSIDE' } : null,
      inputHmac: input.id.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
      comparisonReferenceId: fixture.comparisonReferenceId,
    };
  }

  test('all five methods use primary majority reads; qualification list/detail use one aggregate with joined mapping', async () => {
    const h = await setup('five_methods');
    const list = await h.adapter.listQualifications({ fetchLimit: 2, after: null, observedAtMs: NOW });
    const inside = await h.adapter.listInside({ fetchLimit: 2, after: null, observedAtMs: NOW });
    const events = await h.adapter.listEvents({
      fetchLimit: 2, after: null, observedAtMs: NOW,
      filters: { qualificationId: null, outcome: null, reasonCode: null },
    });
    const detail = await h.adapter.readQualification(h.fixture.qualificationId, NOW);
    const missingEvent = await h.adapter.readEvent(randomUUID(), NOW);
    expect(list).toHaveLength(1);
    expect(list[0]?.faceMapping).toMatchObject({
      qualificationId: h.fixture.qualificationId,
      qualificationIncarnation: h.fixture.qualificationIncarnation,
    });
    expect(inside).toEqual([]);
    expect(events).toEqual([]);
    expect(detail?.faceMapping).toEqual(list[0]?.faceMapping);
    expect(missingEvent).toBeNull();

    const aggregates = commands.filter((item) => item.commandName === 'aggregate');
    expect(aggregates).toHaveLength(5);
    for (const item of aggregates) {
      expect(item.command.readConcern).toEqual({ level: 'majority' });
      expect(item.command.$readPreference).toBeUndefined();
    }
    expect(commands.filter((item) => item.commandName === 'find' || item.commandName === 'count')).toEqual([]);
  });

  test('qualification createdAt+id and inside enteredAt+id keysets cross equal-time pages without gaps or duplicates', async () => {
    const h = await setup('qualification_keysets');
    const base = h.fixture.qualifications[0]!;
    await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).deleteMany({});
    const same = new Date(NOW - 10_000);
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort().reverse();
    const documents = ids.map((id) => qualification(base, id, same));
    await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).insertMany(documents);

    const collect = async (method: 'listQualifications' | 'listInside') => {
      const seen: string[] = [];
      let after: { lastTimeMs: number; lastId: string } | null = null;
      for (;;) {
        const page: readonly QuerySnapshotQualification[] = method === 'listInside'
          ? await h.adapter.listInside({ fetchLimit: 2, after, observedAtMs: NOW })
          : await h.adapter.listQualifications({ fetchLimit: 2, after, observedAtMs: NOW });
        if (page.length === 0) break;
        seen.push(...page.map((row) => row.qualificationId));
        const last = page.at(-1)!;
        after = { lastTimeMs: method === 'listInside' ? last.enteredAtMs! : last.createdAtMs, lastId: last.qualificationId };
      }
      return seen;
    };
    expect(await collect('listQualifications')).toEqual(ids);

    await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).updateMany({}, {
      $set: { presence: 'INSIDE', enteredAt: same },
    });
    expect(await collect('listInside')).toEqual(ids);
  });

  test('event receivedAt+id keyset and limit+1 preserve exact order with qualificationId null', async () => {
    const h = await setup('event_keyset');
    const same = new Date(NOW - 10_000);
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort().reverse();
    await h.database.collection<G04bEventDocument>(G04B_EVENTS_COLLECTION).insertMany(ids.map((id, index) => event(h.fixture, {
      id, externalEventId: `event-${index}`, receivedAt: same, qualificationId: null,
      outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN',
    })));
    const first = await h.adapter.listEvents({
      fetchLimit: 3, after: null, observedAtMs: NOW,
      filters: { qualificationId: null, outcome: null, reasonCode: null },
    });
    const second = await h.adapter.listEvents({
      fetchLimit: 3,
      after: { lastTimeMs: first.at(-1)!.receivedAtMs, lastId: first.at(-1)!.eventId },
      observedAtMs: NOW,
      filters: { qualificationId: null, outcome: null, reasonCode: null },
    });
    expect([...first, ...second].map((row) => row.eventId)).toEqual(ids);
    expect([...first, ...second].every((row) => row.qualificationId === null)).toBe(true);
  });

  test('all eight event-filter presence combinations are ANDed exactly', async () => {
    const h = await setup('filters');
    const acceptedId = randomUUID();
    const rejectedId = randomUUID();
    await h.database.collection<G04bEventDocument>(G04B_EVENTS_COLLECTION).insertMany([
      event(h.fixture, { id: acceptedId, externalEventId: 'accepted', receivedAt: new Date(NOW - 2), qualificationId: h.fixture.qualificationId, outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED' }),
      event(h.fixture, { id: rejectedId, externalEventId: 'unknown', receivedAt: new Date(NOW - 1), qualificationId: null, outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN' }),
    ]);
    for (const qualificationId of [null, h.fixture.qualificationId]) {
      for (const outcome of [null, 'REJECTED'] as const) {
        for (const reasonCode of [null, 'FACE_UNKNOWN'] as const) {
          const result = await h.adapter.listEvents({
            fetchLimit: 10, after: null, observedAtMs: NOW,
            filters: { qualificationId, outcome, reasonCode },
          });
          const expected = [
            { eventId: acceptedId, qualificationId: h.fixture.qualificationId, outcome: 'ACCEPTED', reasonCode: 'ENTRY_GRANTED' },
            { eventId: rejectedId, qualificationId: null, outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN' },
          ].filter((row) => (qualificationId === null || row.qualificationId === qualificationId)
            && (outcome === null || row.outcome === outcome)
            && (reasonCode === null || row.reasonCode === reasonCode));
          expect(result.map((row) => row.eventId).sort()).toEqual(expected.map((row) => row.eventId).sort());
        }
      }
    }
  });

  test('mapping requires both qualification ID and incarnation; details distinguish found/missing', async () => {
    const h = await setup('mapping_incarnation');
    const base = h.fixture.qualifications[0]!;
    const staleId = randomUUID();
    const staleQualification = qualification(base, staleId, new Date(NOW - 5_000));
    await h.database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION).insertOne(staleQualification);
    const staleSlot: G04aFaceSlotDocument = {
      _id: randomUUID(), provider: 'DemoFace.stale', subject: 'stale-subject',
      qualificationId: staleId, qualificationIncarnation: randomUUID(),
      slotIncarnation: randomUUID(), version: 0,
    };
    await h.database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION).insertOne(staleSlot);
    const found = await h.adapter.readQualification(staleId, NOW);
    expect(found).not.toBeNull();
    expect(found?.faceMapping).toBeNull();
    await expect(h.adapter.readQualification(randomUUID(), NOW)).resolves.toBeNull();

    const eventId = randomUUID();
    await h.database.collection<G04bEventDocument>(G04B_EVENTS_COLLECTION).insertOne(event(h.fixture, {
      id: eventId, externalEventId: 'detail-event', receivedAt: new Date(NOW),
      qualificationId: null, outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN',
    }));
    await expect(h.adapter.readEvent(eventId, NOW)).resolves.toMatchObject({ eventId, qualificationId: null });
    await expect(h.adapter.readEvent(randomUUID(), NOW)).resolves.toBeNull();
  });

  test('query projections expose exact safe fields and never persistence secrets', async () => {
    const h = await setup('safe_projection');
    const eventId = randomUUID();
    await h.database.collection<G04bEventDocument>(G04B_EVENTS_COLLECTION).insertOne(event(h.fixture, {
      id: eventId, externalEventId: 'secret-external-id', receivedAt: new Date(NOW),
      qualificationId: null, outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN',
    }));
    const qualifications = await h.adapter.listQualifications({ fetchLimit: 2, after: null, observedAtMs: NOW });
    const events = await h.adapter.listEvents({
      fetchLimit: 2, after: null, observedAtMs: NOW,
      filters: { qualificationId: null, outcome: null, reasonCode: null },
    });
    expect(Object.keys(qualifications[0]!).sort()).toEqual([
      'createdAtMs', 'displayName', 'enteredAtMs', 'exitedAtMs', 'expiredTerminalAtMs', 'faceMapping',
      'presence', 'qualificationId', 'qualificationIncarnation', 'revocationReason', 'revokedAtMs',
      'updatedAtMs', 'validFromMs', 'validUntilMs',
    ]);
    expect(Object.keys(qualifications[0]!.faceMapping!).sort()).toEqual([
      'mappingIncarnation', 'qualificationId', 'qualificationIncarnation', 'version',
    ]);
    expect(Object.keys(events[0]!).sort()).toEqual([
      'direction', 'eventId', 'kind', 'outcome', 'presenceTransition', 'qualificationId',
      'reasonCode', 'receivedAtMs', 'recordedAtMs', 'sourceId',
    ]);
    expect(JSON.stringify({ qualifications, events })).not.toMatch(/secret-external-id|externalEventId|inputHmac|comparisonReference|qrLookupDigest|subject/u);
  });

  test('malformed stored documents and anomalous aggregate projections fail closed', async () => {
    const h = await setup('malformed');
    const malformed = {
      ...h.fixture.qualifications[0],
      _id: randomUUID(),
      qrLookupDigest: 'e'.repeat(64),
      validFrom: 'not-a-date',
    };
    await h.database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).insertOne(malformed as unknown as StringIdDocument, { bypassDocumentValidation: true });
    await expect(h.adapter.listQualifications({ fetchLimit: 10, after: null, observedAtMs: NOW })).rejects.toThrow(/invalid/u);

    type Internals = { collections: {
      qualifications: Collection<G04bQualificationDocument>;
      faceSlots: Collection<G04aFaceSlotDocument>;
      events: Collection<G04bEventDocument>;
      users: Collection<Document>;
      sources: Collection<Document>;
      metadata: Collection<Document>;
    } | null };
    const internals = h.adapter as unknown as Internals;
    const original = internals.collections;
    if (original === null) throw new Error('collections unavailable');
    const eventsCollection = original.events;
    const projection = {
      _id: randomUUID(), sourceId: h.fixture.sourceEntryId, direction: 'ENTRY', kind: 'FACE_UNKNOWN',
      outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN', receivedAt: new Date(NOW), recordedAt: new Date(NOW),
      qualificationId: null, presenceTransition: null, secret: 'extra',
    };
    const anomalousEvents = Object.create(eventsCollection) as Collection<G04bEventDocument>;
    Object.defineProperty(anomalousEvents, 'aggregate', {
      value: () => ({ toArray: () => Promise.resolve([projection]) }),
    });
    internals.collections = { ...original, events: anomalousEvents };
    try {
      await expect(h.adapter.readEvent(projection._id, NOW)).rejects.toThrow(/record|invalid/u);
    } finally {
      internals.collections = original;
    }
  });

  test.each([
    ['listQualifications', { fetchLimit: 1, after: null, observedAtMs: NOW }],
    ['listInside', { fetchLimit: 102, after: null, observedAtMs: NOW }],
    ['listEvents', { fetchLimit: 2, after: null, observedAtMs: NOW, filters: { qualificationId: null, outcome: 'BAD', reasonCode: null } }],
    ['listEvents', { fetchLimit: 2, after: { lastTimeMs: 1.5, lastId: randomUUID() }, observedAtMs: NOW, filters: { qualificationId: null, outcome: null, reasonCode: null } }],
  ] as const)('%s rejects malformed typed input before Mongo execution', async (method, value) => {
    const h = await setup(`guard_${method}_${method === 'listQualifications' ? 'q' : method === 'listInside' ? 'i' : 'e'}_${String(value).replace(/[^a-z0-9]/giu, '_')}`);
    commands.length = 0;
    await expect((h.adapter[method] as (input: never) => Promise<unknown>)(value as never)).rejects.toThrow(/query/u);
    expect(commands.filter((item) => item.commandName === 'aggregate')).toEqual([]);
  });

  test('detail guards reject malformed UUID/time before Mongo execution', async () => {
    const h = await setup('detail_guards');
    commands.length = 0;
    await expect(h.adapter.readQualification('not-a-uuid', NOW)).rejects.toThrow(/UUID/u);
    await expect(h.adapter.readEvent(randomUUID(), Number.NaN)).rejects.toThrow(/time/u);
    expect(commands.filter((item) => item.commandName === 'aggregate')).toEqual([]);
  });

  test('the four query indexes remain exact and unchanged', async () => {
    const h = await setup('indexes');
    const qualificationIndexes = await h.database.collection<StringIdDocument>(G04B_QUALIFICATIONS_COLLECTION).indexInformation({ full: true });
    const eventIndexes = await h.database.collection<StringIdDocument>(G04B_EVENTS_COLLECTION).indexInformation({ full: true });
    expect(qualificationIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: G04B_QUALIFICATION_CREATED_INDEX, key: { createdAt: -1, _id: -1 } }),
      expect.objectContaining({ name: G04B_QUALIFICATION_INSIDE_INDEX, key: { presence: 1, enteredAt: -1, _id: -1 } }),
    ]));
    expect(eventIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: G04B_EVENT_RECEIVED_INDEX, key: { receivedAt: -1, _id: -1 } }),
      expect.objectContaining({ name: G04B_EVENT_QUALIFICATION_INDEX, key: { qualificationId: 1, receivedAt: -1, _id: -1 } }),
    ]));
  });
});
