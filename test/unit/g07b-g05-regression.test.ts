import {
  OperationRegistryError,
  createOperationRegistry,
  createOperationRegistryCapabilityIssuer,
  createWriteOperationCoordinatorBundle,
  type OperationComparisonArtifact,
  type OperationRegistryKey,
} from '../../src/access/application/internal/index.js';

function registryHarness(capacity = 4096, disposition: 'WRITABLE' | 'READ_ONLY' = 'WRITABLE') {
  const capabilities = createOperationRegistryCapabilityIssuer({ registryId: `r-${capacity}-${disposition}`, datasetEpoch: 'epoch', processRunId: 'run', ownerId: 'owner',
    sameArtifact: (a, b) => (a as { value: string }).value === (b as { value: string }).value });
  const registry = createOperationRegistry({ capabilities, writeRunClaim: capabilities.issueWriteRunClaim(disposition), capacity,
    assertOwnerCurrent: () => undefined, assertContinuationEvidence: () => undefined });
  const key = (id: string): OperationRegistryKey => capabilities.issueKey('source', id);
  const artifact = (value: string): OperationComparisonArtifact => capabilities.issueComparisonArtifact(Object.freeze({ value }));
  return { capabilities, registry, key, artifact };
}

describe('G07b supplemental G05c reservation regression', () => {
  test('4096 reservations are admitted and 4097 is rejected without changing counts', () => {
    const h = registryHarness();
    const reservations = Array.from({ length: 4096 }, () => h.registry.reserveCandidate());
    expect(h.registry.snapshot()).toMatchObject({ size: 0, reserved: 4096, capacity: 4096 });
    expect(() => h.registry.reserveCandidate()).toThrow(expect.objectContaining({ code: 'REGISTRY_CAPACITY_EXHAUSTED' }));
    expect(h.registry.snapshot()).toMatchObject({ size: 0, reserved: 4096 });
    for (const reservation of reservations) h.registry.releaseReservation(reservation);
    expect(h.registry.snapshot()).toMatchObject({ size: 0, reserved: 0 });
  });

  test('legacy entries and reservations share capacity; release is foreign/double fenced', () => {
    const h = registryHarness(2); const foreign = registryHarness(2);
    h.registry.register(h.key('legacy'), h.artifact('a'));
    const reserved = h.registry.reserveCandidate();
    expect(() => h.registry.reserveCandidate()).toThrow(OperationRegistryError);
    expect(() => foreign.registry.releaseReservation(reserved)).toThrow(expect.objectContaining({ code: 'INVALID_RESERVATION' }));
    h.registry.releaseReservation(reserved);
    expect(() => h.registry.releaseReservation(reserved)).toThrow(expect.objectContaining({ code: 'RESERVATION_ALREADY_USED' }));
  });

  test('registerReserved consumes reservation for new, join, replay and conflict paths', () => {
    const h = registryHarness(4); const observation = () => h.capabilities.issueObservationReference();
    const r1 = h.registry.reserveCandidate();
    const first = h.registry.registerReserved(r1, h.key('new'), h.artifact('same'), observation());
    expect(first.kind).toBe('REGISTERED'); expect(h.registry.snapshot()).toMatchObject({ size: 1, reserved: 0 });
    const r2 = h.registry.reserveCandidate();
    expect(h.registry.registerReserved(r2, h.key('new'), h.artifact('same'), observation()).kind).toBe('JOINED');
    expect(h.registry.snapshot().reserved).toBe(0);
    const r3 = h.registry.reserveCandidate();
    expect(() => h.registry.registerReserved(r3, h.key('new'), h.artifact('different'), observation()))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(h.registry.snapshot().reserved).toBe(0);
    if (first.kind !== 'REGISTERED') throw new Error('unreachable');
    h.registry.completeCanonical(first.lease, h.capabilities.issueResultReference());
    const r4 = h.registry.reserveCandidate();
    expect(h.registry.registerReserved(r4, h.key('new'), h.artifact('same'), observation()).kind).toBe('REPLAY_CANONICAL');
    expect(h.registry.snapshot().reserved).toBe(0);
  });

  test('read-only management permits lookup but rejects legacy and reservation writes', () => {
    const writable = registryHarness(1); const registered = writable.registry.register(writable.key('x'), writable.artifact('a'));
    expect(registered.kind).toBe('REGISTERED');
    const readOnly = registryHarness(1, 'READ_ONLY');
    expect(readOnly.registry.lookupExisting(readOnly.key('x'), readOnly.artifact('a')).kind).toBe('NOT_PROVEN');
    expect(() => readOnly.registry.reserveCandidate()).toThrow(expect.objectContaining({ code: 'WRITE_NOT_ALLOWED' }));
    expect(() => readOnly.registry.register(readOnly.key('x'), readOnly.artifact('a'))).toThrow(expect.objectContaining({ code: 'WRITE_NOT_ALLOWED' }));
  });
});

