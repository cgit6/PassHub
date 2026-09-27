import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  G04B_STARTUP_VECTORS,
  type G04bEventDocument,
  type G04bMetadataDocument,
  type G04bQualificationDocument,
  type G04bSourceDocument,
  type G04bUserDocument,
} from '../../src/infrastructure/mongo/g04b-schema.js';
import type { G04aFaceSlotDocument } from '../../src/infrastructure/mongo/g04a-face-index-schema.js';

export const G09B_FIXTURE_SEED = 'passhub-g09b-v1-20260927' as const;
export const G09B_BASE_TIME_MS = Date.parse('2026-09-27T00:00:00.000Z');
export const G09B_TIE_BUCKETS = 64;

export interface G09bDeterministicFixture {
  readonly seed: typeof G09B_FIXTURE_SEED;
  readonly baseTimeMs: number;
  readonly datasetEpoch: string;
  readonly comparisonReferenceId: string;
  readonly qualifications: readonly G04bQualificationDocument[];
  readonly faceSlots: readonly G04aFaceSlotDocument[];
  readonly events: readonly G04bEventDocument[];
  readonly users: readonly G04bUserDocument[];
  readonly sources: readonly G04bSourceDocument[];
  readonly metadata: G04bMetadataDocument;
}

export interface G09bFixtureCase {
  readonly id: string;
  readonly collection: 'qualifications' | 'inside' | 'events';
  readonly filters: Readonly<Record<string, string | null>>;
  readonly expectedMatchCount: number;
  readonly selectivity: number;
  readonly first20Ids: readonly string[];
  readonly firstFetch21Ids: readonly string[];
  readonly after: Readonly<{ readonly lastTimeMs: number; readonly lastId: string }>;
  readonly next20Ids: readonly string[];
  readonly nextFetch21Ids: readonly string[];
  readonly nextPage: Readonly<{
    readonly hasNext: boolean;
    readonly anchor: Readonly<{ readonly lastTimeMs: number; readonly lastId: string }> | null;
  }>;
  readonly fetch21Expected: number;
}

