import { Buffer } from 'node:buffer';

import { bindOperationRegistryMetricsBridge, createOperationRegistry, createOperationRegistryCapabilityIssuer, readOperationRegistryUnknownCount } from '../../src/access/application/internal/operation-registry.js';
import { createWriterQuiescence, readWriterQuiescenceCounters } from '../../src/access/application/internal/writer-quiescence.js';
import { createRuntimeControl, createRuntimeIdentityIssuer, bindRuntimeControlLiveCounters } from '../../src/runtime/internal/runtime-control.js';
import { createRuntimeLiveCounterSnapshotSource, publishRuntimeLiveCounterSnapshot, bindRuntimeLiveCounterSnapshot } from '../../src/runtime/internal/runtime-live-counter-snapshot.js';
import { dispatchRuntimeControlProtocol, type RuntimeControlProtocolFrame } from '../../src/runtime/internal/runtime-control-protocol.js';
import { createRuntimeLiveCounterBridge, notifyRuntimeLiveCounterBridge } from '../../src/runtime/internal/runtime-live-counter-bridge.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const receipt = Object.freeze({ operationId: 'writer-1', receivedAtMs: 1, registeredAtMonotonicMs: 1, sequence: 0n });

function statusFrame(): RuntimeControlProtocolFrame {
  const text = `${JSON.stringify({ v: 'c1', requestControlId: '33333333-3333-4333-8333-333333333333', command: 'STATUS', epoch, run })}\n`;
  return Object.freeze({ text, utf8Valid: true, hasBom: false, singleFinalLf: true, byteLength: Buffer.byteLength(text, 'utf8') });
}

test('G10a STATUS reads blocked/unknown writer and actual registry UNKNOWN through nominal internal metrics', async () => {
  const capabilities = createOperationRegistryCapabilityIssuer({ registryId: 'metrics', datasetEpoch: epoch, processRunId: run, ownerId: '44444444-4444-4444-8444-444444444444', sameArtifact: () => true });
  const registry = createOperationRegistry({ capabilities, writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'), assertOwnerCurrent: () => undefined, assertContinuationEvidence: () => undefined });
  const registration = registry.register(capabilities.issueKey('source', 'event'), capabilities.issueComparisonArtifact(Object.freeze({})));
  if (registration.kind !== 'REGISTERED') throw new Error('expected new registry entry');
  const writers = createWriterQuiescence({ clock: { nowMs: () => 0 } });
  // BLOCKED is a fail-closed cleanup-failure state.  Its direct lifecycle
  // projection is retained here; the HTTP composition separately exercises
  // the release-origin failure path that reaches this transition.
  writers.lifecycle.registered(receipt); writers.lifecycle.blocked(receipt);
  const control = createRuntimeControl({ epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }), clock: { nowMs: () => 0 }, awaitObservation: () => undefined });
  const source = createRuntimeLiveCounterSnapshotSource(Object.freeze({ writers: readWriterQuiescenceCounters(writers), registryUnknown: readOperationRegistryUnknownCount(registry) }));
  bindRuntimeControlLiveCounters(control, source);
  const bridge = createRuntimeLiveCounterBridge(() => publishRuntimeLiveCounterSnapshot(source, Object.freeze({ writers: readWriterQuiescenceCounters(writers), registryUnknown: readOperationRegistryUnknownCount(registry) })));
  bindOperationRegistryMetricsBridge(registry, bridge);
  bindOperationRegistryMetricsBridge(registry, bridge);
  expect(() => bindOperationRegistryMetricsBridge(registry, createRuntimeLiveCounterBridge(() => undefined))).toThrow(TypeError);
  registry.markUnknown(registration.lease);

  const blocked = await dispatchRuntimeControlProtocol(control, statusFrame());
  expect(blocked).toMatchObject({ ok: true, snapshot: { writers: { provisional: 0, queued: 0, running: 0, blocked: 1, unknown: 0 }, registryUnknown: 1 } });
  writers.lifecycle.settled(receipt, 'UNKNOWN_EFFECT');
  publishRuntimeLiveCounterSnapshot(source, Object.freeze({ writers: readWriterQuiescenceCounters(writers), registryUnknown: readOperationRegistryUnknownCount(registry) }));
  const unknown = await dispatchRuntimeControlProtocol(control, statusFrame());
  expect(unknown).toMatchObject({ ok: true, snapshot: { writers: { provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 1 }, registryUnknown: 1 } });
});

test('STATUS, HOLD and RELEASE only consume the pushed cache; the nominal source cannot be rebound', async () => {
  const initial = Object.freeze({ writers: Object.freeze({ provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 0 }), registryUnknown: 0 });
  const source = createRuntimeLiveCounterSnapshotSource(initial);
  const control = createRuntimeControl({ epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }), clock: { nowMs: () => 0 }, awaitObservation: () => undefined });
  bindRuntimeControlLiveCounters(control, source);
  expect(() => bindRuntimeLiveCounterSnapshot(source, () => { throw new Error('hostile metrics observer'); })).toThrow(TypeError);
  publishRuntimeLiveCounterSnapshot(source, Object.freeze({ writers: Object.freeze({ provisional: 1, queued: 0, running: 0, blocked: 0, unknown: 0 }), registryUnknown: 0 }));
  await expect(dispatchRuntimeControlProtocol(control, statusFrame())).resolves.toMatchObject({ ok: true, snapshot: { writers: { provisional: 1 } } });
  const held = control.hold({ requestControlId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', epoch, run, expectedRevision: '0' });
  expect(control.release({ requestControlId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch, run, expectedRevision: '1', controlId: held.controlId as string })).toMatchObject({ outcome: 'RELEASED' });
});

test('a bridge refresh cannot reenter control or registry mutation', () => {
  const capabilities = createOperationRegistryCapabilityIssuer({ registryId: 'guard', datasetEpoch: epoch, processRunId: run, ownerId: '44444444-4444-4444-8444-444444444444', sameArtifact: () => true });
  const registry = createOperationRegistry({ capabilities, writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'), assertOwnerCurrent: () => undefined, assertContinuationEvidence: () => undefined });
  const control = createRuntimeControl({ epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }), clock: { nowMs: () => 0 }, awaitObservation: () => undefined });
  const bridge = createRuntimeLiveCounterBridge(() => {
    expect(() => control.hold({ requestControlId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', epoch, run, expectedRevision: '0' })).toThrow('CONTROL_BUSY');
    expect(() => control.release({ requestControlId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch, run, expectedRevision: '0', controlId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).toThrow('CONTROL_BUSY');
    expect(() => control.drain({ requestControlId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', epoch, run, expectedRevision: '0', timeoutMs: 1 })).toThrow('CONTROL_BUSY');
    expect(() => registry.reserveCandidate()).toThrow();
  });
  notifyRuntimeLiveCounterBridge(bridge);
  expect(control.snapshot().revision).toBe('0');
  expect(registry.snapshot().reserved).toBe(0);
  const held = control.hold({ requestControlId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', epoch, run, expectedRevision: '0' });
  expect(control.release({ requestControlId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', epoch, run, expectedRevision: '1', controlId: held.controlId as string }).outcome).toBe('RELEASED');
  expect(registry.reserveCandidate()).toBeDefined();
});
