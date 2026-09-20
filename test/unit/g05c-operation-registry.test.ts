import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  OperationRegistryError,
  createOperationRegistry,
  createOperationRegistryCapabilityIssuer,
  type OperationComparisonArtifact,
  type OperationConfirmationLease,
  type OperationContinuationPermit,
  type OperationExecutionLease,
  type OperationRegistry,
  type OperationRegistryCapabilityIssuer,
  type OperationRegistryErrorCode,
  type OperationRegistryKey,
  type OperationResultReference,
  type WriteRunClaimDisposition,
} from '../../src/access/application/internal/operation-registry.js';

interface Harness {
  readonly issuer: OperationRegistryCapabilityIssuer;
  readonly registry: OperationRegistry;
  readonly owner: jest.Mock<unknown, []>;
  readonly verify: jest.Mock<unknown, [unknown]>;
}

let sequence = 0;

function harness(options: {
  readonly registryId?: string;
  readonly datasetEpoch?: string;
  readonly processRunId?: string;
  readonly ownerId?: string;
  readonly disposition?: WriteRunClaimDisposition;
  readonly capacity?: number;
  readonly sameArtifact?: (existing: unknown, candidate: unknown) => boolean;
  readonly owner?: jest.Mock<unknown, []>;
  readonly verify?: jest.Mock<unknown, [unknown]>;
} = {}): Harness {
  sequence += 1;
  const issuer = createOperationRegistryCapabilityIssuer({
    registryId: options.registryId ?? `registry-${sequence}`,
    datasetEpoch: options.datasetEpoch ?? `epoch-${sequence}`,
    processRunId: options.processRunId ?? `run-${sequence}`,
    ownerId: options.ownerId ?? `owner-${sequence}`,
    sameArtifact: options.sameArtifact ?? ((existing, candidate) => existing === candidate),
  });
  const owner = options.owner ?? jest.fn<unknown, []>(() => undefined);
  const verify = options.verify ?? jest.fn<unknown, [unknown]>(() => undefined);
  const registry = createOperationRegistry({
    capabilities: issuer,
    writeRunClaim: issuer.issueWriteRunClaim(options.disposition ?? 'WRITABLE'),
    assertOwnerCurrent: owner,
    assertContinuationEvidence: verify,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
  });
  return { issuer, registry, owner, verify };
}

function identity(value: string): Readonly<{ value: string }> {
  return Object.freeze({ value });
}

function key(h: Harness, source = 'source', event = 'event'): OperationRegistryKey {
  return h.issuer.issueKey(source, event);
}

function artifact(h: Harness, value: object = identity('artifact')): OperationComparisonArtifact {
  return h.issuer.issueComparisonArtifact(value);
}

function expectCode(work: () => unknown, code: OperationRegistryErrorCode): OperationRegistryError {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(OperationRegistryError);
    expect((error as OperationRegistryError).code).toBe(code);
    return error as OperationRegistryError;
  }
  throw new Error(`expected OperationRegistryError ${code}`);
}

function register(h: Harness, source = 'source', event = 'event', value: object = identity('artifact')): {
  readonly key: OperationRegistryKey;
  readonly artifact: OperationComparisonArtifact;
  readonly lease: OperationExecutionLease;
} {
  const operationKey = key(h, source, event);
  const comparisonArtifact = artifact(h, value);
  const registration = h.registry.register(operationKey, comparisonArtifact);
  expect(registration.kind).toBe('REGISTERED');
  if (registration.kind !== 'REGISTERED') throw new Error('expected registration');
  return { key: operationKey, artifact: comparisonArtifact, lease: registration.lease };
}

function unknown(h: Harness, source = 'source', event = 'event'): {
  readonly key: OperationRegistryKey;
  readonly artifact: OperationComparisonArtifact;
  readonly confirmation: OperationConfirmationLease;
} {
  const created = register(h, source, event);
  return { ...created, confirmation: h.registry.markUnknown(created.lease) };
}

function permit(h: Harness, lease: OperationConfirmationLease, evidence: object = {}): OperationContinuationPermit {
  return h.registry.authorizeContinuation(lease, evidence);
}

