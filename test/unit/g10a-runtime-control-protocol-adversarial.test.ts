import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  dispatchRuntimeControlProtocol,
  type RuntimeControlProtocolFrame,
} from '../../src/runtime/internal/runtime-control-protocol.js';
import {
  createRuntimeControl,
  createRuntimeIdentityIssuer,
  type RuntimeControl,
} from '../../src/runtime/internal/runtime-control.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const idA = '33333333-3333-4333-8333-333333333333';
const idB = '44444444-4444-4444-8444-444444444444';
const idC = '55555555-5555-4555-8555-555555555555';

function makeControl(options?: { readonly observe?: () => void | Promise<void>; readonly ids?: () => string }): RuntimeControl {
  return createRuntimeControl({
    epoch,
    run,
    identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
    clock: Object.freeze({ nowMs: () => 0 }),
    awaitObservation: options?.observe ?? (() => undefined),
    controlIdFactory: options?.ids ?? randomUUID,
  });
}

function frame(text: string): RuntimeControlProtocolFrame {
  return Object.freeze({ text, utf8Valid: true, hasBom: false, singleFinalLf: true, byteLength: Buffer.byteLength(text, 'utf8') });
}
function message(value: Record<string, unknown>): RuntimeControlProtocolFrame { return frame(`${JSON.stringify(value)}\n`); }
function status(requestControlId = idA, extra: Record<string, unknown> = {}): RuntimeControlProtocolFrame {
  return message({ v: 'c1', requestControlId, command: 'STATUS', epoch, run, ...extra });
}
function hold(requestControlId = idA, expectedRevision = '0'): RuntimeControlProtocolFrame {
  return message({ v: 'c1', requestControlId, command: 'HOLD', epoch, run, expectedRevision });
}
function drain(requestControlId = idA, expectedRevision = '0', timeoutMs = 10): RuntimeControlProtocolFrame {
  return message({ v: 'c1', requestControlId, command: 'DRAIN', epoch, run, expectedRevision, timeoutMs });
}

