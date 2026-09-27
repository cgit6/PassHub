import { types as utilTypes } from 'node:util';
import { HumanAuthError, type HumanPrincipal } from '../../auth/domain/index.js';
import type { HumanAuthCapability } from '../../auth/application/index.js';
import {
  assertQueryApplicationQuiescence,
  isQueryApplication,
  type QueryApplication,
} from '../../access/application/query-application.js';
import { isQueryApplicationError } from '../../access/application/query-errors.js';
import { REASON_CODES, type ReasonCode } from '../../access/domain/index.js';
import type { EventQueryFilters } from '../../access/ports/query-ports.js';
import {
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionValidatorPort,
} from './g07b-admission-handler.js';
import {
  assertAdmissionWorkHandoffBundle,
  type AdmissionWorkHandoffBundle,
  type AdmissionWorkToken,
} from './admission-work-handoff.js';
import {
  assertHttpResponsePlanComposition,
  type HttpResponsePlan,
  type HttpResponsePlanBundle,
} from './http-response-plan.js';
import { isWriterQuiescencePort, type WriterQuiescencePort } from './writer-quiescence.js';
import {
  createQuiescedQueryAdmissionCapability,
  type QueryAdmissionCapability,
} from './query-admission-binding.js';
import {
  captureConstructionMethod,
  captureConstructionProperty,
} from '../../shared/internal/construction-capture.js';
import type { BusinessRouteId } from '../../shared/internal/http/index.js';

type QueryRouteId =
  | 'QUALIFICATION_LIST'
  | 'QUALIFICATION_INSIDE_LIST'
  | 'QUALIFICATION_DETAIL'
  | 'EVENT_LIST'
  | 'EVENT_DETAIL';

type QueryPayload = Readonly<{
  readonly routeId: QueryRouteId;
  readonly qualificationId: string | null;
  readonly eventId: string | null;
  readonly limit: number | null;
  readonly cursor: string | null;
  readonly filters: EventQueryFilters | null;
}>;

export interface G09aQueryCompositionOptions {
  readonly currentDatasetEpoch: string;
  readonly auth: HumanAuthCapability;
  readonly queryApplication: QueryApplication;
  readonly responsePlans: HttpResponsePlanBundle;
  readonly workHandoff: AdmissionWorkHandoffBundle;
  readonly writerQuiescence: WriterQuiescencePort;
}

