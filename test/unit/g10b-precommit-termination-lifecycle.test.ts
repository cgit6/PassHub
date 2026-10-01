import {
  BudgetLedgerError,
  createBudgetLedger,
  type BudgetErrorCode,
  type BudgetLedger,
} from '../../src/access/application/internal/budget-ledger.js';
import {
  PrecommitTerminationError,
  createPrecommitTerminationLifecycle,
  type PrecommitTerminationErrorCode,
  type PrecommitTerminationLifecycle,
} from '../../src/access/application/internal/precommit-termination-lifecycle.js';

class Clock {
  value: number;

  constructor(value = 1_000) {
    this.value = value;
  }

  nowMs(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

interface Harness {
  readonly clock: Clock;
  readonly ledger: BudgetLedger;
  readonly lifecycle: PrecommitTerminationLifecycle;
  readonly assertOwner: jest.Mock<void, []>;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void; readonly reject: (error: unknown) => void } {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createHarness(): Harness {
  const clock = new Clock();
  const assertOwner = jest.fn<void, []>(() => undefined);
  const ledger = createBudgetLedger({
    clock,
    ownerFence: { assertCurrent: assertOwner },
    operationId: 'g10b-precommit-lifecycle',
    assertContinuationEvidence: () => undefined,
  });
  const lifecycle = createPrecommitTerminationLifecycle({ ledger, ownerFence: { assertCurrent: assertOwner } });
  return { clock, ledger, lifecycle, assertOwner };
}

function preparePrecommit(h: Harness): void {
  const round = h.ledger.beginRound();
  h.ledger.finishRound(round);
  h.ledger.startConfirmation('PRECOMMIT_CLEANUP');
  h.lifecycle.sealScope('PRECOMMIT');
}

function expectLifecycleCode(work: () => unknown, code: PrecommitTerminationErrorCode): PrecommitTerminationError {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PrecommitTerminationError);
    expect((error as PrecommitTerminationError).code).toBe(code);
    return error as PrecommitTerminationError;
  }
  throw new Error(`expected PrecommitTerminationError ${code}`);
}

function expectBudgetCode(work: () => unknown, code: BudgetErrorCode): BudgetLedgerError {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BudgetLedgerError);
    expect((error as BudgetLedgerError).code).toBe(code);
    return error as BudgetLedgerError;
  }
  throw new Error(`expected BudgetLedgerError ${code}`);
}

