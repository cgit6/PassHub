import { REASON_CODES, type ReasonCode } from '../../domain/index.js';
import type { QueryAfterKey } from '../../ports/query-ports.js';

export type QueryEndpoint = 'qualifications' | 'inside' | 'events';

export interface QueryCursorFilters {
  readonly qualificationId: string | null;
  readonly outcome: 'ACCEPTED' | 'REJECTED' | null;
  readonly reasonCode: ReasonCode | null;
}

export type QueryCursorDecodeResult =
  | Readonly<{ readonly kind: 'EMPTY'; readonly after: null }>
  | Readonly<{ readonly kind: 'VALID'; readonly after: QueryAfterKey }>
  | Readonly<{ readonly kind: 'INVALID_CURSOR' }>
  | Readonly<{ readonly kind: 'DATASET_EPOCH_MISMATCH' }>
  | Readonly<{ readonly kind: 'CURSOR_SCOPE_MISMATCH' }>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ENDPOINTS: readonly QueryEndpoint[] = ['qualifications', 'inside', 'events'];
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const cursorCodecs = new WeakSet<object>();

export interface QueryCursorCodec {
  encode(
    epoch: string,
    endpoint: QueryEndpoint,
    filters: QueryCursorFilters,
    after: QueryAfterKey,
  ): string;
  decode(
    raw: string | null | undefined,
    epoch: string,
    endpoint: QueryEndpoint,
    filters: QueryCursorFilters,
  ): QueryCursorDecodeResult;
}

export function createQueryCursorCodec(): QueryCursorCodec {
  const codec = Object.freeze({ encode, decode });
  cursorCodecs.add(codec);
  return codec;
}

export function isQueryCursorCodec(value: unknown): value is QueryCursorCodec {
  return typeof value === 'object' && value !== null && cursorCodecs.has(value);
}

function encode(
  epoch: string,
  endpoint: QueryEndpoint,
  filters: QueryCursorFilters,
  after: QueryAfterKey,
): string {
  assertEpoch(epoch);
  assertEndpoint(endpoint);
  assertFilters(endpoint, filters);
  assertAfter(after);
  const tuple = [
    'p1',
    epoch,
    endpoint,
    filters.qualificationId,
    filters.outcome,
    filters.reasonCode,
    new Date(after.lastTimeMs).toISOString(),
    after.lastId,
  ] as const;
  const encoded = Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
  assertCanonicalEncoding(encoded);
  return encoded;
}

function decode(
  raw: string | null | undefined,
  epoch: string,
  endpoint: QueryEndpoint,
  filters: QueryCursorFilters,
): QueryCursorDecodeResult {
  assertEpoch(epoch);
  assertEndpoint(endpoint);
  assertFilters(endpoint, filters);
  if (raw === undefined || raw === null) return Object.freeze({ kind: 'EMPTY', after: null });
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 512
    || !BASE64URL.test(raw) || raw !== raw.trim()) {
    return Object.freeze({ kind: 'INVALID_CURSOR' });
  }
  let tuple: unknown;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    const decoded = TEXT_DECODER.decode(bytes);
    tuple = JSON.parse(decoded) as unknown;
  } catch {
    return Object.freeze({ kind: 'INVALID_CURSOR' });
  }
  if (!Array.isArray(tuple) || tuple.length !== 8
    || tuple.some((value) => Array.isArray(value) || (typeof value === 'object' && value !== null))) {
    return Object.freeze({ kind: 'INVALID_CURSOR' });
  }
  const [version, cursorEpoch, cursorEndpoint, qualificationId, outcome, reasonCode, lastTime, lastId] = tuple;
  if (version !== 'p1' || typeof cursorEpoch !== 'string' || !UUID_V4.test(cursorEpoch)
    || typeof cursorEndpoint !== 'string' || !ENDPOINTS.includes(cursorEndpoint as QueryEndpoint)
    || !isNullableString(qualificationId)
    || !isNullableOutcome(outcome)
    || !isNullableReasonCode(reasonCode)
    || typeof lastTime !== 'string'
    || typeof lastId !== 'string') {
    return Object.freeze({ kind: 'INVALID_CURSOR' });
  }
  if (!cursorShapeMatchesEndpoint(cursorEndpoint as QueryEndpoint, qualificationId, outcome, reasonCode)) {
    return Object.freeze({ kind: 'INVALID_CURSOR' });
  }
  let lastTimeMs: number;
  try {
    lastTimeMs = parseCanonicalIso(lastTime);
    assertUuid(lastId);
  } catch {
    return Object.freeze({ kind: 'INVALID_CURSOR' });
  }
  const canonical = Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
  if (canonical !== raw) return Object.freeze({ kind: 'INVALID_CURSOR' });
  if (cursorEpoch !== epoch) return Object.freeze({ kind: 'DATASET_EPOCH_MISMATCH' });
  if (cursorEndpoint !== endpoint
    || qualificationId !== filters.qualificationId
    || outcome !== filters.outcome
    || reasonCode !== filters.reasonCode) {
    return Object.freeze({ kind: 'CURSOR_SCOPE_MISMATCH' });
  }
  return Object.freeze({
    kind: 'VALID',
    after: Object.freeze({ lastTimeMs, lastId }),
  });
}

