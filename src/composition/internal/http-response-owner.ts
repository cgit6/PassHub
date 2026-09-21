import { performance } from 'node:perf_hooks';

import {
  type HttpResponsePlan,
  type HttpResponsePlanRenderer,
  type RenderedHttpResponsePlan,
} from './http-response-plan.js';

export const HTTP_RESPONSE_DEADLINE_MS = 5_000;

export interface NarrowHttpResponse {
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
  statusCode: number;
  setHeader(name: string, value: string | number): void;
  end(body: string): unknown;
  once(event: 'finish' | 'close', listener: () => void): unknown;
  off(event: 'finish' | 'close', listener: () => void): unknown;
}

export interface HttpResponseOwnerClock {
  nowMs(): number;
}

export interface HttpResponseOwnerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HttpResponseOwnerOptions {
  readonly response: NarrowHttpResponse;
  readonly receipt: Readonly<{ readonly registeredAtMonotonicMs: number }>;
  readonly releaseHttp: () => void;
  readonly responsePlanRenderer: HttpResponsePlanRenderer;
  readonly fallbackPlan: HttpResponsePlan;
  readonly deadlineResponse: () => HttpResponsePlan;
  readonly clock?: HttpResponseOwnerClock;
  readonly scheduler?: HttpResponseOwnerScheduler;
}

export interface HttpResponseOwner {
  tryRespond(plan: HttpResponsePlan): boolean;
  snapshot(): Readonly<{ readonly state: 'OPEN' | 'CLAIMING' | 'CLAIMED' | 'CLOSED' }>;
}

export type HttpResponseOwnerErrorCode = 'INVALID_OPTIONS' | 'CONSTRUCTION_FAILED';

export class HttpResponseOwnerError extends Error {
  public constructor(public readonly code: HttpResponseOwnerErrorCode) {
    super(code);
    this.name = 'HttpResponseOwnerError';
  }
}

