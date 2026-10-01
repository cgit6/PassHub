import type { ClientSession } from 'mongodb';

import {
  createBudgetLedger,
  type BudgetLedger,
} from '../../src/access/application/internal/budget-ledger.js';
import {
  createPrecommitTerminationLifecycle,
  type PrecommitTerminationLifecycle,
} from '../../src/access/application/internal/precommit-termination-lifecycle.js';
import {
  G10bPrecommitMongoTerminatorError,
  createG10bPrecommitMongoTerminator,
} from '../../src/infrastructure/mongo/internal/g10b-precommit-mongo-terminator.js';

class Clock {
  nowMs(): number { return 1_000; }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function createLifecycle(ownerFence: { readonly assertCurrent: () => void } = { assertCurrent: () => undefined }): PrecommitTerminationLifecycle {
  const ledger: BudgetLedger = createBudgetLedger({
    clock: new Clock(),
    ownerFence,
    operationId: 'g10b-mongo-terminator',
    assertContinuationEvidence: () => undefined,
  });
  const round = ledger.beginRound();
  ledger.finishRound(round);
  ledger.startConfirmation('PRECOMMIT_CLEANUP');
  return createPrecommitTerminationLifecycle({ ledger, ownerFence });
}

describe('G10b internal Mongo precommit terminator', () => {
  test('synchronously seals caller scope, records a synchronous driver abort exception as uncertain, and calls the high-level driver API exactly once', async () => {
    const calls: string[] = [];
    const lifecycle = createLifecycle();
    const abortTransaction = jest.fn((options?: { readonly timeoutMS?: number }) => {
      calls.push(`abort:${options?.timeoutMS ?? 'missing'}`);
      throw new Error('driver abort exception');
    });
    const endSession = jest.fn(async () => {
      expect(lifecycle.snapshot()).toMatchObject({ phase: 'TERMINATED', activeGroup: false, abortCommandInFlight: false });
      calls.push('endSession');
    });
    const session = { abortTransaction, endSession } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession'>;
    const terminator = createG10bPrecommitMongoTerminator({
      session,
      lifecycle,
      scopeFence: { sealPrecommitScope: () => { calls.push('scope-sealed'); } },
    });

    await expect(terminator.terminatePrecommit()).resolves.toEqual({ outcome: 'STILL_UNKNOWN', abortAttempts: 1 });
    expect(calls).toEqual(['scope-sealed', 'abort:2000', 'endSession']);
    expect(abortTransaction).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'TERMINATED', activeGroup: false, abortCommandInFlight: false });

    await expect(terminator.terminatePrecommit()).rejects.toBeInstanceOf(G10bPrecommitMongoTerminatorError);
    await expect(terminator.terminatePrecommit()).rejects.toMatchObject({ code: 'TERMINATOR_CLOSED' });
    expect(calls).toEqual(['scope-sealed', 'abort:2000', 'endSession']);
  });

