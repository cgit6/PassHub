/** Internal-only synchronous admission and ancillary resource accounting. */

export const ADMISSION_RESOURCE_LIMITS = Object.freeze({
  httpOrdinary: 28,
  httpRetry: 4,
  validationWrite: 4,
  validationLogin: 1,
  validationQuery: 1,
  validationRetry: 2,
  origin: 32,
  scrypt: 1,
  queryDb: 1,
  canonicalReplay: 2,
  originalConfirm: 1,
} as const);

export type AdmissionResourceClass =
  | 'MANAGEMENT'
  | 'NORMAL_RECOGNITION'
  | 'LOGIN'
  | 'QUERY'
  | 'EXISTING_ONLY';

export type AncillaryResourceClass =
  | 'SCRYPT'
  | 'QUERY_DB'
  | 'CANONICAL_REPLAY'
  | 'ORIGINAL_CONFIRM';

export type AdmissionResourceErrorCode =
  | 'INVALID_LEASE'
  | 'LEASE_ALREADY_RELEASED';

export class AdmissionResourceError extends Error {
  public constructor(public readonly code: AdmissionResourceErrorCode) {
    super(code);
    this.name = 'AdmissionResourceError';
  }
}

declare const httpAdmissionLeaseBrand: unique symbol;
declare const validationAdmissionLeaseBrand: unique symbol;
declare const originAdmissionLeaseBrand: unique symbol;
declare const ancillaryAdmissionLeaseBrand: unique symbol;

export interface HttpAdmissionLease {
  readonly [httpAdmissionLeaseBrand]: never;
}

export interface ValidationAdmissionLease {
  readonly [validationAdmissionLeaseBrand]: never;
}

export interface OriginAdmissionLease {
  readonly [originAdmissionLeaseBrand]: never;
}

export interface AncillaryAdmissionLease {
  readonly [ancillaryAdmissionLeaseBrand]: never;
}

export interface AdmissionResourceBundle {
  readonly http: HttpAdmissionLease;
  readonly validation: ValidationAdmissionLease;
  readonly origin: OriginAdmissionLease | null;
}

export interface AncillaryResourcePool {
  tryAcquire(): AncillaryAdmissionLease | null;
  release(lease: AncillaryAdmissionLease): void;
}

export interface AdmissionResourceSnapshot {
  readonly httpOrdinary: Readonly<{ readonly used: number; readonly limit: 28 }>;
  readonly httpRetry: Readonly<{ readonly used: number; readonly limit: 4 }>;
  readonly validationWrite: Readonly<{ readonly used: number; readonly limit: 4 }>;
  readonly validationLogin: Readonly<{ readonly used: number; readonly limit: 1 }>;
  readonly validationQuery: Readonly<{ readonly used: number; readonly limit: 1 }>;
  readonly validationRetry: Readonly<{ readonly used: number; readonly limit: 2 }>;
  readonly origin: Readonly<{ readonly used: number; readonly limit: 32 }>;
  readonly scrypt: Readonly<{ readonly used: number; readonly limit: 1 }>;
  readonly queryDb: Readonly<{ readonly used: number; readonly limit: 1 }>;
  readonly canonicalReplay: Readonly<{ readonly used: number; readonly limit: 2 }>;
  readonly originalConfirm: Readonly<{ readonly used: number; readonly limit: 1 }>;
}

export interface AdmissionResourceLedger {
  tryAcquire(resourceClass: AdmissionResourceClass): AdmissionResourceBundle | null;
  releaseHttp(lease: HttpAdmissionLease): void;
  releaseValidation(lease: ValidationAdmissionLease): void;
  releaseOrigin(lease: OriginAdmissionLease): void;
  readonly ancillary: Readonly<{
    readonly scrypt: AncillaryResourcePool;
    readonly queryDb: AncillaryResourcePool;
    readonly canonicalReplay: AncillaryResourcePool;
    readonly originalConfirm: AncillaryResourcePool;
  }>;
  snapshot(): AdmissionResourceSnapshot;
}

type PoolName = keyof typeof ADMISSION_RESOURCE_LIMITS;

interface PoolState {
  readonly limit: number;
  used: number;
}

interface LeaseState {
  readonly ledger: object;
  readonly pool: PoolName;
  active: boolean;
}

interface AdmissionPlan {
  readonly http: 'httpOrdinary' | 'httpRetry';
  readonly validation:
    | 'validationWrite'
    | 'validationLogin'
    | 'validationQuery'
    | 'validationRetry';
  readonly origin: boolean;
}

const ADMISSION_PLANS: Readonly<Record<AdmissionResourceClass, AdmissionPlan>> = Object.freeze({
  MANAGEMENT: Object.freeze({ http: 'httpOrdinary', validation: 'validationWrite', origin: true }),
  NORMAL_RECOGNITION: Object.freeze({ http: 'httpOrdinary', validation: 'validationWrite', origin: true }),
  LOGIN: Object.freeze({ http: 'httpOrdinary', validation: 'validationLogin', origin: false }),
  QUERY: Object.freeze({ http: 'httpOrdinary', validation: 'validationQuery', origin: false }),
  EXISTING_ONLY: Object.freeze({ http: 'httpRetry', validation: 'validationRetry', origin: false }),
});

