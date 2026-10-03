import { types as utilTypes } from 'node:util';

import {
  assertG10cG07PausedTicketOwner,
  type G10cG07PausedTicketOwner,
  type G10cG07PausedTicketTerminal,
} from './g10c-g07-recovery-bridge.js';

/** A monotonic clock owned by composition, never supplied by an HTTP caller. */
export interface G10cRecoverySchedulerClock {
  nowMs(): number;
}

/** Injectable only so unit tests can deterministically advance the cadence. */
export interface G10cRecoverySchedulerTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface G10cRecoverySchedulerOptions {
  readonly clock: G10cRecoverySchedulerClock;
  readonly timer: G10cRecoverySchedulerTimer;
  readonly pausedTickets: G10cG07PausedTicketOwner;
}

export type G10cRecoverySchedulerState = 'IDLE' | 'ORIGINAL_COMMIT' | 'CANONICAL_READ' | 'FAILED_CLOSED';

export interface G10cRecoveryScheduler {
  /** Start work if a paused G10c writer is waiting.  Repeated wakes coalesce. */
  wake(): void;
  snapshot(): Readonly<{
    readonly state: G10cRecoverySchedulerState;
    readonly timerArmed: boolean;
  }>;
}

export type G10cRecoverySchedulerErrorCode =
  | 'INVALID_OPTIONS'
  | 'CLOCK_INVALID'
  | 'CLOCK_ROLLBACK'
  | 'RECOGNITION_NOT_SUPPORTED'
  | 'CONFIRMATION_INTEGRITY';

export class G10cRecoverySchedulerError extends Error {
  constructor(
    readonly code: G10cRecoverySchedulerErrorCode,
    message: string,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(message, options);
    this.name = 'G10cRecoverySchedulerError';
  }
}

const schedulers = new WeakSet<object>();

/**
 * Serial, composition-internal driver for a retained post-commit-unknown
 * writer.  It knows no G08 business callback, Mongo session, request body,
 * or canonical image.  Its only effects are the existing opaque commit/read
 * commands and one terminal bridge decision.
 *
 * A canonical reader that cannot prove the result is deliberately retried
 * through the ledger's prescribed alternating cadence.  The first following
 * original sender that cannot obtain a slot/window is an integrity terminal:
 * fail closed retains the runtime issued-persistence lease.
 */
