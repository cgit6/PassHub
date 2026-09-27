import {
  createQueryApplication,
  createQueryCursorCodec,
  createWriterQuiescence,
  type EventQueryFilters,
  type QueryDataPort,
  type QuerySnapshotEvent,
  type QuerySnapshotQualification,
} from '../../src/composition/internal/index.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const OLD_EPOCH = '22222222-2222-4222-8222-222222222222';
const QUALIFICATION_ID = '33333333-3333-4333-8333-333333333333';
const INCARNATION = '44444444-4444-4444-8444-444444444444';
const MAPPING_ID = '55555555-5555-4555-8555-555555555555';
const EVENT_ID = '66666666-6666-4666-8666-666666666666';
const SOURCE_ID = '77777777-7777-4777-8777-777777777777';
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const EMPTY_FILTERS = Object.freeze({ qualificationId: null, outcome: null, reasonCode: null });

function qualification(overrides: Partial<QuerySnapshotQualification> = {}): QuerySnapshotQualification {
  return Object.freeze({
    qualificationId: QUALIFICATION_ID,
    displayName: 'Exact Demo',
    validFromMs: NOW - 10_000,
    validUntilMs: NOW + 10_000,
    presence: 'NOT_ENTERED' as const,
    enteredAtMs: null,
    exitedAtMs: null,
    revokedAtMs: null,
    revocationReason: null,
    expiredTerminalAtMs: null,
    createdAtMs: NOW - 20_000,
    updatedAtMs: NOW - 5_000,
    qualificationIncarnation: INCARNATION,
    faceMapping: Object.freeze({
      qualificationId: QUALIFICATION_ID,
      qualificationIncarnation: INCARNATION,
      mappingIncarnation: MAPPING_ID,
      version: 0,
    }),
    ...overrides,
  });
}

function event(overrides: Partial<QuerySnapshotEvent> = {}): QuerySnapshotEvent {
  return Object.freeze({
    eventId: EVENT_ID,
    sourceId: SOURCE_ID,
    direction: 'ENTRY' as const,
    kind: 'QR_SCANNED' as const,
    outcome: 'ACCEPTED' as const,
    reasonCode: 'ENTRY_GRANTED' as const,
    receivedAtMs: NOW - 2_000,
    recordedAtMs: NOW - 1_000,
    qualificationId: QUALIFICATION_ID,
    presenceTransition: Object.freeze({ from: 'NOT_ENTERED' as const, to: 'INSIDE' as const }),
    ...overrides,
  });
}

class FakeQueryData implements QueryDataPort {
  public qualifications: readonly QuerySnapshotQualification[] = [];
  public inside: readonly QuerySnapshotQualification[] = [];
  public events: readonly QuerySnapshotEvent[] = [];
  public qualificationDetail: QuerySnapshotQualification | null = null;
  public eventDetail: QuerySnapshotEvent | null = null;
  public failure: unknown = null;
  public readonly inputs: unknown[] = [];

  private result<T>(value: T): Promise<T> {
    return this.failure === null ? Promise.resolve(value) : Promise.reject(this.failure);
  }
  public listQualifications(input: Parameters<QueryDataPort['listQualifications']>[0]) { this.inputs.push(input); return this.result(this.qualifications); }
  public listInside(input: Parameters<QueryDataPort['listInside']>[0]) { this.inputs.push(input); return this.result(this.inside); }
  public listEvents(input: Parameters<QueryDataPort['listEvents']>[0]) { this.inputs.push(input); return this.result(this.events); }
  public readQualification(id: string, observedAtMs: number) { this.inputs.push({ id, observedAtMs }); return this.result(this.qualificationDetail); }
  public readEvent(id: string, observedAtMs: number) { this.inputs.push({ id, observedAtMs }); return this.result(this.eventDetail); }
}

function harness(data = new FakeQueryData(), nowMs = NOW) {
  const quiescence = createWriterQuiescence({ clock: { nowMs: () => nowMs } });
  return { data, quiescence, app: createQueryApplication({ data, writerQuiescence: quiescence, epoch: EPOCH }) };
}

