import {
  RUNTIME_LOG_MAX_BYTES,
  RUNTIME_LOG_SCHEMA_VERSION,
  RuntimeLogSchemaError,
  createRuntimeLogRecord,
  encodeRuntimeLogRecord,
  validateRuntimeLogRecord,
  type RuntimeLogCode,
  type RuntimeLogRecord,
} from '../../src/runtime/internal/runtime-log-schema.js';
import * as publicApi from '../../src/index.js';
import * as publicCompositionApi from '../../src/composition/index.js';
import { readFileSync } from 'node:fs';

const uuid = {
  request: '11111111-1111-4111-8111-111111111111',
  operation: '22222222-2222-4222-8222-222222222222',
  epoch: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
  owner: '55555555-5555-4555-8555-555555555555',
  requestControl: '66666666-6666-4666-8666-666666666666',
  control: '77777777-7777-4777-8777-777777777777',
} as const;

const codes: readonly RuntimeLogCode[] = [
  'REQUEST_ACCEPTED', 'OPERATION_REGISTERED', 'OPERATION_BLOCKED', 'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
  'DRIVER_STARTED', 'DRIVER_SUCCEEDED', 'DRIVER_FAILED', 'HOLD_ACKNOWLEDGED', 'RELEASE_ACKNOWLEDGED', 'DRAIN_STARTED', 'DRAINED', 'DRAIN_NOT_DRAINED', 'CONTROL_REJECTED',
];

function recordFor(code: RuntimeLogCode): RuntimeLogRecord {
  const record: RuntimeLogRecord = {
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION, timestamp: '2026-09-28T00:00:00.000Z', kind: 'RUNTIME', code,
    requestUUID: null, operationUUID: null, datasetEpoch: uuid.epoch, processRunId: uuid.run, ownerRef: null,
    route: null, phase: null, round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
    commandName: null, driverRequestId: null, requestControlId: null, controlId: null, revision: null,
  };
  if (code === 'REQUEST_ACCEPTED') return { ...record, route: 'QUERY', phase: 'INGRESS', requestUUID: uuid.request };
  if (code === 'OPERATION_REGISTERED' || code === 'OPERATION_BLOCKED') return {
    ...record, route: 'RECOGNITION', phase: 'ADMISSION', requestUUID: uuid.request, operationUUID: uuid.operation, ownerRef: uuid.owner,
  };
  if (code.startsWith('BUSINESS_STEP_')) return {
    ...record, route: 'RECOGNITION', phase: 'PERSISTENCE', requestUUID: uuid.request, operationUUID: uuid.operation, ownerRef: uuid.owner,
    round: 1, group: 'EXECUTION', budgetRemainingMs: 15_000, budgetRemainingUnits: 7,
  };
  if (code.startsWith('DRIVER_')) return {
    ...record, kind: 'DRIVER', route: 'QUERY', phase: 'DRIVER', requestUUID: uuid.request, commandName: 'find', driverRequestId: 0,
  };
  return {
    ...record, kind: 'CONTROL', route: 'CONTROL', phase: 'CONTROL', requestControlId: uuid.requestControl, revision: '0',
    controlId: code === 'CONTROL_REJECTED' ? null : uuid.control,
  };
}

