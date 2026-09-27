import {
  assertRuntimeControl,
  createRuntimeControl,
  createRuntimeIdentityIssuer,
  RuntimeControlError,
  type RuntimeControl,
} from '../../src/runtime/internal/runtime-control.js';
import * as publicApi from '../../src/index.js';
import * as publicCompositionApi from '../../src/composition/index.js';
import { readFileSync } from 'node:fs';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const owner = '55555555-5555-4555-8555-555555555555';
let controlIdOrdinal = 6;

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
      controlIdFactory: nextControlId,
    }),
  };
}

function base(requestControlId = request, expectedRevision = '0') {
  return { requestControlId, epoch, run, expectedRevision } as const;
}

describe('G10a A1 runtime identity/control core', () => {
  test('remains absent from both public barrels and A1 has no later-unit dependencies', () => {
    for (const api of [publicApi, publicCompositionApi]) {
      expect(Object.keys(api).filter((key) => /runtime|control|identity|operationtoken/iu.test(key))).toEqual([]);
    }
    const source = readFileSync('src/runtime/internal/runtime-control.ts', 'utf8');
    const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"];$/gmu)].map((match) => match[1]);
    expect(imports).toEqual(['node:crypto', 'node:util']);
    expect(source).not.toMatch(/logger|socket|g07|mongodb|infrastructure/iu);
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

  test('rejects foreign/forged identity issuer and control capabilities', () => {
    const first = makeControl();
    const foreign = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const foreignToken = foreign.issueBusinessToken({ operationUUID: operation, ownerRef: owner });
    const foreignIdentity = foreign.issue({ requestUUID: request, operationToken: foreignToken, route: 'RECOGNITION' });
    expect(() => first.issuer.issue({ requestUUID: request, operationToken: foreignToken, route: 'RECOGNITION' })).toThrow(TypeError);
    expect(() => first.control.hold({ ...base(), epoch: run })).toThrow(new RuntimeControlError('STALE_EPOCH'));
    expect(() => first.issuer.read(foreignIdentity)).toThrow(TypeError);
    expect(() => assertRuntimeControl(Object.freeze({ snapshot: first.control.snapshot }))).toThrow(TypeError);
    expect(() => createRuntimeControl({ epoch, run, identityIssuer: Object.freeze({}) as never })).toThrow(TypeError);
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
    const options = { epoch, run, identityIssuer: issuer, controlIdFactory: () => ids.shift() as string };
    const control = createRuntimeControl(options);
    options.epoch = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    options.run = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    options.controlIdFactory = () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    expect(Object.isFrozen(control)).toBe(true);
    expect(Object.isFrozen(issuer)).toBe(true);
    expect(Reflect.ownKeys(control)).toEqual(['snapshot', 'hold', 'release', 'drain']);
    expect(control.hold(base()).controlId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
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

  test('hold/release transition increments revision and supports manual+maintenance phases', () => {
    const { control } = makeControl();
    const held = control.hold(base());
    expect(held).toMatchObject({ outcome: 'HELD', revision: '1' });
    const heldControlId = held.controlId as string;
    expect(held.snapshot.phase).toBe('MANUAL_HOLD');
    expect(() => control.hold({ ...base('77777777-7777-4777-8777-777777777777', '1') })).toThrow(new RuntimeControlError('MANUAL_HOLD_EXISTS'));
    const drained = control.drain({ ...base('88888888-8888-4888-8888-888888888888', '1') });
    expect(drained).toMatchObject({ outcome: 'DRAINED', revision: '2' });
    const drainedControlId = drained.controlId as string;
    expect(drainedControlId).not.toBe(heldControlId);
    expect(drained.snapshot.phase).toBe('MANUAL_AND_MAINTENANCE_HELD');
    const released = control.release({ ...base('99999999-9999-4999-8999-999999999999', '2'), controlId: heldControlId });
    expect(released).toMatchObject({ outcome: 'RELEASED', revision: '3', controlId: heldControlId });
    expect(released.snapshot.phase).toBe('MAINTENANCE_HELD');
  });

  test('enforces stale/control-id precedence and does not cache pre-mutation failures', () => {
    const { control } = makeControl();
    expect(() => control.hold({ ...base(), run: epoch })).toThrow(new RuntimeControlError('STALE_RUN'));
    expect(() => control.release({ ...base(), controlId: nextControlId() })).toThrow(new RuntimeControlError('NO_MANUAL_HOLD'));
    expect(() => control.drain({ ...base(), expectedRevision: '1' })).toThrow(new RuntimeControlError('STALE_REVISION'));
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

  test('current transition has a terminal cached before the next factory observation can re-enter', () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const ids = [nextControlId(), nextControlId()];
    let factoryCalls = 0;
    let control!: RuntimeControl;
    let reentered: ReturnType<RuntimeControl['hold']> | undefined;
    let reentrySnapshot: ReturnType<RuntimeControl['snapshot']> | undefined;
    let reentryReadError: unknown;
    control = createRuntimeControl({ epoch, run, identityIssuer: issuer, controlIdFactory: () => {
      const value = ids[factoryCalls];
      factoryCalls += 1;
      if (factoryCalls === 2) {
        reentered = control.hold(base());
        reentrySnapshot = control.snapshot();
        try { void reentered.outcome; } catch (error) { reentryReadError = error; }
      }
      if (value === undefined) throw new Error('test factory exhausted');
      return value;
    } });
    const terminal = control.hold(base());
    expect(reentered).toBe(terminal);
    expect(reentryReadError).toEqual(new RuntimeControlError('CONTROL_BUSY'));
    expect(reentrySnapshot).toMatchObject({ revision: '0', phase: 'RUNNING' });
    expect(factoryCalls).toBe(2);
  });

  test('drain exact reentry joins the same projected terminal while reservation is active', () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const ids = [nextControlId(), nextControlId()];
    let factoryCalls = 0;
    let control!: RuntimeControl;
    let reentered: ReturnType<RuntimeControl['drain']> | undefined;
    let reentrySnapshot: ReturnType<RuntimeControl['snapshot']> | undefined;
    let reentryReadError: unknown;
    control = createRuntimeControl({ epoch, run, identityIssuer: issuer, controlIdFactory: () => {
      const value = ids[factoryCalls];
      factoryCalls += 1;
      if (factoryCalls === 2) {
        reentered = control.drain(base());
        reentrySnapshot = control.snapshot();
        try { void reentered.outcome; } catch (error) { reentryReadError = error; }
      }
      if (value === undefined) throw new Error('test factory exhausted');
      return value;
    } });
    const terminal = control.drain(base());
    expect(reentered).toBe(terminal);
    expect(reentryReadError).toEqual(new RuntimeControlError('CONTROL_BUSY'));
    expect(reentrySnapshot).toMatchObject({ revision: '0', phase: 'RUNNING' });
    expect(terminal.snapshot.revision).toBe('1');
  });

  test.each([
    ['throws', () => { throw new Error('factory failure'); }],
    ['invalid', () => 'INVALID'],
  ])('factory %s leaves hold state/cache/revision untouched', (_label, factory) => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    let calls = 0;
    const control = createRuntimeControl({ epoch, run, identityIssuer: issuer, controlIdFactory: () => {
      calls += 1;
      if (calls === 1) return nextControlId();
      return factory();
    } });
    expect(() => control.hold(base())).toThrow(TypeError);
    expect(control.snapshot()).toMatchObject({ revision: '0', phase: 'RUNNING', manual: { active: false, controlId: null }, maintenance: { active: false, controlId: null, outcome: null } });
    // A failed pre-reservation is neither current nor last: exact and different
    // request IDs both encounter only the captured factory failure, and the
    // failing factory is never called again to consume another candidate ID.
    expect(() => control.hold(base())).toThrow(TypeError);
    expect(() => control.hold({ ...base('77777777-7777-4777-8777-777777777777', '0') })).toThrow(TypeError);
    expect(calls).toBe(2);
  });

  test('keeps a terminal current while post-mutation id reservation rejects a different reentrant mutation as busy', () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const ids = [
      'f1000001-f100-4100-8100-f10000000001',
      'f1000002-f100-4100-8100-f10000000002',
      'f1000003-f100-4100-8100-f10000000003',
    ];
    let factoryCalls = 0;
    let control!: RuntimeControl;
    let reentryError: unknown;
    control = createRuntimeControl({ epoch, run, identityIssuer: issuer, controlIdFactory: () => {
      const value = ids[factoryCalls];
      factoryCalls += 1;
      if (factoryCalls === 2) {
        try {
          control.drain({ ...base('77777777-7777-4777-8777-777777777777', '1') });
        } catch (error) {
          reentryError = error;
        }
      }
      if (value === undefined) throw new Error('test factory exhausted');
      return value;
    } });

    const terminal = control.hold(base());
    expect(terminal).toMatchObject({ outcome: 'HELD', revision: '1', controlId: ids[0] });
    expect(reentryError).toEqual(new RuntimeControlError('CONTROL_BUSY'));
    expect(factoryCalls).toBe(2);
    expect(control.snapshot()).toMatchObject({
      revision: '1',
      phase: 'MANUAL_HOLD',
      manual: { active: true, controlId: ids[0] },
      maintenance: { active: false, controlId: null, outcome: null },
    });
  });

  test('protects the current mutation before caching its terminal result', () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const control = createRuntimeControl({
      epoch,
      run,
      identityIssuer: issuer,
      controlIdFactory: nextControlId,
    });
    expect(control.hold(base()).outcome).toBe('HELD');
  });

  test('drain is an immediate terminal mutation and remains a maintenance veto', () => {
    const { control } = makeControl();
    const drained = control.drain(base());
    expect(drained.snapshot).toEqual({
      epoch, run, revision: '1', phase: 'MAINTENANCE_HELD',
      manual: { active: false, controlId: null },
      maintenance: { active: true, controlId: drained.controlId, outcome: 'DRAINED' },
      writers: { provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 0 },
      issuedPersistence: 0, activeQueryReads: 0, registryUnknown: 0,
      logging: { status: 'HEALTHY', droppedCount: 0 },
    });
    expect(control.drain(base())).toBe(drained);
    expect(() => control.drain({ ...base('77777777-7777-4777-8777-777777777777', drained.revision) })).toThrow(new RuntimeControlError('MAINTENANCE_HOLD_EXISTS'));
  });

  test.each([
    ['HOLD', 'throws', (candidate: string) => { throw new Error(`factory failure ${candidate}`); }],
    ['HOLD', 'invalid', () => 'INVALID'],
    ['HOLD', 'duplicate', (candidate: string) => candidate],
    ['DRAIN', 'throws', (candidate: string) => { throw new Error(`factory failure ${candidate}`); }],
    ['DRAIN', 'invalid', () => 'INVALID'],
    ['DRAIN', 'duplicate', (candidate: string) => candidate],
  ] as const)('%s exact reentry cannot observe success when following factory %s fails', (command, _label, failure) => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const candidate = nextControlId();
    let calls = 0;
    let control!: RuntimeControl;
    let inner: ReturnType<RuntimeControl['hold']> | undefined;
    let callbackSnapshot: ReturnType<RuntimeControl['snapshot']> | undefined;
    control = createRuntimeControl({ epoch, run, identityIssuer: issuer, controlIdFactory: () => {
      calls += 1;
      if (calls === 1) return candidate;
      inner = command === 'HOLD' ? control.hold(base()) : control.drain(base());
      callbackSnapshot = control.snapshot();
      return failure(candidate);
    } });
    const invoke = (): ReturnType<RuntimeControl['hold']> => command === 'HOLD' ? control.hold(base()) : control.drain(base());
    expect(invoke).toThrow(TypeError);
    expect(inner).toBeDefined();
    for (const read of [
      () => inner?.outcome,
      () => inner?.revision,
      () => inner?.controlId,
      () => inner?.snapshot,
    ]) expect(read).toThrow(TypeError);
    expect(callbackSnapshot).toMatchObject({ revision: '0', phase: 'RUNNING', manual: { active: false }, maintenance: { active: false } });
    expect(control.snapshot()).toMatchObject({ revision: '0', phase: 'RUNNING', manual: { active: false, controlId: null }, maintenance: { active: false, controlId: null, outcome: null } });
    expect(invoke).toThrow(TypeError);
    const invokeDifferent = (): ReturnType<RuntimeControl['hold']> => command === 'HOLD'
      ? control.hold({ ...base('77777777-7777-4777-8777-777777777777', '0') })
      : control.drain({ ...base('77777777-7777-4777-8777-777777777777', '0') });
    expect(invokeDifferent).toThrow(TypeError);
    expect(calls).toBe(2);
  });

  test('returns deeply frozen exact results for each reachable phase and preserves maintenance after release', () => {
    const { control } = makeControl();
    const held = control.hold(base());
    const drained = control.drain({ ...base('77777777-7777-4777-8777-777777777777', held.revision) });
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

  test('fails closed when a captured control-id factory repeats an issued value', () => {
    const issuer = createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run });
    const duplicate = nextControlId();
    let calls = 0;
    const control = createRuntimeControl({ epoch, run, identityIssuer: issuer, controlIdFactory: () => { calls += 1; return duplicate; } });
    expect(() => control.hold(base())).toThrow(TypeError);
    expect(control.snapshot()).toMatchObject({
      revision: '0', phase: 'RUNNING',
      manual: { active: false, controlId: null },
      maintenance: { active: false, controlId: null, outcome: null },
    });
    expect(() => control.hold(base())).toThrow(TypeError);
    expect(() => control.drain({ ...base('77777777-7777-4777-8777-777777777777') })).toThrow(TypeError);
    expect(calls).toBe(2);
  });
});