export interface G09bFixtureManifest {
  readonly seed: typeof G09B_FIXTURE_SEED;
  readonly fixtureHash: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly cases: readonly G09bFixtureCase[];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const COLLECTION_ORDER = ['qualifications', 'faceSlots', 'events', 'users', 'sources', 'metadata'] as const;
const QUALIFICATION_KEYS = ['_id', 'incarnation', 'version', 'displayName', 'validFrom', 'validUntil', 'createdBy', 'qrLookupDigest', 'presence', 'enteredAt', 'exitedAt', 'revokedAt', 'revocationReason', 'expiredTerminalAt', 'createdAt', 'updatedAt'] as const;
const FACE_SLOT_KEYS = ['_id', 'provider', 'subject', 'qualificationId', 'qualificationIncarnation', 'slotIncarnation', 'version'] as const;
const EVENT_KEYS = ['_id', 'sourceId', 'externalEventId', 'kind', 'direction', 'outcome', 'reasonCode', 'receivedAt', 'recordedAt', 'qualificationId', 'presenceTransition', 'inputHmac', 'comparisonReferenceId'] as const;
const USER_KEYS = ['_id', 'username', 'role', 'enabled', 'passwordSalt', 'passwordHash', 'scryptParams'] as const;
const SOURCE_KEYS = ['_id', 'credentialAlias', 'direction', 'active', 'credentialDigest', 'incarnation', 'version'] as const;
const METADATA_KEYS = ['_id', 'kind', 'datasetEpoch', 'comparisonReferenceId', 'frameVersion', 'startupVectors', 'qrGuardVersion', 'faceGuardVersion', 'slotCount', 'writeRunClaim'] as const;

export function createG09bDeterministicFixture(): G09bDeterministicFixture {
  const datasetEpoch = uuid('dataset-epoch');
  const comparisonReferenceId = uuid('comparison-reference');
  const qualifications: G04bQualificationDocument[] = [];
  const faceSlots: G04aFaceSlotDocument[] = [];
  const events: G04bEventDocument[] = [];
  const users = [user('operator', 'OPERATOR'), user('viewer', 'VIEWER')];
  const sources = [source('entry', 'ENTRY'), source('exit', 'EXIT')];

  for (let index = 0; index < 10_000; index += 1) {
    const group = index < 4_000 ? 'active-ne'
      : index < 5_000 ? 'revoked'
        : index < 6_000 ? 'expired-terminal'
          : index < 8_000 ? 'inside'
            : 'exited';
    qualifications.push(qualification(index, group));
  }
  for (let index = 0; index < 4_000; index += 1) {
    const qualificationIndex = index < 2_000 ? index : 6_000 + (index - 2_000);
    const qualification = qualifications[qualificationIndex]!;
    faceSlots.push({
      _id: uuid(`face-slot-${index}`),
      provider: `provider-${index % 17}`,
      subject: `subject-${index}`,
      qualificationId: qualification._id,
      qualificationIncarnation: qualification.incarnation,
      slotIncarnation: uuid(`slot-incarnation-${index}`),
      version: 0,
    });
  }
  const hotQualificationId = qualifications[0]!._id;
  for (let index = 0; index < 40_000; index += 1) {
    const group = index < 5_000 ? 'hot-rejected-expired'
      : index < 10_000 ? 'hot-accepted'
        : index < 20_000 ? 'other-rejected-expired'
          : index < 30_000 ? 'other-accepted'
            : 'null-face-unknown';
    events.push(event(index, group, hotQualificationId, qualifications, comparisonReferenceId));
  }
  const metadata: G04bMetadataDocument = {
    _id: 'system', kind: 'system', datasetEpoch, comparisonReferenceId, frameVersion: 'v2',
    startupVectors: G04B_STARTUP_VECTORS,
    qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 4_000, writeRunClaim: null,
  };
  const fixture: G09bDeterministicFixture = {
    seed: G09B_FIXTURE_SEED, baseTimeMs: G09B_BASE_TIME_MS, datasetEpoch, comparisonReferenceId,
    qualifications: Object.freeze(insertionOrder('qualifications', qualifications)),
    faceSlots: Object.freeze(insertionOrder('faceSlots', faceSlots)),
    events: Object.freeze(insertionOrder('events', events)),
    users: Object.freeze(insertionOrder('users', users)),
    sources: Object.freeze(insertionOrder('sources', sources)), metadata,
  };
  assertFixture(fixture);
  return Object.freeze(fixture);
}

export function assertG09bDeterministicFixture(fixture: G09bDeterministicFixture): void {
  assertFixture(fixture);
}

export function createG09bFixtureManifest(fixture: G09bDeterministicFixture): G09bFixtureManifest {
  assertFixture(fixture);
  const fixtureHash = hashFixture(fixture);
  const hotQualificationId = qualificationIdForIndex(fixture, 0);
  const cases = Object.freeze([
    qualificationCase(fixture, 'qualifications-all', 'qualifications', null),
    qualificationCase(fixture, 'inside-all', 'inside', null),
    eventCase(fixture, 'events-all', null, null, null),
    eventCase(fixture, 'events-hot', hotQualificationId, null, null),
    eventCase(fixture, 'events-rejected', null, 'REJECTED', null),
    eventCase(fixture, 'events-expired', null, null, 'QUALIFICATION_EXPIRED'),
    eventCase(fixture, 'events-hot-rejected', hotQualificationId, 'REJECTED', null),
    eventCase(fixture, 'events-hot-expired', hotQualificationId, null, 'QUALIFICATION_EXPIRED'),
    eventCase(fixture, 'events-rejected-expired', null, 'REJECTED', 'QUALIFICATION_EXPIRED'),
    eventCase(fixture, 'events-hot-rejected-expired', hotQualificationId, 'REJECTED', 'QUALIFICATION_EXPIRED'),
  ]);
  const expectedCounts = [10_000, 2_000, 40_000, 10_000, 25_000, 15_000, 5_000, 5_000, 15_000, 5_000];
  if (cases.some((item, index) => item.expectedMatchCount !== expectedCounts[index])) throw new Error('G09b manifest expected counts are invalid');
  return Object.freeze({
    seed: G09B_FIXTURE_SEED,
    fixtureHash,
    counts: Object.freeze({ qualifications: 10_000, faceSlots: 4_000, events: 40_000, users: 2, sources: 2, metadata: 1 }),
    cases,
  });
}

export function hashFixture(fixture: G09bDeterministicFixture): string {
  const hash = createHash('sha256');
  for (const line of canonicalNdjsonLines(fixture)) hash.update(line, 'utf8');
  return hash.digest('hex');
}

export function* canonicalNdjsonLines(fixture: G09bDeterministicFixture): Generator<string> {
  for (const collection of COLLECTION_ORDER) {
    const values = collection === 'metadata' ? [fixture.metadata]
      : collection === 'qualifications' ? fixture.qualifications
        : collection === 'faceSlots' ? fixture.faceSlots
          : collection === 'events' ? fixture.events
            : collection === 'users' ? fixture.users : fixture.sources;
    const sorted = captureCanonicalRows(collection, values);
    for (const entry of sorted) yield `${collection}\t${canonicalJson(collection, entry.value)}\n`;
  }
}

function qualification(index: number, group: string): G04bQualificationDocument {
  const now = new Date(G09B_BASE_TIME_MS - (index % G09B_TIE_BUCKETS) * 1_000);
  const inside = group === 'inside';
  const exited = group === 'exited';
  const revoked = group === 'revoked';
  const expired = group === 'expired-terminal';
  const presenceOrdinal = inside ? index - 6_000 : exited ? index - 8_000 : 0;
  const enteredAt = inside || exited ? new Date(G09B_BASE_TIME_MS - 86_400_000 - Math.floor(presenceOrdinal / G09B_TIE_BUCKETS) * 1_000) : null;
  return {
    _id: uuid(`qualification-${index}`), incarnation: uuid(`qualification-incarnation-${index}`), version: 0,
    displayName: `G09b qualification ${String(index).padStart(5, '0')}`,
    validFrom: new Date(G09B_BASE_TIME_MS - 172_800_000), validUntil: new Date(G09B_BASE_TIME_MS + 172_800_000),
    createdBy: uuid('user-operator'), qrLookupDigest: digest(`qr-${index}`),
    presence: inside ? 'INSIDE' : exited ? 'EXITED' : 'NOT_ENTERED', enteredAt,
    exitedAt: exited ? new Date(G09B_BASE_TIME_MS - 43_200_000 - Math.floor(presenceOrdinal / G09B_TIE_BUCKETS) * 1_000) : null,
    revokedAt: revoked ? new Date(G09B_BASE_TIME_MS - 21_600_000 - (index % G09B_TIE_BUCKETS) * 1_000) : null,
    revocationReason: revoked ? 'fixture revoked' : null,
    expiredTerminalAt: expired ? new Date(G09B_BASE_TIME_MS - 10_800_000 - (index % G09B_TIE_BUCKETS) * 1_000) : null,
    createdAt: now, updatedAt: now,
  };
}

function event(index: number, group: string, hotQualificationId: string, qualifications: readonly G04bQualificationDocument[], comparisonReferenceId: string): G04bEventDocument {
  const hot = group.startsWith('hot');
  const accepted = group.includes('accepted');
  const nullFace = group === 'null-face-unknown';
  const direction: 'ENTRY' | 'EXIT' = index % 2 === 0 ? 'ENTRY' : 'EXIT';
  const acceptedReason = direction === 'ENTRY' ? 'ENTRY_GRANTED' : 'EXIT_RECORDED';
  const qualificationId = nullFace ? null : hot ? hotQualificationId : accepted
    ? qualifications[6_000 + ((index - 20_000) % 2_000 + 2_000) % 2_000]!._id
    : qualifications[5_000 + ((index - 10_000) % 1_000 + 1_000) % 1_000]!._id;
  const reasonCode = accepted ? acceptedReason : nullFace ? 'FACE_UNKNOWN' : 'QUALIFICATION_EXPIRED';
  const transition = accepted ? (direction === 'ENTRY'
    ? { from: 'NOT_ENTERED' as const, to: 'INSIDE' as const }
    : { from: 'INSIDE' as const, to: 'EXITED' as const }) : null;
  const receivedAt = new Date(G09B_BASE_TIME_MS - (index % G09B_TIE_BUCKETS) * 1_000);
  return {
    _id: uuid(`event-${index}`), sourceId: uuid(`source-${direction.toLowerCase()}`), externalEventId: `g09b-${String(index).padStart(5, '0')}`,
    kind: nullFace ? 'FACE_UNKNOWN' : accepted ? 'QR_SCANNED' : 'QR_SCANNED', direction, outcome: accepted ? 'ACCEPTED' : 'REJECTED', reasonCode,
    receivedAt, recordedAt: new Date(receivedAt.getTime() + 250), qualificationId, presenceTransition: transition,
    inputHmac: digest(`input-${index}`), comparisonReferenceId,
  };
}

function source(alias: 'entry' | 'exit', direction: 'ENTRY' | 'EXIT'): G04bSourceDocument {
  return { _id: uuid(`source-${direction.toLowerCase()}`), credentialAlias: alias, direction, active: true, credentialDigest: digest(`credential-${alias}`), incarnation: uuid(`source-incarnation-${alias}`), version: 0 };
}

function user(username: string, role: 'OPERATOR' | 'VIEWER'): G04bUserDocument {
  return { _id: uuid(`user-${username}`), username, role, enabled: true, passwordSalt: digest(`salt-${username}`).slice(0, 32), passwordHash: digest(`password-${username}`) + digest(`password-${username}-2`), scryptParams: { N: 131072, r: 8, p: 1, keyLength: 64 } };
}

function qualificationCase(fixture: G09bDeterministicFixture, id: string, collection: 'qualifications' | 'inside', _unused: null): G09bFixtureCase {
  const rows = collection === 'qualifications' ? fixture.qualifications : fixture.qualifications.filter((row) => row.presence === 'INSIDE');
  return pageCase(id, collection, rows, rows.length, {});
}

function qualificationIdForIndex(fixture: G09bDeterministicFixture, index: number): string {
  const name = `G09b qualification ${String(index).padStart(5, '0')}`;
  const row = fixture.qualifications.find((item) => item.displayName === name);
  if (row === undefined) throw new Error(`missing qualification ${index}`);
  return row._id;
}

function eventCase(fixture: G09bDeterministicFixture, id: string, qualificationId: string | null, outcome: 'ACCEPTED' | 'REJECTED' | null, reasonCode: string | null): G09bFixtureCase {
  const rows = fixture.events.filter((row) => (qualificationId === null || row.qualificationId === qualificationId) && (outcome === null || row.outcome === outcome) && (reasonCode === null || row.reasonCode === reasonCode));
  return pageCase(id, 'events', rows, rows.length, { qualificationId, outcome, reasonCode });
}

function pageCase(id: string, collection: 'qualifications' | 'inside' | 'events', rows: readonly (G04bQualificationDocument | G04bEventDocument)[], expectedMatchCount: number, filters: Readonly<Record<string, string | null>>): G09bFixtureCase {
  const sorted = [...rows].sort((left, right) => {
    const leftTime = timeFor(collection, left); const rightTime = timeFor(collection, right);
    return rightTime - leftTime || compareUtf16(String(right._id), String(left._id));
  });
  const first20 = sorted.slice(0, 20); const firstFetch21 = sorted.slice(0, 21); const next20 = sorted.slice(20, 40); const nextFetch21 = sorted.slice(20, 41); const twentieth = first20[19]!; const fortieth = sorted[39];
  if (first20.length !== Math.min(20, expectedMatchCount) || next20.length !== Math.max(0, Math.min(20, expectedMatchCount - 20))) throw new Error(`oracle page shape failed for ${id}`);
  if (firstFetch21.length !== Math.min(21, expectedMatchCount) || nextFetch21.length !== Math.min(21, Math.max(0, expectedMatchCount - 20))) throw new Error(`oracle fetch21 shape failed for ${id}`);
  if (new Set([...first20, ...next20].map((row) => row._id)).size !== first20.length + next20.length) throw new Error(`oracle page duplicate failed for ${id}`);
  const anchorTime = timeFor(collection, twentieth); const anchorId = twentieth._id;
  if (next20.some((row) => { const rowTime = timeFor(collection, row); return rowTime > anchorTime || (rowTime === anchorTime && compareUtf16(row._id, anchorId) >= 0); })) throw new Error(`oracle fixed-next ordering failed for ${id}`);
  if (new Set(firstFetch21.map((row) => row._id)).size !== firstFetch21.length || new Set(nextFetch21.map((row) => row._id)).size !== nextFetch21.length) throw new Error(`oracle fetch21 duplicate failed for ${id}`);
  const nextPage = fortieth === undefined ? { hasNext: false, anchor: null } : { hasNext: sorted.length > 40, anchor: { lastTimeMs: timeFor(collection, fortieth), lastId: fortieth._id } };
  if (nextPage.hasNext !== (expectedMatchCount > 40)) throw new Error(`oracle next-page sentinel failed for ${id}`);
  if (sorted.filter((row) => timeFor(collection, row) === anchorTime).length < G09B_TIE_BUCKETS) throw new Error(`oracle tie bucket failed for ${id}`);
  return Object.freeze({ id, collection, filters: Object.freeze({ ...filters }), expectedMatchCount, selectivity: expectedMatchCount / (collection === 'events' ? 40_000 : 10_000), first20Ids: Object.freeze(first20.map((row) => row._id)), firstFetch21Ids: Object.freeze(firstFetch21.map((row) => row._id)), after: Object.freeze({ lastTimeMs: anchorTime, lastId: anchorId }), next20Ids: Object.freeze(next20.map((row) => row._id)), nextFetch21Ids: Object.freeze(nextFetch21.map((row) => row._id)), nextPage: Object.freeze(nextPage.anchor === null ? { hasNext: false, anchor: null } : { hasNext: nextPage.hasNext, anchor: Object.freeze(nextPage.anchor) }), fetch21Expected: Math.min(21, expectedMatchCount) });
}

function timeFor(collection: G09bFixtureCase['collection'], row: G04bQualificationDocument | G04bEventDocument): number {
  return collection === 'events' ? (row as G04bEventDocument).receivedAt.getTime() : collection === 'inside' ? (row as G04bQualificationDocument).enteredAt!.getTime() : (row as G04bQualificationDocument).createdAt.getTime();
}

function insertionOrder<T extends { readonly _id: string }>(collection: string, values: readonly T[]): T[] {
  const captured = values.map((value) => ({ value, id: captureOwnStringId(value) }));
  return captured.sort((left, right) => {
    const leftKey = digest(`insert:${collection}:${left.id}`);
    const rightKey = digest(`insert:${collection}:${right.id}`);
    return compareUtf16(leftKey, rightKey) || compareUtf16(left.id, right.id);
  }).map((entry) => entry.value);
}

function captureCanonicalRows(collection: typeof COLLECTION_ORDER[number], values: readonly unknown[]): readonly { readonly value: unknown; readonly id: string }[] {
  const keys = keysForCollection(collection);
  const captured = values.map((value) => {
    if (value === null || typeof value !== 'object') throw new Error('G09b canonical row is invalid');
    const record = value as Record<string, unknown>;
    assertCanonicalRecord(record, keys);
    return Object.freeze({ value, id: captureOwnStringId(record) });
  });
  return captured.sort((left, right) => compareUtf16(left.id, right.id));
}

function canonicalJson(collection: typeof COLLECTION_ORDER[number], value: unknown): string {
  const keys = keysForCollection(collection);
  return JSON.stringify(canonicalValue(value, keys));
}

function canonicalValue(value: unknown, keys?: readonly string[]): unknown {
  if (value !== null && typeof value === 'object' && isProxy(value)) throw new Error('G09b canonical object must not be a Proxy');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    assertCanonicalArray(value);
    return value.map((item) => canonicalValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const ordered = keys ?? nestedKeys(record);
    assertCanonicalRecord(record, ordered);
    const output: Record<string, unknown> = {};
    for (const key of ordered) output[key] = canonicalValue(record[key]);
    return output;
  }
  return value;
}

function keysForCollection(collection: typeof COLLECTION_ORDER[number]): readonly string[] {
  return collection === 'qualifications' ? QUALIFICATION_KEYS : collection === 'faceSlots' ? FACE_SLOT_KEYS : collection === 'events' ? EVENT_KEYS : collection === 'users' ? USER_KEYS : collection === 'sources' ? SOURCE_KEYS : METADATA_KEYS;
}

function captureOwnStringId(value: object): string {
  if (isProxy(value)) throw new Error('G09b canonical row must not be a Proxy');
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, '_id'); } catch { throw new Error('G09b canonical row descriptor failed'); }
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new Error('G09b canonical row _id is invalid');
  return descriptor.value;
}

