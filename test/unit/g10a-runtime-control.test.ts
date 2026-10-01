import {
  assertRuntimeControl,
  createRuntimeControl,
  createRuntimeIdentityIssuer,
  RuntimeControlError,
  type RuntimeControl,
} from '../../src/runtime/internal/runtime-control.js';
import { RuntimeLogSink } from '../../src/runtime/internal/runtime-log-sink.js';
import { RUNTIME_LOG_SCHEMA_VERSION, createRuntimeLogRecord } from '../../src/runtime/internal/runtime-log-schema.js';
import * as publicApi from '../../src/index.js';
import * as publicCompositionApi from '../../src/composition/index.js';
import { readFileSync } from 'node:fs';
import { createWriteOperationCoordinatorBundle } from '../../src/access/application/internal/write-operation-coordinator.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const owner = '55555555-5555-4555-8555-555555555555';
let controlIdOrdinal = 6;
const runtimeObservation = Object.freeze({ clock: Object.freeze({ nowMs: () => 0 }), awaitObservation: () => undefined });

function nextControlId(): string {
  const value = `${String(controlIdOrdinal).padStart(8, '0')}-6666-4666-8666-666666666666`;
  controlIdOrdinal += 1;
  return value;
}

function makeControl(): { control: RuntimeControl; issuer: ReturnType<typeof createRuntimeIdentityIssuer> } {
  const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
  return {
    issuer,
    control: createRuntimeControl({
      epoch,
      run,
      identityIssuer: issuer,
      ...runtimeObservation,
      controlIdFactory: nextControlId,
    }),
  };
}

function base(requestControlId = request, expectedRevision = '0') {
  return { requestControlId, epoch, run, expectedRevision } as const;
}
function drainBase(requestControlId = request, expectedRevision = '0', timeoutMs = 30, signal?: AbortSignal) {
  return { ...base(requestControlId, expectedRevision), timeoutMs, ...(signal === undefined ? {} : { signal }) } as const;
}

function runtimeLogRecord() {
  return createRuntimeLogRecord({
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION,
    timestamp: '2026-09-29T00:00:00.000Z',
    kind: 'RUNTIME', code: 'REQUEST_ACCEPTED',
    requestUUID: request, operationUUID: null, datasetEpoch: epoch, processRunId: run, ownerRef: null,
    route: 'QUERY', phase: 'INGRESS', round: null, group: null,
    budgetRemainingMs: null, budgetRemainingUnits: null, commandName: null, driverRequestId: null,
    requestControlId: null, controlId: null, revision: null,
  });
}

