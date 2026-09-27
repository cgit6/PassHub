import {
  createQueryCursorCodec,
  isQueryCursorCodec,
  type QueryCursorCodec,
  type QueryCursorFilters,
  type QueryEndpoint,
} from './internal/query-cursor.js';
import { QueryApplicationError } from './query-errors.js';
import { assertPersistedEventInvariant } from './internal/persisted-event-invariants.js';
import {
  isWriterQuiescencePort,
  type ReadObservationLease,
  type WriterQuiescencePort,
} from './internal/writer-quiescence.js';
import {
  type EventQueryItem,
  type EventQueryFilters,
  type QueryDataPort,
  type QueryDetailResult,
  type QueryPage,
  type QualificationQueryItem,
  type QuerySnapshotEvent,
  type QuerySnapshotQualification,
  type QueryAfterKey,
} from '../ports/query-ports.js';
import { REASON_CODES, assertQualificationState, qualificationCanRetainFaceMapping } from '../domain/index.js';
import {
  captureConstructionMethod,
  captureOptionalConstructionProperty,
  captureConstructionProperty,
} from '../../shared/internal/construction-capture.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_LIMIT = 100;
const queryApplications = new WeakSet<object>();
const queryApplicationQuiescence = new WeakMap<object, object>();

export interface QueryApplication {
  listQualifications(input: Readonly<{ limit: number; cursor?: string | null }>): Promise<QueryPage<QualificationQueryItem>>;
  listInside(input: Readonly<{ limit: number; cursor?: string | null }>): Promise<QueryPage<QualificationQueryItem>>;
  listEvents(input: Readonly<{
    readonly limit: number;
    readonly cursor?: string | null;
    readonly filters: EventQueryFilters;
  }>): Promise<QueryPage<EventQueryItem>>;
  qualificationDetail(qualificationId: string): Promise<QueryDetailResult<QualificationQueryItem>>;
  eventDetail(eventId: string): Promise<QueryDetailResult<EventQueryItem>>;
}