describe('G10a A10.1 private runtime log schema', () => {
  test('is not exposed by public barrels and has no I/O or control wiring dependencies', () => {
    for (const api of [publicApi, publicCompositionApi]) expect(Object.keys(api).filter((key) => /runtime.*log|log.*schema|logger/iu.test(key))).toEqual([]);
    const source = readFileSync('src/runtime/internal/runtime-log-schema.ts', 'utf8');
    expect([...source.matchAll(/^import .* from ['"]([^'"]+)['"];$/gmu)].map((match) => match[1])).toEqual(['node:buffer', 'node:util']);
    expect(source).not.toMatch(/fs|queue|timer|runtimecontrol|socket|logs_read|g07|g08|mongodb/iu);
  });

  test.each(codes)('accepts exact closed matrix row %s and produces frozen bounded NDJSON', (code) => {
    const source = recordFor(code);
    const captured = createRuntimeLogRecord(source);
    expect(captured).toEqual(source);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Reflect.ownKeys(captured)).toEqual([
      'schemaVersion', 'timestamp', 'kind', 'code', 'requestUUID', 'operationUUID', 'datasetEpoch', 'processRunId', 'ownerRef',
      'route', 'phase', 'round', 'group', 'budgetRemainingMs', 'budgetRemainingUnits', 'commandName', 'driverRequestId', 'requestControlId', 'controlId', 'revision',
    ]);
    const line = encodeRuntimeLogRecord(captured);
    expect(line.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(RUNTIME_LOG_MAX_BYTES);
    expect(JSON.parse(line)).toEqual(source);
    expect(validateRuntimeLogRecord(JSON.parse(line))).toEqual(source);
  });

  test('rejects each matrix cross-over and inappropriate non-null field', () => {
    const cases: readonly RuntimeLogRecord[] = [
      { ...recordFor('REQUEST_ACCEPTED'), route: 'CONTROL' },
      { ...recordFor('REQUEST_ACCEPTED'), operationUUID: uuid.operation },
      { ...recordFor('OPERATION_REGISTERED'), phase: 'PERSISTENCE' },
      { ...recordFor('BUSINESS_STEP_ISSUED'), budgetRemainingUnits: null },
      { ...recordFor('BUSINESS_STEP_ISSUED'), commandName: 'find' },
      { ...recordFor('DRIVER_STARTED'), route: 'CONTROL' },
      { ...recordFor('DRIVER_STARTED'), operationUUID: uuid.operation },
      { ...recordFor('HOLD_ACKNOWLEDGED'), controlId: null },
      { ...recordFor('CONTROL_REJECTED'), controlId: uuid.control },
      { ...recordFor('DRAINED'), requestUUID: uuid.request },
    ];
    for (const candidate of cases) expect(() => createRuntimeLogRecord(candidate)).toThrow(new RuntimeLogSchemaError('INVALID_RECORD'));
  });

  test('enforces canonical UUIDs, timestamp, decimal revision, enums, and numeric bounds', () => {
    const original = recordFor('BUSINESS_STEP_REGISTERED');
    const invalids = [
      { ...original, datasetEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() },
      { ...original, timestamp: '2026-09-28T00:00:00Z' },
      { ...original, revision: '00' },
      { ...original, round: 4 },
      { ...original, group: 'OTHER' },
      { ...original, budgetRemainingMs: 15_001 },
      { ...original, budgetRemainingUnits: -1 },
      { ...recordFor('DRIVER_FAILED'), driverRequestId: Number.MAX_SAFE_INTEGER + 1 },
      { ...original, code: 'NOT_A_CODE' },
    ];
    for (const candidate of invalids) expect(() => createRuntimeLogRecord(candidate)).toThrow(new RuntimeLogSchemaError('INVALID_RECORD'));
  });

  test('rejects Proxy/accessor/extra/symbol/non-enumerable/foreign-prototype/toJSON without invoking hostile getters', () => {
    const valid = recordFor('REQUEST_ACCEPTED');
    let getterCalls = 0;
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'timestamp', { enumerable: true, get: () => { getterCalls += 1; return valid.timestamp; } });
    const extra = { ...valid, extra: true };
    const symbol = { ...valid, [Symbol('hidden')]: true };
    const nonEnumerable = { ...valid } as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'route', { enumerable: false, value: valid.route });
    const foreign = Object.assign(Object.create(null), valid);
    const withToJson = { ...valid, toJSON: () => valid };
    const proxy = new Proxy(valid, { get: () => { throw new Error('must not invoke'); } });
    for (const candidate of [accessor, extra, symbol, nonEnumerable, foreign, withToJson, proxy]) {
      expect(() => createRuntimeLogRecord(candidate)).toThrow(new RuntimeLogSchemaError('INVALID_RECORD'));
    }
    expect(getterCalls).toBe(0);
  });

  test('copies input data, so later source mutation cannot alter the frozen record or encoded bytes', () => {
    const source = { ...recordFor('DRIVER_SUCCEEDED') };
    const captured = createRuntimeLogRecord(source);
    const before = encodeRuntimeLogRecord(captured);
    source.code = 'DRIVER_FAILED';
    expect(captured.code).toBe('DRIVER_SUCCEEDED');
    expect(encodeRuntimeLogRecord(captured)).toBe(before);
    expect(() => encodeRuntimeLogRecord({ ...captured, timestamp: 'not-a-time' } as RuntimeLogRecord)).toThrow(new RuntimeLogSchemaError('INVALID_RECORD'));
  });

  test('fails closed on hostile values passed directly to encode, without invoking getters or toJSON', () => {
    const valid = recordFor('REQUEST_ACCEPTED');
    let getterCalls = 0;
    let toJsonCalls = 0;
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'timestamp', {
      enumerable: true,
      get: () => { getterCalls += 1; return valid.timestamp; },
    });
    const proxy = new Proxy(valid, { get: () => { throw new Error('must not invoke'); } });
    const withToJson = Object.assign(Object.create(Object.prototype), valid) as Record<string, unknown>;
    Object.defineProperty(withToJson, 'toJSON', {
      enumerable: false,
      value: () => { toJsonCalls += 1; return valid; },
    });

    for (const candidate of [accessor, proxy, withToJson]) {
      expect(() => encodeRuntimeLogRecord(candidate as RuntimeLogRecord)).toThrow(new RuntimeLogSchemaError('INVALID_RECORD'));
    }
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
  });

  test('enforces every numeric boundary and rejects an otherwise valid record whose canonical line is oversized', () => {
    const business = recordFor('BUSINESS_STEP_SETTLED');
    const driver = recordFor('DRIVER_SUCCEEDED');
    const validAtLimits = [
      { ...business, round: 3, budgetRemainingMs: 0, budgetRemainingUnits: 0 },
      { ...business, round: 1, budgetRemainingMs: 15_000, budgetRemainingUnits: 7 },
      { ...driver, driverRequestId: Number.MAX_SAFE_INTEGER },
    ];
    for (const candidate of validAtLimits) expect(() => createRuntimeLogRecord(candidate)).not.toThrow();

    const invalid = [
      { ...business, round: 0 },
      { ...business, round: 3.5 },
      { ...business, budgetRemainingMs: -1 },
      { ...business, budgetRemainingMs: 0.5 },
      { ...business, budgetRemainingUnits: 8 },
      { ...business, budgetRemainingUnits: 0.5 },
      { ...driver, driverRequestId: -1 },
      { ...driver, driverRequestId: 0.5 },
    ];
    for (const candidate of invalid) expect(() => createRuntimeLogRecord(candidate)).toThrow(new RuntimeLogSchemaError('INVALID_RECORD'));

    const oversized = { ...recordFor('HOLD_ACKNOWLEDGED'), revision: `1${'0'.repeat(RUNTIME_LOG_MAX_BYTES)}` };
    expect(() => createRuntimeLogRecord(oversized)).toThrow(new RuntimeLogSchemaError('OVERSIZE'));
    expect(() => encodeRuntimeLogRecord(oversized)).toThrow(new RuntimeLogSchemaError('OVERSIZE'));
  });

  test('rejects inherited, duplicate-shaped, missing, and reordered-untrusted records while canonical order stays stable', () => {
    const valid = recordFor('DRIVER_STARTED');
    const inherited = Object.create(valid) as RuntimeLogRecord;
    const missing = { ...valid } as { -readonly [K in keyof RuntimeLogRecord]?: RuntimeLogRecord[K] };
    delete missing.commandName;
    const nonWritable = { ...valid } as Record<string, unknown>;
    Object.defineProperty(nonWritable, 'code', { enumerable: true, writable: false, configurable: false, value: valid.code });
    const reordered = Object.fromEntries([...Reflect.ownKeys(valid)].reverse().map((key) => [key, (valid as unknown as Record<PropertyKey, unknown>)[key]]));

    for (const candidate of [inherited, missing]) {
      expect(() => validateRuntimeLogRecord(candidate)).toThrow(new RuntimeLogSchemaError('INVALID_RECORD'));
    }
    expect(encodeRuntimeLogRecord(nonWritable as unknown as RuntimeLogRecord)).toBe(encodeRuntimeLogRecord(valid));
    expect(encodeRuntimeLogRecord(reordered as unknown as RuntimeLogRecord)).toBe(encodeRuntimeLogRecord(valid));
  });
});