  test('does not begin endSession while the lifecycle-owned abort Promise remains unsettled', async () => {
    const calls: string[] = [];
    const pending = deferred();
    const lifecycle = createLifecycle();
    const session = {
      abortTransaction: jest.fn(() => { calls.push('abort'); return pending.promise; }),
      endSession: jest.fn(async () => {
        expect(lifecycle.snapshot()).toMatchObject({ phase: 'TERMINATED', activeGroup: false, abortCommandInFlight: false });
        calls.push('endSession');
      }),
    } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession'>;
    const terminator = createG10bPrecommitMongoTerminator({
      session,
      lifecycle,
      scopeFence: { sealPrecommitScope: () => { calls.push('scope-sealed'); } },
    });

    const result = terminator.terminatePrecommit();
    await Promise.resolve();
    expect(calls).toEqual(['scope-sealed', 'abort']);
    expect(lifecycle.snapshot()).toMatchObject({ activeGroup: true, abortCommandInFlight: true });

    pending.resolve();
    await expect(result).resolves.toEqual({ outcome: 'NO_EFFECT_CONFIRMED', abortAttempts: 1 });
    expect(calls).toEqual(['scope-sealed', 'abort', 'endSession']);
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'TERMINATED', activeGroup: false, abortCommandInFlight: false });
  });

  test('closes its API before a pending endSession settles, so it cannot issue a late abort', async () => {
    const calls: string[] = [];
    const ending = deferred();
    const lifecycle = createLifecycle();
    const abortTransaction = jest.fn(async () => { calls.push('abort'); });
    const endSession = jest.fn(() => { calls.push('endSession'); return ending.promise; });
    const terminator = createG10bPrecommitMongoTerminator({
      session: { abortTransaction, endSession } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession'>,
      lifecycle,
      scopeFence: { sealPrecommitScope: () => { calls.push('scope-sealed'); } },
    });

    const result = terminator.terminatePrecommit();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(calls).toEqual(['scope-sealed', 'abort', 'endSession']);
    await expect(terminator.terminatePrecommit()).rejects.toMatchObject({ code: 'TERMINATOR_CLOSED' });
    expect(calls).toEqual(['scope-sealed', 'abort', 'endSession']);

    ending.resolve();
    await expect(result).resolves.toEqual({ outcome: 'NO_EFFECT_CONFIRMED', abortAttempts: 1 });
    expect(calls).toEqual(['scope-sealed', 'abort', 'endSession']);
  });

  test('rejects an asynchronous scope fence before any ClientSession command', async () => {
    const abortTransaction = jest.fn(async () => undefined);
    const endSession = jest.fn(async () => undefined);
    const lifecycle = createLifecycle();
    const terminator = createG10bPrecommitMongoTerminator({
      session: { abortTransaction, endSession } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession'>,
      lifecycle,
      scopeFence: { sealPrecommitScope: (() => Promise.resolve()) as unknown as () => void },
    });

    await expect(terminator.terminatePrecommit()).rejects.toMatchObject({ code: 'SCOPE_FENCE_INVALID' });
    expect(abortTransaction).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'OPEN', activeGroup: false });
  });

  test('does not allow a presealed unknown-commit lifecycle to enter the abort seam', async () => {
    const abortTransaction = jest.fn(async () => undefined);
    const endSession = jest.fn(async () => undefined);
    const sealPrecommitScope = jest.fn(() => undefined);
    const lifecycle = createLifecycle();
    lifecycle.sealScope('COMMIT_UNKNOWN');
    const terminator = createG10bPrecommitMongoTerminator({
      session: { abortTransaction, endSession } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession'>,
      lifecycle,
      scopeFence: { sealPrecommitScope },
    });

    await expect(terminator.terminatePrecommit()).rejects.toMatchObject({ code: 'UNKNOWN_COMMIT_FORBIDDEN' });
    expect(sealPrecommitScope).not.toHaveBeenCalled();
    expect(abortTransaction).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
  });

  test('an asynchronous driver abort rejection is terminal STILL_UNKNOWN, precedes endSession, and never gets a second high-level call', async () => {
    const calls: string[] = [];
    const lifecycle = createLifecycle();
    const abortTransaction = jest.fn(async () => {
      calls.push('abort');
      throw new Error('abort failed');
    });
    const endSession = jest.fn(async () => {
      expect(lifecycle.snapshot()).toMatchObject({ phase: 'TERMINATED', activeGroup: false, abortCommandInFlight: false });
      calls.push('endSession');
    });
    const terminator = createG10bPrecommitMongoTerminator({
      session: { abortTransaction, endSession } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession'>,
      lifecycle,
      scopeFence: { sealPrecommitScope: () => { calls.push('scope-sealed'); } },
    });

    await expect(terminator.terminatePrecommit()).resolves.toEqual({ outcome: 'STILL_UNKNOWN', abortAttempts: 1 });
    expect(calls).toEqual(['scope-sealed', 'abort', 'endSession']);
    expect(abortTransaction).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'TERMINATED', activeGroup: false, abortCommandInFlight: false });

    await expect(terminator.terminatePrecommit()).rejects.toMatchObject({ code: 'TERMINATOR_CLOSED' });
    expect(calls).toEqual(['scope-sealed', 'abort', 'endSession']);
  });

  test('propagates a lifecycle owner failure after a driver callback without retrying or ending the session', async () => {
    let ownerIsStale = false;
    const ownerFence = {
      assertCurrent: () => {
        if (ownerIsStale) throw new Error('owner became stale while settling abort');
      },
    };
    const lifecycle = createLifecycle(ownerFence);
    const abortTransaction = jest.fn(async () => { ownerIsStale = true; });
    const endSession = jest.fn(async () => undefined);
    const terminator = createG10bPrecommitMongoTerminator({
      session: { abortTransaction, endSession } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession'>,
      lifecycle,
      scopeFence: { sealPrecommitScope: () => undefined },
    });

    await expect(terminator.terminatePrecommit()).rejects.toMatchObject({ code: 'OWNER_STALE' });
    expect(abortTransaction).toHaveBeenCalledTimes(1);
    expect(endSession).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toMatchObject({ frozen: true, activeGroup: true, abortCommandsAdmitted: 1 });
  });

});