export function createQueryApplication(options: Readonly<{
  readonly data: QueryDataPort;
  readonly writerQuiescence: WriterQuiescencePort;
  readonly epoch: string;
  readonly cursorCodec?: QueryCursorCodec;
}>): QueryApplication {
  const captured = captureOptions(options);
  const data = captured.data;
  const writerQuiescence = captured.writerQuiescence;
  const listQualifications = captureConstructionMethod(data, 'listQualifications', 'query data').bind(data) as QueryDataPort['listQualifications'];
  const listInside = captureConstructionMethod(data, 'listInside', 'query data').bind(data) as QueryDataPort['listInside'];
  const listEvents = captureConstructionMethod(data, 'listEvents', 'query data').bind(data) as QueryDataPort['listEvents'];
  const readQualification = captureConstructionMethod(data, 'readQualification', 'query data').bind(data) as QueryDataPort['readQualification'];
  const readEvent = captureConstructionMethod(data, 'readEvent', 'query data').bind(data) as QueryDataPort['readEvent'];
  const acquireLease = captureConstructionMethod(writerQuiescence, 'acquireReadObservationLease', 'writer quiescence').bind(writerQuiescence);
  assertOptions(captured);
  const codec = captured.cursorCodec ?? createQueryCursorCodec();
  if (!isQueryCursorCodec(codec)) throw new TypeError('query cursor codec provenance is invalid');
  const encodeCursor = captureConstructionMethod(codec, 'encode', 'query cursor codec').bind(codec);
  const decodeCursor = captureConstructionMethod(codec, 'decode', 'query cursor codec').bind(codec);
  const epoch = captured.epoch;

  const application = Object.freeze({
    async listQualifications(input: Readonly<{ limit: number; cursor?: string | null }>): Promise<QueryPage<QualificationQueryItem>> {
      assertLimit(input.limit);
      const filters = emptyFilters();
      const after = decodeAfter(input.cursor, epoch, 'qualifications', filters, decodeCursor);
      return runList(
        acquireLease,
        (lease) => listQualifications({ fetchLimit: input.limit + 1, after, observedAtMs: lease.observedAtMs }),
        (row, observedAtMs) => mapQualification(row, observedAtMs),
        'qualifications',
        filters,
        encodeCursor,
        epoch,
        input.limit,
      );
    },
    async listInside(input: Readonly<{ limit: number; cursor?: string | null }>): Promise<QueryPage<QualificationQueryItem>> {
      assertLimit(input.limit);
      const filters = emptyFilters();
      const after = decodeAfter(input.cursor, epoch, 'inside', filters, decodeCursor);
      return runList(
        acquireLease,
        (lease) => listInside({ fetchLimit: input.limit + 1, after, observedAtMs: lease.observedAtMs }),
        (row, observedAtMs) => mapQualification(row, observedAtMs),
        'inside',
        filters,
        encodeCursor,
        epoch,
        input.limit,
      );
    },
    async listEvents(input: Readonly<{
      readonly limit: number;
      readonly cursor?: string | null;
      readonly filters: EventQueryFilters;
    }>): Promise<QueryPage<EventQueryItem>> {
      assertLimit(input.limit);
      const filters = normalizeEventFilters(input.filters);
      const after = decodeAfter(input.cursor, epoch, 'events', filters, decodeCursor);
      return runList(
        acquireLease,
        (lease) => listEvents({ fetchLimit: input.limit + 1, after, filters, observedAtMs: lease.observedAtMs }),
        (row) => mapEvent(row),
        'events',
        filters,
        encodeCursor,
        epoch,
        input.limit,
      );
    },
    async qualificationDetail(qualificationId: string): Promise<QueryDetailResult<QualificationQueryItem>> {
      assertUuid(qualificationId);
      return runDetail(acquireLease, (lease) => readQualification(qualificationId, lease.observedAtMs), (row, observedAtMs) => mapQualification(row, observedAtMs));
    },
    async eventDetail(eventId: string): Promise<QueryDetailResult<EventQueryItem>> {
      assertUuid(eventId);
      return runDetail(acquireLease, (lease) => readEvent(eventId, lease.observedAtMs), (row) => mapEvent(row));
    },
  });
  queryApplications.add(application);
  queryApplicationQuiescence.set(application, writerQuiescence as object);
  return application;
}

export function isQueryApplication(value: unknown): value is QueryApplication {
  return typeof value === 'object' && value !== null && queryApplications.has(value);
}

export function assertQueryApplicationQuiescence(
  application: QueryApplication,
  writerQuiescence: WriterQuiescencePort,
): void {
  if (!isQueryApplication(application) || queryApplicationQuiescence.get(application as object) !== writerQuiescence) {
    throw new TypeError('query application quiescence provenance is invalid');
  }
}