describe('G07b supplemental G05a provisional regression', () => {
  test('slow head does not spin or get overtaken; same-ms receipts use sequence', async () => {
    const calls: string[] = [];
    const executor = async (input: string, _context: unknown, settlement: { businessResultPersisted(value: string): void }) => {
      calls.push(input); settlement.businessResultPersisted(input);
    };
    const bundle = createWriteOperationCoordinatorBundle({ clock: { nowMs: () => 7 }, monotonicClock: { nowMs: () => 9 },
      executors: { managementCreate: executor, managementUpdate: executor, managementRevoke: executor, recognition: executor } });
    const head = bundle.managementCreate.registerProvisional(); const tail = bundle.recognition.registerProvisional();
    expect([head.receipt.receivedAtMs, tail.receipt.receivedAtMs]).toEqual([7, 7]);
    expect([head.receipt.sequence, tail.receipt.sequence]).toEqual([0n, 1n]);
    tail.activate('tail'); await Promise.resolve(); await Promise.resolve(); expect(calls).toEqual([]);
    head.activate('head'); await expect(head.completion).resolves.toBe('head'); await expect(tail.completion).resolves.toBe('tail');
    expect(calls).toEqual(['head', 'tail']);
  });

  test('later prestart rejection settles immediately even while earlier operation becomes unknown', async () => {
    let unknown!: () => void; const observed: string[] = [];
    const executor = async (_input: string, _context: unknown, settlement: { unknownEffect(error: Error): void }) => {
      await new Promise<void>((resolve) => { unknown = () => { settlement.unknownEffect(new Error('unknown')); resolve(); }; });
    };
    const bundle = createWriteOperationCoordinatorBundle({ clock: { nowMs: () => 1 }, lifecycleObserver: { settled: (e) => { observed.push(e.disposition); } },
      executors: { managementCreate: executor, managementUpdate: executor, managementRevoke: executor, recognition: executor } });
    const first = bundle.managementCreate.registerProvisional(); const later = bundle.managementUpdate.registerProvisional();
    first.activate('first'); await Promise.resolve(); later.rejectBeforeStart(new Error('invalid'));
    await expect(later.completion).rejects.toThrow('invalid'); expect(observed).toEqual(['PRESTART_REJECTED']);
    unknown(); await expect(first.completion).rejects.toThrow('unknown'); expect(observed).toEqual(['PRESTART_REJECTED', 'UNKNOWN_EFFECT']);
  });

  test('observer thenable is rejected and blocks following work without unhandled rejection', async () => {
    const executor = (_input: string, _context: unknown, settlement: { businessResultPersisted(value: string): void }) => settlement.businessResultPersisted('ok');
    const bundle = createWriteOperationCoordinatorBundle({ clock: { nowMs: () => 1 }, lifecycleObserver: { settled: () => Promise.resolve() as never },
      executors: { managementCreate: executor, managementUpdate: executor, managementRevoke: executor, recognition: executor } });
    await expect(bundle.managementCreate.enqueue('x')).rejects.toThrow('lifecycle observer failed');
    await expect(bundle.managementCreate.enqueue('y')).rejects.toThrow('blocked');
  });
});
