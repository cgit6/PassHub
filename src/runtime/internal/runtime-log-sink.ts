import { encodeRuntimeLogRecord, type RuntimeLogRecord } from './runtime-log-schema.js';

/**
 * The persistence boundary deliberately has no filesystem knowledge.  A later
 * adapter may provide one, but this sink owns the bounded asynchronous FIFO
 * and its failure semantics.
 */
export interface RuntimeLogDriver {
  write(line: string): Promise<void>;
}

export const RUNTIME_LOG_WAITING_CAPACITY = 128;
export const RUNTIME_LOG_MAX_SETTLE_MS = 2_000;

export type RuntimeLogSinkStatus = 'HEALTHY' | 'LOGGING_DEGRADED';

export interface RuntimeLogSinkSnapshot {
  readonly status: RuntimeLogSinkStatus;
  readonly droppedCount: number;
  readonly waiting: number;
  readonly writing: boolean;
  readonly closed: boolean;
}

export interface RuntimeLogSinkOptions {
  /** Test-only shortening is allowed, but never a deadline above the contract. */
  readonly settleTimeoutMs?: number;
}

/**
 * Private composition primitive.  `append` never awaits storage and never
 * throws: logging must not change a business/control decision.  The queue
 * capacity counts only waiting lines; the line handed to the driver is not in
 * that capacity.
 */
export class RuntimeLogSink {
  private readonly queue: string[] = [];
  private readonly settleTimeoutMs: number;
  private writing = false;
  private closed = false;
  private abandoned = false;
  private degraded = false;
  private droppedCount = 0;
  private generation = 0;
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly driver: RuntimeLogDriver, options: RuntimeLogSinkOptions = {}) {
    const timeout = options.settleTimeoutMs ?? RUNTIME_LOG_MAX_SETTLE_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > RUNTIME_LOG_MAX_SETTLE_MS) {
      throw new RangeError('settleTimeoutMs');
    }
    this.settleTimeoutMs = timeout;
  }

  /** Returns false only when the line was deliberately not accepted. */
  append(record: RuntimeLogRecord): boolean {
    // Closing is an explicit lifecycle refusal, not a logging fault.  In
    // contrast, a timed-out abandoned worker cannot safely resume I/O, so an
    // attempted append there is a dropped newest record.
    if (this.closed) return false;
    if (this.abandoned || this.queue.length >= RUNTIME_LOG_WAITING_CAPACITY) {
      this.drop();
      return false;
    }
    let line: string;
    try {
      // Re-encode at the sink boundary; structural casts cannot bypass A10.1.
      line = encodeRuntimeLogRecord(record);
    } catch {
      this.drop();
      return false;
    }
    this.queue.push(line);
    this.startWorker();
    return true;
  }

  snapshot(): RuntimeLogSinkSnapshot {
    return Object.freeze({
      status: this.degraded ? 'LOGGING_DEGRADED' : 'HEALTHY',
      droppedCount: this.droppedCount,
      waiting: this.queue.length,
      writing: this.writing,
      closed: this.closed,
    });
  }

  /** Bounded observation only; it never propagates logging failures. */
  async flush(): Promise<void> {
    if (this.isIdle()) return;
    await this.waitForIdleWithinDeadline();
  }

  /** New appends are rejected immediately; already accepted work gets <=2s. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.isIdle()) return;
    await this.waitForIdleWithinDeadline();
  }

  private startWorker(): void {
    if (this.writing || this.abandoned || this.queue.length === 0) return;
    const line = this.queue.shift();
    if (line === undefined) return;
    this.writing = true;
    const generation = this.generation;
    void this.writeOne(line, generation);
  }

  private async writeOne(line: string, generation: number): Promise<void> {
    try {
      // Calling through a promise boundary prevents a synchronous driver throw
      // from re-entering state transitions while append is still on its stack.
      await Promise.resolve().then(() => this.driver.write(line));
    } catch {
      if (generation === this.generation) this.failDriver();
      return;
    }
    if (generation !== this.generation) return;
    this.writing = false;
    this.startWorker();
    this.notifyIfIdle();
  }

  private failDriver(): void {
    // The line handed to the driver has not been durably written either.  It
    // is no longer in `queue`, so account for it explicitly before discarding
    // the still-waiting tail.  A late callback is fenced by generation (or,
    // for this failure path, cannot reach this method a second time).
    const failedInFlight = this.writing;
    this.writing = false;
    // Once a driver has rejected a line, reopening the same opaque driver
    // would make recovery ordering unknowable.  Keep the sink as a degraded
    // black hole for this process; append still remains non-throwing.
    this.abandoned = true;
    this.markDegraded();
    if (failedInFlight) this.drop();
    this.dropQueued();
    this.notifyIfIdle();
  }

  private async waitForIdleWithinDeadline(): Promise<void> {
    let resolveIdle: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
      this.idleWaiters.add(resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'TIMED_OUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMED_OUT'), this.settleTimeoutMs);
    });
    const result = await Promise.race([idle.then(() => 'IDLE' as const), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (resolveIdle !== undefined) this.idleWaiters.delete(resolveIdle);
    if (result === 'TIMED_OUT') this.invalidateTimedOutWorker();
  }

  private invalidateTimedOutWorker(): void {
    // A driver write cannot be force-cancelled.  Starting another physical
    // write would violate FIFO/single-worker ordering, so this sink becomes a
    // safe degraded black hole.  Late completion is ignored by generation.
    const timedOutInFlight = this.writing;
    this.generation += 1;
    this.abandoned = true;
    this.writing = false;
    this.markDegraded();
    if (timedOutInFlight) this.drop();
    this.dropQueued();
    this.resolveIdleWaiters();
  }

  private isIdle(): boolean { return !this.writing && this.queue.length === 0; }

  private notifyIfIdle(): void {
    if (this.isIdle()) this.resolveIdleWaiters();
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private dropQueued(): void {
    while (this.queue.length > 0) {
      this.queue.shift();
      this.drop();
    }
  }

  private drop(): void {
    this.markDegraded();
    if (this.droppedCount < Number.MAX_SAFE_INTEGER) this.droppedCount += 1;
  }

  private markDegraded(): void { this.degraded = true; }
}