async function runList<TSnapshot, TItem>(
  acquireLease: () => ReturnType<WriterQuiescencePort['acquireReadObservationLease']>,
  read: (lease: ReadObservationLease) => Promise<readonly TSnapshot[]>,
  map: (row: TSnapshot, observedAtMs: number) => TItem,
  endpoint: QueryEndpoint,
  filters: QueryCursorFilters,
  encodeCursor: QueryCursorCodec['encode'],
  epoch: string,
  limit: number,
): Promise<QueryPage<TItem>> {
  let acquired: ReturnType<WriterQuiescencePort['acquireReadObservationLease']>;
  try { acquired = acquireLease(); } catch { throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE'); }
  if (acquired.kind !== 'ACQUIRED') throw new QueryApplicationError('TECHNICAL_BUSY');
  let rows: readonly TSnapshot[];
  try {
    rows = await read(acquired.lease);
  } catch {
    try { acquired.lease.release(); } catch { /* preserve persistence classification */ }
    throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  }
  try {
    if (rows.length > limit + 1) throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
    const hasExtra = rows.length === limit + 1;
    const visibleRows = hasExtra ? rows.slice(0, limit) : rows;
    const items = visibleRows.map((row) => map(row, acquired.lease.observedAtMs));
    const last = visibleRows[visibleRows.length - 1];
    const nextCursor = hasExtra && last !== undefined
      ? encodeCursor(epoch, endpoint, filters, afterKeyFor(last, endpoint))
      : null;
    return Object.freeze({ items: Object.freeze(items), nextCursor });
  } catch (error: unknown) {
    throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  } finally {
    try { acquired.lease.release(); } catch { throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE'); }
  }
}

async function runDetail<TSnapshot, TItem>(
  acquireLease: () => ReturnType<WriterQuiescencePort['acquireReadObservationLease']>,
  read: (lease: ReadObservationLease) => Promise<TSnapshot | null>,
  map: (row: TSnapshot, observedAtMs: number) => TItem,
): Promise<QueryDetailResult<TItem>> {
  let acquired: ReturnType<WriterQuiescencePort['acquireReadObservationLease']>;
  try { acquired = acquireLease(); } catch { throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE'); }
  if (acquired.kind !== 'ACQUIRED') throw new QueryApplicationError('TECHNICAL_BUSY');
  let row: TSnapshot | null;
  try {
    row = await read(acquired.lease);
  } catch {
    try { acquired.lease.release(); } catch { /* preserve persistence classification */ }
    throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  }
  try {
    if (row === null) return Object.freeze({ kind: 'NOT_FOUND' });
    return Object.freeze({ kind: 'FOUND', item: map(row, acquired.lease.observedAtMs) });
  } catch (error: unknown) {
    throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  } finally {
    try { acquired.lease.release(); } catch { throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE'); }
  }
}

function decodeAfter(
  raw: string | null | undefined,
  epoch: string,
  endpoint: QueryEndpoint,
  filters: QueryCursorFilters,
  decodeCursor: QueryCursorCodec['decode'],
): QueryAfterKey | null {
  const decoded = decodeCursor(raw, epoch, endpoint, filters);
  return decoded.kind === 'EMPTY' ? null : decoded.kind === 'VALID' ? decoded.after : throwCursorError(decoded.kind);
}

function throwCursorError(kind: Exclude<ReturnType<QueryCursorCodec['decode']>['kind'], 'EMPTY' | 'VALID'>): never {
  if (kind === 'DATASET_EPOCH_MISMATCH') throw new QueryApplicationError('DATASET_EPOCH_MISMATCH');
  if (kind === 'CURSOR_SCOPE_MISMATCH') throw new QueryApplicationError('CURSOR_SCOPE_MISMATCH');
  throw new QueryApplicationError('INVALID_CURSOR');
}

function mapQualification(row: QuerySnapshotQualification, observedAtMs: number): QualificationQueryItem {
  row = normalizeQualification(row);
  const state = {
    validFromMs: row.validFromMs,
    validUntilMs: row.validUntilMs,
    presence: row.presence,
    enteredAtMs: row.enteredAtMs,
    exitedAtMs: row.exitedAtMs,
    revokedAtMs: row.revokedAtMs,
    revocationReason: row.revocationReason,
    expiredTerminalAtMs: row.expiredTerminalAtMs,
  } as const;
  assertQualificationState(state);
  const mappingMatches = row.faceMapping !== null
    && row.faceMapping.qualificationId === row.qualificationId
    && row.faceMapping.qualificationIncarnation === row.qualificationIncarnation;
  const faceBound = mappingMatches && qualificationCanRetainFaceMapping(state, observedAtMs);
  const expired = row.expiredTerminalAtMs !== null || observedAtMs >= row.validUntilMs;
  return Object.freeze({
    qualificationId: row.qualificationId,
    displayName: row.displayName,
    validFrom: iso(row.validFromMs),
    validUntil: iso(row.validUntilMs),
    presence: row.presence,
    expired,
    revokedAt: row.revokedAtMs === null ? null : iso(row.revokedAtMs),
    revocationReason: row.revocationReason,
    expiredTerminalAt: row.expiredTerminalAtMs === null ? null : iso(row.expiredTerminalAtMs),
    faceBound,
    createdAt: iso(row.createdAtMs),
    updatedAt: iso(row.updatedAtMs),
  });
}

function mapEvent(row: QuerySnapshotEvent): EventQueryItem {
  row = normalizeEvent(row);
  assertPersistedEventInvariant(row);
  return Object.freeze({
    eventId: row.eventId,
    sourceId: row.sourceId,
    direction: row.direction,
    kind: row.kind,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    receivedAt: iso(row.receivedAtMs),
    recordedAt: iso(row.recordedAtMs),
    qualificationId: row.qualificationId,
    presenceTransition: row.presenceTransition === null
      ? null
      : Object.freeze({
          from: row.presenceTransition.from,
          to: row.presenceTransition.to,
        }),
  });
}

function afterKeyFor(row: unknown, endpoint: QueryEndpoint): QueryAfterKey {
  if (endpoint === 'events') {
    const event = normalizeEvent(row);
    return Object.freeze({ lastTimeMs: event.receivedAtMs, lastId: event.eventId });
  }
  const qualification = normalizeQualification(row);
  const lastTimeMs = endpoint === 'inside' ? qualification.enteredAtMs : qualification.createdAtMs;
  if (lastTimeMs === null) throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  return Object.freeze({ lastTimeMs, lastId: qualification.qualificationId });
}

function emptyFilters(): QueryCursorFilters {
  return Object.freeze({ qualificationId: null, outcome: null, reasonCode: null });
}

function normalizeEventFilters(value: EventQueryFilters): QueryCursorFilters {
  if (typeof value !== 'object' || value === null
    || Object.keys(value).sort().join(',') !== 'outcome,qualificationId,reasonCode') {
    throw new QueryApplicationError('INVALID_REQUEST');
  }
  if (value.qualificationId !== null) assertUuid(value.qualificationId);
  if (value.outcome !== null && value.outcome !== 'ACCEPTED' && value.outcome !== 'REJECTED') {
    throw new QueryApplicationError('INVALID_REQUEST');
  }
  if (value.reasonCode !== null && !REASON_CODES.includes(value.reasonCode)) {
    throw new QueryApplicationError('INVALID_REQUEST');
  }
  const result = Object.freeze({
    qualificationId: value.qualificationId,
    outcome: value.outcome,
    reasonCode: value.reasonCode,
  });
  return result;
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT || String(value) !== String(Number(value))) {
    throw new QueryApplicationError('INVALID_REQUEST');
  }
}

function assertUuid(value: string): void {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new QueryApplicationError('INVALID_REQUEST');
}

function iso(value: number): string {
  if (!Number.isSafeInteger(value)) throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  return date.toISOString();
}

function normalizeQualification(row: unknown): QuerySnapshotQualification {
  const value = plainDataRecord(row, [
    'createdAtMs', 'displayName', 'enteredAtMs', 'exitedAtMs', 'expiredTerminalAtMs',
    'faceMapping', 'presence', 'qualificationId', 'qualificationIncarnation',
    'revocationReason', 'revokedAtMs', 'updatedAtMs', 'validFromMs', 'validUntilMs',
  ]);
  if (!isUuidValue(value.qualificationId)
    || typeof value.displayName !== 'string' || !Number.isSafeInteger(value.validFromMs)
    || !Number.isSafeInteger(value.validUntilMs) || !Number.isSafeInteger(value.createdAtMs)
    || !Number.isSafeInteger(value.updatedAtMs) || !['NOT_ENTERED', 'INSIDE', 'EXITED'].includes(value.presence as string)
    || (value.revokedAtMs !== null && !Number.isSafeInteger(value.revokedAtMs))
    || (value.expiredTerminalAtMs !== null && !Number.isSafeInteger(value.expiredTerminalAtMs))
    || (value.revocationReason !== null && typeof value.revocationReason !== 'string')
    || !isUuidValue(value.qualificationIncarnation)
    || (value.enteredAtMs !== null && !Number.isSafeInteger(value.enteredAtMs))
    || (value.exitedAtMs !== null && !Number.isSafeInteger(value.exitedAtMs))) {
    throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  }
  if (value.faceMapping !== null) {
    const mapping = plainDataRecord(value.faceMapping, ['mappingIncarnation', 'qualificationId', 'qualificationIncarnation', 'version']);
    if (!isUuidValue(mapping.qualificationId)
      || !isUuidValue(mapping.qualificationIncarnation)
      || !isUuidValue(mapping.mappingIncarnation)
      || !Number.isSafeInteger(mapping.version) || (mapping.version as number) < 0) {
      throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
    }
    return Object.freeze({ ...value, faceMapping: Object.freeze(mapping) }) as QuerySnapshotQualification;
  }
  return Object.freeze({ ...value, faceMapping: null }) as QuerySnapshotQualification;
}

function normalizeEvent(row: unknown): QuerySnapshotEvent {
  const value = plainDataRecord(row, [
    'direction', 'eventId', 'kind', 'outcome', 'presenceTransition',
    'qualificationId', 'reasonCode', 'receivedAtMs', 'recordedAtMs', 'sourceId',
  ]);
  if (!isUuidValue(value.eventId)
    || !isUuidValue(value.sourceId) || !['ENTRY', 'EXIT'].includes(value.direction as string)
    || !['QR_SCANNED', 'FACE_MATCHED', 'FACE_UNKNOWN'].includes(value.kind as string)
    || !['ACCEPTED', 'REJECTED'].includes(value.outcome as string) || !Number.isSafeInteger(value.receivedAtMs)
    || !Number.isSafeInteger(value.recordedAtMs)
    || !REASON_CODES.includes(value.reasonCode as never)
    || (value.qualificationId !== null && !isUuidValue(value.qualificationId))) {
    throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  }
  if (value.presenceTransition !== null) {
    const transition = plainDataRecord(value.presenceTransition, ['from', 'to']);
    if (!['NOT_ENTERED', 'INSIDE', 'EXITED'].includes(transition.from as string)
      || !['NOT_ENTERED', 'INSIDE', 'EXITED'].includes(transition.to as string)) {
      throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
    }
    return Object.freeze({ ...value, presenceTransition: Object.freeze(transition) }) as QuerySnapshotEvent;
  }
  return Object.freeze({ ...value, presenceTransition: null }) as QuerySnapshotEvent;
}

function plainDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null) throw new TypeError('record is not an object');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('record prototype is invalid');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')) throw new TypeError('record keys are invalid');
    const expected = new Set(expectedKeys);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string' || !expected.has(key)) throw new TypeError('record keys are invalid');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError('record property is accessor');
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new QueryApplicationError('PERSISTENCE_UNAVAILABLE');
  }
}

