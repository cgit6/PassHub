/**
 * G11c maintenance lifecycle.
 *
 * This is deliberately an orchestration-only seam.  It does not know how a
 * marker is represented, how a process is stopped, or how Mongo is queried;
 * those effects are supplied by the private deployment composition.  The
 * sequence is nevertheless fixed here so a caller cannot skip isolation or
 * claim that a stop request alone proves process disappearance.
 */

const LIFECYCLE_MINT = Symbol('G11c maintenance lifecycle mint');
const markers = new WeakSet<object>();

export type G11cMaintenancePhase =
  | 'NEW'
  | 'MARKER_ACTIVE'
  | 'DRAINING'
  | 'DRAINED'
  | 'DRAIN_NOT_CONFIRMED'
  | 'API_STOPPING'
  | 'API_DISAPPEARANCE_WAITING'
  | 'API_STOPPED'
  | 'MONGO_STOPPING'
  | 'MONGO_DISAPPEARANCE_WAITING'
  | 'MONGO_STOPPED'
  | 'MONGO_RECOVERING'
  | 'MONGO_READY'
  | 'NO_LATE_WORK_VERIFIED'
  | 'FAILED';

export type G11cMaintenanceFailure =
  | 'MARKER_ACQUIRE_FAILED'
  | 'DRAIN_UNAVAILABLE'
  | 'API_STOP_FAILED'
  | 'API_DISAPPEARANCE_UNCONFIRMED'
  | 'MONGO_STOP_FAILED'
  | 'MONGO_DISAPPEARANCE_UNCONFIRMED'
  | 'MONGO_RECOVERY_FAILED'
  | 'NO_LATE_WORK_UNCONFIRMED';

export type G11cDrainOutcome = 'DRAINED' | 'NOT_DRAINED' | 'INTERNAL_UNAVAILABLE';

/** Opaque proof that the deployment marker was acquired and remains active. */
export class G11cMaintenanceMarker {
  declare private readonly nominalMarker: void;

  constructor(authority: symbol) {
    if (authority !== LIFECYCLE_MINT) throw new TypeError('invalid G11c maintenance marker');
    markers.add(this);
    Object.freeze(this);
  }
}

/** Private deployment seam; this module is not part of the public barrel. */
export function mintG11cMaintenanceMarker(): G11cMaintenanceMarker {
  return new G11cMaintenanceMarker(LIFECYCLE_MINT);
}

export function isG11cMaintenanceMarker(value: unknown): value is G11cMaintenanceMarker {
  return typeof value === 'object' && value !== null && markers.has(value);
}

export interface G11cMaintenanceEffects {
  /** Must durably close the public entry path before returning. */
  readonly acquirePersistentMarker: () => Promise<G11cMaintenanceMarker>;
  /** Private runtime-control drain; the marker must already be active. */
  readonly drainPrivateRuntime: (timeoutMs: number) => Promise<G11cDrainOutcome>;
  /** Requests API shutdown.  Completion is not process disappearance. */
  readonly requestApiStop: () => Promise<void>;
  /** Observes the expected old API process identity as gone. */
  readonly awaitApiProcessGone: () => Promise<void>;
  /** Requests Mongo shutdown only after API process disappearance. */
  readonly requestMongoStop: () => Promise<void>;
  /** Observes the expected old Mongo process identity as gone. */
  readonly awaitMongoProcessGone: () => Promise<void>;
  /** Starts/awaits recovery until the expected single-member PRIMARY is ready. */
  readonly awaitMongoPrimary: () => Promise<void>;
  /** Must prove no old work can produce a late effect after recovery. */
  readonly verifyNoLateWork: () => Promise<void>;
}

export interface G11cMaintenanceResult {
  readonly phase: G11cMaintenancePhase;
  readonly marker: G11cMaintenanceMarker | null;
  readonly drain: G11cDrainOutcome | null;
  readonly failure: G11cMaintenanceFailure | null;
}

interface MutableState {
  phase: G11cMaintenancePhase;
  marker: G11cMaintenanceMarker | null;
  drain: G11cDrainOutcome | null;
  failure: G11cMaintenanceFailure | null;
  run?: Promise<G11cMaintenanceResult>;
}

const states = new WeakMap<G11cMaintenanceLifecycle, MutableState>();

/**
 * A one-shot lifecycle owner.  Failures never release the marker and never
 * execute a later phase.  A non-successful drain is recorded, then the
 * process-isolation sequence still runs; this is the safe shutdown path, not
 * evidence that draining succeeded.
 */
export class G11cMaintenanceLifecycle {
  declare private readonly nominalLifecycle: void;

  constructor(authority: symbol) {
    if (authority !== LIFECYCLE_MINT) throw new TypeError('invalid G11c maintenance lifecycle');
    Object.freeze(this);
  }