export interface G09aQueryComposition extends QueryAdmissionCapability {}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BEARER = /^Bearer ([^\s]+)$/u;
const QUERY_ROUTES = new Set<QueryRouteId>([
  'QUALIFICATION_LIST', 'QUALIFICATION_INSIDE_LIST', 'QUALIFICATION_DETAIL', 'EVENT_LIST', 'EVENT_DETAIL',
]);
export function createG09aQueryComposition(options: G09aQueryCompositionOptions): G09aQueryComposition {
  const captured = captureOptions(options);
  assertAdmissionWorkHandoffBundle(captured.workHandoff);
  assertHttpResponsePlanComposition(captured.responsePlans, captured.currentDatasetEpoch);
  assertQueryApplicationQuiescence(captured.queryApplication, captured.writerQuiescence);

  const verifyAccessToken = captureConstructionMethod(captured.auth, 'verifyAccessToken', 'G09a auth').bind(captured.auth);
  const readFacts = captureConstructionMethod(captured.auth, 'facts', 'G09a auth').bind(captured.auth);
  const assertRole = captureConstructionMethod(captured.auth, 'assertRole', 'G09a auth').bind(captured.auth);
  const issuer = captureConstructionProperty(captured.workHandoff, 'issuer', 'G09a handoff');
  const issueWork = captureConstructionMethod(issuer, 'issue', 'G09a handoff issuer').bind(issuer);
  const listQualifications = captureConstructionMethod(captured.queryApplication, 'listQualifications', 'G09a query application').bind(captured.queryApplication);
  const listInside = captureConstructionMethod(captured.queryApplication, 'listInside', 'G09a query application').bind(captured.queryApplication);
  const listEvents = captureConstructionMethod(captured.queryApplication, 'listEvents', 'G09a query application').bind(captured.queryApplication);
  const qualificationDetail = captureConstructionMethod(captured.queryApplication, 'qualificationDetail', 'G09a query application').bind(captured.queryApplication);
  const eventDetail = captureConstructionMethod(captured.queryApplication, 'eventDetail', 'G09a query application').bind(captured.queryApplication);
  const technical = captureConstructionProperty(captured.responsePlans, 'technical', 'G09a response plans');
  const business = captureConstructionProperty(captured.responsePlans, 'business', 'G09a response plans');
  const issueTechnical = captureConstructionMethod(technical, 'issue', 'G09a technical response plans').bind(technical);
  const issueBusiness = captureConstructionMethod(business, 'issue', 'G09a business response plans').bind(business);
  assertOptions(captured, verifyAccessToken, readFacts, assertRole, issueWork, listQualifications, listInside, listEvents,
    qualificationDetail, eventDetail, issueTechnical, issueBusiness);
  const payloads = new WeakMap<object, QueryPayload>();

  const validator: AdmissionValidatorPort = Object.freeze({
    async validate(input: AdmissionValidationInput): Promise<AdmissionValidationResult> {
      if (!isQueryRoute(input.routeId) || input.retryMode !== 'NORMAL' || !isSafeAcceptedIngress(input.accepted)) {
        return rejected(issueTechnical('INVALID_REQUEST'));
      }
      let parsed: QueryPayload;
      try {
        parsed = parseQueryRequest(input.routeId, input.parameters, input.accepted.query);
      } catch {
        return rejected(issueTechnical('INVALID_REQUEST'));
      }

      let principal: HumanPrincipal;
      let accountId: string;
      try {
        const authorization = readOptionalOwnDataProperty(input.accepted.headers, 'authorization');
        const match = typeof authorization === 'string' ? BEARER.exec(authorization) : null;
        if (match === null || match[1] === undefined) throw new HumanAuthError('INVALID_TOKEN');
        principal = await verifyAccessToken(match[1]);
        const facts = readFacts(principal);
        if (facts.role !== 'OPERATOR' && facts.role !== 'VIEWER') throw new HumanAuthError('ROLE_FORBIDDEN');
        assertRole(principal, facts.role);
        accountId = facts.userId;
      } catch (error: unknown) {
        return rejected(issueTechnical(authCode(error)));
      }

      try {
        const token = issueWork(input.routeId);
        payloads.set(token as object, parsed);
        return Object.freeze({ kind: 'QUERY', accountId, workInput: token });
      } catch {
        return rejected(issueTechnical('PERSISTENCE_UNAVAILABLE'));
      }
    },
  });

  const work = Object.freeze({
    async query(input: AdmissionWorkToken): Promise<HttpResponsePlan> {
      const payload = payloads.get(input as object);
      if (payload === undefined) throw new TypeError('query work token is missing or already consumed');
      payloads.delete(input as object);
      try {
        if (payload.routeId === 'QUALIFICATION_LIST') {
          const result = await listQualifications({ limit: payload.limit!, cursor: payload.cursor });
          return persistedList(result.items, result.nextCursor);
        }
        if (payload.routeId === 'QUALIFICATION_INSIDE_LIST') {
          const result = await listInside({ limit: payload.limit!, cursor: payload.cursor });
          return persistedList(result.items, result.nextCursor);
        }
        if (payload.routeId === 'EVENT_LIST') {
          const result = await listEvents({ limit: payload.limit!, cursor: payload.cursor, filters: payload.filters! });
          return persistedList(result.items, result.nextCursor);
        }
        const result = payload.routeId === 'QUALIFICATION_DETAIL'
          ? await qualificationDetail(payload.qualificationId!)
          : await eventDetail(payload.eventId!);
        if (result.kind === 'NOT_FOUND') return issueTechnical('RESOURCE_NOT_FOUND');
        return persistedDetail(result.item);
      } catch (error: unknown) {
        return queryFailure(error);
      }
    },
  });

  function persistedList(items: readonly unknown[], nextCursor: string | null): HttpResponsePlan {
    try { return issueBusiness(200, Object.freeze({ items, nextCursor })); }
    catch { return issueTechnical('PERSISTENCE_UNAVAILABLE'); }
  }

  function persistedDetail(item: unknown): HttpResponsePlan {
    try { return issueBusiness(200, item as Readonly<Record<string, unknown>>); }
    catch { return issueTechnical('PERSISTENCE_UNAVAILABLE'); }
  }

  function queryFailure(error: unknown): HttpResponsePlan {
    if (isQueryApplicationError(error)) {
      if (error.code === 'DATASET_EPOCH_MISMATCH') return issueTechnical('DATASET_EPOCH_MISMATCH');
      if (error.code === 'TECHNICAL_BUSY') return issueTechnical('TECHNICAL_BUSY');
      if (error.code === 'PERSISTENCE_UNAVAILABLE') return issueTechnical('PERSISTENCE_UNAVAILABLE');
      if (error.code === 'INVALID_REQUEST' || error.code === 'INVALID_CURSOR' || error.code === 'CURSOR_SCOPE_MISMATCH') return issueTechnical('INVALID_REQUEST');
    }
    return issueTechnical('PERSISTENCE_UNAVAILABLE');
  }

  return createQuiescedQueryAdmissionCapability(
    Object.freeze({ validate: validator.validate, query: work.query }),
    captured.writerQuiescence,
  );
}