describe('G09a canonical cursor codec', () => {
  const codec = createQueryCursorCodec();
  const after = Object.freeze({ lastTimeMs: NOW, lastId: QUALIFICATION_ID });

  test('encodes the exact eight-tuple as unpadded canonical base64url within 512 bytes', () => {
    const cursor = codec.encode(EPOCH, 'qualifications', EMPTY_FILTERS, after);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/u);
    expect(cursor).not.toContain('=');
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual([
      'p1', EPOCH, 'qualifications', null, null, null, new Date(NOW).toISOString(), QUALIFICATION_ID,
    ]);
    expect(codec.decode(cursor, EPOCH, 'qualifications', EMPTY_FILTERS)).toEqual({ kind: 'VALID', after });
  });

  test.each([
    '', 'A'.repeat(513), 'abcd=', Buffer.from([0xff]).toString('base64url'),
    Buffer.from('["p1"]', 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify(['p1', EPOCH, 'qualifications', null, null, null, '2026-09-27T12:00:00Z', QUALIFICATION_ID]), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify(['p1', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'qualifications', null, null, null, new Date(NOW).toISOString(), QUALIFICATION_ID]), 'utf8').toString('base64url'),
  ])('rejects malformed, fatal UTF-8, or noncanonical cursor %#', (cursor) => {
    expect(codec.decode(cursor, EPOCH, 'qualifications', EMPTY_FILTERS)).toEqual({ kind: 'INVALID_CURSOR' });
  });

  test('classifies a canonical old epoch before scope mismatch and route/filter mismatch separately', () => {
    const old = codec.encode(OLD_EPOCH, 'events', Object.freeze({ qualificationId: QUALIFICATION_ID, outcome: 'REJECTED', reasonCode: 'QUALIFICATION_EXPIRED' }), after);
    expect(codec.decode(old, EPOCH, 'qualifications', EMPTY_FILTERS)).toEqual({ kind: 'DATASET_EPOCH_MISMATCH' });
    const current = codec.encode(EPOCH, 'events', Object.freeze({ qualificationId: QUALIFICATION_ID, outcome: null, reasonCode: null }), after);
    expect(codec.decode(current, EPOCH, 'inside', EMPTY_FILTERS)).toEqual({ kind: 'CURSOR_SCOPE_MISMATCH' });
    expect(codec.decode(current, EPOCH, 'events', Object.freeze({ qualificationId: null, outcome: null, reasonCode: null }))).toEqual({ kind: 'CURSOR_SCOPE_MISMATCH' });
  });

  test('limit is not cursor-bound and the decoded after key is reused with a different limit', async () => {
    const h = harness();
    const cursor = codec.encode(EPOCH, 'qualifications', EMPTY_FILTERS, after);
    await h.app.listQualifications({ limit: 73, cursor });
    expect(h.data.inputs).toEqual([{ fetchLimit: 74, after, observedAtMs: NOW }]);
  });

  test('malformed endpoint filters are INVALID_REQUEST before cursor classification', async () => {
    const h = harness();
    const old = codec.encode(OLD_EPOCH, 'events', Object.freeze({ qualificationId: null, outcome: null, reasonCode: null }), after);
    await expect(h.app.listEvents({
      limit: 1, cursor: old,
      filters: { qualificationId: null, outcome: 'BAD', reasonCode: null } as never,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('application classifies old epoch separately from route/filter scope mismatch', async () => {
    const h = harness();
    const old = codec.encode(OLD_EPOCH, 'qualifications', EMPTY_FILTERS, after);
    await expect(h.app.listQualifications({ limit: 1, cursor: old })).rejects.toMatchObject({ code: 'DATASET_EPOCH_MISMATCH' });
    const wrongRoute = codec.encode(EPOCH, 'inside', EMPTY_FILTERS, after);
    await expect(h.app.listQualifications({ limit: 1, cursor: wrongRoute })).rejects.toMatchObject({ code: 'CURSOR_SCOPE_MISMATCH' });
  });
});

describe('G09a query application boundary and paging', () => {
  test('captures construction methods, takes one observedAt, fetches limit+1, and emits cursor only for an extra row', async () => {
    const data = new FakeQueryData();
    data.qualifications = [qualification(), qualification({ qualificationId: EVENT_ID, createdAtMs: NOW - 10_000 })];
    const original = data.listQualifications;
    const h = harness(data);
    data.listQualifications = () => Promise.reject(new Error('replacement'));
    const page = await h.app.listQualifications({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(data.inputs).toEqual([{ fetchLimit: 2, after: null, observedAtMs: NOW }]);
    data.listQualifications = original;
    data.qualifications = [qualification()];
    await expect(h.app.listQualifications({ limit: 1 })).resolves.toMatchObject({ nextCursor: null });
  });

  test('port rejection, throwing Proxy row, and extra secret row are all PERSISTENCE_UNAVAILABLE and release lease', async () => {
    const data = new FakeQueryData();
    const h = harness(data);
    data.failure = new Error('database secret');
    await expect(h.app.listQualifications({ limit: 1 })).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
    data.failure = null;
    data.qualifications = [new Proxy(qualification(), { ownKeys: () => { throw new Error('proxy'); } })];
    await expect(h.app.listQualifications({ limit: 1 })).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
    data.qualifications = [{ ...qualification(), credentialDigest: 'secret' } as never];
    await expect(h.app.listQualifications({ limit: 1 })).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
    data.qualifications = [];
    await expect(h.app.listQualifications({ limit: 1 })).resolves.toEqual({ items: [], nextCursor: null });
  });

  test.each(['foreign prototype', 'symbol brand'] as const)('%s row is rejected rather than trusted as a persistence DTO', async (brand) => {
    const data = new FakeQueryData();
    const branded = brand === 'foreign prototype'
      ? Object.assign(Object.create({ persistenceBrand: true }) as object, qualification()) as QuerySnapshotQualification
      : Object.defineProperty({ ...qualification() }, Symbol('persistenceBrand'), { value: true }) as QuerySnapshotQualification;
    data.qualifications = [branded];
    await expect(harness(data).app.listQualifications({ limit: 1 })).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
  });

  test('qualification projections derive expired/faceBound from one observation and expose exact keys', async () => {
    const data = new FakeQueryData();
    data.qualifications = [
      qualification({ presence: 'INSIDE', enteredAtMs: NOW - 5_000, validUntilMs: NOW - 1, expiredTerminalAtMs: null }),
      qualification({ qualificationId: EVENT_ID, qualificationIncarnation: MAPPING_ID, validUntilMs: NOW - 1 }),
    ];
    const items = (await harness(data).app.listQualifications({ limit: 2 })).items;
    expect(items[0]).toMatchObject({ presence: 'INSIDE', expired: true, faceBound: true });
    expect(items[1]).toMatchObject({ presence: 'NOT_ENTERED', expired: true, faceBound: false });
    expect(Object.keys(items[0]!).sort()).toEqual([
      'createdAt', 'displayName', 'expired', 'expiredTerminalAt', 'faceBound', 'presence',
      'qualificationId', 'revocationReason', 'revokedAt', 'updatedAt', 'validFrom', 'validUntil',
    ]);
  });

  test.each([
    { presence: 'NOT_ENTERED', enteredAtMs: NOW - 1 },
    { presence: 'INSIDE', enteredAtMs: null },
    { presence: 'EXITED', enteredAtMs: NOW - 2, exitedAtMs: null },
    { revokedAtMs: NOW - 1, revocationReason: null },
    { expiredTerminalAtMs: NOW - 1, revokedAtMs: NOW - 2, revocationReason: 'x' },
  ] as const)('invalid qualification state %# is persistence unavailable', async (override) => {
    const data = new FakeQueryData();
    data.qualifications = [qualification(override as Partial<QuerySnapshotQualification>)];
    await expect(harness(data).app.listQualifications({ limit: 1 })).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
  });
});

describe('G09a persisted Event semantic matrix', () => {
  const filters: EventQueryFilters = Object.freeze({ qualificationId: null, outcome: null, reasonCode: null });
  const cases: QuerySnapshotEvent[] = [
    event(),
    event({ direction: 'EXIT', outcome: 'ACCEPTED', reasonCode: 'EXIT_RECORDED', presenceTransition: { from: 'INSIDE', to: 'EXITED' } }),
    ...(['SOURCE_INACTIVE', 'INVALID_QR_CREDENTIAL', 'FACE_UNKNOWN', 'FACE_SUBJECT_NOT_MAPPED'] as const).map((reasonCode) => event({ outcome: 'REJECTED', reasonCode, qualificationId: null, presenceTransition: null })),
    ...(['QUALIFICATION_REVOKED', 'ALREADY_INSIDE', 'QUALIFICATION_ALREADY_USED', 'QUALIFICATION_NOT_YET_VALID', 'QUALIFICATION_EXPIRED'] as const).map((reasonCode) => event({ outcome: 'REJECTED', reasonCode, presenceTransition: null })),
    ...(['NOT_INSIDE', 'ALREADY_EXITED'] as const).map((reasonCode) => event({ direction: 'EXIT', outcome: 'REJECTED', reasonCode, presenceTransition: null })),
  ];

  test.each(cases)('accepts legitimate $direction/$outcome/$reasonCode Event', async (row) => {
    const data = new FakeQueryData(); data.events = [row];
    await expect(harness(data).app.listEvents({ limit: 1, filters })).resolves.toMatchObject({ items: [{ reasonCode: row.reasonCode }] });
  });

  test.each([
    event({ outcome: 'ACCEPTED', reasonCode: 'FACE_UNKNOWN', qualificationId: null, presenceTransition: null }),
    event({ outcome: 'REJECTED', reasonCode: 'ENTRY_GRANTED', presenceTransition: null }),
    event({ outcome: 'REJECTED', reasonCode: 'FACE_UNKNOWN', qualificationId: QUALIFICATION_ID, presenceTransition: null }),
    event({ direction: 'EXIT', outcome: 'REJECTED', reasonCode: 'QUALIFICATION_EXPIRED', presenceTransition: null }),
    event({ direction: 'ENTRY', outcome: 'REJECTED', reasonCode: 'NOT_INSIDE', presenceTransition: null }),
    event({ outcome: 'REJECTED', reasonCode: 'ALREADY_INSIDE', presenceTransition: { from: 'NOT_ENTERED', to: 'INSIDE' } }),
  ])('rejects illegal cross-field Event %#', async (row) => {
    const data = new FakeQueryData(); data.events = [row];
    await expect(harness(data).app.listEvents({ limit: 1, filters })).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
  });

  test('rejects an Event row carrying a secret/extra persistence field', async () => {
    const data = new FakeQueryData();
    data.events = [{ ...event(), inputHmac: 'must-not-leak' } as never];
    await expect(harness(data).app.listEvents({ limit: 1, filters })).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
  });
});