  run(effects: G11cMaintenanceEffects, drainTimeoutMs: number): Promise<G11cMaintenanceResult> {
    const state = states.get(this);
    if (state === undefined) throw new TypeError('invalid G11c maintenance lifecycle');
    if (state.run !== undefined) return state.run;
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 30_000) {
      throw new RangeError('invalid G11c drain timeout');
    }
    const captured = captureEffects(effects);
    // Publish the promise before invoking any effect.  An adapter may call
    // back synchronously (for example while creating the marker); re-entry
    // must observe this exact one-shot operation rather than start a second
    // lifecycle.
    let resolveRun!: (result: G11cMaintenanceResult) => void;
    let rejectRun!: (error: unknown) => void;
    const run = new Promise<G11cMaintenanceResult>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    state.run = run;
    void this.execute(captured, drainTimeoutMs).then(resolveRun, rejectRun);
    return run;
  }

  snapshot(): G11cMaintenanceResult {
    const state = states.get(this);
    if (state === undefined) throw new TypeError('invalid G11c maintenance lifecycle');
    return Object.freeze({ phase: state.phase, marker: state.marker, drain: state.drain, failure: state.failure });
  }

  private async execute(effects: G11cMaintenanceEffects, drainTimeoutMs: number): Promise<G11cMaintenanceResult> {
    const state = states.get(this);
    if (state === undefined) throw new TypeError('invalid G11c maintenance lifecycle');
    try {
      state.marker = await effects.acquirePersistentMarker();
      if (!isG11cMaintenanceMarker(state.marker)) return this.fail('MARKER_ACQUIRE_FAILED');
      state.phase = 'MARKER_ACTIVE';

      state.phase = 'DRAINING';
      try {
        const drain = await effects.drainPrivateRuntime(drainTimeoutMs);
        state.drain = drain === 'DRAINED' || drain === 'NOT_DRAINED' || drain === 'INTERNAL_UNAVAILABLE'
          ? drain : 'INTERNAL_UNAVAILABLE';
      } catch {
        // Drain has already crossed the private maintenance veto in the
        // runtime-control layer.  An unavailable response must not skip the
        // process-isolation path; it only prevents a successful result.
        state.drain = 'INTERNAL_UNAVAILABLE';
      }
      if (state.drain !== 'DRAINED') {
        state.phase = 'DRAIN_NOT_CONFIRMED';
        state.failure = 'DRAIN_UNAVAILABLE';
      }
      else state.phase = 'DRAINED';

      state.phase = 'API_STOPPING';
      await effects.requestApiStop();
      state.phase = 'API_DISAPPEARANCE_WAITING';
      await effects.awaitApiProcessGone();
      state.phase = 'API_STOPPED';

      state.phase = 'MONGO_STOPPING';
      await effects.requestMongoStop();
      state.phase = 'MONGO_DISAPPEARANCE_WAITING';
      await effects.awaitMongoProcessGone();
      state.phase = 'MONGO_STOPPED';

      state.phase = 'MONGO_RECOVERING';
      await effects.awaitMongoPrimary();
      state.phase = 'MONGO_READY';
      await effects.verifyNoLateWork();
      state.phase = 'NO_LATE_WORK_VERIFIED';
      return this.snapshot();
    } catch (error) {
      return this.fail(classifyFailure(state.phase, error));
    }
  }

  private fail(failure: G11cMaintenanceFailure): G11cMaintenanceResult {
    const state = states.get(this);
    if (state === undefined) throw new TypeError('invalid G11c maintenance lifecycle');
    state.failure = failure;
    state.phase = 'FAILED';
    return this.snapshot();
  }
}

export function createG11cMaintenanceLifecycle(): G11cMaintenanceLifecycle {
  const lifecycle = new G11cMaintenanceLifecycle(LIFECYCLE_MINT);
  states.set(lifecycle, { phase: 'NEW', marker: null, drain: null, failure: null });
  return lifecycle;
}

function classifyFailure(phase: G11cMaintenancePhase, _error: unknown): G11cMaintenanceFailure {
  switch (phase) {
    case 'NEW': return 'MARKER_ACQUIRE_FAILED';
    case 'DRAINING': return 'DRAIN_UNAVAILABLE';
    case 'API_STOPPING': return 'API_STOP_FAILED';
    case 'API_DISAPPEARANCE_WAITING': return 'API_DISAPPEARANCE_UNCONFIRMED';
    case 'API_STOPPED': return 'API_DISAPPEARANCE_UNCONFIRMED';
    case 'MONGO_STOPPING': return 'MONGO_STOP_FAILED';
    case 'MONGO_DISAPPEARANCE_WAITING': return 'MONGO_DISAPPEARANCE_UNCONFIRMED';
    case 'MONGO_STOPPED': return 'MONGO_DISAPPEARANCE_UNCONFIRMED';
    case 'MONGO_RECOVERING': return 'MONGO_RECOVERY_FAILED';
    case 'MONGO_READY': return 'NO_LATE_WORK_UNCONFIRMED';
    default: return 'MARKER_ACQUIRE_FAILED';
  }
}

function captureEffects(input: G11cMaintenanceEffects): Readonly<G11cMaintenanceEffects> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('invalid G11c effects');
  const fields: readonly (keyof G11cMaintenanceEffects)[] = [
    'acquirePersistentMarker', 'drainPrivateRuntime', 'requestApiStop', 'awaitApiProcessGone',
    'requestMongoStop', 'awaitMongoProcessGone', 'awaitMongoPrimary', 'verifyNoLateWork',
  ];
  const record = input as unknown as Record<string, unknown>;
  if (Reflect.ownKeys(input).length !== fields.length || fields.some((field) => typeof record[field] !== 'function')) {
    throw new TypeError('invalid G11c effects');
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, record[field]])) as unknown as G11cMaintenanceEffects);
}