describe('G10a A11.1 adversarial protocol contract', () => {
  test('draws the fatal-frame/no-response boundary before JSON or control dispatch', async () => {
    const control = makeControl();
    const valid = status();
    const cases: RuntimeControlProtocolFrame[] = [
      Object.freeze({ ...valid, utf8Valid: false }),
      Object.freeze({ ...valid, hasBom: true }),
      Object.freeze({ ...valid, singleFinalLf: false }),
      Object.freeze({ ...valid, text: `${valid.text}\n`, byteLength: Buffer.byteLength(`${valid.text}\n`) }),
      Object.freeze({ ...valid, text: `${valid.text}x\n`, byteLength: Buffer.byteLength(`${valid.text}x\n`) }),
      Object.freeze({ ...valid, text: valid.text, byteLength: valid.byteLength + 1 }),
      Object.freeze({ ...valid, text: `${' '.repeat(4096)}\n`, byteLength: 4097 }),
    ];
    for (const candidate of cases) await expect(dispatchRuntimeControlProtocol(control, candidate)).resolves.toBeUndefined();
    expect(control.snapshot()).toMatchObject({ revision: '0', phase: 'RUNNING' });
  });

  test('uses INVALID_REQUEST, rather than the framing path, for complete JSON/DTO failures and preserves only canonical IDs', async () => {
    const control = makeControl();
    const base = { v: 'c1', requestControlId: idA, command: 'STATUS', epoch, run };
    const malformed: readonly [RuntimeControlProtocolFrame, string | null][] = [
      [frame('{"v":"c1"}\n'), null],
      [message({ ...base, v: 'c2' }), idA],
      [message({ ...base, command: 'NOPE' }), idA],
      [message({ ...base, extra: null }), idA],
      [message({ ...base, epoch: 1 }), idA],
      [message({ ...base, requestControlId: 'abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase() }), null],
      [frame(`[${JSON.stringify(base)}]\n`), null],
    ];
    for (const [candidate, preservedId] of malformed) {
      await expect(dispatchRuntimeControlProtocol(control, candidate))
        .resolves.toEqual({ v: 'c1', requestControlId: preservedId, ok: false, code: 'INVALID_REQUEST' });
    }
    expect(control.snapshot().revision).toBe('0');
  });

  test('does not permit duplicate decoded keys at root or arbitrary nesting to select a request ID or mutate state', async () => {
    const control = makeControl();
    const rootDuplicate = `{"v":"c1","requestControlId":"${idA}","requestControlId":"${idB}","command":"HOLD","epoch":"${epoch}","run":"${run}","expectedRevision":"0"}\n`;
    const escapedDuplicate = `{"v":"c1","requestControlId":"${idA}","command":"HOLD","epoch":"${epoch}","run":"${run}","expectedRevision":"0","nest":{"\\u0061":1,"a":2}}\n`;
    await expect(dispatchRuntimeControlProtocol(control, frame(rootDuplicate))).resolves.toEqual({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' });
    await expect(dispatchRuntimeControlProtocol(control, frame(escapedDuplicate))).resolves.toEqual({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' });
    expect(control.snapshot().revision).toBe('0');
  });

  test('honours epoch/run, replay/conflict, revision and precondition ordering in its closed error mapping', async () => {
    const control = makeControl();
    await expect(dispatchRuntimeControlProtocol(control, message({ v: 'c1', requestControlId: idA, command: 'HOLD', epoch: run, run, expectedRevision: '99' })))
      .resolves.toEqual({ v: 'c1', requestControlId: idA, ok: false, code: 'STALE_EPOCH' });
    await expect(dispatchRuntimeControlProtocol(control, message({ v: 'c1', requestControlId: idA, command: 'HOLD', epoch, run: epoch, expectedRevision: '99' })))
      .resolves.toEqual({ v: 'c1', requestControlId: idA, ok: false, code: 'STALE_RUN' });
    const held = await dispatchRuntimeControlProtocol(control, hold(idA));
    expect(held).toMatchObject({ ok: true, outcome: 'HELD', revision: '1' });
    await expect(dispatchRuntimeControlProtocol(control, hold(idA))).resolves.toEqual(held);
    await expect(dispatchRuntimeControlProtocol(control, hold(idA, '1')))
      .resolves.toEqual({ v: 'c1', requestControlId: idA, ok: false, code: 'REQUEST_CONTROL_CONFLICT' });
    await expect(dispatchRuntimeControlProtocol(control, hold(idB, '0')))
      .resolves.toEqual({ v: 'c1', requestControlId: idB, ok: false, code: 'STALE_REVISION' });
    await expect(dispatchRuntimeControlProtocol(control, hold(idB, '1')))
      .resolves.toEqual({ v: 'c1', requestControlId: idB, ok: false, code: 'MANUAL_HOLD_EXISTS' });
  });

  test('maps release preconditions and maintenance preconditions without leaking RuntimeControl implementation errors', async () => {
    const control = makeControl();
    await expect(dispatchRuntimeControlProtocol(control, message({ v: 'c1', requestControlId: idA, command: 'RELEASE', epoch, run, expectedRevision: '0', controlId: '66666666-6666-4666-8666-666666666666' })))
      .resolves.toEqual({ v: 'c1', requestControlId: idA, ok: false, code: 'NO_MANUAL_HOLD' });
    const held = await dispatchRuntimeControlProtocol(control, hold());
    const controlId = held && held.ok ? held.controlId : null;
    await expect(dispatchRuntimeControlProtocol(control, message({ v: 'c1', requestControlId: idB, command: 'RELEASE', epoch, run, expectedRevision: '1', controlId: '66666666-6666-4666-8666-666666666666' })))
      .resolves.toEqual({ v: 'c1', requestControlId: idB, ok: false, code: 'CONTROL_ID_MISMATCH' });
    await expect(dispatchRuntimeControlProtocol(control, message({ v: 'c1', requestControlId: idB, command: 'RELEASE', epoch, run, expectedRevision: '1', controlId })))
      .resolves.toMatchObject({ ok: true, outcome: 'RELEASED', revision: '2' });
    await expect(dispatchRuntimeControlProtocol(control, drain(idC, '2'))).resolves.toMatchObject({ ok: true, outcome: 'DRAINED', revision: '3' });
    await expect(dispatchRuntimeControlProtocol(control, drain('66666666-6666-4666-8666-666666666666', '3')))
      .resolves.toEqual({ v: 'c1', requestControlId: '66666666-6666-4666-8666-666666666666', ok: false, code: 'MAINTENANCE_HOLD_EXISTS' });
  });

  test('maps a different command during an in-progress drain to CONTROL_BUSY, while exact drain replay joins it', async () => {
    const control = makeControl();
    const lease = control.acquireIssuedPersistence();
    const inProgress = dispatchRuntimeControlProtocol(control, drain(idA, '0', 100));
    await expect(dispatchRuntimeControlProtocol(control, hold(idB, '1')))
      .resolves.toEqual({ v: 'c1', requestControlId: idB, ok: false, code: 'CONTROL_BUSY' });
    const joined = dispatchRuntimeControlProtocol(control, drain(idA, '0', 100));
    lease.release();
    await expect(joined).resolves.toEqual(await inProgress);
  });

  test('maps a post-mutation drain observer failure to a closed cached INTERNAL_UNAVAILABLE error', async () => {
    const control = makeControl({ observe: () => { throw new Error('private observation failure'); } });
    const lease = control.acquireIssuedPersistence();
    const first = await dispatchRuntimeControlProtocol(control, drain(idA, '0', 10));
    expect(first).toEqual({ v: 'c1', requestControlId: idA, ok: false, code: 'INTERNAL_UNAVAILABLE' });
    await expect(dispatchRuntimeControlProtocol(control, drain(idA, '0', 10))).resolves.toEqual(first);
    lease.release();
  });

  test('does not invoke an injected ID callback while dispatching a HOLD command', async () => {
    let calls = 0;
    const control = makeControl({ ids: () => {
      calls += 1;
      if (calls === 1) return '66666666-6666-4666-8666-666666666666';
      throw new Error('secret factory diagnostic');
    } });
    await expect(dispatchRuntimeControlProtocol(control, hold()))
      .resolves.toMatchObject({ v: 'c1', requestControlId: idA, ok: true, command: 'HOLD', outcome: 'HELD' });
    expect(calls).toBe(0);
  });
});