export function createAdmissionResourceLedger(): AdmissionResourceLedger {
  const identity = Object.freeze({});
  const pools = createPoolStates();
  const httpLeases = new WeakMap<object, LeaseState>();
  const validationLeases = new WeakMap<object, LeaseState>();
  const originLeases = new WeakMap<object, LeaseState>();
  const ancillaryLeases = new WeakMap<object, LeaseState>();

  const mint = <T extends object>(
    pool: PoolName,
    store: WeakMap<object, LeaseState>,
  ): T => {
    const lease = Object.freeze({}) as T;
    store.set(lease, { ledger: identity, pool, active: true });
    pools[pool].used += 1;
    return lease;
  };

  const release = (
    lease: object,
    expectedPools: readonly PoolName[],
    store: WeakMap<object, LeaseState>,
  ): void => {
    if (!isObject(lease)) throw new AdmissionResourceError('INVALID_LEASE');
    const state = store.get(lease);
    if (state === undefined || state.ledger !== identity || !expectedPools.includes(state.pool)) {
      throw new AdmissionResourceError('INVALID_LEASE');
    }
    if (!state.active) throw new AdmissionResourceError('LEASE_ALREADY_RELEASED');
    state.active = false;
    pools[state.pool].used -= 1;
  };

  const createAncillaryPool = (pool: PoolName): AncillaryResourcePool => Object.freeze({
    tryAcquire(): AncillaryAdmissionLease | null {
      const state = pools[pool];
      if (state.used >= state.limit) return null;
      return mint<AncillaryAdmissionLease>(pool, ancillaryLeases);
    },
    release(lease: AncillaryAdmissionLease): void {
      release(lease, [pool], ancillaryLeases);
    },
  });

  const ledger: AdmissionResourceLedger = Object.freeze({
    tryAcquire(resourceClass: AdmissionResourceClass): AdmissionResourceBundle | null {
      const plan = ADMISSION_PLANS[resourceClass];
      if (plan === undefined) return null;
      if (pools[plan.http].used >= pools[plan.http].limit) return null;
      if (pools[plan.validation].used >= pools[plan.validation].limit) return null;
      if (plan.origin && pools.origin.used >= pools.origin.limit) return null;

      const http = mint<HttpAdmissionLease>(plan.http, httpLeases);
      const validation = mint<ValidationAdmissionLease>(plan.validation, validationLeases);
      const origin = plan.origin
        ? mint<OriginAdmissionLease>('origin', originLeases)
        : null;
      return Object.freeze({ http, validation, origin });
    },

    releaseHttp(lease: HttpAdmissionLease): void {
      release(lease, ['httpOrdinary', 'httpRetry'], httpLeases);
    },

    releaseValidation(lease: ValidationAdmissionLease): void {
      release(lease, [
        'validationWrite',
        'validationLogin',
        'validationQuery',
        'validationRetry',
      ], validationLeases);
    },

    releaseOrigin(lease: OriginAdmissionLease): void {
      release(lease, ['origin'], originLeases);
    },

    ancillary: Object.freeze({
      scrypt: createAncillaryPool('scrypt'),
      queryDb: createAncillaryPool('queryDb'),
      canonicalReplay: createAncillaryPool('canonicalReplay'),
      originalConfirm: createAncillaryPool('originalConfirm'),
    }),

    snapshot(): AdmissionResourceSnapshot {
      return Object.freeze({
        httpOrdinary: view(pools.httpOrdinary, 28),
        httpRetry: view(pools.httpRetry, 4),
        validationWrite: view(pools.validationWrite, 4),
        validationLogin: view(pools.validationLogin, 1),
        validationQuery: view(pools.validationQuery, 1),
        validationRetry: view(pools.validationRetry, 2),
        origin: view(pools.origin, 32),
        scrypt: view(pools.scrypt, 1),
        queryDb: view(pools.queryDb, 1),
        canonicalReplay: view(pools.canonicalReplay, 2),
        originalConfirm: view(pools.originalConfirm, 1),
      });
    },
  });
  return ledger;
}

function createPoolStates(): Record<PoolName, PoolState> {
  return {
    httpOrdinary: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.httpOrdinary },
    httpRetry: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.httpRetry },
    validationWrite: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.validationWrite },
    validationLogin: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.validationLogin },
    validationQuery: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.validationQuery },
    validationRetry: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.validationRetry },
    origin: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.origin },
    scrypt: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.scrypt },
    queryDb: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.queryDb },
    canonicalReplay: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.canonicalReplay },
    originalConfirm: { used: 0, limit: ADMISSION_RESOURCE_LIMITS.originalConfirm },
  };
}

function view<TLimit extends number>(
  state: PoolState,
  limit: TLimit,
): Readonly<{ readonly used: number; readonly limit: TLimit }> {
  return Object.freeze({ used: state.used, limit });
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
