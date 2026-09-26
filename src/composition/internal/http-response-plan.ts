import { types as utilTypes } from 'node:util';

export const SAFE_HTTP_RESPONSE_CODES = Object.freeze([
  'INVALID_RETRY_MODE',
  'INVALID_DATASET_EPOCH',
  'DATASET_EPOCH_MISMATCH',
  'INVALID_REQUEST',
  'AUTHENTICATION_FAILED',
  'AUTH_UNAVAILABLE',
  'FORBIDDEN',
  'MANAGEMENT_CONFLICT',
  'PERSISTENCE_UNAVAILABLE',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'TECHNICAL_BUSY',
  'REQUEST_ADMISSION_UNAVAILABLE',
  'REQUEST_STATUS_UNCONFIRMED',
  'CANONICAL_RESULT_UNCONFIRMED',
  'OPERATION_EXECUTION_EXHAUSTED',
  'FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED',
  'REQUEST_IN_PROGRESS',
  'TECHNICAL_OPERATION_COMPLETED',
] as const);

export type SafeHttpResponseCode = (typeof SAFE_HTTP_RESPONSE_CODES)[number];
export type BusinessHttpStatus = 200 | 201 | 202 | 409;

const STATUS_BY_CODE: Readonly<Record<SafeHttpResponseCode, number>> = Object.freeze({
  INVALID_RETRY_MODE: 400,
  INVALID_DATASET_EPOCH: 400,
  DATASET_EPOCH_MISMATCH: 409,
  INVALID_REQUEST: 400,
  AUTHENTICATION_FAILED: 401,
  AUTH_UNAVAILABLE: 503,
  FORBIDDEN: 403,
  MANAGEMENT_CONFLICT: 409,
  PERSISTENCE_UNAVAILABLE: 503,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  TECHNICAL_BUSY: 503,
  REQUEST_ADMISSION_UNAVAILABLE: 503,
  REQUEST_STATUS_UNCONFIRMED: 503,
  CANONICAL_RESULT_UNCONFIRMED: 503,
  OPERATION_EXECUTION_EXHAUSTED: 503,
  FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED: 507,
  REQUEST_IN_PROGRESS: 202,
  TECHNICAL_OPERATION_COMPLETED: 200,
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const FORBIDDEN_RAW_KEYS: ReadonlySet<string> = new Set([
  'cause',
  'stack',
  'rawerror',
  'raw_error',
]);

declare const httpResponsePlanBrand: unique symbol;

export interface HttpResponsePlan {
  readonly [httpResponsePlanBrand]: never;
}

export interface RenderedHttpResponsePlan {
  readonly status: number;
  readonly body: string;
  readonly byteLength: number;
  readonly headers: Readonly<{
    readonly contentType: 'application/json; charset=utf-8';
    readonly cacheControl: 'no-store';
  }>;
}

export interface TechnicalResponsePlanIssuer {
  issue(code: SafeHttpResponseCode): HttpResponsePlan;
}

export interface BusinessResponsePlanIssuer {
  issue(status: BusinessHttpStatus, payload: Readonly<Record<string, unknown>>): HttpResponsePlan;
}

export interface HttpResponsePlanRenderer {
  render(plan: HttpResponsePlan): RenderedHttpResponsePlan;
}

export interface HttpResponsePlanBundle {
  readonly technical: TechnicalResponsePlanIssuer;
  readonly business: BusinessResponsePlanIssuer;
  readonly renderer: HttpResponsePlanRenderer;
}

export interface HttpResponsePlanBundleOptions {
  readonly currentDatasetEpoch: string;
  readonly maxBodyBytes?: number;
}

interface BundleState {
  readonly identity: object;
  readonly currentDatasetEpoch: string;
  readonly maxBodyBytes: number;
}

interface PlanState {
  readonly bundle: BundleState;
  readonly rendered: RenderedHttpResponsePlan;
}

const bundleStates = new WeakMap<object, BundleState>();
const planStates = new WeakMap<object, PlanState>();

export function createHttpResponsePlanBundle(
  options: HttpResponsePlanBundleOptions,
): HttpResponsePlanBundle {
  if (typeof options !== 'object' || options === null
    || typeof options.currentDatasetEpoch !== 'string'
    || !UUID_V4.test(options.currentDatasetEpoch)
    || (options.maxBodyBytes !== undefined
      && (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0))) {
    throw new TypeError('invalid HTTP response plan options');
  }

  const state: BundleState = Object.freeze({
    identity: Object.freeze({}),
    currentDatasetEpoch: options.currentDatasetEpoch,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  });
  const technicalCache = new Map<SafeHttpResponseCode, HttpResponsePlan>();

  const mint = (status: number, payload: Readonly<Record<string, unknown>>): HttpResponsePlan => {
    const body = JSON.stringify(payload);
    const byteLength = Buffer.byteLength(body);
    if (byteLength > state.maxBodyBytes) throw new TypeError('HTTP response plan body exceeds limit');
    const rendered: RenderedHttpResponsePlan = Object.freeze({
      status,
      body,
      byteLength,
      headers: Object.freeze({
        contentType: 'application/json; charset=utf-8' as const,
        cacheControl: 'no-store' as const,
      }),
    });
    const plan = Object.freeze({}) as HttpResponsePlan;
    planStates.set(plan, { bundle: state, rendered });
    return plan;
  };

  const technical: TechnicalResponsePlanIssuer = Object.freeze({
    issue(code: SafeHttpResponseCode): HttpResponsePlan {
      if (!SAFE_HTTP_RESPONSE_CODES.includes(code)) {
        throw new TypeError('unsupported technical response code');
      }
      const existing = technicalCache.get(code);
      if (existing !== undefined) return existing;
      const plan = mint(STATUS_BY_CODE[code], Object.freeze({
        code,
        currentDatasetEpoch: state.currentDatasetEpoch,
      }));
      technicalCache.set(code, plan);
      return plan;
    },
  });

  const business: BusinessResponsePlanIssuer = Object.freeze({
    issue(status: BusinessHttpStatus, payload: Readonly<Record<string, unknown>>): HttpResponsePlan {
      if (status !== 200 && status !== 201 && status !== 202 && status !== 409) {
        throw new TypeError('unsupported business response status');
      }
      const copied = copyJsonObject(payload, new Set<object>(), 0);
      if (Object.hasOwn(copied, 'currentDatasetEpoch')) {
        throw new TypeError('business response payload cannot supply currentDatasetEpoch');
      }
      return mint(status, Object.freeze({
        ...copied,
        currentDatasetEpoch: state.currentDatasetEpoch,
      }));
    },
  });

  const renderer: HttpResponsePlanRenderer = Object.freeze({
    render(plan: HttpResponsePlan): RenderedHttpResponsePlan {
      if (!isObject(plan)) throw new TypeError('HTTP response plan is invalid');
      const planState = planStates.get(plan);
      if (planState === undefined || planState.bundle !== state) {
        throw new TypeError('HTTP response plan was issued by another bundle');
      }
      return planState.rendered;
    },
  });

  const bundle: HttpResponsePlanBundle = Object.freeze({ technical, business, renderer });
  bundleStates.set(bundle, state);
  return bundle;
}

export function assertHttpResponsePlanComposition(
  bundle: HttpResponsePlanBundle,
  currentDatasetEpoch: string,
): void {
  if (!isObject(bundle)) throw new TypeError('HTTP response plan bundle is invalid');
  const state = bundleStates.get(bundle);
  if (state === undefined || state.currentDatasetEpoch !== currentDatasetEpoch) {
    throw new TypeError('HTTP response plan bundle does not match dataset epoch');
  }
}

function copyJsonObject(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): Record<string, unknown> {
  const copied = copyJsonValue(value, ancestors, depth);
  if (!isPlainRecord(copied)) throw new TypeError('business response payload must be a plain object');
  return copied;
}

function copyJsonValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (depth > MAX_JSON_DEPTH) throw new TypeError('business response payload is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('business response number must be finite');
    return value;
  }
  if (typeof value !== 'object'
    || value === undefined
    || utilTypes.isProxy(value)
    || isThenable(value)) {
    throw new TypeError('business response contains an unstable value');
  }
  if (ancestors.has(value)) throw new TypeError('business response contains a cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('business response arrays must contain enumerable data elements');
        }
        result.push(copyJsonValue(descriptor.value, ancestors, depth + 1));
      }
      return Object.freeze(result);
    }
    if (!isPlainRecord(value)) throw new TypeError('business response values must be plain records');
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('business response symbol keys are not supported');
      if (FORBIDDEN_RAW_KEYS.has(key.toLowerCase())) {
        throw new TypeError('business response contains a forbidden raw error field');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('business response properties must be enumerable data properties');
      }
      result[key] = copyJsonValue(descriptor.value, ancestors, depth + 1);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function isThenable(value: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'then');
  if (descriptor === undefined) return false;
  if (!('value' in descriptor)) return true;
  return typeof descriptor.value === 'function';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
