/** Internal-only fixed-minute rate accounting. */

export const FIXED_MINUTE_RATE_LIMITS = Object.freeze({
  login: Object.freeze({ perKey: 5, global: 20, maxKeys: 256 }),
  query: Object.freeze({ perKey: 60, global: 120 }),
  recognition: Object.freeze({ perKey: 30, global: 60 }),
  management: Object.freeze({ perKey: 10, global: 20 }),
} as const);

export type RateLimitCategory = 'LOGIN' | 'QUERY' | 'RECOGNITION' | 'MANAGEMENT';
export type RateLimitErrorCode = 'INVALID_KEY' | 'CLOCK_FAILURE' | 'RATE_LIMITER_FROZEN';

export class RateLimitError extends Error {
  public constructor(
    public readonly code: RateLimitErrorCode,
    public readonly category: RateLimitCategory,
  ) {
    super(code);
    this.name = 'RateLimitError';
  }
}

export type RateLimitDecision =
  | Readonly<{ readonly kind: 'ALLOWED' }>
  | Readonly<{ readonly kind: 'RATE_LIMITED'; readonly code: 'RATE_LIMITED' }>;

export interface TrustedRateLimitClock {
  nowMs(): number;
}

export interface FixedMinuteRatePort {
  allow(key: string): RateLimitDecision;
}

export interface RateLimitCategorySnapshot {
  readonly minute: number | null;
  readonly globalCount: number;
  readonly keyCount: number;
  readonly frozen: boolean;
}

export interface FixedMinuteRateLedger {
  readonly login: FixedMinuteRatePort;
  readonly query: FixedMinuteRatePort;
  readonly recognition: FixedMinuteRatePort;
  readonly management: FixedMinuteRatePort;
  snapshot(): Readonly<Record<'login' | 'query' | 'recognition' | 'management', RateLimitCategorySnapshot>>;
}

export interface FixedMinuteRateLedgerOptions {
  readonly clock: TrustedRateLimitClock;
}

export interface FixedMinuteCategoryLimits {
  readonly perKey: number;
  readonly global: number;
  readonly maxKeys?: number;
}

export interface ConfigurableFixedMinuteRateLimits {
  readonly login: FixedMinuteCategoryLimits;
  readonly query: FixedMinuteCategoryLimits;
  readonly recognition: FixedMinuteCategoryLimits;
  readonly management: FixedMinuteCategoryLimits;
}

interface CategoryState {
  readonly category: RateLimitCategory;
  readonly perKeyLimit: number;
  readonly globalLimit: number;
  readonly maxKeys: number | null;
  minute: number | null;
  globalCount: number;
  readonly counts: Map<string, number>;
}

interface GuardedClockState {
  readonly nowMs: () => number;
  lastNowMs: number | null;
  invoking: boolean;
  frozen: boolean;
}

const ALLOWED: RateLimitDecision = Object.freeze({ kind: 'ALLOWED' });
const RATE_LIMITED: RateLimitDecision = Object.freeze({
  kind: 'RATE_LIMITED',
  code: 'RATE_LIMITED',
});

export function createFixedMinuteRateLedger(
  options: FixedMinuteRateLedgerOptions,
): FixedMinuteRateLedger {
  return createConfigurableFixedMinuteRateLedger(options, FIXED_MINUTE_RATE_LIMITS);
}