function cursorShapeMatchesEndpoint(
  endpoint: QueryEndpoint,
  qualificationId: string | null,
  outcome: 'ACCEPTED' | 'REJECTED' | null,
  reasonCode: ReasonCode | null,
): boolean {
  if (endpoint !== 'events') return qualificationId === null && outcome === null && reasonCode === null;
  return qualificationId === null || UUID_V4.test(qualificationId);
}

function assertEpoch(value: string): void {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new TypeError('query epoch must be UUID v4');
}

function assertEndpoint(value: QueryEndpoint): void {
  if (!ENDPOINTS.includes(value)) throw new TypeError('query endpoint is invalid');
}

function assertFilters(endpoint: QueryEndpoint, value: QueryCursorFilters): void {
  if (typeof value !== 'object' || value === null
    || !Object.isFrozen(value)
    || !Object.hasOwn(value, 'qualificationId')
    || !Object.hasOwn(value, 'outcome')
    || !Object.hasOwn(value, 'reasonCode')) {
    throw new TypeError('query cursor filters are not canonical');
  }
  if (endpoint !== 'events'
    && (value.qualificationId !== null || value.outcome !== null || value.reasonCode !== null)) {
    throw new TypeError('qualification and inside cursors cannot carry filters');
  }
  if (!isNullableString(value.qualificationId) || !isNullableOutcome(value.outcome)
    || !isNullableReasonCode(value.reasonCode)) {
    throw new TypeError('query cursor filters are invalid');
  }
  if (value.qualificationId !== null) assertUuid(value.qualificationId);
}

function assertAfter(value: QueryAfterKey): void {
  if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
    throw new TypeError('query after key is not canonical');
  }
  if (!Number.isSafeInteger(value.lastTimeMs)) throw new TypeError('query after time is invalid');
  new Date(value.lastTimeMs).toISOString();
  assertUuid(value.lastId);
}

function parseCanonicalIso(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError('query cursor time is not canonical UTC milliseconds');
  }
  return parsed;
}

function assertCanonicalEncoding(value: string): void {
  if (value.length < 1 || value.length > 512 || !BASE64URL.test(value)) {
    throw new TypeError('query cursor is not canonical base64url');
  }
}

function assertUuid(value: string): void {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new TypeError('query cursor ID is invalid');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableOutcome(value: unknown): value is 'ACCEPTED' | 'REJECTED' | null {
  return value === null || value === 'ACCEPTED' || value === 'REJECTED';
}

function isNullableReasonCode(value: unknown): value is ReasonCode | null {
  return value === null || (typeof value === 'string' && REASON_CODES.includes(value as ReasonCode));
}