export function createG10cRecoveryScheduler(
  options: G10cRecoverySchedulerOptions,
): G10cRecoveryScheduler {
  assertOptions(options);
  const clockNow = options.clock.nowMs.bind(options.clock);
  const schedule = options.timer.setTimeout.bind(options.timer);
  const unschedule = options.timer.clearTimeout.bind(options.timer);
  const pausedTickets = options.pausedTickets;

  let lastNowMs: number | null = null;
  let state: G10cRecoverySchedulerState = 'IDLE';
  let terminal: G10cG07PausedTicketTerminal | null = null;
  let timerHandle: unknown;
  let timerArmed = false;
  let driving = false;

  const readNow = (): number => {
    let nowMs: unknown;
    try {
      nowMs = clockNow();
    } catch (error: unknown) {
      throw new G10cRecoverySchedulerError('CLOCK_INVALID', 'G10c recovery scheduler clock failed', { cause: error });
    }
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) {
      throw new G10cRecoverySchedulerError('CLOCK_INVALID', 'G10c recovery scheduler clock is invalid');
    }
    if (lastNowMs !== null && nowMs < lastNowMs) {
      throw new G10cRecoverySchedulerError('CLOCK_ROLLBACK', 'G10c recovery scheduler clock rolled back');
    }
    lastNowMs = nowMs;
    return nowMs;
  };

  const clearTimer = (): void => {
    if (!timerArmed) return;
    timerArmed = false;
    try { unschedule(timerHandle); } catch { /* already terminally decided */ }
  };

  const failClosed = (error: unknown): void => {
    clearTimer();
    const current = terminal;
    terminal = null;
    driving = false;
    state = 'FAILED_CLOSED';
    if (current === null) return;
    try {
      current.failClosed(error);
    } catch {
      // A terminal capability may already have fenced its owner.  Never
      // resume work or replace the first reason with a best-effort error.
    }
  };

  const completeConfirmed = async (): Promise<void> => {
    const current = terminal;
    if (current === null) {
      throw new G10cRecoverySchedulerError('CONFIRMATION_INTEGRITY', 'G10c recovery has no claimed terminal');
    }
    await current.confirmedPersisted();
    terminal = null;
    driving = false;
    state = 'IDLE';
    wake();
  };

  const arm = (delayMs: 1_000 | 2_000, nextState: 'ORIGINAL_COMMIT' | 'CANONICAL_READ'): void => {
    if (terminal === null || timerArmed || state === 'FAILED_CLOSED') {
      throw new G10cRecoverySchedulerError('CONFIRMATION_INTEGRITY', 'G10c recovery timer cannot be armed');
    }
    readNow();
    state = nextState;
    try {
      timerHandle = schedule(() => {
        timerArmed = false;
        timerHandle = undefined;
        void drive().catch((error: unknown) => failClosed(error));
      }, delayMs);
      timerArmed = true;
    } catch (error: unknown) {
      throw new G10cRecoverySchedulerError('CONFIRMATION_INTEGRITY', 'G10c recovery timer failed to arm', { cause: error });
    }
  };

  const claimNext = (): boolean => {
    const tickets = pausedTickets.pending();
    const ticket = tickets[0];
    if (ticket === undefined) return false;
    terminal = pausedTickets.claim(ticket);
    if (terminal.kind === 'RECOGNITION') {
      throw new G10cRecoverySchedulerError(
        'RECOGNITION_NOT_SUPPORTED',
        'G10c recognition canonical recovery requires a persisted event projection',
      );
    }
    state = 'ORIGINAL_COMMIT';
    return true;
  };

  const drive = async (): Promise<void> => {
    if (driving || timerArmed || state === 'FAILED_CLOSED') return;
    driving = true;
    try {
      readNow();
      if (terminal === null && !claimNext()) {
        driving = false;
        state = 'IDLE';
        return;
      }
      const current = terminal;
      if (current === null) {
        throw new G10cRecoverySchedulerError('CONFIRMATION_INTEGRITY', 'G10c recovery claim disappeared');
      }
      if (state === 'ORIGINAL_COMMIT') {
        const result = await current.createOriginalCommitTerminator().attemptOriginalCommit();
        if (result.delivery === 'COMMIT_CONFIRMED') {
          await completeConfirmed();
          return;
        }
        driving = false;
        // Only the first rejected original sender gets the one-second
        // canonical check.  The ledger prescribes two-second spacing for
        // every later alternating confirmation command.
        arm(result.attempt === 0 ? 1_000 : 2_000, 'CANONICAL_READ');
        return;
      }
      if (state === 'CANONICAL_READ') {
        const result = await current.createCanonicalConfirmationReader().confirmCanonicalRead();
        if (result.result === 'MATCHED') {
          await completeConfirmed();
          return;
        }
        // The read itself has settled the ledger as STILL_UNKNOWN.  The
        // next prescribed command is a later original sender, never CRUD.
        driving = false;
        arm(2_000, 'ORIGINAL_COMMIT');
        return;
      }
      throw new G10cRecoverySchedulerError('CONFIRMATION_INTEGRITY', 'G10c recovery state is invalid');
    } catch (error: unknown) {
      failClosed(error);
    }
  };

  const wake = (): void => {
    if (state === 'FAILED_CLOSED' || terminal !== null || timerArmed || driving) return;
    void drive().catch((error: unknown) => failClosed(error));
  };

  const scheduler: G10cRecoveryScheduler = Object.freeze({
    wake,
    snapshot: (): Readonly<{ readonly state: G10cRecoverySchedulerState; readonly timerArmed: boolean }> =>
      Object.freeze({ state, timerArmed }),
  });
  schedulers.add(scheduler as object);
  return scheduler;
}

export function assertG10cRecoveryScheduler(value: unknown): asserts value is G10cRecoveryScheduler {
  if (!isObject(value) || !schedulers.has(value)) {
    throw new TypeError('G10c recovery scheduler is not trusted');
  }
}

function assertOptions(options: unknown): asserts options is G10cRecoverySchedulerOptions {
  if (!isPlainRecord(options)) {
    throw new G10cRecoverySchedulerError('INVALID_OPTIONS', 'G10c recovery scheduler options are invalid');
  }
  const record = options as Readonly<Record<string, unknown>>;
  const clock = record.clock;
  const timer = record.timer;
  if (!isObject(clock) || typeof (clock as G10cRecoverySchedulerClock).nowMs !== 'function'
    || !isObject(timer)
    || typeof (timer as G10cRecoverySchedulerTimer).setTimeout !== 'function'
    || typeof (timer as G10cRecoverySchedulerTimer).clearTimeout !== 'function') {
    throw new G10cRecoverySchedulerError('INVALID_OPTIONS', 'G10c recovery scheduler options are invalid');
  }
  assertG10cG07PausedTicketOwner(record.pausedTickets);
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value)
    && !Array.isArray(value)
    && !utilTypes.isProxy(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
