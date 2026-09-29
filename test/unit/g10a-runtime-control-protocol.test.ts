import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  dispatchRuntimeControlProtocol,
  dispatchRuntimeControlProtocolSynchronously,
  type RuntimeControlProtocolFrame,
} from '../../src/runtime/internal/runtime-control-protocol.js';
import {
  createRuntimeControl,
  createRuntimeIdentityIssuer,
  type RuntimeControl,
} from '../../src/runtime/internal/runtime-control.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const requestTwo = '44444444-4444-4444-8444-444444444444';

function control(): RuntimeControl {
  return createRuntimeControl({
    epoch, run,
    identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
    clock: Object.freeze({ nowMs: () => 0 }),
    awaitObservation: () => undefined,
    controlIdFactory: randomUUID,
  });
}
function frame(value: string): RuntimeControlProtocolFrame {
  return Object.freeze({ text: value, utf8Valid: true, hasBom: false, singleFinalLf: true, byteLength: Buffer.byteLength(value, 'utf8') });
}
function line(value: Record<string, unknown>): RuntimeControlProtocolFrame { return frame(`${JSON.stringify(value)}\n`); }
function status(id = request): RuntimeControlProtocolFrame { return line({ v: 'c1', requestControlId: id, command: 'STATUS', epoch, run }); }
function hold(id = request, revision = '0'): RuntimeControlProtocolFrame { return line({ v: 'c1', requestControlId: id, command: 'HOLD', epoch, run, expectedRevision: revision }); }

