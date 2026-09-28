import {
  RUNTIME_LOG_WAITING_CAPACITY,
  RuntimeLogSink,
  type RuntimeLogDriver,
} from '../../src/runtime/internal/runtime-log-sink.js';
import {
  RUNTIME_LOG_SCHEMA_VERSION,
  createRuntimeLogRecord,
  type RuntimeLogRecord,
} from '../../src/runtime/internal/runtime-log-schema.js';
import * as publicApi from '../../src/index.js';
import * as publicCompositionApi from '../../src/composition/index.js';

const ids = {
  request: '11111111-1111-4111-8111-111111111111',
  epoch: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
} as const;

function record(index = 0): RuntimeLogRecord {
  return createRuntimeLogRecord({
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION,
    timestamp: `2026-09-28T00:00:0${index}.000Z`,
    kind: 'RUNTIME', code: 'REQUEST_ACCEPTED', requestUUID: ids.request,
    operationUUID: null, datasetEpoch: ids.epoch, processRunId: ids.run, ownerRef: null,
    route: 'QUERY', phase: 'INGRESS', round: null, group: null, budgetRemainingMs: null,
    budgetRemainingUnits: null, commandName: null, driverRequestId: null,
    requestControlId: null, controlId: null, revision: null,
  });
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => { resolve = resolveFn; reject = rejectFn; });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }
async function delay(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe('G10a A10.2 private bounded runtime log sink', () => {
  test('is private, has no filesystem/control/producer wiring, and uses the A10.1 encoder', () => {
    for (const api of [publicApi, publicCompositionApi]) expect(Object.keys(api).filter((key) => /runtime.*log|log.*sink|logger/iu.test(key))).toEqual([]);
    const source = require('node:fs').readFileSync('src/runtime/internal/runtime-log-sink.ts', 'utf8') as string;
    expect(source).toContain("encodeRuntimeLogRecord(record)");
    expect(source).not.toMatch(/node:fs|rotation|runtimecontrol|g07|g08|mongodb|socket|logs_read/iu);
  });

  test('append is nonblocking and one worker preserves FIFO while waiting capacity excludes the current write', async () => {
    const first = deferred<void>();
    const lines: string[] = [];
    const driver: RuntimeLogDriver = { write: jest.fn((line: string) => { lines.push(line); return first.promise; }) };
    const sink = new RuntimeLogSink(driver);

    expect(sink.append(record(0))).toBe(true);
    for (let index = 1; index <= RUNTIME_LOG_WAITING_CAPACITY; index += 1) expect(sink.append(record(index % 10))).toBe(true);
    expect(sink.snapshot()).toMatchObject({ waiting: RUNTIME_LOG_WAITING_CAPACITY, writing: true, status: 'HEALTHY' });
    expect(sink.append(record(0))).toBe(false);
    expect(sink.snapshot()).toMatchObject({ waiting: RUNTIME_LOG_WAITING_CAPACITY, writing: true, status: 'LOGGING_DEGRADED', droppedCount: 1 });

    await tick();
    expect(driver.write).toHaveBeenCalledTimes(1);
    first.resolve();
    await tick();
    // The first completion starts exactly one next write; it never fan-outs.
    expect(driver.write).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(2);
  });

  test('encoder failure drops newest and cannot throw into a caller', () => {
    const sink = new RuntimeLogSink({ write: async () => undefined });
    const forged = { ...record(), timestamp: 'not-a-date' } as RuntimeLogRecord;
    expect(() => expect(sink.append(forged)).toBe(false)).not.toThrow();
    expect(sink.snapshot()).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1, waiting: 0, writing: false, closed: false });
  });

  test('synchronous driver throw drops queued work, becomes sticky degraded, and never invokes the driver again', async () => {
    const writes: string[] = [];
    const sink = new RuntimeLogSink({
      write: (line: string) => {
        writes.push(line);
        if (writes.length === 1) throw new Error('broken');
        return Promise.resolve();
      },
    });
    expect(sink.append(record(0))).toBe(true);
    expect(sink.append(record(1))).toBe(true);
    expect(sink.append(record(2))).toBe(true);
    await tick();
    expect(writes).toHaveLength(1);
    // The failed in-flight line and both queued lines are all lost.
    expect(sink.snapshot()).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 3, waiting: 0, writing: false, closed: false });
    // D184 makes write failure terminal for this best-effort sink.  A later
    // record is dropped newest; recovering by starting another physical
    // driver write would violate the sticky-degraded contract.
    expect(sink.append(record(3))).toBe(false);
    await tick();
    expect(writes).toHaveLength(1);
    expect(sink.snapshot().status).toBe('LOGGING_DEGRADED');
    expect(sink.snapshot().droppedCount).toBe(4);
  });

  test('asynchronous driver rejection drops the current queue and fences all later driver writes', async () => {
    const first = deferred<void>();
    const calls: string[] = [];
    const sink = new RuntimeLogSink({ write: jest.fn((line: string) => { calls.push(line); return first.promise; }) });
    sink.append(record(0)); sink.append(record(1)); sink.append(record(2));
    await tick();
    first.reject(new Error('write rejected'));
    await tick();
    expect(calls).toHaveLength(1);
    // Rejection loses the in-flight line as well as both queued lines.
    expect(sink.snapshot()).toMatchObject({ status: 'LOGGING_DEGRADED', droppedCount: 3, waiting: 0, writing: false });
    expect(sink.append(record(3))).toBe(false);
    await tick();
    expect(calls).toHaveLength(1);
    expect(sink.snapshot().droppedCount).toBe(4);
  });

  test('flush is bounded, invalidates a hung late write, drops pending records, and future appends are safely dropped', async () => {
    const held = deferred<void>();
    const calls: string[] = [];
    const sink = new RuntimeLogSink({ write: jest.fn((line: string) => { calls.push(line); return held.promise; }) }, { settleTimeoutMs: 5 });
    sink.append(record(0)); sink.append(record(1));
    await tick();
    await sink.flush();
    // Timeout loses the still in-flight line and the queued line exactly once.
    expect(sink.snapshot()).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 2, waiting: 0, writing: false, closed: false });
    held.resolve();
    await tick();
    expect(calls).toHaveLength(1);
    expect(sink.append(record(2))).toBe(false);
    expect(sink.snapshot().droppedCount).toBe(3);
  });

  test('close timeout accounts for the in-flight record once and fences its late completion', async () => {
    const held = deferred<void>();
    const calls: string[] = [];
    const sink = new RuntimeLogSink({ write: jest.fn((line: string) => { calls.push(line); return held.promise; }) }, { settleTimeoutMs: 5 });
    expect(sink.append(record(0))).toBe(true);
    await tick();

    await sink.close();
    expect(sink.snapshot()).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1, waiting: 0, writing: false, closed: true });
    held.resolve();
    await tick();
    expect(calls).toHaveLength(1);
    expect(sink.snapshot()).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1, waiting: 0, writing: false, closed: true });
  });

  test('close rejects new work immediately while allowing an accepted write to settle within the bounded deadline', async () => {
    const held = deferred<void>();
    const sink = new RuntimeLogSink({ write: () => held.promise }, { settleTimeoutMs: 50 });
    expect(sink.append(record())).toBe(true);
    await tick();
    const close = sink.close();
    expect(sink.append(record(1))).toBe(false);
    held.resolve();
    await close;
    expect(sink.snapshot()).toEqual({ status: 'HEALTHY', droppedCount: 0, waiting: 0, writing: false, closed: true });
  });

  test('flush succeeds when idle and never waits longer than the configured <=2 second bound', async () => {
    const sink = new RuntimeLogSink({ write: async () => undefined }, { settleTimeoutMs: 10 });
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(() => new RuntimeLogSink({ write: async () => undefined }, { settleTimeoutMs: 2_001 })).toThrow(new RangeError('settleTimeoutMs'));
    await delay(1);
  });
});