function isUuidValue(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function assertOptions(options: Readonly<{
  readonly data: QueryDataPort;
  readonly writerQuiescence: WriterQuiescencePort;
  readonly epoch: string;
  readonly cursorCodec?: QueryCursorCodec;
}>): void {
  if (typeof options !== 'object' || options === null || typeof options.data !== 'object' || options.data === null
    || typeof options.writerQuiescence !== 'object' || options.writerQuiescence === null
    || !isWriterQuiescencePort(options.writerQuiescence)
    || typeof options.epoch !== 'string' || !UUID_V4.test(options.epoch)
    || typeof options.cursorCodec !== 'undefined' && !isQueryCursorCodec(options.cursorCodec)) {
    throw new TypeError('query application options are invalid');
  }
}

function captureOptions(options: Readonly<{
  readonly data: QueryDataPort;
  readonly writerQuiescence: WriterQuiescencePort;
  readonly epoch: string;
  readonly cursorCodec?: QueryCursorCodec;
}>): Readonly<{
  readonly data: QueryDataPort;
  readonly writerQuiescence: WriterQuiescencePort;
  readonly epoch: string;
  readonly cursorCodec?: QueryCursorCodec;
}> {
  const cursorCodec = captureOptionalConstructionProperty(options, 'cursorCodec', 'query application options') as QueryCursorCodec | undefined;
  const captured = {
    data: captureConstructionProperty(options, 'data', 'query application options') as QueryDataPort,
    writerQuiescence: captureConstructionProperty(options, 'writerQuiescence', 'query application options') as WriterQuiescencePort,
    epoch: captureConstructionProperty(options, 'epoch', 'query application options') as string,
  } as { data: QueryDataPort; writerQuiescence: WriterQuiescencePort; epoch: string; cursorCodec?: QueryCursorCodec };
  if (cursorCodec !== undefined) captured.cursorCodec = cursorCodec;
  return Object.freeze(captured);
}
