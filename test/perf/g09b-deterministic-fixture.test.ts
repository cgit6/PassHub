import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  G04B_STARTUP_VECTORS,
  type G04bEventDocument,
  type G04bQualificationDocument,
} from '../../src/infrastructure/mongo/g04b-schema.js';
import {
  G09B_BASE_TIME_MS,
  G09B_FIXTURE_SEED,
  G09B_TIE_BUCKETS,
  canonicalNdjsonLines,
  createG09bDeterministicFixture,
  createG09bFixtureManifest,
  hashFixture,
  type G09bDeterministicFixture,
  type G09bFixtureCase,
} from './g09b-deterministic-fixture.js';

const EXPECTED_HASH = 'c86eb1cdd84c5b7ce204bd2d24f96af37d32f67f5e8fba06f8f0f28848f4de48';
const UUID_V4_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

const QUALIFICATION_KEYS = ['_id', 'incarnation', 'version', 'displayName', 'validFrom', 'validUntil', 'createdBy', 'qrLookupDigest', 'presence', 'enteredAt', 'exitedAt', 'revokedAt', 'revocationReason', 'expiredTerminalAt', 'createdAt', 'updatedAt'].sort();
const FACE_SLOT_KEYS = ['_id', 'provider', 'subject', 'qualificationId', 'qualificationIncarnation', 'slotIncarnation', 'version'].sort();
const EVENT_KEYS = ['_id', 'sourceId', 'externalEventId', 'kind', 'direction', 'outcome', 'reasonCode', 'receivedAt', 'recordedAt', 'qualificationId', 'presenceTransition', 'inputHmac', 'comparisonReferenceId'].sort();
const USER_KEYS = ['_id', 'username', 'role', 'enabled', 'passwordSalt', 'passwordHash', 'scryptParams'].sort();
const SOURCE_KEYS = ['_id', 'credentialAlias', 'direction', 'active', 'credentialDigest', 'incarnation', 'version'].sort();
const METADATA_KEYS = ['_id', 'kind', 'datasetEpoch', 'comparisonReferenceId', 'frameVersion', 'startupVectors', 'qrGuardVersion', 'faceGuardVersion', 'slotCount', 'writeRunClaim'].sort();

function binaryDescending(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = right.charCodeAt(index) - left.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return right.length - left.length;
}

function timeFor(collection: G09bFixtureCase['collection'], row: G04bQualificationDocument | G04bEventDocument): number {
  if (collection === 'events') return (row as G04bEventDocument).receivedAt.getTime();
  if (collection === 'inside') return (row as G04bQualificationDocument).enteredAt!.getTime();
  return (row as G04bQualificationDocument).createdAt.getTime();
}

function rowsFor(fixture: G09bDeterministicFixture, item: G09bFixtureCase) {
  if (item.collection === 'qualifications') return fixture.qualifications;
  if (item.collection === 'inside') return fixture.qualifications.filter((row) => row.presence === 'INSIDE');
  const qualificationId = item.filters.qualificationId ?? null;
  const outcome = item.filters.outcome ?? null;
  const reasonCode = item.filters.reasonCode ?? null;
  return fixture.events.filter((row) => (qualificationId === null || row.qualificationId === qualificationId)
    && (outcome === null || row.outcome === outcome)
    && (reasonCode === null || row.reasonCode === reasonCode));
}

function independentlySorted(fixture: G09bDeterministicFixture, item: G09bFixtureCase) {
  return [...rowsFor(fixture, item)].sort((left, right) => {
    const timeDifference = timeFor(item.collection, right) - timeFor(item.collection, left);
    return timeDifference || binaryDescending(left._id, right._id);
  });
}

function insertionDigest(collection: string, id: string): string {
  return createHash('sha256')
    .update(`${G09B_FIXTURE_SEED}\0insert:${collection}:${id}`, 'utf8')
    .digest('hex');
}

function expectedInsertionOrder(collection: string, ids: readonly string[]): readonly string[] {
  return [...ids].sort((left, right) => {
    const leftKey = insertionDigest(collection, left);
    const rightKey = insertionDigest(collection, right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left < right ? -1 : left > right ? 1 : 0;
  });
}

function replaceFirstQualification(fixture: G09bDeterministicFixture, row: G04bQualificationDocument): G09bDeterministicFixture {
  return {
    ...fixture,
    qualifications: Object.freeze([row, ...fixture.qualifications.slice(1)]),
  };
}

function captureFailure(operation: () => unknown): Error {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw new Error('canonical rejection did not use Error');
  }
  throw new Error('canonical attack was accepted');
}