function captureOptions(options: G09aQueryCompositionOptions): G09aQueryCompositionOptions {
  const keys = [
    'currentDatasetEpoch', 'auth', 'queryApplication', 'responsePlans', 'workHandoff', 'writerQuiescence',
  ] as const;
  const captured = {} as Record<(typeof keys)[number], unknown>;
  for (const key of keys) {
    captured[key] = captureConstructionProperty(options, key, 'G09a query options');
  }
  return Object.freeze(captured) as G09aQueryCompositionOptions;
}

function rejected(response: HttpResponsePlan): AdmissionValidationResult {
  return Object.freeze({ kind: 'REJECTED', response });
}

function authCode(error: unknown): 'AUTHENTICATION_FAILED' | 'FORBIDDEN' | 'AUTH_UNAVAILABLE' {
  if (error instanceof HumanAuthError) {
    if (error.code === 'INVALID_TOKEN') return 'AUTHENTICATION_FAILED';
    if (error.code === 'ROLE_FORBIDDEN') return 'FORBIDDEN';
    return 'AUTH_UNAVAILABLE';
  }
  return 'AUTH_UNAVAILABLE';
}

function parseQueryRequest(
  routeId: QueryRouteId,
  parameters: Readonly<{ readonly id?: string }>,
  pairs: readonly Readonly<{ readonly name: string; readonly value: string }>[],
): QueryPayload {
  if (isProxyOrThrows(pairs) || !Array.isArray(pairs)) throw new TypeError('query pairs are invalid');
  const expectedPath = routeId === 'QUALIFICATION_DETAIL' || routeId === 'EVENT_DETAIL';
  assertExactParameters(parameters, expectedPath);
  if (expectedPath && pairs.length !== 0) throw new TypeError('detail query must be empty');
  const pathId = expectedPath ? parameterId(parameters) : undefined;
  const qualificationId = routeId === 'QUALIFICATION_DETAIL' ? requireUuid(pathId) : null;
  const eventId = routeId === 'EVENT_DETAIL' ? requireUuid(pathId) : null;
  if (expectedPath) return Object.freeze({ routeId, qualificationId, eventId, limit: null, cursor: null, filters: null });
  const allowed = routeId === 'EVENT_LIST'
    ? ['cursor', 'limit', 'outcome', 'qualificationId', 'reasonCode']
    : ['cursor', 'limit'];
  const fields = new Map<string, string>();
  for (const pair of pairs) {
    if (!isPair(pair) || !allowed.includes(pair.name) || fields.has(pair.name) || pair.value.length === 0) throw new TypeError('query field is invalid');
    fields.set(pair.name, pair.value);
  }
  const limit = parseLimit(fields.get('limit'));
  const cursor = fields.get('cursor') ?? null;
  if (cursor !== null && cursor.length === 0) throw new TypeError('cursor is empty');
  if (routeId !== 'EVENT_LIST') return Object.freeze({ routeId, qualificationId: null, eventId: null, limit, cursor, filters: null });
  const filterQualificationId = fields.get('qualificationId');
  const filterOutcome = fields.get('outcome');
  const filterReason = fields.get('reasonCode');
  const filters: EventQueryFilters = Object.freeze({
    qualificationId: filterQualificationId === undefined ? null : requireUuid(filterQualificationId),
    outcome: filterOutcome === undefined ? null : parseOutcome(filterOutcome),
    reasonCode: filterReason === undefined ? null : parseReason(filterReason),
  });
  return Object.freeze({ routeId, qualificationId: null, eventId: null, limit, cursor, filters });
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)) throw new TypeError('limit is invalid');
  return Number(value);
}
function parseOutcome(value: string): 'ACCEPTED' | 'REJECTED' { if (value !== 'ACCEPTED' && value !== 'REJECTED') throw new TypeError('outcome is invalid'); return value; }
function parseReason(value: string): ReasonCode { if (!REASON_CODES.includes(value as ReasonCode)) throw new TypeError('reason is invalid'); return value as ReasonCode; }
function requireUuid(value: unknown): string { if (typeof value !== 'string' || !UUID_V4.test(value)) throw new TypeError('UUID is invalid'); return value; }
function isQueryRoute(value: BusinessRouteId): value is QueryRouteId { return QUERY_ROUTES.has(value as QueryRouteId); }
function isPair(value: unknown): value is { readonly name: string; readonly value: string } {
  try {
    if (isProxyOrThrows(value) || typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => key !== 'name' && key !== 'value')) return false;
    const name = Object.getOwnPropertyDescriptor(value, 'name');
    const fieldValue = Object.getOwnPropertyDescriptor(value, 'value');
    return name !== undefined && Object.hasOwn(name, 'value') && typeof name.value === 'string'
      && fieldValue !== undefined && Object.hasOwn(fieldValue, 'value') && typeof fieldValue.value === 'string';
  } catch {
    return false;
  }
}
function assertExactParameters(value: Readonly<{ readonly id?: string }>, detail: boolean): void {
  try {
    if (isProxyOrThrows(value) || typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidQueryShape();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidQueryShape();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string') || keys.length !== (detail ? 1 : 0) || (detail && !keys.includes('id')) || (!detail && keys.length !== 0)) throw invalidQueryShape();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw invalidQueryShape();
    }
  } catch {
    throw invalidQueryShape();
  }
}
function parameterId(value: Readonly<{ readonly id?: string }>): unknown {
  try { return Object.getOwnPropertyDescriptor(value, 'id')?.value; } catch { throw invalidQueryShape(); }
}