function nestedKeys(record: Record<string, unknown>): readonly string[] {
  if (Object.hasOwn(record, 'from') && Object.hasOwn(record, 'to')) return ['from', 'to'];
  if (Object.hasOwn(record, 'N') && Object.hasOwn(record, 'r') && Object.hasOwn(record, 'p') && Object.hasOwn(record, 'keyLength')) return ['N', 'r', 'p', 'keyLength'];
  if (Object.hasOwn(record, 'name') && Object.hasOwn(record, 'expectedFrameHex') && Object.hasOwn(record, 'expectedHmacHex')) return ['name', 'expectedFrameHex', 'expectedHmacHex'];
  if (Object.hasOwn(record, 'runId') && Object.hasOwn(record, 'claimedAt')) return ['runId', 'claimedAt'];
  throw new Error('G09b canonical nested record shape is invalid');
}

function assertCanonicalArray(value: readonly unknown[]): void {
  if (isProxy(value)) throw new Error('G09b canonical array must not be a Proxy');
  let keys: readonly (string | symbol)[];
  try { keys = Reflect.ownKeys(value); } catch { throw new Error('G09b canonical array reflection failed'); }
  const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length'];
  if (keys.length !== expected.length || keys.some((key, index) => typeof key !== 'string' || key !== expected[index])) throw new Error('G09b canonical array keys are invalid');
  for (const key of expected) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw new Error('G09b canonical array descriptor failed'); }
    if (descriptor === undefined || !('value' in descriptor)) throw new Error('G09b canonical array accessor is invalid');
  }
}