describe('G10a A11.1 runtime control protocol core', () => {
  test('keeps the protocol private and free of net/fs/socket dependencies', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile('src/runtime/internal/runtime-control-protocol.ts', 'utf8'));
    expect(source).not.toMatch(/^import .*node:(?:net|fs|child_process)/mu);
    const root = await import('../../src/index.js');
    const composition = await import('../../src/composition/index.js');
    for (const api of [root, composition]) expect(Object.keys(api).filter((key) => /protocol|runtimecontrol/iu.test(key))).toEqual([]);
  });

  test('returns no response for strict frame precondition violations without dispatch', async () => {
    const instance = control();
    for (const bad of [
      { ...status(), utf8Valid: false }, { ...status(), hasBom: true }, { ...status(), singleFinalLf: false },
      { ...status(), byteLength: 4097 }, { ...status(), text: '{}', byteLength: 2 },
    ]) {
      await expect(dispatchRuntimeControlProtocol(instance, bad)).resolves.toBeUndefined();
    }
    expect(instance.snapshot().revision).toBe('0');
  });

  test('encodes exact ten-key STATUS success and validates epoch/run in order', async () => {
    const instance = control();
    const response = await dispatchRuntimeControlProtocol(instance, status());
    expect(response).toEqual({
      v: 'c1', requestControlId: request, ok: true, command: 'STATUS', outcome: 'STATUS', revision: '0', controlId: null,
      snapshot: instance.snapshot(), records: null, truncated: null,
    });
    expect(Object.keys(response!)).toEqual(['v', 'requestControlId', 'ok', 'command', 'outcome', 'revision', 'controlId', 'snapshot', 'records', 'truncated']);
    await expect(dispatchRuntimeControlProtocol(instance, line({ v: 'c1', requestControlId: request, command: 'STATUS', epoch: run, run })))
      .resolves.toEqual({ v: 'c1', requestControlId: request, ok: false, code: 'STALE_EPOCH' });
  });

  test('directly dispatches HOLD, RELEASE and DRAIN and encodes their exact result envelopes', async () => {
    const instance = control();
    const held = await dispatchRuntimeControlProtocol(instance, hold());
    expect(held).toMatchObject({ ok: true, command: 'HOLD', outcome: 'HELD', revision: '1', records: null, truncated: null });
    const controlId = held && held.ok ? held.controlId : null;
    expect(controlId).toMatch(/^[0-9a-f-]+$/u);
    await expect(dispatchRuntimeControlProtocol(instance, line({ v: 'c1', requestControlId: requestTwo, command: 'RELEASE', epoch, run, expectedRevision: '1', controlId })))
      .resolves.toMatchObject({ ok: true, command: 'RELEASE', outcome: 'RELEASED', revision: '2', controlId });
    await expect(dispatchRuntimeControlProtocol(instance, line({ v: 'c1', requestControlId: '55555555-5555-4555-8555-555555555555', command: 'DRAIN', epoch, run, expectedRevision: '2', timeoutMs: 10 })))
      .resolves.toMatchObject({ ok: true, command: 'DRAIN', outcome: 'DRAINED', revision: '3' });
  });

  test('keeps STATUS/HOLD/RELEASE inside a non-thenable, callback-free synchronous boundary and returns DRAIN as data', () => {
    let observationCalls = 0;
    const instance = createRuntimeControl({
      epoch, run,
      identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
      clock: Object.freeze({ nowMs: () => 0 }),
      awaitObservation: () => { observationCalls += 1; return Promise.resolve(); },
      controlIdFactory: randomUUID,
    });

    const statusResponse = dispatchRuntimeControlProtocolSynchronously(instance, status());
    expect(statusResponse).toMatchObject({ ok: true, command: 'STATUS', outcome: 'STATUS' });
    expect(statusResponse).not.toHaveProperty('then');
    expect(observationCalls).toBe(0);

    const holdResponse = dispatchRuntimeControlProtocolSynchronously(instance, hold(requestTwo));
    expect(holdResponse).toMatchObject({ ok: true, command: 'HOLD', outcome: 'HELD', revision: '1' });
    expect(holdResponse).not.toHaveProperty('then');
    expect(observationCalls).toBe(0);

    const pending = dispatchRuntimeControlProtocolSynchronously(instance, line({
      v: 'c1', requestControlId: '55555555-5555-4555-8555-555555555555', command: 'DRAIN', epoch, run,
      expectedRevision: '1', timeoutMs: 10,
    }));
    expect(pending).toEqual({ kind: 'DRAIN_PENDING', timeoutMs: 10 });
    expect(observationCalls).toBe(0);
  });

  test('rejects unknown/missing/extra DTO fields and preserves only a safely parsed canonical request id', async () => {
    const instance = control();
    await expect(dispatchRuntimeControlProtocol(instance, line({ v: 'c1', requestControlId: request, command: 'STATUS', epoch, run, extra: true })))
      .resolves.toEqual({ v: 'c1', requestControlId: request, ok: false, code: 'INVALID_REQUEST' });
    await expect(dispatchRuntimeControlProtocol(instance, line({ v: 'c1', requestControlId: 'INVALID', command: 'STATUS', epoch, run })))
      .resolves.toEqual({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' });
    await expect(dispatchRuntimeControlProtocol(instance, frame('{"v":"c1","requestControlId":"33333333-3333-4333-8333-333333333333"\n')))
      .resolves.toEqual({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' });
  });

  test('finds duplicates at arbitrary depth before JSON.parse and makes no control mutation', async () => {
    const instance = control();
    const nested = '{"v":"c1","requestControlId":"33333333-3333-4333-8333-333333333333","command":"HOLD","epoch":"11111111-1111-4111-8111-111111111111","run":"22222222-2222-4222-8222-222222222222","expectedRevision":"0","nested":{"a":1,"\\u0061":2}}\n';
    await expect(dispatchRuntimeControlProtocol(instance, frame(nested)))
      .resolves.toEqual({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' });
    expect(instance.snapshot().revision).toBe('0');

    let deep = '{"v":"c1","requestControlId":"33333333-3333-4333-8333-333333333333","command":"STATUS","epoch":"11111111-1111-4111-8111-111111111111","run":"22222222-2222-4222-8222-222222222222","x":';
    for (let i = 0; i < 80; i += 1) deep += '{"k":';
    deep += '0';
    for (let i = 0; i < 80; i += 1) deep += '}';
    deep += '}\n';
    await expect(dispatchRuntimeControlProtocol(instance, frame(deep))).resolves.toEqual({ v: 'c1', requestControlId: request, ok: false, code: 'INVALID_REQUEST' });
  });

  test('maps all trusted control errors to closed error codes and does not expose implementation failures', async () => {
    const instance = control();
    await expect(dispatchRuntimeControlProtocol(instance, hold())).resolves.toMatchObject({ ok: true, outcome: 'HELD' });
    await expect(dispatchRuntimeControlProtocol(instance, hold(requestTwo, '1'))).resolves.toEqual({ v: 'c1', requestControlId: requestTwo, ok: false, code: 'MANUAL_HOLD_EXISTS' });
    await expect(dispatchRuntimeControlProtocol(instance, hold('55555555-5555-4555-8555-555555555555', '0'))).resolves.toEqual({ v: 'c1', requestControlId: '55555555-5555-4555-8555-555555555555', ok: false, code: 'STALE_REVISION' });
  });
});