function isSafeAcceptedIngress(value: unknown): value is AdmissionValidationInput['accepted'] {
  try {
    if (isProxyOrThrows(value) || typeof value !== 'object' || value === null) return false;
    const body = readOwnDataProperty(value, 'body');
    const query = readOwnDataProperty(value, 'query');
    const headers = readOwnDataProperty(value, 'headers');
    if (body !== null || isProxyOrThrows(query) || !Array.isArray(query) || isProxyOrThrows(headers)
      || typeof headers !== 'object' || headers === null) return false;
    readOptionalOwnDataProperty(headers, 'authorization');
    return true;
  } catch {
    return false;
  }
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (isProxyOrThrows(value) || typeof value !== 'object' || value === null) throw invalidQueryShape();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw invalidQueryShape();
  return descriptor.value;
}

function readOptionalOwnDataProperty(value: unknown, key: string): unknown {
  if (isProxyOrThrows(value) || typeof value !== 'object' || value === null) throw invalidQueryShape();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw invalidQueryShape();
  return descriptor.value;
}

function isProxyOrThrows(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  try { return utilTypes.isProxy(value); } catch { throw invalidQueryShape(); }
}

function invalidQueryShape(): TypeError { return new TypeError('invalid query shape'); }

function assertOptions(
  options: G09aQueryCompositionOptions,
  verifyAccessToken: unknown,
  readFacts: unknown,
  assertRole: unknown,
  issueWork: unknown,
  listQualifications: unknown,
  listInside: unknown,
  listEvents: unknown,
  qualificationDetail: unknown,
  eventDetail: unknown,
  issueTechnical: unknown,
  issueBusiness: unknown,
): void {
  if (typeof options !== 'object' || options === null || typeof options.currentDatasetEpoch !== 'string'
    || typeof options.auth !== 'object' || options.auth === null
    || !isQueryApplication(options.queryApplication) || !isWriterQuiescencePort(options.writerQuiescence)
    || typeof options.responsePlans !== 'object' || options.responsePlans === null
    || [verifyAccessToken, readFacts, assertRole, issueWork, listQualifications, listInside, listEvents,
      qualificationDetail, eventDetail, issueTechnical, issueBusiness].some((value) => typeof value !== 'function')) {
    throw new TypeError('G09a query composition options are invalid');
  }
}