/** Internal test seam; production callers use createFixedMinuteRateLedger. */
export function createConfigurableFixedMinuteRateLedger(
  options: FixedMinuteRateLedgerOptions,
  limits: ConfigurableFixedMinuteRateLimits,
): FixedMinuteRateLedger {
  if (typeof options !== 'object' || options === null || typeof options.clock?.nowMs !== 'function') {
    throw new TypeError('trusted rate-limit clock is required');
  }
  const nowMs = options.clock.nowMs.bind(options.clock);
  const capturedLimits = captureLimits(limits);
  const guard: GuardedClockState = {
    nowMs,
    lastNowMs: null,
    invoking: false,
    frozen: false,
  };
  const login = state('LOGIN', capturedLimits.login);
  const query = state('QUERY', capturedLimits.query);
  const recognition = state('RECOGNITION', capturedLimits.recognition);
  const management = state('MANAGEMENT', capturedLimits.management);

  const port = (categoryState: CategoryState): FixedMinuteRatePort => Object.freeze({
    allow(key: string): RateLimitDecision {
      if (guard.frozen) {
        throw new RateLimitError('RATE_LIMITER_FROZEN', categoryState.category);
      }
      if (guard.invoking) return freezeLedger(guard, categoryState.category);
      assertKey(key, categoryState.category);
      const currentMs = readGuardedClock(guard, categoryState.category);
      const currentMinute = Math.floor(currentMs / 60_000);
      if (categoryState.minute === null || currentMinute > categoryState.minute) {
        categoryState.minute = currentMinute;
        categoryState.globalCount = 0;
        categoryState.counts.clear();
      } else if (currentMinute < categoryState.minute) {
        return freezeLedger(guard, categoryState.category);
      }

      const existing = categoryState.counts.get(key);
      if (existing === undefined
        && categoryState.maxKeys !== null
        && categoryState.counts.size >= categoryState.maxKeys) {
        return RATE_LIMITED;
      }
      if (categoryState.globalCount >= categoryState.globalLimit) return RATE_LIMITED;
      if ((existing ?? 0) >= categoryState.perKeyLimit) return RATE_LIMITED;

      categoryState.counts.set(key, (existing ?? 0) + 1);
      categoryState.globalCount += 1;
      return ALLOWED;
    },
  });

  return Object.freeze({
    login: port(login),
    query: port(query),
    recognition: port(recognition),
    management: port(management),
    snapshot: () => Object.freeze({
      login: snapshot(login, guard.frozen),
      query: snapshot(query, guard.frozen),
      recognition: snapshot(recognition, guard.frozen),
      management: snapshot(management, guard.frozen),
    }),
  });
}

function state(
  category: RateLimitCategory,
  limits: Readonly<{ readonly perKey: number; readonly global: number; readonly maxKeys: number | null }>,
): CategoryState {
  return {
    category,
    perKeyLimit: limits.perKey,
    globalLimit: limits.global,
    maxKeys: limits.maxKeys,
    minute: null,
    globalCount: 0,
    counts: new Map<string, number>(),
  };
}

function assertKey(key: string, category: RateLimitCategory): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new RateLimitError('INVALID_KEY', category);
  }
}

function readGuardedClock(guard: GuardedClockState, category: RateLimitCategory): number {
  guard.invoking = true;
  let currentMs: number;
  try {
    currentMs = guard.nowMs();
  } catch {
    return freezeLedger(guard, category);
  } finally {
    guard.invoking = false;
  }
  if (guard.frozen) return freezeLedger(guard, category);
  if (!Number.isSafeInteger(currentMs) || currentMs < 0) return freezeLedger(guard, category);
  if (guard.lastNowMs !== null && currentMs < guard.lastNowMs) {
    return freezeLedger(guard, category);
  }
  guard.lastNowMs = currentMs;
  return currentMs;
}

function freezeLedger(guard: GuardedClockState, category: RateLimitCategory): never {
  guard.frozen = true;
  throw new RateLimitError('CLOCK_FAILURE', category);
}

function snapshot(categoryState: CategoryState, frozen = false): RateLimitCategorySnapshot {
  return Object.freeze({
    minute: categoryState.minute,
    globalCount: categoryState.globalCount,
    keyCount: categoryState.counts.size,
    frozen,
  });
}

function captureLimits(
  limits: ConfigurableFixedMinuteRateLimits,
): Readonly<Record<'login' | 'query' | 'recognition' | 'management',
Readonly<{ readonly perKey: number; readonly global: number; readonly maxKeys: number | null }>>> {
  if (typeof limits !== 'object' || limits === null) throw new TypeError('fixed-minute limits are required');
  return Object.freeze({
    login: captureCategoryLimits(limits.login),
    query: captureCategoryLimits(limits.query),
    recognition: captureCategoryLimits(limits.recognition),
    management: captureCategoryLimits(limits.management),
  });
}

function captureCategoryLimits(
  limits: FixedMinuteCategoryLimits,
): Readonly<{ readonly perKey: number; readonly global: number; readonly maxKeys: number | null }> {
  if (typeof limits !== 'object' || limits === null
    || !Number.isSafeInteger(limits.perKey) || limits.perKey < 1
    || !Number.isSafeInteger(limits.global) || limits.global < 1
    || (limits.maxKeys !== undefined
      && (!Number.isSafeInteger(limits.maxKeys) || limits.maxKeys < 1))) {
    throw new TypeError('fixed-minute category limits are invalid');
  }
  return Object.freeze({
    perKey: limits.perKey,
    global: limits.global,
    maxKeys: limits.maxKeys ?? null,
  });
}