describe('G09b deterministic fixture identity', () => {
  test('is deterministic across calls and independent Node processes with one fixed SHA-256 hash', () => {
    const first = createG09bDeterministicFixture();
    const second = createG09bDeterministicFixture();
    const firstManifest = createG09bFixtureManifest(first);
    const secondManifest = createG09bFixtureManifest(second);
    expect(firstManifest.fixtureHash).toBe(EXPECTED_HASH);
    expect(hashFixture(first)).toBe(EXPECTED_HASH);
    expect(hashFixture(second)).toBe(EXPECTED_HASH);
    expect(secondManifest).toEqual(firstManifest);
    expect(EXPECTED_HASH).toMatch(HEX64);

    const child = () => JSON.parse(execFileSync(process.execPath, ['scripts/internal-g09b-fixture.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    })) as { fixtureHash: string; counts: Record<string, number>; cases: readonly G09bFixtureCase[] };
    const childOne = child();
    const childTwo = child();
    expect(childOne.fixtureHash).toBe(EXPECTED_HASH);
    expect(childTwo.fixtureHash).toBe(EXPECTED_HASH);
    expect(childTwo.counts).toEqual(childOne.counts);
    expect(childTwo.cases).toEqual(childOne.cases);
  }, 120_000);

  test('implementation has no random or current-time source', () => {
    const source = readFileSync('test/perf/g09b-deterministic-fixture.ts', 'utf8');
    expect(source).not.toMatch(/randomUUID|randomBytes|randomFill|Math\.random|Date\.now|performance\.now|crypto\.random|new Date\(\s*\)/u);
    expect(source).toContain(G09B_FIXTURE_SEED);
    expect(source).toContain('sha256');
  });

  test('all derived identifiers have UUIDv4 version/variant bits and all digests are fixed lowercase hex', () => {
    const fixture = createG09bDeterministicFixture();
    const ids = [
      fixture.datasetEpoch,
      fixture.comparisonReferenceId,
      ...fixture.qualifications.flatMap((row) => [row._id, row.incarnation, row.createdBy]),
      ...fixture.faceSlots.flatMap((row) => [row._id, row.qualificationId!, row.qualificationIncarnation!, row.slotIncarnation]),
      ...fixture.events.flatMap((row) => [row._id, row.sourceId, row.comparisonReferenceId, ...(row.qualificationId === null ? [] : [row.qualificationId])]),
      ...fixture.users.map((row) => row._id),
      ...fixture.sources.flatMap((row) => [row._id, row.incarnation]),
    ];
    expect(ids.every((value) => UUID_V4_FULL.test(value))).toBe(true);
    expect(ids.every((value) => value[14] === '4' && /^[89ab]$/u.test(value[19]!))).toBe(true);
    expect(fixture.qualifications.every((row) => HEX64.test(row.qrLookupDigest))).toBe(true);
    expect(fixture.events.every((row) => HEX64.test(row.inputHmac))).toBe(true);
    expect(fixture.sources.every((row) => HEX64.test(row.credentialDigest))).toBe(true);
    expect(fixture.users.every((row) => /^[0-9a-f]{32}$/u.test(row.passwordSalt) && /^[0-9a-f]{128}$/u.test(row.passwordHash))).toBe(true);
  });
});

describe('G09b fixture counts, schema, references, and insertion order', () => {
  const fixture = createG09bDeterministicFixture();

  test('has exact 10k/4k/40k counts and the five qualification groups', () => {
    expect(G09B_BASE_TIME_MS).toBe(Date.parse('2026-09-27T00:00:00.000Z'));
    expect({
      qualifications: fixture.qualifications.length,
      faceSlots: fixture.faceSlots.length,
      events: fixture.events.length,
      users: fixture.users.length,
      sources: fixture.sources.length,
      slotCount: fixture.metadata.slotCount,
    }).toEqual({ qualifications: 10_000, faceSlots: 4_000, events: 40_000, users: 2, sources: 2, slotCount: 4_000 });
    expect({
      activeNotEntered: fixture.qualifications.filter((row) => row.presence === 'NOT_ENTERED' && row.revokedAt === null && row.expiredTerminalAt === null).length,
      revokedNotEntered: fixture.qualifications.filter((row) => row.presence === 'NOT_ENTERED' && row.revokedAt !== null).length,
      expiredTerminalNotEntered: fixture.qualifications.filter((row) => row.presence === 'NOT_ENTERED' && row.expiredTerminalAt !== null).length,
      inside: fixture.qualifications.filter((row) => row.presence === 'INSIDE').length,
      exited: fixture.qualifications.filter((row) => row.presence === 'EXITED').length,
    }).toEqual({ activeNotEntered: 4_000, revokedNotEntered: 1_000, expiredTerminalNotEntered: 1_000, inside: 2_000, exited: 2_000 });
  });

  test('has the exact five Event groups and cross-field invariants', () => {
    const hotId = fixture.qualifications.find((row) => row.displayName === 'G09b qualification 00000')!._id;
    expect({
      hotRejected: fixture.events.filter((row) => row.qualificationId === hotId && row.outcome === 'REJECTED' && row.reasonCode === 'QUALIFICATION_EXPIRED').length,
      hotAccepted: fixture.events.filter((row) => row.qualificationId === hotId && row.outcome === 'ACCEPTED').length,
      otherRejected: fixture.events.filter((row) => row.qualificationId !== null && row.qualificationId !== hotId && row.outcome === 'REJECTED').length,
      otherAccepted: fixture.events.filter((row) => row.qualificationId !== null && row.qualificationId !== hotId && row.outcome === 'ACCEPTED').length,
      nullUnknown: fixture.events.filter((row) => row.qualificationId === null && row.kind === 'FACE_UNKNOWN').length,
    }).toEqual({ hotRejected: 5_000, hotAccepted: 5_000, otherRejected: 10_000, otherAccepted: 10_000, nullUnknown: 10_000 });
    expect(fixture.events.every((row) => row.recordedAt.getTime() === row.receivedAt.getTime() + 250
      && (row.outcome === 'ACCEPTED') === (row.presenceTransition !== null)
      && (row.qualificationId === null) === (row.kind === 'FACE_UNKNOWN')
      && (row.presenceTransition === null || (row.direction === 'ENTRY'
        ? row.presenceTransition.from === 'NOT_ENTERED' && row.presenceTransition.to === 'INSIDE'
        : row.presenceTransition.from === 'INSIDE' && row.presenceTransition.to === 'EXITED'))
      && (row.outcome === 'ACCEPTED'
        ? row.reasonCode === (row.direction === 'ENTRY' ? 'ENTRY_GRANTED' : 'EXIT_RECORDED')
        : row.reasonCode === (row.qualificationId === null ? 'FACE_UNKNOWN' : 'QUALIFICATION_EXPIRED')))).toBe(true);
  });

  test('uses exact stored schemas and metadata/reference/comparison/source facts', () => {
    expect(fixture.qualifications.every((row) => Object.keys(row).sort().join('\0') === QUALIFICATION_KEYS.join('\0'))).toBe(true);
    expect(fixture.faceSlots.every((row) => Object.keys(row).sort().join('\0') === FACE_SLOT_KEYS.join('\0'))).toBe(true);
    expect(fixture.events.every((row) => Object.keys(row).sort().join('\0') === EVENT_KEYS.join('\0'))).toBe(true);
    expect(fixture.users.every((row) => Object.keys(row).sort().join('\0') === USER_KEYS.join('\0'))).toBe(true);
    expect(fixture.sources.every((row) => Object.keys(row).sort().join('\0') === SOURCE_KEYS.join('\0'))).toBe(true);
    expect(Object.keys(fixture.metadata).sort()).toEqual(METADATA_KEYS);
    expect(fixture.metadata).toMatchObject({
      _id: 'system', kind: 'system', datasetEpoch: fixture.datasetEpoch,
      comparisonReferenceId: fixture.comparisonReferenceId, frameVersion: 'v2',
      qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 4_000, writeRunClaim: null,
    });
    expect(fixture.metadata.startupVectors).toEqual(G04B_STARTUP_VECTORS);
    const qualificationIncarnations = new Map(fixture.qualifications.map((row) => [row._id, row.incarnation]));
    const userIds = new Set(fixture.users.map((row) => row._id));
    const sourceByDirection = new Map(fixture.sources.map((row) => [row.direction, row._id]));
    expect(fixture.sources.map((row) => ({ alias: row.credentialAlias, direction: row.direction, active: row.active, version: row.version })))
      .toEqual(expect.arrayContaining([
        { alias: 'entry', direction: 'ENTRY', active: true, version: 0 },
        { alias: 'exit', direction: 'EXIT', active: true, version: 0 },
      ]));
    expect(fixture.qualifications.every((row) => userIds.has(row.createdBy))).toBe(true);
    expect(fixture.faceSlots.every((row) => row.qualificationId !== null
      && row.qualificationIncarnation === qualificationIncarnations.get(row.qualificationId))).toBe(true);
    expect(fixture.events.every((row) => row.comparisonReferenceId === fixture.comparisonReferenceId
      && row.sourceId === sourceByDirection.get(row.direction)
      && (row.qualificationId === null || qualificationIncarnations.has(row.qualificationId)))).toBe(true);
  });

  test('Face slots bind exactly 2k active and 2k INSIDE qualifications with unique provider/subject pairs', () => {
    const qualificationById = new Map(fixture.qualifications.map((row) => [row._id, row]));
    expect(fixture.faceSlots.filter((row) => qualificationById.get(row.qualificationId!)?.presence === 'NOT_ENTERED')).toHaveLength(2_000);
    expect(fixture.faceSlots.filter((row) => qualificationById.get(row.qualificationId!)?.presence === 'INSIDE')).toHaveLength(2_000);
    expect(new Set(fixture.faceSlots.map((row) => `${row.provider}\0${row.subject}`)).size).toBe(4_000);
    expect(new Set(fixture.faceSlots.map((row) => row.provider)).size).toBe(17);
  });

  test.each([
    ['qualifications', fixture.qualifications.map((row) => row._id)],
    ['faceSlots', fixture.faceSlots.map((row) => row._id)],
    ['events', fixture.events.map((row) => row._id)],
    ['users', fixture.users.map((row) => row._id)],
    ['sources', fixture.sources.map((row) => row._id)],
  ] as const)('%s insertion order is the exact independent SHA-256 order', (collection, ids) => {
    expect(ids).toEqual(expectedInsertionOrder(collection, ids));
  });
});

describe('G09b ten-case independent oracle', () => {
  const fixture = createG09bDeterministicFixture();
  const manifest = createG09bFixtureManifest(fixture);
  const expectedIds = [
    'qualifications-all', 'inside-all', 'events-all', 'events-hot', 'events-rejected',
    'events-expired', 'events-hot-rejected', 'events-hot-expired',
    'events-rejected-expired', 'events-hot-rejected-expired',
  ];
  const expectedCounts = [10_000, 2_000, 40_000, 10_000, 25_000, 15_000, 5_000, 5_000, 15_000, 5_000];
  const expectedSelectivity = [1, 0.2, 1, 0.25, 0.625, 0.375, 0.125, 0.125, 0.375, 0.125];

  test('has exact case IDs, match counts, selectivity, and filter combinations', () => {
    expect(manifest.counts).toEqual({
      qualifications: 10_000, faceSlots: 4_000, events: 40_000,
      users: 2, sources: 2, metadata: 1,
    });
    expect(manifest.cases.map((item) => item.id)).toEqual(expectedIds);
    expect(manifest.cases.map((item) => item.expectedMatchCount)).toEqual(expectedCounts);
    expect(manifest.cases.map((item) => item.selectivity)).toEqual(expectedSelectivity);
    expect(manifest.cases.slice(2).map((item) => item.filters)).toEqual([
      { qualificationId: null, outcome: null, reasonCode: null },
      { qualificationId: expect.any(String), outcome: null, reasonCode: null },
      { qualificationId: null, outcome: 'REJECTED', reasonCode: null },
      { qualificationId: null, outcome: null, reasonCode: 'QUALIFICATION_EXPIRED' },
      { qualificationId: expect.any(String), outcome: 'REJECTED', reasonCode: null },
      { qualificationId: expect.any(String), outcome: null, reasonCode: 'QUALIFICATION_EXPIRED' },
      { qualificationId: null, outcome: 'REJECTED', reasonCode: 'QUALIFICATION_EXPIRED' },
      { qualificationId: expect.any(String), outcome: 'REJECTED', reasonCode: 'QUALIFICATION_EXPIRED' },
    ]);
  });

  test.each(manifest.cases)('$id has exact first/next fetch21 pages, fixed anchors, ties, and binary-desc no-gap order', (item) => {
    const rows = independentlySorted(fixture, item);
    expect(rows).toHaveLength(item.expectedMatchCount);
    expect(item.first20Ids).toEqual(rows.slice(0, 20).map((row) => row._id));
    expect(item.firstFetch21Ids).toEqual(rows.slice(0, 21).map((row) => row._id));
    expect(item.next20Ids).toEqual(rows.slice(20, 40).map((row) => row._id));
    expect(item.nextFetch21Ids).toEqual(rows.slice(20, 41).map((row) => row._id));
    expect(item.first20Ids).toHaveLength(20);
    expect(item.firstFetch21Ids).toHaveLength(21);
    expect(item.next20Ids).toHaveLength(20);
    expect(item.nextFetch21Ids).toHaveLength(21);
    expect(item.fetch21Expected).toBe(21);
    const twentieth = rows[19]!;
    const fortieth = rows[39]!;
    expect(item.after).toEqual({ lastTimeMs: timeFor(item.collection, twentieth), lastId: twentieth._id });
    expect(item.nextPage).toEqual({
      hasNext: true,
      anchor: { lastTimeMs: timeFor(item.collection, fortieth), lastId: fortieth._id },
    });
    expect(item.firstFetch21Ids[20]).toBe(item.next20Ids[0]);
    expect(new Set([...item.first20Ids, ...item.next20Ids]).size).toBe(40);
    expect(rows.filter((row) => timeFor(item.collection, row) === item.after.lastTimeMs).length).toBeGreaterThanOrEqual(G09B_TIE_BUCKETS);
    for (let index = 1; index < 41; index += 1) {
      const prior = rows[index - 1]!;
      const current = rows[index]!;
      const priorTime = timeFor(item.collection, prior);
      const currentTime = timeFor(item.collection, current);
      expect(priorTime > currentTime || (priorTime === currentTime && binaryDescending(prior._id, current._id) < 0)).toBe(true);
    }
  });
});

describe('G09b canonical fixture hashing', () => {
  const fixture = createG09bDeterministicFixture();

  test('a data mutation changes the hash while record key order does not', () => {
    const first = fixture.qualifications[0]!;
    const mutated = replaceFirstQualification(fixture, { ...first, displayName: `${first.displayName}-changed` });
    expect(hashFixture(mutated)).not.toBe(EXPECTED_HASH);

    const reversed = Object.fromEntries(Object.entries(first).reverse()) as unknown as G04bQualificationDocument;
    expect(hashFixture(replaceFirstQualification(fixture, reversed))).toBe(EXPECTED_HASH);
  });

  test.each(['extra', 'symbol', 'accessor', 'proxy', 'proxy Date'] as const)(
    '%s canonical attack is rejected generically without trap or canary leakage',
    (kind) => {
      const canary = `canonical-${kind}-secret-canary`;
      let traps = 0;
      const trap = () => { traps += 1; throw new Error(canary); };
      const original = fixture.qualifications[0]!;
      let attacked: G04bQualificationDocument;
      if (kind === 'extra') {
        attacked = { ...original, extra: canary } as unknown as G04bQualificationDocument;
      } else if (kind === 'symbol') {
        attacked = { ...original };
        Object.defineProperty(attacked, Symbol(canary), { value: canary, enumerable: true });
      } else if (kind === 'accessor') {
        attacked = { ...original };
        Object.defineProperty(attacked, 'displayName', { enumerable: true, get: trap });
      } else if (kind === 'proxy') {
        attacked = new Proxy(original, {
          get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap,
        });
      } else {
        const proxyDate = new Proxy(original.createdAt, {
          get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap,
        });
        attacked = { ...original, createdAt: proxyDate };
      }
      const error = captureFailure(() => hashFixture(replaceFirstQualification(fixture, attacked)));
      expect(error.message).toMatch(/^G09b canonical/u);
      expect(error.message).not.toContain(canary);
      expect(Object.hasOwn(error, 'cause')).toBe(false);
      expect(traps).toBe(0);
    },
  );

  test('canonical NDJSON collection/row order is stable and hashes exactly once with final newlines', () => {
    const lines = [...canonicalNdjsonLines(fixture)];
    expect(lines).toHaveLength(54_005);
    expect(lines.every((line) => line.endsWith('\n') && line.split('\t').length === 2)).toBe(true);
    expect(lines.slice(0, 10_000).every((line) => line.startsWith('qualifications\t'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^metadata\t/u);
    const independent = createHash('sha256').update(lines.join(''), 'utf8').digest('hex');
    expect(independent).toBe(EXPECTED_HASH);
  });
});