describe('G10b precommit termination lifecycle', () => {
  test('only the current owner can seal scope, and reservation is impossible before that seal', () => {
    const h = createHarness();
    expectLifecycleCode(() => h.lifecycle.reserveAbortGroup(), 'SCOPE_NOT_SEALED');

    preparePrecommit(h);
    expect(h.assertOwner).toHaveBeenCalled();
    expect(h.lifecycle.snapshot()).toMatchObject({
      phase: 'SEALED_PRECOMMIT', scope: 'PRECOMMIT', activeGroup: false, abortCommandsAdmitted: 0,
    });
  });

  test('a sealed unknown commit closes without abort and permanently rejects late abort admission', () => {
    const h = createHarness();
    h.lifecycle.sealScope('COMMIT_UNKNOWN');

    expectLifecycleCode(() => h.lifecycle.reserveAbortGroup(), 'UNKNOWN_COMMIT_ABORT_FORBIDDEN');
    expect(h.ledger.snapshot()).toMatchObject({ nativeGroupsReserved: 0, nativeGroupActive: false });
    h.lifecycle.closeUnknownCommit();
    expect(h.lifecycle.snapshot()).toMatchObject({ phase: 'TERMINATED', frozen: false, activeGroup: false });
    expectLifecycleCode(() => h.lifecycle.reserveAbortGroup(), 'LIFECYCLE_TERMINATED');
  });

  test('reserves the existing native group and lifecycle-owns exactly two settled one-shot abort sends', async () => {
    const h = createHarness();
    preparePrecommit(h);
    const group = h.lifecycle.reserveAbortGroup();
    expect(group.timeoutMs).toBe(2_000);
    expect(h.ledger.snapshot()).toMatchObject({ nativeGroupsReserved: 1, nativeGroupActive: true, confirmationSlotsRemaining: 5 });

    const sends: Array<Readonly<{ readonly attempt: number; readonly timeoutMs: number }>> = [];
    await h.lifecycle.executeAbort(group, (context) => { sends.push(context); });
    await h.lifecycle.executeAbort(group, (context) => { sends.push(context); });

    expect(sends).toEqual([{ attempt: 0, timeoutMs: 2_000 }, { attempt: 1, timeoutMs: 2_000 }]);
    expectBudgetCode(() => h.lifecycle.executeAbort(group, () => undefined), 'NATIVE_GROUP_COMMANDS_EXHAUSTED');
    expect(h.lifecycle.snapshot()).toMatchObject({ abortCommandsAdmitted: 2, abortCommandInFlight: false });
  });

  test('a native group shares its existing two-second deadline across lifecycle-owned sends', async () => {
    const h = createHarness();
    preparePrecommit(h);
    const group = h.lifecycle.reserveAbortGroup();
    await h.lifecycle.executeAbort(group, () => undefined);

    h.clock.advance(1_999);
    let secondTimeout: number | null = null;
    await h.lifecycle.executeAbort(group, (context) => { secondTimeout = context.timeoutMs; });
    expect(secondTimeout).toBe(1);
    h.clock.advance(1);
    expectBudgetCode(() => h.lifecycle.executeAbort(group, () => undefined), 'NATIVE_GROUP_COMMANDS_EXHAUSTED');
  });

  test('the lifecycle refuses termination while its owned async abort send remains unsettled', async () => {
    const h = createHarness();
    preparePrecommit(h);
    const group = h.lifecycle.reserveAbortGroup();
    const pending = deferred();
    const abort = h.lifecycle.executeAbort(group, () => pending.promise);

    expectLifecycleCode(() => h.lifecycle.terminate(group, 'STILL_UNKNOWN'), 'ABORT_GROUP_UNSETTLED');
    expect(h.lifecycle.snapshot()).toMatchObject({ abortCommandInFlight: true, abortCommandsAdmitted: 1 });
    pending.resolve();
    await abort;
    h.lifecycle.terminate(group, 'STILL_UNKNOWN');
    expect(h.lifecycle.snapshot()).toMatchObject({
      phase: 'TERMINATED', activeGroup: false, abortCommandsAdmitted: 1, abortCommandInFlight: false,
    });
  });

  test('an asynchronous sender rejection preserves its original error after it settles its owned permit', async () => {
    const h = createHarness();
    preparePrecommit(h);
    const group = h.lifecycle.reserveAbortGroup();
    const failure = new Error('driver abort rejected');
    await expect(h.lifecycle.executeAbort(group, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(h.lifecycle.snapshot()).toMatchObject({ abortCommandInFlight: false, abortCommandsAdmitted: 1 });

    await h.lifecycle.executeAbort(group, () => undefined);
    h.lifecycle.terminate(group, 'NO_EFFECT_CONFIRMED');
    expectLifecycleCode(() => h.lifecycle.reserveAbortGroup(), 'LIFECYCLE_TERMINATED');
    expect(h.ledger.snapshot()).toMatchObject({ nativeGroupActive: false, nativeGroupsReserved: 1 });
  });

  test('a synchronous sender rejection preserves its original error after it settles its owned permit', async () => {
    const h = createHarness();
    preparePrecommit(h);
    const group = h.lifecycle.reserveAbortGroup();
    const failure = new Error('driver abort threw');

    await expect(h.lifecycle.executeAbort(group, () => { throw failure; })).rejects.toBe(failure);
    expect(h.lifecycle.snapshot()).toMatchObject({ abortCommandInFlight: false, abortCommandsAdmitted: 1 });
  });

  test('termination closes the lifecycle-owned send gate, so no callback can run late', async () => {
    const h = createHarness();
    preparePrecommit(h);
    const group = h.lifecycle.reserveAbortGroup();
    const send = jest.fn<void, []>(() => undefined);
    await h.lifecycle.executeAbort(group, send);
    h.lifecycle.terminate(group, 'NO_EFFECT_CONFIRMED');

    expectLifecycleCode(() => h.lifecycle.executeAbort(group, send), 'ABORT_GROUP_TERMINATED');
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.snapshot()).toMatchObject({ frozen: false, abortCommandInFlight: false, phase: 'TERMINATED' });
  });
});