async function microtasks(): Promise<void> {
  // The sink calls a driver through one promise boundary, then observes its
  // rejection through a second.  Keep this deterministic without fake timers.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('G10a A1 runtime identity/control core', () => {
  test('remains absent from both public barrels and uses only its private runtime log source', () => {
    for (const api of [publicApi, publicCompositionApi]) {
      expect(Object.keys(api).filter((key) => /runtime|control|identity|operationtoken/iu.test(key))).toEqual([]);
    }
    const source = readFileSync('src/runtime/internal/runtime-control.ts', 'utf8');
    const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"];$/gmu)].map((match) => match[1]);
    expect(imports).toEqual(['node:crypto', 'node:util', './runtime-log-schema.js', './runtime-log-sink.js']);
    expect(source).not.toMatch(/socket|g07|mongodb|infrastructure/iu);
  });

  test('captures identity facts and emits exact frozen snapshot with decimal revision', () => {
    const { control, issuer } = makeControl();
    const token = issuer.issueBusinessToken({ operationUUID: operation, ownerRef: owner });
    const identity = issuer.issue({ requestUUID: request, operationToken: token, route: 'RECOGNITION' });
    expect(issuer.read(identity)).toEqual({ requestUUID: request, operationUUID: operation, datasetEpoch: epoch, processRunId: run, ownerRef: owner, route: 'RECOGNITION' });
    const snapshot = control.snapshot();
    expect(snapshot).toEqual({
      epoch, run, revision: '0', phase: 'RUNNING',
      manual: { active: false, controlId: null },
      maintenance: { active: false, controlId: null, outcome: null },
      writers: { provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 0 },
      issuedPersistence: 0, activeQueryReads: 0, registryUnknown: 0,
      logging: { status: 'HEALTHY', droppedCount: 0 },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.manual)).toBe(true);
    expect(Object.isFrozen(snapshot.maintenance)).toBe(true);
    expect(Object.isFrozen(snapshot.writers)).toBe(true);
    expect(Object.isFrozen(snapshot.logging)).toBe(true);
    expect(Object.keys(snapshot)).toEqual(['epoch', 'run', 'revision', 'phase', 'manual', 'maintenance', 'writers', 'issuedPersistence', 'activeQueryReads', 'registryUnknown', 'logging']);
  });

  test('accepts pushed log degradation after composition, then STATUS/HOLD/RELEASE use only the cached health', async () => {
    const sink = new RuntimeLogSink({ write: async () => { throw new Error('deterministic logging failure'); } });
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: issuer, ...runtimeObservation, controlIdFactory: nextControlId, runtimeLogSink: sink,
    });
    expect(control.snapshot().logging).toEqual({ status: 'HEALTHY', droppedCount: 0 });

    // The sink is healthy when composed, then its asynchronous driver rejects
    // one accepted record.  The published update, not any later snapshot pull,
    // must make RuntimeControl report the sticky degradation and its drop.
    expect(sink.append(runtimeLogRecord())).toBe(true);
    await microtasks();
    expect(control.snapshot().logging).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1 });

    // A later hostile replacement cannot be reached by STATUS/HOLD/RELEASE.
    Object.defineProperty(sink, 'snapshot', { configurable: true, value: (): never => { throw new Error('must not be pulled'); } });
    expect(control.snapshot().logging).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1 }); // STATUS
    const held = control.hold(base()); // HOLD
    expect(held.outcome).toBe('HELD');
    expect(held.snapshot.logging).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1 });
    const released = control.release({
      ...base('66666666-6666-4666-8666-666666666666', held.revision),
      controlId: held.controlId as string,
    }); // RELEASE
    expect(released.outcome).toBe('RELEASED');
    expect(released.snapshot.logging).toEqual({ status: 'LOGGING_DEGRADED', droppedCount: 1 });
  });

  test('rejects foreign/forged identity issuer and control capabilities', () => {
    const first = makeControl();
    const foreign = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const foreignToken = foreign.issueBusinessToken({ operationUUID: operation, ownerRef: owner });
    const foreignIdentity = foreign.issue({ requestUUID: request, operationToken: foreignToken, route: 'RECOGNITION' });
    expect(() => first.issuer.issue({ requestUUID: request, operationToken: foreignToken, route: 'RECOGNITION' })).toThrow(TypeError);
    expect(() => first.control.hold({ ...base(), epoch: run })).toThrow(new RuntimeControlError('STALE_EPOCH'));
    expect(() => first.issuer.read(foreignIdentity)).toThrow(TypeError);
    expect(() => assertRuntimeControl(Object.freeze({ snapshot: first.control.snapshot }))).toThrow(TypeError);
    expect(() => createRuntimeControl({ epoch, run, identityIssuer: Object.freeze({}) as never, ...runtimeObservation })).toThrow(TypeError);
    expect(() => createRuntimeControl({
      epoch, run, identityIssuer: first.issuer, ...runtimeObservation,
      runtimeLogSink: Object.freeze({ snapshot: () => ({}) }) as never,
    })).toThrow('runtime log sink is not trusted');
  });

  test('rejects forged, foreign, reused, and cross-route operation tokens and identities', () => {
    const first = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const second = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const token = first.issueBusinessToken({ operationUUID: operation, ownerRef: owner });
    const foreignToken = second.issueBusinessToken({ operationUUID: operation, ownerRef: owner });
    expect(() => first.issue({ requestUUID: request, operationToken: Object.freeze({}), route: 'RECOGNITION' })).toThrow(TypeError);
    expect(() => first.issue({ requestUUID: request, operationToken: foreignToken, route: 'RECOGNITION' })).toThrow(TypeError);
    expect(() => first.issue({ requestUUID: request, operationToken: token, operationUUID: null, ownerRef: null, route: 'QUERY' } as never)).toThrow(TypeError);

    const identity = first.issue({ requestUUID: request, operationToken: token, route: 'MANAGEMENT_CREATE' });
    expect(() => first.issue({ requestUUID: request, operationToken: token, route: 'MANAGEMENT_UPDATE' })).toThrow(TypeError);
    expect(() => second.read(identity)).toThrow(TypeError);
    expect(() => first.read(Object.freeze({}) as never)).toThrow(TypeError);
    const facts = first.read(identity);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Reflect.ownKeys(facts)).toEqual(['requestUUID', 'operationUUID', 'datasetEpoch', 'processRunId', 'ownerRef', 'route']);
  });

  test.each(['MANAGEMENT_CREATE', 'MANAGEMENT_UPDATE', 'MANAGEMENT_REVOKE', 'RECOGNITION'] as const)(
    'binds the exact business route discriminant %s',
    (route) => {
      const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
      const token = issuer.issueBusinessToken({ operationUUID: operation, ownerRef: owner });
      expect(issuer.read(issuer.issue({ requestUUID: request, operationToken: token, route }))).toEqual({
        requestUUID: request, operationUUID: operation, datasetEpoch: epoch, processRunId: run, ownerRef: owner, route,
      });
    },
  );

  test.each(['QUERY', 'LOGIN'] as const)('binds the exact read route discriminant %s with null business facts', (route) => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    expect(issuer.read(issuer.issue({ requestUUID: request, operationToken: null, operationUUID: null, ownerRef: null, route }))).toEqual({
      requestUUID: request, operationUUID: null, datasetEpoch: epoch, processRunId: run, ownerRef: null, route,
    });
  });

  test('uses strict identity route discriminants and rejects Proxy/accessor/extra ingress records', () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const token = issuer.issueBusinessToken({ operationUUID: operation, ownerRef: owner });
    expect(() => issuer.issue({ requestUUID: request, operationToken: null, route: 'RECOGNITION' })).toThrow(TypeError);
    expect(() => issuer.issue({ requestUUID: request, operationToken: token, operationUUID: operation, ownerRef: owner, route: 'RECOGNITION' } as never)).toThrow(TypeError);
    expect(() => issuer.issue({ requestUUID: request, operationToken: null, operationUUID: operation, ownerRef: owner, route: 'QUERY' } as never)).toThrow(TypeError);
    expect(() => issuer.issue({ requestUUID: request, operationToken: null, operationUUID: null, ownerRef: null, route: 'CONTROL' } as never)).toThrow(TypeError);
    const readIdentity = issuer.issue({ requestUUID: request, operationToken: null, operationUUID: null, ownerRef: null, route: 'QUERY' });
    expect(issuer.read(readIdentity)).toMatchObject({ operationUUID: null, ownerRef: null, route: 'QUERY' });
    issuer.issue({ requestUUID: request, operationToken: token, route: 'RECOGNITION' });
    expect(() => issuer.issue({ requestUUID: request, operationToken: token, route: 'RECOGNITION' })).toThrow(TypeError);

    const extra = { datasetEpoch: epoch, processRunId: run, extra: true };
    expect(() => createRuntimeIdentityIssuer(extra as never)).toThrow(TypeError);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'datasetEpoch', { enumerable: true, get: () => epoch });
    Object.defineProperty(accessor, 'processRunId', { enumerable: true, value: run });
    expect(() => createRuntimeIdentityIssuer(accessor as never)).toThrow(TypeError);
    expect(() => createRuntimeIdentityIssuer(new Proxy({ datasetEpoch: epoch, processRunId: run }, { get: () => { throw new Error('trap'); } }) as never)).toThrow(TypeError);

    const { control } = makeControl();
    expect(() => control.hold({ ...base(), extra: true } as never)).toThrow(TypeError);
    expect(() => control.hold(new Proxy(base(), { get: () => { throw new Error('trap'); } }) as never)).toThrow(TypeError);
  });

  test('rejects accessor, Proxy, symbol, non-plain prototype, and function records without invoking hostile traps', () => {
    let traps = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      datasetEpoch: { enumerable: true, get: () => { traps += 1; return epoch; } },
      processRunId: { enumerable: true, value: run },
    });
    expect(() => createRuntimeIdentityIssuer(accessor as never)).toThrow(TypeError);
    expect(traps).toBe(0);

    const proxy = new Proxy({ datasetEpoch: epoch, processRunId: run }, {
      get: () => { traps += 1; throw new Error('SECRET_CANARY'); },
      ownKeys: () => { traps += 1; throw new Error('SECRET_CANARY'); },
      getPrototypeOf: () => { traps += 1; throw new Error('SECRET_CANARY'); },
    });
    expect(() => createRuntimeIdentityIssuer(proxy as never)).toThrow(TypeError);
    expect(traps).toBe(0);

    const symbolRecord = { datasetEpoch: epoch, processRunId: run, [Symbol('canary')]: 'SECRET_CANARY' };
    const inherited = Object.create({ canary: 'SECRET_CANARY' }) as Record<string, unknown>;
    Object.assign(inherited, { datasetEpoch: epoch, processRunId: run });
    expect(() => createRuntimeIdentityIssuer(symbolRecord as never)).toThrow(TypeError);
    expect(() => createRuntimeIdentityIssuer(inherited as never)).toThrow(TypeError);
    expect(() => createRuntimeIdentityIssuer((() => undefined) as never)).toThrow(TypeError);

    const { control } = makeControl();
    expect(() => control.hold(Object.create({ ...base() }) as never)).toThrow(TypeError);
    const requestAccessor = { ...base() } as Record<string, unknown>;
    Object.defineProperty(requestAccessor, 'expectedRevision', { enumerable: true, get: () => { traps += 1; return '0'; } });
    expect(() => control.hold(requestAccessor as never)).toThrow(TypeError);
    expect(traps).toBe(0);
  });

  test('captures construction dependencies and exposes frozen methods that cannot be swapped', () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const options = { epoch, run, identityIssuer: issuer, ...runtimeObservation, controlIdFactory: () => ids.shift() as string };
    const control = createRuntimeControl(options);
    options.epoch = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    options.run = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    options.controlIdFactory = () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    expect(Object.isFrozen(control)).toBe(true);
    expect(Object.isFrozen(issuer)).toBe(true);
    expect(Reflect.ownKeys(control)).toEqual(['snapshot', 'acquireIssuedPersistence', 'acquireActiveQueryRead', 'canStartWriter', 'isMaintenanceWriterVeto', 'bindWriterWake', 'bindMaintenanceReadySettlement', 'bindMaintenanceValidationCancellation', 'hold', 'release', 'drain']);
    expect(control.hold(base()).controlId).toMatch(/^[0-9a-f-]+$/u);
    expect(control.snapshot()).toMatchObject({ epoch, run });
  });

  test.each([
    ['', 'INVALID_REQUEST'],
    ['33333333-3333-4333-7333-333333333333', 'INVALID_REQUEST'],
    ['33333333-3333-4333-C333-333333333333', 'INVALID_REQUEST'],
  ])('rejects noncanonical request UUID %p as %s before state access', (requestControlId) => {
    const { control } = makeControl();
    expect(() => control.hold({ ...base(), requestControlId })).toThrow(new RuntimeControlError('INVALID_REQUEST'));
    expect(control.snapshot().revision).toBe('0');
  });

  test.each(['', '-1', '+1', '00', '01', '1.0', ' 1', '1 ', '1e0'])(
    'rejects noncanonical revision %p without mutation',
    (expectedRevision) => {
      const { control } = makeControl();
      expect(() => control.hold({ ...base(), expectedRevision })).toThrow(new RuntimeControlError('INVALID_REQUEST'));
      expect(control.snapshot().revision).toBe('0');
    },
  );

  test('validates release controlId before epoch/run/revision and preserves state', () => {
    const { control } = makeControl();
    const held = control.hold(base());
    const bad = { ...base('77777777-7777-4777-8777-777777777777', '999'), epoch: run, run: epoch, controlId: 'INVALID' };
    expect(() => control.release(bad)).toThrow(new RuntimeControlError('INVALID_REQUEST'));
    expect(control.snapshot()).toMatchObject({ revision: '1', phase: 'MANUAL_HOLD', manual: { active: true, controlId: held.controlId } });
  });

  test('hold/release transition increments revision and supports manual+maintenance phases', async () => {
    const { control } = makeControl();
    const held = control.hold(base());
    expect(held).toMatchObject({ outcome: 'HELD', revision: '1' });
    const heldControlId = held.controlId as string;
    expect(held.snapshot.phase).toBe('MANUAL_HOLD');
    expect(() => control.hold({ ...base('77777777-7777-4777-8777-777777777777', '1') })).toThrow(new RuntimeControlError('MANUAL_HOLD_EXISTS'));
    const drained = await control.drain(drainBase('88888888-8888-4888-8888-888888888888', '1'));
    expect(drained).toMatchObject({ outcome: 'DRAINED', revision: '2' });
    const drainedControlId = drained.controlId as string;
    expect(drainedControlId).not.toBe(heldControlId);
    expect(drained.snapshot.phase).toBe('MANUAL_AND_MAINTENANCE_HELD');
    const released = control.release({ ...base('99999999-9999-4999-8999-999999999999', '2'), controlId: heldControlId });
    expect(released).toMatchObject({ outcome: 'RELEASED', revision: '3', controlId: heldControlId });
    expect(released.snapshot.phase).toBe('MAINTENANCE_HELD');
  });

  test('enforces stale/control-id precedence and does not cache pre-mutation failures', async () => {
    const { control } = makeControl();
    expect(() => control.hold({ ...base(), run: epoch })).toThrow(new RuntimeControlError('STALE_RUN'));
    expect(() => control.release({ ...base(), controlId: nextControlId() })).toThrow(new RuntimeControlError('NO_MANUAL_HOLD'));
    expect(() => control.drain(drainBase(request, '1'))).toThrow(new RuntimeControlError('STALE_REVISION'));
    const held = control.hold(base());
    expect(() => control.release({ ...base('77777777-7777-4777-8777-777777777777', held.revision), controlId: epoch })).toThrow(new RuntimeControlError('CONTROL_ID_MISMATCH'));
    expect(() => control.release({ ...base(), epoch: run, controlId: 'not-a-uuid' })).toThrow(new RuntimeControlError('INVALID_REQUEST'));
    expect(control.snapshot().revision).toBe('1');
  });

  test('replays exact last mutation and conflicts on same request id with changed payload', () => {
    const { control } = makeControl();
    const held = control.hold(base());
    expect(control.hold(base())).toBe(held);
    expect(() => control.hold({ ...base(), expectedRevision: '1' })).toThrow(new RuntimeControlError('REQUEST_CONTROL_CONFLICT'));
    const releaseRequestId = '77777777-7777-4777-8777-777777777777';
    const heldControlId = held.controlId as string;
    const released = control.release({ ...base(releaseRequestId, held.revision), controlId: heldControlId });
    expect(control.release({ ...base(releaseRequestId, held.revision), controlId: heldControlId })).toBe(released);
    expect(() => control.release({ ...base(releaseRequestId, '0'), controlId: heldControlId })).toThrow(new RuntimeControlError('REQUEST_CONTROL_CONFLICT'));
  });

  test('manual hold gates only unstarted writers; release commits before one deferred safe wake', async () => {
    const { control } = makeControl();
    const wakes: string[] = [];
    control.bindWriterWake(() => {
      expect(control.snapshot()).toMatchObject({ revision: '2', manual: { active: false, controlId: null } });
      wakes.push('wake');
      throw new Error('observer failure must not undo release');
    });
    expect(control.canStartWriter()).toBe(true);
    const held = control.hold(base());
    expect(control.canStartWriter()).toBe(false);
    const release = { ...base('77777777-7777-4777-8777-777777777777', held.revision), controlId: held.controlId as string };
    const released = control.release(release);
    expect(released.outcome).toBe('RELEASED');
    expect(control.canStartWriter()).toBe(true);
    expect(wakes).toEqual([]);
    await Promise.resolve();
    expect(wakes).toEqual(['wake']);
    expect(control.release(release)).toBe(released);
    expect(wakes).toEqual(['wake']);
    expect(() => control.bindWriterWake(() => undefined)).toThrow(TypeError);
  });

  test('invalid release and exact release replay never wake a held writer twice', async () => {
    const { control } = makeControl();
    let wakes = 0;
    control.bindWriterWake(() => { wakes += 1; });
    const held = control.hold(base());
    const release = { ...base('77777777-7777-4777-8777-777777777777', held.revision), controlId: held.controlId as string };

    expect(() => control.release({ ...release, controlId: 'not-a-uuid' })).toThrow(new RuntimeControlError('INVALID_REQUEST'));
    expect(wakes).toBe(0);
    expect(control.snapshot()).toMatchObject({ manual: { active: true, controlId: held.controlId } });

    const terminal = control.release(release);
    expect(wakes).toBe(0);
    await Promise.resolve();
    expect(wakes).toBe(1);
    expect(control.release(release)).toBe(terminal);
    expect(wakes).toBe(1);
  });

  test('retains only the exact last terminal and gives epoch/run precedence over replay and conflict', () => {
    const { control } = makeControl();
    const held = control.hold(base());
    const releaseId = '77777777-7777-4777-8777-777777777777';
    const released = control.release({ ...base(releaseId, held.revision), controlId: held.controlId as string });
    expect(control.release({ ...base(releaseId, held.revision), controlId: held.controlId as string })).toBe(released);
    expect(() => control.release({ ...base(releaseId, held.revision), epoch: run, controlId: held.controlId as string })).toThrow(new RuntimeControlError('STALE_EPOCH'));
    expect(() => control.release({ ...base(releaseId, held.revision), run: epoch, controlId: held.controlId as string })).toThrow(new RuntimeControlError('STALE_RUN'));
    expect(() => control.hold(base())).toThrow(new RuntimeControlError('STALE_REVISION'));
  });

  test('never invokes an injected legacy ID callback from a control command', async () => {
    let calls = 0;
    const control = createRuntimeControl({
      epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }), ...runtimeObservation,
      controlIdFactory: (): never => { calls += 1; throw new Error('must not run'); },
    });
    const held = control.hold(base());
    expect(held.controlId).toMatch(/^[0-9a-f-]+$/u);
    control.release({ ...base('77777777-7777-4777-8777-777777777777', held.revision), controlId: held.controlId as string });
    await expect(control.drain(drainBase('88888888-8888-4888-8888-888888888888', '2'))).resolves.toMatchObject({ outcome: 'DRAINED' });
    expect(calls).toBe(0);
  });

  test('STATUS, HOLD, and RELEASE do not synchronously invoke hostile or reentrant callbacks', async () => {
    let factoryCalls = 0;
    let wakeCalls = 0;
    let reentrantResult: ReturnType<RuntimeControl['hold']> | undefined;
    const control = createRuntimeControl({
      epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }), ...runtimeObservation,
      controlIdFactory: (): never => { factoryCalls += 1; throw new Error('factory must not run'); },
    });
    control.bindWriterWake(() => {
      wakeCalls += 1;
      reentrantResult = control.hold(base('99999999-9999-4999-8999-999999999999', '2'));
      throw new Error('wake failure must stay outside RELEASE');
    });

    expect(control.snapshot().revision).toBe('0'); // STATUS-equivalent read
    const held = control.hold(base());
    const released = control.release({ ...base('77777777-7777-4777-8777-777777777777', held.revision), controlId: held.controlId as string });
    expect(released.revision).toBe('2');
    expect(factoryCalls).toBe(0);
    expect(wakeCalls).toBe(0);
    expect(reentrantResult).toBeUndefined();

    await Promise.resolve();
    expect(wakeCalls).toBe(1);
    expect(reentrantResult).toMatchObject({ outcome: 'HELD', revision: '3' });
    expect(factoryCalls).toBe(0);
  });

  test('drain is an immediate terminal mutation and remains a maintenance veto', async () => {
    const { control } = makeControl();
    const drained = await control.drain(drainBase());
    expect(drained.snapshot).toEqual({
      epoch, run, revision: '1', phase: 'MAINTENANCE_HELD',
      manual: { active: false, controlId: null },
      maintenance: { active: true, controlId: drained.controlId, outcome: 'DRAINED' },
      writers: { provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 0 },
      issuedPersistence: 0, activeQueryReads: 0, registryUnknown: 0,
      logging: { status: 'HEALTHY', droppedCount: 0 },
    });
    await expect(control.drain(drainBase())).resolves.toEqual(drained);
    expect(() => control.drain(drainBase('77777777-7777-4777-8777-777777777777', drained.revision))).toThrow(new RuntimeControlError('MAINTENANCE_HOLD_EXISTS'));
  });

  test('runs the one-shot READY settlement callback after maintenance mutation and makes callback failure terminal', async () => {
    const { control } = makeControl();
    let observed: ReturnType<RuntimeControl['snapshot']> | undefined;
    control.bindMaintenanceReadySettlement(() => { observed = control.snapshot(); });
    expect(() => control.bindMaintenanceReadySettlement(() => undefined)).toThrow(TypeError);
    const drained = await control.drain(drainBase());
    expect(observed).toMatchObject({
      revision: '1',
      phase: 'MAINTENANCE_DRAINING',
      maintenance: { active: true, outcome: 'WAITING' },
    });
    expect(drained.outcome).toBe('DRAINED');

    const second = makeControl().control;
    second.bindMaintenanceReadySettlement(() => { throw new Error('coordinator unavailable'); });
    await expect(second.drain(drainBase())).resolves.toMatchObject({
      outcome: 'INTERNAL_UNAVAILABLE',
      snapshot: { maintenance: { active: true, outcome: 'INTERNAL_UNAVAILABLE' } },
    });

    // This command is synchronous.  A thenable would otherwise escape the
    // drain terminal boundary and turn a later rejection into an unobserved
    // background failure.
    const third = makeControl().control;
    third.bindMaintenanceReadySettlement((() => Promise.resolve()) as unknown as () => void);
    await expect(third.drain(drainBase())).resolves.toMatchObject({
      outcome: 'INTERNAL_UNAVAILABLE',
      snapshot: { maintenance: { active: true, outcome: 'INTERNAL_UNAVAILABLE' } },
    });
  });

  test('maintenance settlement finalizes only READY FIFO work as KNOWN_NO_EFFECT', async () => {
    const lifecycle: string[] = [];
    const executed = jest.fn();
    const coordinator = createWriteOperationCoordinatorBundle<string, string, string, string, string, string, string, string>({
      clock: { nowMs: () => 0 },
      startGate: () => false,
      lifecycleObserver: { settled: ({ disposition }) => { lifecycle.push(disposition); } },
      executors: {
        managementCreate: (input, _context, settlement) => { executed(input); settlement.businessResultPersisted(input); },
        managementUpdate: (input, _context, settlement) => { executed(input); settlement.businessResultPersisted(input); },
        managementRevoke: (input, _context, settlement) => { executed(input); settlement.businessResultPersisted(input); },
        recognition: (input, _context, settlement) => { executed(input); settlement.businessResultPersisted(input); },
      },
    });
    const validationInFlight = coordinator.managementCreate.registerProvisional();
    const ready = coordinator.recognition.registerProvisional();
    const maintenanceError = new Error('maintenance-ready');
    ready.activate('ready-input');
    const cleanups: string[] = [];

    coordinator.settleReadyKnownNoEffect(maintenanceError, (input) => { cleanups.push(input as string); });
    await expect(ready.completion).rejects.toBe(maintenanceError);
    expect(cleanups).toEqual(['ready-input']);
    expect(lifecycle).toEqual(['KNOWN_NO_EFFECT']);
    expect(executed).not.toHaveBeenCalled();

    // WAITING_VALIDATION has not been run, settled, or converted to UNKNOWN;
    // later A8 owns its cancellation disposition.
    const cleanupError = new Error('test cleanup');
    validationInFlight.rejectBeforeStart(cleanupError);
    await expect(validationInFlight.completion).rejects.toBe(cleanupError);
    expect(lifecycle).toEqual(['KNOWN_NO_EFFECT', 'PRESTART_REJECTED']);
  });

  test('returns deeply frozen exact results for each reachable phase and preserves maintenance after release', async () => {
    const { control } = makeControl();
    const held = control.hold(base());
    const drained = await control.drain(drainBase('77777777-7777-4777-8777-777777777777', held.revision));
    const released = control.release({ ...base('88888888-8888-4888-8888-888888888888', drained.revision), controlId: held.controlId as string });
    for (const result of [held, drained, released]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Reflect.ownKeys(result)).toEqual(['outcome', 'revision', 'controlId', 'snapshot']);
      expect(Object.isFrozen(result.snapshot)).toBe(true);
      expect(Object.isFrozen(result.snapshot.manual)).toBe(true);
      expect(Object.isFrozen(result.snapshot.maintenance)).toBe(true);
      expect(Object.isFrozen(result.snapshot.writers)).toBe(true);
      expect(Object.isFrozen(result.snapshot.logging)).toBe(true);
      expect(Reflect.ownKeys(result.snapshot.manual)).toEqual(['active', 'controlId']);
      expect(Reflect.ownKeys(result.snapshot.maintenance)).toEqual(['active', 'controlId', 'outcome']);
      expect(Reflect.ownKeys(result.snapshot.writers)).toEqual(['provisional', 'queued', 'running', 'blocked', 'unknown']);
      expect(Reflect.ownKeys(result.snapshot.logging)).toEqual(['status', 'droppedCount']);
    }
    expect(held.snapshot.phase).toBe('MANUAL_HOLD');
    expect(drained.snapshot.phase).toBe('MANUAL_AND_MAINTENANCE_HELD');
    expect(released.snapshot.phase).toBe('MAINTENANCE_HELD');
    expect(released.snapshot.maintenance).toEqual({ active: true, controlId: drained.controlId, outcome: 'DRAINED' });
  });

  test('tracks issued persistence through the full work promise and rejects reuse', async () => {
    const { control } = makeControl();
    const lease = control.acquireIssuedPersistence();
    expect(control.snapshot()).toMatchObject({ issuedPersistence: 1, activeQueryReads: 0, phase: 'RUNNING' });
    const work = Promise.reject(new Error('work failed'));
    await expect(work.finally(() => lease.release())).rejects.toThrow('work failed');
    expect(control.snapshot()).toMatchObject({ issuedPersistence: 0 });
    expect(() => lease.release()).toThrow(TypeError);
  });

  test('leases are frozen opaque nominal capabilities and reject foreign or forged receivers', () => {
    const first = makeControl().control;
    const second = makeControl().control;
    const writer = first.acquireIssuedPersistence();
    const query = first.acquireActiveQueryRead();
    const foreignWriter = second.acquireIssuedPersistence();
    const foreignQuery = second.acquireActiveQueryRead();
    const fake = Object.freeze({ release: () => undefined });

    for (const lease of [writer, query, foreignWriter, foreignQuery]) {
      expect(Object.isFrozen(lease)).toBe(true);
      expect(Reflect.ownKeys(lease)).toEqual(['release']);
    }
    for (const [method, receivers] of [
      [writer.release, [query, foreignWriter, fake]],
      [query.release, [writer, foreignQuery, fake]],
    ] as const) {
      for (const receiver of receivers) {
        expect(() => method.call(receiver)).toThrow(TypeError);
        expect(() => method.apply(receiver, [])).toThrow(TypeError);
        expect(() => method.bind(receiver)()).toThrow(TypeError);
      }
    }
    expect(first.snapshot()).toMatchObject({ issuedPersistence: 1, activeQueryReads: 1 });
    expect(second.snapshot()).toMatchObject({ issuedPersistence: 1, activeQueryReads: 1 });

    for (const lease of [writer, query, foreignWriter, foreignQuery]) {
      expect(() => lease.release()).not.toThrow();
      expect(() => lease.release()).toThrow(TypeError);
    }
    expect(first.snapshot()).toMatchObject({ issuedPersistence: 0, activeQueryReads: 0 });
    expect(second.snapshot()).toMatchObject({ issuedPersistence: 0, activeQueryReads: 0 });
  });

  test('tracks active query reads around synchronous invocation and blocks new reads after maintenance starts', async () => {
    const { control } = makeControl();
    const lease = control.acquireActiveQueryRead();
    expect(control.snapshot()).toMatchObject({ activeQueryReads: 1, issuedPersistence: 0 });
    let observed = false;
    try {
      observed = true;
      expect(control.snapshot().activeQueryReads).toBe(1);
    } finally {
      lease.release();
    }
    expect(observed).toBe(true);
    expect(control.snapshot().activeQueryReads).toBe(0);
    const drained = await control.drain(drainBase());
    expect(drained.outcome).toBe('DRAINED');
    expect(() => control.acquireActiveQueryRead()).toThrow(new RuntimeControlError('CONTROL_BUSY'));
  });

  test('drain waits for both issued persistence and active query leases before becoming DRAINED', async () => {
    const { control } = makeControl();
    const writer = control.acquireIssuedPersistence();
    const query = control.acquireActiveQueryRead();
    const draining = control.drain(drainBase());
    await Promise.resolve();
    expect(control.snapshot()).toMatchObject({
      phase: 'MAINTENANCE_DRAINING',
      issuedPersistence: 1,
      activeQueryReads: 1,
      maintenance: { active: true, outcome: 'WAITING' },
    });
    writer.release();
    expect(control.snapshot().issuedPersistence).toBe(0);
    expect(control.snapshot().activeQueryReads).toBe(1);
    query.release();
    await expect(draining).resolves.toMatchObject({ outcome: 'DRAINED', snapshot: { phase: 'MAINTENANCE_HELD', issuedPersistence: 0, activeQueryReads: 0 } });
  });

  test('drain timeout and abort settle NOT_DRAINED while retaining maintenance veto', async () => {
    let now = 0;
    let timeoutObservations = 0;
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: issuer, controlIdFactory: nextControlId,
      clock: { nowMs: () => now },
      awaitObservation: (remainingMs) => { timeoutObservations += 1; now += remainingMs; },
    });
    const writer = control.acquireIssuedPersistence();
    await expect(control.drain(drainBase(request, '0', 10))).resolves.toMatchObject({ outcome: 'NOT_DRAINED', snapshot: { phase: 'MAINTENANCE_HELD', maintenance: { outcome: 'NOT_DRAINED' }, issuedPersistence: 1 } });
    writer.release();
    await Promise.resolve();
    expect(timeoutObservations).toBe(1);

    const second = makeControl().control;
    const held = second.acquireIssuedPersistence();
    const abort = new AbortController();
    const pending = second.drain(drainBase('77777777-7777-4777-8777-777777777777', '0', 100, abort.signal));
    abort.abort();
    await expect(pending).resolves.toMatchObject({ outcome: 'NOT_DRAINED', snapshot: { maintenance: { outcome: 'NOT_DRAINED' } } });
    held.release();
    await Promise.resolve();
    expect(second.snapshot()).toMatchObject({ revision: '1', phase: 'MAINTENANCE_HELD', issuedPersistence: 0, maintenance: { outcome: 'NOT_DRAINED' } });
  });

  test('observation failure settles INTERNAL_UNAVAILABLE and late lease settlement cannot rewrite its terminal', async () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: issuer, controlIdFactory: nextControlId,
      clock: { nowMs: () => 0 },
      awaitObservation: () => Promise.reject(new Error('SECRET_OBSERVATION_CANARY')),
    });
    const writer = control.acquireIssuedPersistence();
    const terminal = await control.drain(drainBase());
    expect(terminal).toMatchObject({
      outcome: 'INTERNAL_UNAVAILABLE', revision: '1',
      snapshot: { phase: 'MAINTENANCE_HELD', issuedPersistence: 1, maintenance: { active: true, outcome: 'INTERNAL_UNAVAILABLE' } },
    });
    expect(() => control.acquireIssuedPersistence()).toThrow(new RuntimeControlError('CONTROL_BUSY'));
    expect(() => control.acquireActiveQueryRead()).toThrow(new RuntimeControlError('CONTROL_BUSY'));
    writer.release();
    await Promise.resolve();
    expect(control.snapshot()).toMatchObject({
      revision: '1', phase: 'MAINTENANCE_HELD', issuedPersistence: 0,
      maintenance: { active: true, controlId: terminal.controlId, outcome: 'INTERNAL_UNAVAILABLE' },
    });
    await expect(control.drain(drainBase())).resolves.toBe(terminal);
  });

  test('timeout terminal remains NOT_DRAINED after late writer and query settlements', async () => {
    let now = 0;
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: issuer, controlIdFactory: nextControlId,
      clock: { nowMs: () => now },
      awaitObservation: (remainingMs) => { now += remainingMs; },
    });
    const writer = control.acquireIssuedPersistence();
    const query = control.acquireActiveQueryRead();
    const terminal = await control.drain(drainBase(request, '0', 10));
    expect(terminal).toMatchObject({ outcome: 'NOT_DRAINED', revision: '1' });
    writer.release();
    query.release();
    await Promise.resolve();
    expect(control.snapshot()).toMatchObject({
      revision: '1', phase: 'MAINTENANCE_HELD', issuedPersistence: 0, activeQueryReads: 0,
      maintenance: { active: true, controlId: terminal.controlId, outcome: 'NOT_DRAINED' },
    });
    await expect(control.drain(drainBase(request, '0', 10))).resolves.toBe(terminal);
  });

  test('manual hold combines with a live drain as MANUAL_AND_MAINTENANCE_DRAINING then remains held', async () => {
    const { control } = makeControl();
    const writer = control.acquireIssuedPersistence();
    const query = control.acquireActiveQueryRead();
    const held = control.hold(base());
    const draining = control.drain(drainBase('77777777-7777-4777-8777-777777777777', held.revision));
    await Promise.resolve();
    expect(control.snapshot()).toMatchObject({
      revision: '2', phase: 'MANUAL_AND_MAINTENANCE_DRAINING',
      manual: { active: true, controlId: held.controlId },
      maintenance: { active: true, outcome: 'WAITING' },
      issuedPersistence: 1, activeQueryReads: 1,
    });
    expect(() => control.acquireIssuedPersistence()).toThrow(new RuntimeControlError('CONTROL_BUSY'));
    expect(() => control.acquireActiveQueryRead()).toThrow(new RuntimeControlError('CONTROL_BUSY'));
    writer.release();
    query.release();
    await expect(draining).resolves.toMatchObject({
      outcome: 'DRAINED', revision: '2', snapshot: { phase: 'MANUAL_AND_MAINTENANCE_HELD', maintenance: { outcome: 'DRAINED' } },
    });
  });

  test('rejects a signal that only satisfies the old structural guard instead of starting an uncleanable observer', () => {
    const { control } = makeControl();
    const structuralSignal = Object.freeze({
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    expect(() => control.drain(drainBase(request, '0', 10, structuralSignal as unknown as AbortSignal))).toThrow(new RuntimeControlError('INVALID_REQUEST'));
    const nativePrototypeFake = Object.create(AbortSignal.prototype) as AbortSignal;
    expect(() => control.drain(drainBase(request, '0', 10, nativePrototypeFake))).toThrow(new RuntimeControlError('INVALID_REQUEST'));
    expect(control.snapshot()).toMatchObject({ revision: '0', phase: 'RUNNING', maintenance: { active: false, outcome: null } });
  });

  test('rejects an AbortSignal-prototype fake with own aborted and event method overrides', () => {
    const { control } = makeControl();
    let traps = 0;
    const fake = Object.create(AbortSignal.prototype) as AbortSignal & { aborted: boolean; addEventListener: () => void; removeEventListener: () => void };
    Object.defineProperties(fake, {
      aborted: { configurable: true, enumerable: true, get: () => { traps += 1; return false; } },
      addEventListener: { configurable: true, enumerable: true, value: () => { traps += 1; } },
      removeEventListener: { configurable: true, enumerable: true, value: () => { traps += 1; } },
    });
    expect(() => control.drain(drainBase(request, '0', 10, fake))).toThrow(new RuntimeControlError('INVALID_REQUEST'));
    expect(traps).toBe(0);
    expect(control.snapshot()).toMatchObject({ revision: '0', phase: 'RUNNING', maintenance: { active: false, outcome: null } });
  });

  test('a genuine non-aborted native AbortSignal reaches timeout and keeps its terminal after late release', async () => {
    let now = 0;
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: issuer, controlIdFactory: nextControlId,
      clock: { nowMs: () => now },
      awaitObservation: (remainingMs) => { now += remainingMs; },
    });
    const native = new AbortController();
    const writer = control.acquireIssuedPersistence();
    const terminal = await control.drain(drainBase(request, '0', 10, native.signal));
    expect(terminal).toMatchObject({ outcome: 'NOT_DRAINED', revision: '1', snapshot: { issuedPersistence: 1 } });
    expect(native.signal.aborted).toBe(false);
    writer.release();
    await Promise.resolve();
    expect(control.snapshot()).toMatchObject({ revision: '1', issuedPersistence: 0, maintenance: { active: true, outcome: 'NOT_DRAINED' } });
  });

  test('accepts fractional monotonic clock values and fails closed on clock rollback', async () => {
    let fractionalNow = 1.25;
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const fractionalControl = createRuntimeControl({
      epoch, run, identityIssuer: issuer, controlIdFactory: nextControlId,
      clock: { nowMs: () => fractionalNow },
      awaitObservation: (remainingMs) => { fractionalNow += remainingMs; },
    });
    let fractionalWriter = fractionalControl.acquireIssuedPersistence();
    const fractionalDrain = fractionalControl.drain(drainBase(request, '0', 10));
    fractionalWriter.release();
    await expect(fractionalDrain).resolves.toMatchObject({ outcome: 'DRAINED', snapshot: { issuedPersistence: 0 } });

    let reads = 0;
    const rollbackControl = createRuntimeControl({
      epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }), controlIdFactory: nextControlId,
      clock: { nowMs: () => reads++ === 0 ? 2 : 1 },
      awaitObservation: () => undefined,
    });
    const rollbackWriter = rollbackControl.acquireIssuedPersistence();
    await expect(rollbackControl.drain(drainBase('77777777-7777-4777-8777-777777777777', '0', 10))).resolves.toMatchObject({ outcome: 'INTERNAL_UNAVAILABLE' });
    rollbackWriter.release();
  });

  test('deadline overflow settles INTERNAL_UNAVAILABLE without changing revision or maintenance terminal later', async () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: issuer, controlIdFactory: nextControlId,
      clock: { nowMs: () => Number.MAX_SAFE_INTEGER - 4 },
      awaitObservation: () => { throw new Error('must not observe overflowed deadline'); },
    });
    const writer = control.acquireIssuedPersistence();
    const terminal = await control.drain(drainBase(request, '0', 5));
    expect(terminal).toMatchObject({ outcome: 'INTERNAL_UNAVAILABLE', revision: '1', snapshot: { issuedPersistence: 1 } });
    writer.release();
    await Promise.resolve();
    expect(control.snapshot()).toMatchObject({ revision: '1', issuedPersistence: 0, maintenance: { active: true, outcome: 'INTERNAL_UNAVAILABLE' } });
  });

  test('late observation settlement after successful drain cannot rewrite terminal or retain a counter waiter', async () => {
    let resolveObservation!: () => void;
    let observationCalls = 0;
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch, run, identityIssuer: issuer, controlIdFactory: nextControlId,
      clock: { nowMs: () => 0 },
      awaitObservation: () => {
        observationCalls += 1;
        return new Promise<void>((resolve) => { resolveObservation = resolve; });
      },
    });
    const writer = control.acquireIssuedPersistence();
    const pending = control.drain(drainBase());
    await Promise.resolve();
    await Promise.resolve();
    expect(observationCalls).toBe(1);
    writer.release();
    const terminal = await pending;
    expect(terminal).toMatchObject({ outcome: 'DRAINED', revision: '1' });
    resolveObservation();
    await Promise.resolve();
    await Promise.resolve();
    expect(observationCalls).toBe(1);
    expect(control.snapshot()).toMatchObject({ revision: '1', phase: 'MAINTENANCE_HELD', issuedPersistence: 0, maintenance: { outcome: 'DRAINED' } });
  });

  test('cleanup failure cannot prevent terminal drain resolution or current cleanup', async () => {
    const { control } = makeControl();
    const abort = new AbortController();
    const eventPrototype = EventTarget.prototype;
    const originalRemove = Object.getOwnPropertyDescriptor(eventPrototype, 'removeEventListener');
    if (originalRemove === undefined) throw new Error('native removeEventListener descriptor missing');
    let cleanupCalls = 0;
    Object.defineProperty(eventPrototype, 'removeEventListener', {
      ...originalRemove,
      value: function hostileNativeCleanup(): never { cleanupCalls += 1; throw new Error('cleanup canary'); },
    });
    try {
      const writer = control.acquireIssuedPersistence();
      const pending = control.drain(drainBase(request, '0', 100, abort.signal));
      abort.abort();
      await expect(pending).resolves.toMatchObject({ outcome: 'NOT_DRAINED', snapshot: { maintenance: { outcome: 'NOT_DRAINED' } } });
      expect(cleanupCalls).toBe(1);
      writer.release();
      await expect(control.drain(drainBase(request, '0', 100, abort.signal))).resolves.toMatchObject({ outcome: 'NOT_DRAINED' });
      expect(control.snapshot()).toMatchObject({ revision: '1', phase: 'MAINTENANCE_HELD', issuedPersistence: 0, maintenance: { outcome: 'NOT_DRAINED' } });
    } finally {
      Object.defineProperty(eventPrototype, 'removeEventListener', originalRemove);
    }
  });

  test('lease release requires its nominal receiver and exact control/kind provenance', () => {
    const first = makeControl().control;
    const second = makeControl().control;
    const writer = first.acquireIssuedPersistence();
    const query = first.acquireActiveQueryRead();
    expect(() => writer.release.call(query)).toThrow(TypeError);
    expect(() => query.release.call(writer)).toThrow(TypeError);
    expect(() => writer.release.call({})).toThrow(TypeError);
    expect(() => query.release.call(Object.freeze({}))).toThrow(TypeError);
    const foreignWriter = second.acquireIssuedPersistence();
    expect(foreignWriter).toBeDefined();
    expect(first.snapshot()).toMatchObject({ issuedPersistence: 1, activeQueryReads: 1 });
    writer.release();
    query.release();
    expect(() => writer.release()).toThrow(TypeError);
    expect(() => query.release()).toThrow(TypeError);
    expect(first.snapshot()).toMatchObject({ issuedPersistence: 0, activeQueryReads: 0 });
    foreignWriter.release();
  });
});
