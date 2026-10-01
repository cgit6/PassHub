import {
  createPostCommitUnknownRecoveryOwner,
  createWriteOperationCoordinatorBundle,
  type PostCommitUnknownRecoveryLease,
  type WriteOperationContext,
  type WriteOperationExecutorChannels,
  type WriteOperationSettlement,
} from '../../src/access/application/internal/write-operation-coordinator.js';

type Channels = WriteOperationExecutorChannels<string, string, string, string, string, string, string, string>;

function channels(overrides: Partial<Channels> = {}): Channels {
  const persisted = (input: string, _context: WriteOperationContext, settlement: WriteOperationSettlement<string>): void => {
    settlement.businessResultPersisted(input);
  };
  return {
    managementCreate: persisted,
    managementUpdate: persisted,
    managementRevoke: persisted,
    recognition: persisted,
    ...overrides,
  };
}

function bundle(overrides: Partial<Channels> = {}) {
  return createWriteOperationCoordinatorBundle({
    clock: { nowMs: () => 1_000 },
    executors: channels(overrides),
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function pendingState<T>(promise: Promise<T>): Promise<'resolved' | 'rejected' | 'pending'> {
  return Promise.race([
    promise.then(() => 'resolved' as const, () => 'rejected' as const),
    Promise.resolve('pending' as const),
  ]);
}

describe('G10c write-operation post-commit unknown recovery lease', () => {
  test('pauses the current writer, preserves its owner, and does not auto-unblock FIFO after a controlled persisted-result terminal', async () => {
    let lease!: PostCommitUnknownRecoveryLease;
    let context!: WriteOperationContext;
    const second = jest.fn((input: string, _context: WriteOperationContext, settlement: WriteOperationSettlement<string>) => {
      settlement.businessResultPersisted(input);
    });
    const coordinator = bundle({
      managementCreate: (_input, receivedContext, settlement) => {
        context = receivedContext;
        lease = settlement.pausePostCommitUnknown(new Error('post-commit response lost'));
      },
      managementUpdate: second,
    });
    const first = coordinator.managementCreate.enqueue('first');
    const queued = coordinator.managementUpdate.enqueue('second');

    await flushMicrotasks();
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Reflect.ownKeys(lease)).toEqual([]);
    expect(() => context.assertCurrent()).not.toThrow();
    expect(second).not.toHaveBeenCalled();
    await expect(pendingState(first)).resolves.toBe('pending');
    await expect(pendingState(queued)).resolves.toBe('pending');

    const owner = createPostCommitUnknownRecoveryOwner(coordinator);
    const handle = owner.adopt(lease);
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Reflect.ownKeys(owner)).toEqual(['adopt']);
    expect(Reflect.ownKeys(handle)).toEqual(['assertCurrent', 'businessResultPersisted', 'failClosed']);
    expect(() => handle.assertCurrent()).not.toThrow();
    expect(() => context.owner.assertCurrent()).not.toThrow();

    handle.businessResultPersisted('confirmed-first');
    await expect(first).resolves.toBe('confirmed-first');
    await expect(pendingState(queued)).resolves.toBe('pending');
    expect(second).not.toHaveBeenCalled();
    await expect(coordinator.recognition.enqueue('later')).rejects.toThrow('blocked by unknown effect');
    expect(() => handle.assertCurrent()).toThrow('not paused');
    expect(() => context.assertCurrent()).toThrow('not current');
  });

  test('rejects forged, foreign, and duplicate adoption without changing the paused writer', async () => {
    let lease!: PostCommitUnknownRecoveryLease;
    const first = bundle({
      recognition: (_input, _context, settlement) => {
        lease = settlement.pausePostCommitUnknown(new Error('unknown'));
      },
    });
    const second = bundle();
    const completion = first.recognition.enqueue('input');
    await flushMicrotasks();
    const owner = createPostCommitUnknownRecoveryOwner(first);
    const duplicateOwner = createPostCommitUnknownRecoveryOwner(first);
    const foreignOwner = createPostCommitUnknownRecoveryOwner(second);

    expect(() => foreignOwner.adopt(lease)).toThrow(TypeError);
    expect(() => owner.adopt(Object.freeze({}) as PostCommitUnknownRecoveryLease)).toThrow(TypeError);
    expect(() => owner.adopt.call(foreignOwner, lease)).toThrow(TypeError);
    const handle = owner.adopt(lease);
    expect(() => owner.adopt(lease)).toThrow('already adopted');
    expect(() => duplicateOwner.adopt(lease)).toThrow('already adopted');
    expect(() => handle.assertCurrent.call(Object.freeze({}))).toThrow(TypeError);
    await expect(pendingState(completion)).resolves.toBe('pending');

    const terminal = new Error('cannot prove committed result');
    handle.failClosed(terminal);
    await expect(completion).rejects.toBe(terminal);
  });

  test('invalid or late pause requests retain the existing fail-closed unknown behavior', async () => {
    let settlement!: WriteOperationSettlement<string>;
    const coordinator = bundle({
      managementCreate: (_input, _context, receivedSettlement) => {
        settlement = receivedSettlement;
        settlement.unknownEffect(new Error('ordinary unknown'));
      },
    });
    await expect(coordinator.managementCreate.enqueue('input')).rejects.toThrow('ordinary unknown');
    expect(() => settlement.pausePostCommitUnknown(new Error('too late'))).toThrow('not current');

    let invalidLease!: PostCommitUnknownRecoveryLease;
    const malformed = bundle({
      managementCreate: (_input, _context, receivedSettlement) => {
        invalidLease = receivedSettlement.pausePostCommitUnknown(new Error('unknown'));
        receivedSettlement.businessResultPersisted('illegal second settlement');
      },
    });
    await expect(malformed.managementCreate.enqueue('input')).rejects.toThrow('post-commit unknown recovery pause is invalid');
    const owner = createPostCommitUnknownRecoveryOwner(malformed);
    expect(() => owner.adopt(invalidLease)).toThrow('not paused');
  });

  test('a recovery fail-closed terminal keeps later writers blocked', async () => {
    let lease!: PostCommitUnknownRecoveryLease;
    const next = jest.fn();
    const coordinator = bundle({
      managementCreate: (_input, _context, settlement) => {
        lease = settlement.pausePostCommitUnknown(new Error('unknown'));
      },
      managementUpdate: next,
    });
    const first = coordinator.managementCreate.enqueue('first');
    const queued = coordinator.managementUpdate.enqueue('next');
    await flushMicrotasks();

    const owner = createPostCommitUnknownRecoveryOwner(coordinator);
    const terminal = new Error('recovery inconclusive');
    owner.adopt(lease).failClosed(terminal);
    await expect(first).rejects.toBe(terminal);
    await expect(pendingState(queued)).resolves.toBe('pending');
    expect(next).not.toHaveBeenCalled();
    await expect(coordinator.recognition.enqueue('later')).rejects.toThrow('blocked by unknown effect');
  });
});