export function createHttpResponseOwner(options: HttpResponseOwnerOptions): HttpResponseOwner {
  assertOptions(options);

  let responseSetHeader: NarrowHttpResponse['setHeader'];
  let responseEnd: NarrowHttpResponse['end'];
  let responseOnce: NarrowHttpResponse['once'];
  let responseOff: NarrowHttpResponse['off'];
  let clockNow: () => number;
  let schedule: HttpResponseOwnerScheduler['setTimeout'];
  let unschedule: HttpResponseOwnerScheduler['clearTimeout'];
  let renderPlan: HttpResponsePlanRenderer['render'];
  let fallbackResponse: RenderedHttpResponsePlan;
  try {
    responseSetHeader = options.response.setHeader.bind(options.response);
    responseEnd = options.response.end.bind(options.response);
    responseOnce = options.response.once.bind(options.response);
    responseOff = options.response.off.bind(options.response);
    clockNow = (options.clock?.nowMs ?? performance.now.bind(performance)).bind(options.clock ?? performance);
    const scheduler = options.scheduler ?? defaultScheduler();
    schedule = scheduler.setTimeout.bind(scheduler);
    unschedule = scheduler.clearTimeout.bind(scheduler);
    renderPlan = options.responsePlanRenderer.render.bind(options.responsePlanRenderer);
    fallbackResponse = renderPlan(options.fallbackPlan);
  } catch {
    throw new HttpResponseOwnerError('CONSTRUCTION_FAILED');
  }
  const response = options.response;
  const releaseHttp = options.releaseHttp;
  const deadlineResponse = options.deadlineResponse;
  const registeredAtMonotonicMs = options.receipt.registeredAtMonotonicMs;

  let state: 'OPEN' | 'CLAIMING' | 'CLAIMED' | 'CLOSED' = 'OPEN';
  let timerHandle: unknown;
  let timerArmed = false;
  let listenersBound = false;
  let released = false;
  let closeObservedDuringClaim = false;

  const clearTimer = (): void => {
    if (!timerArmed) return;
    timerArmed = false;
    try {
      unschedule(timerHandle);
    } catch {
      // Cleanup is best effort after ownership has already been decided.
    }
  };

  const unbind = (): void => {
    if (!listenersBound) return;
    listenersBound = false;
    try {
      responseOff('finish', onFinished);
    } catch {
      // Listener callbacks are still guarded by the CLOSED state.
    }
    try {
      responseOff('close', onClosed);
    } catch {
      // Listener callbacks are still guarded by the CLOSED state.
    }
  };

  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    try {
      releaseHttp();
    } catch {
      // The owner is permanently closed even if trusted release bookkeeping
      // fails; reopening would permit a second response.
    }
  };

  const closeWithoutResponse = (): void => {
    if (state === 'CLAIMING') {
      closeObservedDuringClaim = true;
      return;
    }
    if (state !== 'OPEN') return;
    state = 'CLOSED';
    clearTimer();
    unbind();
    releaseOnce();
  };

  function onFinished(): void {
    closeWithoutResponse();
  }

  function onClosed(): void {
    closeWithoutResponse();
  }

  const responseIsClosed = (): boolean =>
    response.destroyed === true || response.writableEnded === true;

  const writeClaimed = (rendered: RenderedHttpResponsePlan): void => {
    try {
      response.statusCode = rendered.status;
      responseSetHeader('Content-Type', rendered.headers.contentType);
      responseSetHeader('Content-Length', rendered.byteLength);
      responseSetHeader('Cache-Control', rendered.headers.cacheControl);
      responseEnd(rendered.body);
    } catch {
      // A transport write failure cannot return ownership to OPEN.
    } finally {
      state = 'CLOSED';
      releaseOnce();
    }
  };

  const claimAndRespond = (plan: HttpResponsePlan): boolean => {
    if (state !== 'OPEN') return false;
    state = 'CLAIMING';
    closeObservedDuringClaim = false;
    let rendered = fallbackResponse;
    try {
      rendered = renderPlan(plan);
    } catch {
      rendered = fallbackResponse;
    }
    state = 'CLAIMED';
    clearTimer();
    unbind();
    // CLAIMING won the response race.  A concurrent/synchronous close only
    // changes whether the write succeeds; it cannot reopen response ownership.
    void closeObservedDuringClaim;
    writeClaimed(rendered);
    return true;
  };

  const onDeadline = (): void => {
    if (state !== 'OPEN') return;
    state = 'CLAIMING';
    closeObservedDuringClaim = false;
    let rendered = fallbackResponse;
    try {
      const candidate: unknown = deadlineResponse();
      rejectThenable(candidate);
      rendered = renderPlan(candidate as HttpResponsePlan);
    } catch {
      rendered = fallbackResponse;
    }
    state = 'CLAIMED';
    clearTimer();
    unbind();
    void closeObservedDuringClaim;
    writeClaimed(rendered);
  };

  const owner: HttpResponseOwner = Object.freeze({
    tryRespond: claimAndRespond,
    snapshot: () => Object.freeze({ state }),
  });

  // Construction failure never invokes releaseHttp: no owner is returned and
  // the orchestrator retains the lease and must roll it back itself.
  try {
    const currentMonotonicMs = clockNow();
    if (!Number.isFinite(currentMonotonicMs)
      || currentMonotonicMs < 0
      || currentMonotonicMs < registeredAtMonotonicMs) {
      throw new TypeError('invalid monotonic clock');
    }
    if (responseIsClosed()) {
      closeWithoutResponse();
      return owner;
    }
    listenersBound = true;
    responseOnce('finish', onFinished);
    if (state !== 'OPEN' || responseIsClosed()) {
      closeWithoutResponse();
      unbind();
      return owner;
    }
    responseOnce('close', onClosed);
    if (state !== 'OPEN' || responseIsClosed()) {
      closeWithoutResponse();
      unbind();
      return owner;
    }
    const remainingMs = Math.max(0, HTTP_RESPONSE_DEADLINE_MS - (currentMonotonicMs - registeredAtMonotonicMs));
    timerHandle = schedule(onDeadline, remainingMs);
    timerArmed = true;
    if (state !== 'OPEN') clearTimer();
  } catch {
    state = 'CLOSED';
    clearTimer();
    unbind();
    if (released) return owner;
    throw new HttpResponseOwnerError('CONSTRUCTION_FAILED');
  }

  return owner;
}

function assertOptions(options: HttpResponseOwnerOptions): void {
  if (typeof options !== 'object' || options === null
    || typeof options.response !== 'object' || options.response === null
    || typeof options.response.setHeader !== 'function'
    || typeof options.response.end !== 'function'
    || typeof options.response.once !== 'function'
    || typeof options.response.off !== 'function'
    || typeof options.releaseHttp !== 'function'
    || typeof options.responsePlanRenderer !== 'object'
    || options.responsePlanRenderer === null
    || typeof options.responsePlanRenderer.render !== 'function'
    || (typeof options.fallbackPlan !== 'object' && typeof options.fallbackPlan !== 'function')
    || options.fallbackPlan === null
    || typeof options.deadlineResponse !== 'function'
    || typeof options.receipt !== 'object' || options.receipt === null
    || !Number.isFinite(options.receipt.registeredAtMonotonicMs)
    || options.receipt.registeredAtMonotonicMs < 0
    || (options.clock !== undefined && typeof options.clock.nowMs !== 'function')
    || (options.scheduler !== undefined
      && (typeof options.scheduler.setTimeout !== 'function'
        || typeof options.scheduler.clearTimeout !== 'function'))) {
    throw new HttpResponseOwnerError('INVALID_OPTIONS');
  }
}

function rejectThenable(value: unknown): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  let then: unknown;
  try {
    then = Reflect.get(value, 'then');
  } catch {
    throw new TypeError('deadline response must be synchronous');
  }
  if (typeof then !== 'function') return;
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // The value is rejected below even when Promise assimilation also fails.
  }
  throw new TypeError('deadline response must be synchronous');
}

function defaultScheduler(): HttpResponseOwnerScheduler {
  return Object.freeze({
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    },
    clearTimeout(handle: unknown): void {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
}