function assertCanonicalRecord(record: Record<string, unknown>, expectedKeys: readonly string[]): void {
  if (isProxy(record)) throw new Error('G09b canonical record must not be a Proxy');
  let prototype: object | null;
  let keys: readonly (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(record);
    keys = Reflect.ownKeys(record);
  } catch { throw new Error('G09b canonical record reflection failed'); }
  if (prototype !== Object.prototype && prototype !== null) throw new Error('G09b canonical record prototype is invalid');
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) throw new Error('G09b canonical record keys are invalid');
  for (const key of expectedKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(record, key); } catch { throw new Error('G09b canonical record descriptor failed'); }
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw new Error('G09b canonical record accessor is invalid');
  }
}

function compareUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function digest(label: string): string { return createHash('sha256').update(`${G09B_FIXTURE_SEED}\0${label}`, 'utf8').digest('hex'); }
function uuid(label: string): string { const hex = digest(label).slice(0, 32).split(''); hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!; const raw = hex.join(''); const value = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`; if (!UUID_V4.test(value)) throw new Error('fixture UUID derivation failed'); return value; }

function assertFixture(fixture: G09bDeterministicFixture): void {
  if (fixture.seed !== G09B_FIXTURE_SEED || fixture.baseTimeMs !== G09B_BASE_TIME_MS || !UUID_V4.test(fixture.datasetEpoch) || !UUID_V4.test(fixture.comparisonReferenceId)) throw new Error('fixture identity invariant failed');
  if (fixture.metadata.datasetEpoch !== fixture.datasetEpoch || fixture.metadata.comparisonReferenceId !== fixture.comparisonReferenceId || fixture.events.some((row) => row.comparisonReferenceId !== fixture.comparisonReferenceId)) throw new Error('comparison reference invariant failed');
  if (fixture.qualifications.length !== 10_000 || fixture.faceSlots.length !== 4_000 || fixture.events.length !== 40_000 || fixture.users.length !== 2 || fixture.sources.length !== 2 || fixture.metadata.slotCount !== 4_000) throw new Error('G09b fixture counts are invalid');
  const qualificationIds = new Set(fixture.qualifications.map((row) => row._id));
  const userIds = new Set(fixture.users.map((row) => row._id));
  const incarnationByQualification = new Map(fixture.qualifications.map((row) => [row._id, row.incarnation]));
  const assertUnique = (label: string, values: readonly string[]) => { if (new Set(values).size !== values.length) throw new Error(`${label} IDs are not unique`); };
  assertUnique('qualification', fixture.qualifications.map((row) => row._id));
  assertUnique('face slot', fixture.faceSlots.map((row) => row._id));
  assertUnique('event', fixture.events.map((row) => row._id));
  assertUnique('qualification incarnation', fixture.qualifications.map((row) => row.incarnation));
  if (fixture.qualifications.filter((row) => row.presence === 'NOT_ENTERED' && row.revokedAt === null && row.expiredTerminalAt === null).length !== 4_000) throw new Error('active qualification distribution is invalid');
  if (fixture.qualifications.filter((row) => row.revokedAt !== null).length !== 1_000 || fixture.qualifications.filter((row) => row.expiredTerminalAt !== null).length !== 1_000 || fixture.qualifications.filter((row) => row.presence === 'INSIDE').length !== 2_000 || fixture.qualifications.filter((row) => row.presence === 'EXITED').length !== 2_000) throw new Error('qualification distribution is invalid');
  if (fixture.qualifications.filter((row) => row.presence === 'INSIDE' && row.enteredAt !== null && row.exitedAt === null).length !== 2_000 || fixture.qualifications.filter((row) => row.presence === 'EXITED' && row.enteredAt !== null && row.exitedAt !== null).length !== 2_000) throw new Error('qualification presence timestamps are invalid');
  if (fixture.qualifications.some((row) => !UUID_V4.test(row._id) || !UUID_V4.test(row.incarnation) || row.version !== 0 || !UUID_V4.test(row.createdBy) || !userIds.has(row.createdBy) || !HEX64.test(row.qrLookupDigest) || row.validFrom.getTime() >= row.validUntil.getTime())) throw new Error('qualification invariant failed');
  const qualificationById = new Map(fixture.qualifications.map((row) => [row._id, row]));
  if (fixture.faceSlots.filter((row) => row.qualificationId !== null).length !== 4_000 || new Set(fixture.faceSlots.map((row) => `${row.provider}\0${row.subject}`)).size !== 4_000 || new Set(fixture.faceSlots.map((row) => row.provider)).size !== 17) throw new Error('face slot binding distribution is invalid');
  if (fixture.faceSlots.some((row) => !UUID_V4.test(row._id) || !UUID_V4.test(row.slotIncarnation) || row.version !== 0 || row.qualificationId === null || row.qualificationIncarnation !== incarnationByQualification.get(row.qualificationId) || !qualificationIds.has(row.qualificationId))) throw new Error('face slot reference invariant failed');
  if (fixture.faceSlots.filter((row) => qualificationById.get(row.qualificationId!)?.presence === 'NOT_ENTERED').length !== 2_000 || fixture.faceSlots.filter((row) => qualificationById.get(row.qualificationId!)?.presence === 'INSIDE').length !== 2_000) throw new Error('face slot group distribution is invalid');
  if (fixture.events.filter((row) => row.outcome === 'REJECTED' && row.reasonCode === 'QUALIFICATION_EXPIRED' && row.qualificationId === fixture.qualifications.find((qualification) => qualification.displayName.endsWith('00000'))?._id).length !== 5_000) throw new Error('hot rejected event distribution is invalid');
  const hotId = fixture.qualifications.find((qualification) => qualification.displayName.endsWith('00000'))?._id;
  if (hotId === undefined || fixture.events.filter((row) => row.outcome === 'ACCEPTED' && row.qualificationId === hotId).length !== 5_000) throw new Error('hot accepted event distribution is invalid');
  if (fixture.events.filter((row) => row.outcome === 'REJECTED' && row.reasonCode === 'QUALIFICATION_EXPIRED').length !== 15_000 || fixture.events.filter((row) => row.outcome === 'REJECTED').length !== 25_000 || fixture.events.filter((row) => row.outcome === 'ACCEPTED').length !== 15_000) throw new Error('event group distribution is invalid');
  if (fixture.events.filter((row) => row.qualificationId === null && row.kind === 'FACE_UNKNOWN').length !== 10_000) throw new Error('null face event distribution is invalid');
  const sourceByDirection = new Map(fixture.sources.map((row) => [row.direction, row._id]));
  assertUnique('external event', fixture.events.map((row) => row.externalEventId));
  if (fixture.events.some((row) => !UUID_V4.test(row._id) || !UUID_V4.test(row.sourceId) || !UUID_V4.test(row.comparisonReferenceId) || !HEX64.test(row.inputHmac) || (row.qualificationId !== null && !qualificationIds.has(row.qualificationId)) || row.recordedAt.getTime() !== row.receivedAt.getTime() + 250 || (row.kind === 'FACE_UNKNOWN' && row.qualificationId !== null) || (row.kind !== 'FACE_UNKNOWN' && row.qualificationId === null) || (row.outcome === 'ACCEPTED' && row.presenceTransition === null) || (row.outcome === 'REJECTED' && row.presenceTransition !== null) || (row.outcome === 'ACCEPTED' && row.reasonCode !== (row.direction === 'ENTRY' ? 'ENTRY_GRANTED' : 'EXIT_RECORDED')) || (row.outcome === 'REJECTED' && row.reasonCode !== (row.qualificationId === null ? 'FACE_UNKNOWN' : 'QUALIFICATION_EXPIRED')))) throw new Error('event invariant failed');
  if (fixture.events.some((row) => row.presenceTransition !== null && (row.presenceTransition.from !== (row.direction === 'ENTRY' ? 'NOT_ENTERED' : 'INSIDE') || row.presenceTransition.to !== (row.direction === 'ENTRY' ? 'INSIDE' : 'EXITED')))) throw new Error('event transition invariant failed');
  if (fixture.events.some((row) => row.sourceId !== sourceByDirection.get(row.direction))) throw new Error('event source direction invariant failed');
  if (new Set(fixture.events.map((row) => row.receivedAt.getTime())).size < G09B_TIE_BUCKETS || new Set(fixture.qualifications.map((row) => row.createdAt.getTime())).size < G09B_TIE_BUCKETS || fixture.events.filter((row) => row.receivedAt.getTime() === G09B_BASE_TIME_MS).length < G09B_TIE_BUCKETS || fixture.qualifications.filter((row) => row.createdAt.getTime() === G09B_BASE_TIME_MS).length < G09B_TIE_BUCKETS) throw new Error('tie bucket invariant failed');
  if (new Set(fixture.users.map((row) => row.role)).size !== 2 || new Set(fixture.sources.map((row) => row.direction)).size !== 2 || fixture.users.some((row) => !UUID_V4.test(row._id) || !/^[0-9a-f]{128}$/u.test(row.passwordHash) || !/^[0-9a-f]{32,}$/u.test(row.passwordSalt)) || fixture.sources.some((row) => !UUID_V4.test(row._id) || !UUID_V4.test(row.incarnation) || !HEX64.test(row.credentialDigest))) throw new Error('user/source invariant failed');
}