describe('G05c issuer, provenance, capture, and isolation', () => {
  test('issuer rejects malformed metadata, comparer, keys, artifacts, and claims', () => {
    const valid = {
      registryId: 'registry', datasetEpoch: 'epoch', processRunId: 'run', ownerId: 'owner',
      sameArtifact: () => true,
    };
    for (const options of [null, { ...valid, registryId: '' }, { ...valid, datasetEpoch: '' },
      { ...valid, processRunId: '' }, { ...valid, ownerId: '' }, { ...valid, sameArtifact: null }]) {
      expect(() => createOperationRegistryCapabilityIssuer(options as never)).toThrow(TypeError);
    }
    const issuer = createOperationRegistryCapabilityIssuer(valid);
    for (const pair of [['', 'event'], ['source', '']] as const) {
      expect(() => issuer.issueKey(pair[0], pair[1])).toThrow(TypeError);
    }
    for (const value of [null, 1, 'identity', {}, []]) {
      expect(() => issuer.issueComparisonArtifact(value as never)).toThrow(TypeError);
    }
    expect(() => issuer.issueWriteRunClaim('UNKNOWN' as never)).toThrow(TypeError);
  });

  test('all issued capabilities and results are frozen with the documented minimal shape', () => {
    const h = harness();
    const issuedKey = key(h);
    const issuedArtifact = artifact(h);
    const claim = h.issuer.issueWriteRunClaim('WRITABLE');
    const result = h.issuer.issueResultReference();
    const registration = h.registry.register(issuedKey, issuedArtifact);
    expect(registration.kind).toBe('REGISTERED');
    if (registration.kind !== 'REGISTERED') return;
    const confirmation = h.registry.markUnknown(registration.lease);
    const continuation = permit(h, confirmation);
    for (const token of [h.issuer, issuedKey, issuedArtifact, claim, result, registration, registration.entry,
      registration.lease, confirmation, continuation, h.registry, h.registry.snapshot()]) {
      expect(Object.isFrozen(token)).toBe(true);
    }
    expect(Object.keys(issuedKey)).toEqual([]);
    expect(Object.keys(issuedArtifact)).toEqual([]);
    expect(Object.keys(claim)).toEqual([]);
    expect(Object.keys(result)).toEqual([]);
    expect(Object.keys(continuation)).toEqual(['generation']);
    expect(Object.keys(result)).not.toEqual(expect.arrayContaining(['payload', 'identity', 'secret', 'reference']));
  });

  test('plain and foreign keys, artifacts, results, claims, leases, and permits cannot cross provenance', () => {
    const first = harness();
    const second = harness();
    expectCode(() => first.registry.register({} as OperationRegistryKey, artifact(first)), 'INVALID_CAPABILITY');
    expectCode(() => first.registry.register(key(second), artifact(first)), 'DATASET_EPOCH_MISMATCH');
    expectCode(() => first.registry.register(key(first), {} as OperationComparisonArtifact), 'INVALID_CAPABILITY');
    expectCode(() => first.registry.register(key(first), artifact(second)), 'INVALID_CAPABILITY');
    expect(() => createOperationRegistry({
      capabilities: first.issuer,
      writeRunClaim: second.issuer.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: () => undefined,
      assertContinuationEvidence: () => undefined,
    })).toThrow(TypeError);
    expect(() => createOperationRegistry({
      capabilities: first.issuer,
      writeRunClaim: Object.freeze({}) as never,
      assertOwnerCurrent: () => undefined,
      assertContinuationEvidence: () => undefined,
    })).toThrow(TypeError);

    const firstUnknown = unknown(first);
    const secondUnknown = unknown(second);
    const firstPermit = permit(first, firstUnknown.confirmation);
    expectCode(() => first.registry.markUnknown({ generation: 1 } as OperationExecutionLease), 'INVALID_LEASE');
    expectCode(() => first.registry.markUnknown(register(second, 's2', 'e2').lease), 'INVALID_LEASE');
    expectCode(() => first.registry.completeCanonical(firstUnknown.confirmation, Object.freeze({}) as OperationResultReference),
      'INVALID_CAPABILITY');
    expectCode(() => first.registry.completeCanonical(firstUnknown.confirmation, second.issuer.issueResultReference()), 'INVALID_CAPABILITY');
    expectCode(() => first.registry.resumeUnknown(secondUnknown.confirmation, firstPermit), 'INVALID_LEASE');
    expectCode(() => first.registry.resumeUnknown(firstUnknown.confirmation, {} as OperationContinuationPermit), 'INVALID_PERMIT');
    expectCode(() => first.registry.resumeUnknown(firstUnknown.confirmation, permit(second, secondUnknown.confirmation)), 'INVALID_PERMIT');
  });

  test('same metadata from a distinct issuer is still foreign', () => {
    const metadata = { registryId: 'same', datasetEpoch: 'same', processRunId: 'same', ownerId: 'same' };
    const first = harness(metadata);
    const second = harness(metadata);
    expectCode(() => first.registry.register(key(second), artifact(first)), 'DATASET_EPOCH_MISMATCH');
    expectCode(() => first.registry.register(key(first), artifact(second)), 'INVALID_CAPABILITY');
  });

  test('issuer and registry capture metadata and trusted callbacks against later option mutation', () => {
    const originalComparer = jest.fn((a: unknown, b: unknown) => a === b);
    const issuerOptions = {
      registryId: 'captured-registry', datasetEpoch: 'captured-epoch', processRunId: 'captured-run',
      ownerId: 'captured-owner', sameArtifact: originalComparer,
    };
    const issuer = createOperationRegistryCapabilityIssuer(issuerOptions);
    issuerOptions.registryId = 'mutated';
    issuerOptions.datasetEpoch = 'mutated';
    (issuerOptions as { sameArtifact: (a: unknown, b: unknown) => boolean }).sameArtifact = () => false;
    const owner = jest.fn(() => undefined);
    const verifier = jest.fn(() => undefined);
    const registryOptions = {
      capabilities: issuer, writeRunClaim: issuer.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: owner, assertContinuationEvidence: verifier, capacity: 2,
    };
    const registry = createOperationRegistry(registryOptions);
    (registryOptions as { assertOwnerCurrent: () => unknown }).assertOwnerCurrent = () => { throw new Error('mutated owner'); };
    (registryOptions as { assertContinuationEvidence: (evidence: unknown) => unknown }).assertContinuationEvidence = () => { throw new Error('mutated verifier'); };
    registryOptions.capacity = 1;
    const shared = identity('same');
    const operationKey = issuer.issueKey('s', 'e');
    const firstArtifact = issuer.issueComparisonArtifact(shared);
    expect(registry.register(operationKey, firstArtifact).kind).toBe('REGISTERED');
    expect(registry.register(operationKey, issuer.issueComparisonArtifact(shared)).kind).toBe('JOINED');
    const second = registry.register(issuer.issueKey('s', 'e2'), issuer.issueComparisonArtifact(identity('two')));
    expect(second.kind).toBe('REGISTERED');
    expect(registry.snapshot()).toMatchObject({
      registryId: 'captured-registry', datasetEpoch: 'captured-epoch', processRunId: 'captured-run',
      ownerId: 'captured-owner', capacity: 2,
    });
    expect(originalComparer).toHaveBeenCalledTimes(1);
    expect(owner).toHaveBeenCalledTimes(2);
    if (second.kind === 'REGISTERED') {
      const confirmation = registry.markUnknown(second.lease);
      registry.authorizeContinuation(confirmation, {});
    }
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  test('separate registry instances remain isolated even when sharing one issuer', () => {
    const issuer = createOperationRegistryCapabilityIssuer({
      registryId: 'shared', datasetEpoch: 'epoch', processRunId: 'run', ownerId: 'owner',
      sameArtifact: (a, b) => a === b,
    });
    const make = (): OperationRegistry => createOperationRegistry({
      capabilities: issuer, writeRunClaim: issuer.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: () => undefined, assertContinuationEvidence: () => undefined,
    });
    const first = make();
    const second = make();
    const operationKey = issuer.issueKey('source', 'event');
    const comparisonArtifact = issuer.issueComparisonArtifact(identity('same'));
    const a = first.register(operationKey, comparisonArtifact);
    const b = second.register(operationKey, comparisonArtifact);
    expect([a.kind, b.kind]).toEqual(['REGISTERED', 'REGISTERED']);
    expect(first.snapshot().size).toBe(1);
    expect(second.snapshot().size).toBe(1);
    if (a.kind === 'REGISTERED') expectCode(() => second.markUnknown(a.lease), 'INVALID_LEASE');
  });
});

describe('G05c registration, conflict, and bounded retention', () => {
  test('a new key allocates exactly once and synchronous duplicates join without another lease', () => {
    const h = harness();
    const shared = identity('same');
    const operationKey = key(h);
    const first = h.registry.register(operationKey, artifact(h, shared));
    const duplicate = h.registry.register(operationKey, artifact(h, shared));
    expect(first.kind).toBe('REGISTERED');
    expect(duplicate.kind).toBe('JOINED');
    expect(duplicate).not.toHaveProperty('lease');
    expect(h.registry.snapshot().size).toBe(1);
    expect(h.owner).toHaveBeenCalledTimes(1);
  });

  test('source ID and external event ID form the whole key without cross-source aliasing', () => {
    const h = harness();
    const shared = identity('same');
    expect(h.registry.register(key(h, 'source-a', 'same-event'), artifact(h, shared)).kind).toBe('REGISTERED');
    expect(h.registry.register(key(h, 'source-b', 'same-event'), artifact(h, shared)).kind).toBe('REGISTERED');
    expect(h.registry.register(key(h, 'source-a', 'other-event'), artifact(h, shared)).kind).toBe('REGISTERED');
    expect(h.registry.snapshot().size).toBe(3);
  });

  test('the same artifact token and a different token accepted by the comparer both join', () => {
    const h = harness({ sameArtifact: (a, b) => (a as { value: string }).value === (b as { value: string }).value });
    const operationKey = key(h);
    const firstArtifact = artifact(h, identity('same'));
    expect(h.registry.register(operationKey, firstArtifact).kind).toBe('REGISTERED');
    expect(h.registry.register(operationKey, firstArtifact).kind).toBe('JOINED');
    expect(h.registry.register(operationKey, artifact(h, identity('same'))).kind).toBe('JOINED');
  });

  test('a comparer false conflict leaves the original entry and result unchanged', () => {
    const h = harness({ sameArtifact: (a, b) => (a as { value: string }).value === (b as { value: string }).value });
    const created = register(h, 'source', 'event', identity('first'));
    expectCode(() => h.registry.register(created.key, artifact(h, identity('different'))), 'IDEMPOTENCY_CONFLICT');
    expect(h.registry.snapshot().size).toBe(1);
    expect(h.registry.lookupExisting(created.key, created.artifact).kind).toBe('JOINED');
  });

  test('invalid attempts do not occupy capacity', () => {
    const h = harness({ capacity: 1 });
    expectCode(() => h.registry.register({} as OperationRegistryKey, artifact(h)), 'INVALID_CAPABILITY');
    expectCode(() => h.registry.register(key(h), {} as OperationComparisonArtifact), 'INVALID_CAPABILITY');
    expect(h.registry.snapshot().size).toBe(0);
    expect(register(h).lease.generation).toBe(1);
  });

  test('default capacity accepts the 4096th entry and rejects the 4097th', () => {
    const h = harness();
    for (let index = 0; index < 4_096; index += 1) {
      expect(h.registry.register(key(h, 'source', `event-${index}`), artifact(h, identity(`${index}`))).kind)
        .toBe('REGISTERED');
    }
    expect(h.registry.snapshot()).toMatchObject({ size: 4_096, capacity: 4_096 });
    expectCode(() => h.registry.register(key(h, 'source', 'event-4096'), artifact(h, identity('4096'))),
      'REGISTRY_CAPACITY_EXHAUSTED');
    expect(h.registry.snapshot().size).toBe(4_096);
  });

  test('full capacity still permits join and canonical replay while terminal entries are never freed', () => {
    const h = harness({ capacity: 1 });
    const shared = identity('same');
    const created = register(h, 'source', 'event', shared);
    expect(h.registry.register(created.key, artifact(h, shared)).kind).toBe('JOINED');
    const result = h.issuer.issueResultReference();
    h.registry.completeCanonical(created.lease, result);
    const replay = h.registry.register(created.key, artifact(h, shared));
    expect(replay.kind).toBe('REPLAY_CANONICAL');
    if (replay.kind === 'REPLAY_CANONICAL') expect(replay.resultReference).toBe(result);
    expectCode(() => h.registry.register(key(h, 'source', 'other'), artifact(h)), 'REGISTRY_CAPACITY_EXHAUSTED');
    expect(h.registry.snapshot().size).toBe(1);
  });
});

describe('G05c lifecycle, generations, terminal authority, and late callbacks', () => {
  test('IN_FLIGHT becomes UNKNOWN, invalidates the execution lease, and preserves metadata', () => {
    const h = harness({ datasetEpoch: 'epoch', processRunId: 'run', ownerId: 'owner' });
    const created = register(h, 'source-a', 'event-a');
    expect(created.lease.generation).toBe(1);
    const confirmation = h.registry.markUnknown(created.lease);
    expect(confirmation.generation).toBe(1);
    expectCode(() => h.registry.markUnknown(created.lease), 'LEASE_ALREADY_USED');
    const joined = h.registry.lookupExisting(created.key, created.artifact);
    expect(joined).toMatchObject({
      kind: 'JOINED',
      entry: {
        datasetEpoch: 'epoch', sourceId: 'source-a', externalEventId: 'event-a', state: 'UNKNOWN',
        generation: 1, processRunId: 'run', ownerId: 'owner',
      },
    });
  });

  test.each(['CANONICAL', 'SAFE_TECHNICAL_TERMINAL'] as const)(
    'confirmation can establish %s and replay the exact opaque result reference',
    (terminal) => {
      const h = harness();
      const item = unknown(h);
      const result = h.issuer.issueResultReference();
      if (terminal === 'CANONICAL') h.registry.completeCanonical(item.confirmation, result);
      else h.registry.completeSafeTechnicalTerminal(item.confirmation, result);
      const replay = h.registry.lookupExisting(item.key, item.artifact);
      expect(replay.kind).toBe(terminal === 'CANONICAL' ? 'REPLAY_CANONICAL' : 'REPLAY_SAFE_TECHNICAL_TERMINAL');
      if (replay.kind === 'REPLAY_CANONICAL' || replay.kind === 'REPLAY_SAFE_TECHNICAL_TERMINAL') {
        expect(replay.resultReference).toBe(result);
        expect(replay.entry.state).toBe(terminal);
      }
    },
  );

  test('valid evidence mints only one permit per generation and evidence cannot be reused', () => {
    const h = harness();
    const first = unknown(h, 'source', 'first');
    const evidence = {};
    const firstPermit = h.registry.authorizeContinuation(first.confirmation, evidence);
    expect(firstPermit.generation).toBe(1);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expectCode(() => h.registry.authorizeContinuation(first.confirmation, {}), 'CONTINUATION_ALREADY_AUTHORIZED');
    const second = unknown(h, 'source', 'second');
    expectCode(() => h.registry.authorizeContinuation(second.confirmation, evidence), 'PERMIT_ALREADY_USED');
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  test('foreign, mismatched-stale, and reused permits fail closed', () => {
    const h = harness();
    const first = unknown(h, 'source', 'first');
    const second = unknown(h, 'source', 'second');
    const firstPermit = permit(h, first.confirmation);
    expectCode(() => h.registry.resumeUnknown(second.confirmation, firstPermit), 'STALE_PERMIT');
    expectCode(() => h.registry.resumeUnknown(first.confirmation, firstPermit), 'PERMIT_ALREADY_USED');

    const other = harness();
    const otherUnknown = unknown(other);
    const otherPermit = permit(other, otherUnknown.confirmation);
    expectCode(() => h.registry.resumeUnknown(first.confirmation, otherPermit), 'INVALID_PERMIT');
  });

  test('UNKNOWN resumes into a new generation and all old-generation callbacks are fenced', () => {
    const h = harness();
    const item = unknown(h);
    const continuation = permit(h, item.confirmation);
    const resumed = h.registry.resumeUnknown(item.confirmation, continuation);
    expect(resumed.generation).toBe(2);
    expectCode(() => h.registry.completeCanonical(item.confirmation, h.issuer.issueResultReference()), 'LEASE_ALREADY_USED');
    expectCode(() => h.registry.resumeUnknown(item.confirmation, continuation), 'LEASE_ALREADY_USED');
    const joined = h.registry.lookupExisting(item.key, item.artifact);
    expect(joined).toMatchObject({ kind: 'JOINED', entry: { state: 'IN_FLIGHT', generation: 2 } });
  });

  test('the first valid terminal callback wins and terminal entries cannot reopen or settle twice', () => {
    const h = harness();
    const created = register(h);
    const first = h.issuer.issueResultReference();
    const second = h.issuer.issueResultReference();
    h.registry.completeCanonical(created.lease, first);
    expectCode(() => h.registry.completeSafeTechnicalTerminal(created.lease, second), 'LEASE_ALREADY_USED');
    const registration = h.registry.register(created.key, created.artifact);
    expect(registration.kind).toBe('REPLAY_CANONICAL');
    if (registration.kind === 'REPLAY_CANONICAL') expect(registration.resultReference).toBe(first);
    expect(registration).not.toHaveProperty('lease');
  });

  test('late callbacks cannot affect another key or consume its lease', () => {
    const h = harness();
    const old = register(h, 'source', 'old');
    const current = register(h, 'source', 'current');
    h.registry.completeCanonical(old.lease, h.issuer.issueResultReference());
    expectCode(() => h.registry.markUnknown(old.lease), 'LEASE_ALREADY_USED');
    const currentConfirmation = h.registry.markUnknown(current.lease);
    expect(currentConfirmation.generation).toBe(1);
    expect(h.registry.lookupExisting(current.key, current.artifact)).toMatchObject({
      kind: 'JOINED', entry: { state: 'UNKNOWN', generation: 1 },
    });
  });

  test('lease kinds are not interchangeable and invalid result/evidence values cannot mutate state', () => {
    const h = harness();
    const created = register(h, 'source', 'execution');
    expectCode(() => h.registry.authorizeContinuation(created.lease as unknown as OperationConfirmationLease, {}),
      'INVALID_LEASE');
    expect(() => h.registry.authorizeContinuation(created.lease as unknown as OperationConfirmationLease, null as never))
      .toThrow(TypeError);
    expectCode(() => h.registry.completeCanonical(created.lease, null as unknown as OperationResultReference),
      'INVALID_CAPABILITY');
    const confirmation = h.registry.markUnknown(created.lease);
    expectCode(() => h.registry.markUnknown(confirmation as unknown as OperationExecutionLease), 'INVALID_LEASE');
    expect(h.registry.lookupExisting(created.key, created.artifact)).toMatchObject({
      kind: 'JOINED', entry: { state: 'UNKNOWN', generation: 1 },
    });
  });
});

describe('G05c epoch, restart claims, and lookup semantics', () => {
  test.each(['READ_ONLY', 'STALE'] as const)('%s claims cannot register a new operation', (disposition) => {
    const h = harness({ disposition });
    expectCode(() => h.registry.register(key(h), artifact(h)), 'WRITE_NOT_ALLOWED');
    expect(h.registry.snapshot()).toMatchObject({ claimDisposition: disposition, size: 0 });
  });

  test('empty writable lookup is ABSENT while empty read-only and stale lookups are NOT_PROVEN', () => {
    for (const [disposition, expected] of [
      ['WRITABLE', 'ABSENT'], ['READ_ONLY', 'NOT_PROVEN'], ['STALE', 'NOT_PROVEN'],
    ] as const) {
      const h = harness({ disposition });
      expect(h.registry.lookupExisting(key(h), artifact(h))).toEqual({ kind: expected });
    }
  });

  test('old epoch capabilities are rejected and a reset epoch starts an independent empty registry', () => {
    const oldRun = harness({ registryId: 'registry', datasetEpoch: 'old', processRunId: 'old-run', ownerId: 'owner' });
    const old = register(oldRun);
    const reset = harness({ registryId: 'registry', datasetEpoch: 'new', processRunId: 'new-run', ownerId: 'owner' });
    expectCode(() => reset.registry.register(old.key, artifact(reset)), 'DATASET_EPOCH_MISMATCH');
    expect(reset.registry.lookupExisting(key(reset), artifact(reset))).toEqual({ kind: 'ABSENT' });
    expect(reset.registry.register(key(reset), artifact(reset)).kind).toBe('REGISTERED');
    expect(oldRun.registry.lookupExisting(old.key, old.artifact).kind).toBe('JOINED');
  });

  test('entry views preserve captured metadata and advance only their own generation', () => {
    const h = harness({ datasetEpoch: 'epoch-view', processRunId: 'run-view', ownerId: 'owner-view' });
    const first = unknown(h, 'source', 'first');
    const second = register(h, 'source', 'second');
    const resumed = h.registry.resumeUnknown(first.confirmation, permit(h, first.confirmation));
    expect(resumed.generation).toBe(2);
    expect(h.registry.lookupExisting(first.key, first.artifact)).toMatchObject({
      entry: { datasetEpoch: 'epoch-view', processRunId: 'run-view', ownerId: 'owner-view', generation: 2 },
    });
    expect(h.registry.lookupExisting(second.key, second.artifact)).toMatchObject({ entry: { generation: 1 } });
  });
});

describe('G05c trusted dependency fail-closed behavior', () => {
  test.each([
    ['throws Error', (): unknown => { throw new Error('owner secret'); }],
    ['throws primitive', (): unknown => { throw 'primitive secret'; }],
    ['returns value', (): unknown => 1],
    ['resolves Promise', (): unknown => Promise.resolve(undefined)],
    ['rejects Promise', (): unknown => Promise.reject(new Error('async secret'))],
    ['then getter throws', (): unknown => Object.defineProperty({}, 'then', { get() { throw new Error('getter secret'); } })],
    ['then method throws', (): unknown => ({ then() { throw new Error('then secret'); } })],
  ] as const)('owner callback %s freezes with a typed failure', async (_name, behavior) => {
    const owner = jest.fn<unknown, []>(behavior);
    const h = harness({ owner });
    const failure = expectCode(() => h.registry.register(key(h), artifact(h)), 'TRUSTED_DEPENDENCY_FAILURE');
    expect(failure.registryId).toBe(h.registry.snapshot().registryId);
    expect(h.registry.snapshot()).toMatchObject({ frozen: true, size: 0 });
    expectCode(() => h.registry.register(key(h), artifact(h)), 'REGISTRY_FROZEN');
    await Promise.resolve();
    await Promise.resolve();
  });

  test.each([
    ['throws Error', (): unknown => { throw new Error('compare secret'); }],
    ['throws primitive', (): unknown => { throw 17; }],
    ['returns non-boolean', (): unknown => 'yes'],
    ['resolves Promise', (): unknown => Promise.resolve(true)],
  ] as const)('artifact comparer %s freezes without replacing the entry', async (_name, behavior) => {
    let fail = false;
    const h = harness({ sameArtifact: (a, b) => fail ? behavior() as boolean : a === b });
    const shared = identity('shared');
    const item = register(h, 'source', 'event', shared);
    fail = true;
    expectCode(() => h.registry.lookupExisting(item.key, artifact(h, shared)), 'TRUSTED_DEPENDENCY_FAILURE');
    expect(h.registry.snapshot()).toMatchObject({ frozen: true, size: 1 });
    await Promise.resolve();
    await Promise.resolve();
  });

  test.each([
    ['throws Error', (): unknown => { throw new Error('evidence secret'); }],
    ['throws primitive', (): unknown => { throw false; }],
    ['returns value', (): unknown => true],
    ['rejects Promise', (): unknown => Promise.reject(new Error('evidence async secret'))],
  ] as const)('continuation verifier %s freezes without minting a usable permit', async (_name, behavior) => {
    const verify = jest.fn<unknown, [unknown]>(behavior);
    const h = harness({ verify });
    const item = unknown(h);
    expectCode(() => h.registry.authorizeContinuation(item.confirmation, {}), 'TRUSTED_DEPENDENCY_FAILURE');
    expect(h.registry.snapshot()).toMatchObject({ frozen: true, size: 1 });
    expectCode(() => h.registry.authorizeContinuation(item.confirmation, {}), 'REGISTRY_FROZEN');
    await Promise.resolve();
    await Promise.resolve();
  });

  test('a forged same-registry error thrown by a callback is still a trusted dependency failure', () => {
    const fake = new OperationRegistryError('INVALID_LEASE', 'forged-id', 'forged');
    const h = harness({ registryId: 'forged-id', owner: jest.fn(() => { throw fake; }) });
    const failure = expectCode(() => h.registry.register(key(h), artifact(h)), 'TRUSTED_DEPENDENCY_FAILURE');
    expect(failure.cause).toBe(fake);
    expect(h.registry.snapshot().frozen).toBe(true);
  });

  test('rejected trusted promises are observed internally and never become unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const h = harness({ owner: jest.fn(() => Promise.reject(new Error('observed internally'))) });
      expectCode(() => h.registry.register(key(h), artifact(h)), 'TRUSTED_DEPENDENCY_FAILURE');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  test.each([false, true])('reentry freezes permanently whether the callback catches it: caught=%s', (caught) => {
    let registry!: OperationRegistry;
    let issuer!: OperationRegistryCapabilityIssuer;
    const owner = jest.fn(() => {
      const nested = (): unknown => registry.lookupExisting(issuer.issueKey('nested', 'nested'), issuer.issueComparisonArtifact(identity('nested')));
      if (caught) {
        try { nested(); } catch { /* trusted dependency tried to suppress the violation */ }
        return undefined;
      }
      return nested();
    });
    issuer = createOperationRegistryCapabilityIssuer({
      registryId: `reentry-${String(caught)}`, datasetEpoch: 'epoch', processRunId: 'run', ownerId: 'owner',
      sameArtifact: (a, b) => a === b,
    });
    registry = createOperationRegistry({
      capabilities: issuer, writeRunClaim: issuer.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: owner, assertContinuationEvidence: () => undefined,
    });
    const error = expectCode(
      () => registry.register(issuer.issueKey('source', 'event'), issuer.issueComparisonArtifact(identity('artifact'))),
      caught ? 'REGISTRY_FROZEN' : 'REENTRANT',
    );
    expect(error.registryId).toBe(`reentry-${String(caught)}`);
    expect(registry.snapshot()).toMatchObject({ frozen: true, size: 0 });
    expectCode(() => registry.register(issuer.issueKey('later', 'later'), issuer.issueComparisonArtifact(identity('later'))),
      'REGISTRY_FROZEN');
  });

  test('an owner-stale late callback freezes before mutating its entry or unrelated capacity', () => {
    let current = true;
    const owner = jest.fn(() => {
      if (!current) throw new Error('stale owner secret');
    });
    const h = harness({ capacity: 2, owner });
    const first = register(h, 'source', 'first');
    register(h, 'source', 'second');
    current = false;
    expectCode(() => h.registry.markUnknown(first.lease), 'TRUSTED_DEPENDENCY_FAILURE');
    expect(h.registry.snapshot()).toMatchObject({ frozen: true, size: 2 });
  });
});

describe('G05c construction, diagnostics, secrecy, and static boundary', () => {
  test('construction rejects missing dependencies, foreign claims, and invalid capacities without creating entries', () => {
    const h = harness();
    const base = {
      capabilities: h.issuer, writeRunClaim: h.issuer.issueWriteRunClaim('WRITABLE'),
      assertOwnerCurrent: () => undefined, assertContinuationEvidence: () => undefined,
    };
    for (const options of [null, { ...base, capabilities: null }, { ...base, writeRunClaim: null },
      { ...base, assertOwnerCurrent: null }, { ...base, assertContinuationEvidence: null }]) {
      expect(() => createOperationRegistry(options as never)).toThrow(TypeError);
    }
    expect(() => createOperationRegistry({ ...base, capabilities: Object.freeze({}) as OperationRegistryCapabilityIssuer }))
      .toThrow(TypeError);
    for (const capacity of [0, -1, 1.5, 4_097, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createOperationRegistry({ ...base, capacity })).toThrow(TypeError);
    }
  });

  test('public errors and snapshots expose diagnostics but no artifact identity, result payload, or secret reference details', () => {
    const secret = 'TOP-SECRET-ARTIFACT';
    const h = harness({ registryId: 'safe-registry' });
    const item = register(h, 'source', 'event', identity(secret));
    const error = expectCode(() => h.registry.register(item.key, artifact(h, identity('different-secret'))),
      'IDEMPOTENCY_CONFLICT');
    const serialized = JSON.stringify({ error, snapshot: h.registry.snapshot() });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('different-secret');
    expect(serialized).not.toContain('identity');
    expect(serialized).not.toContain('resultReference');
    expect(Object.keys(h.registry.snapshot()).sort()).toEqual([
      'capacity', 'claimDisposition', 'datasetEpoch', 'frozen', 'ownerId', 'processRunId', 'registryId', 'size',
    ]);
  });

  test('registry is not exported from package, application, access, or composition root surfaces', async () => {
    const projectRoot = path.resolve(__dirname, '../../..');
    for (const relative of [
      'src/index.ts', 'src/access/index.ts', 'src/access/application/index.ts',
      'src/composition/index.ts',
    ]) {
      const source = await readFile(path.join(projectRoot, relative), 'utf8');
      expect(source).not.toMatch(/operation-registry|createOperationRegistry|OperationRegistry/);
    }
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { exports: object };
    expect(packageJson.exports).toEqual(expect.not.objectContaining({
      './internal': expect.anything(), './operation-registry': expect.anything(),
    }));
  });

  test('production registry has no infrastructure, future-gate, raw comparison, retry, transaction, or parallel orchestration', async () => {
    const projectRoot = path.resolve(__dirname, '../../..');
    const source = await readFile(
      path.join(projectRoot, 'src/access/application/internal/operation-registry.ts'), 'utf8',
    );
    const forbidden = [
      /from\s+['"][^'"]*(?:mongo|http|nest|auth)[^'"]*['"]/iu,
      /\b(?:G10|G11|withTransaction|Promise\.all|retry|setTimeout|setInterval)\b/u,
      /(?:timingSafeEqual|createHmac|JSON\.stringify|Buffer\.(?:from|compare)|\.equals\s*\()/u,
      /\b(?:delete|evict|ttl|expire|expiration)\b/iu,
    ];
    for (const pattern of forbidden) expect(source).not.toMatch(pattern);
  });
});
