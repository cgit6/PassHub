import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BudgetLedgerError,
  createBudgetLedger,
  type BudgetErrorCode,
  type BudgetLedger,
  type BudgetLedgerConfig,
  type BudgetLedgerOptions,
  type ConfirmationPermit,
  type RoundPermit,
} from '../../src/access/application/internal/budget-ledger.js';

class MonotonicClock {
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
  readonly clock: MonotonicClock;
  readonly ledger: BudgetLedger;
  readonly verify: jest.Mock<unknown, [unknown]>;
}

let operationSequence = 0;

function harness(overrides: Partial<BudgetLedgerOptions> = {}): Harness {
  const clock = (overrides.clock as MonotonicClock | undefined) ?? new MonotonicClock();
  const verify = (overrides.assertContinuationEvidence as jest.Mock<unknown, [unknown]> | undefined)
    ?? jest.fn<unknown, [unknown]>(() => undefined);
  operationSequence += 1;
  const ledger = createBudgetLedger({
    clock,
    ownerFence: { assertCurrent: () => undefined },
    operationId: `g05b-${operationSequence}`,
    assertContinuationEvidence: verify,
    ...overrides,
  });
  return { clock, ledger, verify };
}

function expectCode(work: () => unknown, code: BudgetErrorCode): BudgetLedgerError {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BudgetLedgerError);
    expect((error as BudgetLedgerError).code).toBe(code);
    return error as BudgetLedgerError;
  }
  throw new Error(`expected BudgetLedgerError ${code}`);
}

function finishRoundWithoutCommands(ledger: BudgetLedger): void {
  const round = ledger.beginRound();
  ledger.finishRound(round);
}

function startUnknownAfterRound(h: Harness): void {
  finishRoundWithoutCommands(h.ledger);
  h.ledger.startConfirmation('UNKNOWN_RESULT');
}

function settleNoEffect(h: Harness): ConfirmationPermit {
  const permit = h.ledger.admitNextUnknownConfirmation();
  h.ledger.settleNoEffectConfirmed(permit);
  return permit;
}

describe('G05b construction, capture, and execution budget', () => {
  test('defaults are captured and the 15 second execution clock starts only at first beginRound', () => {
    const h = harness();
    expect(h.ledger.snapshot()).toMatchObject({
      executionStartMs: null,
      executionDeadlineMs: null,
      roundsStarted: 0,
      confirmationSlotsRemaining: 7,
    });
    h.clock.advance(50_000); // construction and queue delay are free
    const round = h.ledger.beginRound();
    expect(round.round).toBe(1);
    expect(h.ledger.snapshot()).toMatchObject({ executionStartMs: 51_000, executionDeadlineMs: 66_000 });
  });

  test.each([
    ['executionMs', 0], ['executionMs', -1], ['executionMs', 1.5], ['executionMs', Number.MAX_SAFE_INTEGER + 1],
    ['singleCommandMs', 0], ['confirmationMs', Number.NaN], ['nativeGroupMs', Number.POSITIVE_INFINITY],
    ['maxRounds', 2], ['confirmationSlots', 6], ['nativeGroupSlots', 1],
  ] as const)('rejects invalid trusted config %s=%s', (key, value) => {
    expect(() => harness({ config: { [key]: value } })).toThrow(TypeError);
  });

  test('rejects missing construction dependencies and invalid operation ids', () => {
    const base = {
      clock: { nowMs: () => 0 }, ownerFence: { assertCurrent: () => undefined },
      operationId: 'op', assertContinuationEvidence: () => undefined,
    };
    for (const options of [
      null,
      { ...base, clock: null },
      { ...base, ownerFence: null },
      { ...base, assertContinuationEvidence: null },
      { ...base, operationId: '' },
    ]) expect(() => createBudgetLedger(options as never)).toThrow(TypeError);
  });

  test('captures trusted methods, verifier, operation id, and every config scalar against later mutation', () => {
    const clockState = { value: 10, nowMs() { return this.value; } };
    const ownerState = { calls: 0, assertCurrent() { this.calls += 1; } };
    const verifier = jest.fn(() => undefined);
    const config: Partial<BudgetLedgerConfig> = {
      executionMs: 30, singleCommandMs: 7, confirmationMs: 20, nativeGroupMs: 9,
    };
    const options: BudgetLedgerOptions = {
      clock: clockState, ownerFence: ownerState, operationId: 'captured',
      assertContinuationEvidence: verifier, config,
    };
    const ledger = createBudgetLedger(options);
    clockState.nowMs = () => 999;
    ownerState.assertCurrent = () => { throw new Error('mutated'); };
    (options as unknown as { assertContinuationEvidence: (evidence: unknown) => unknown }).assertContinuationEvidence = () => { throw new Error('mutated'); };
    (config as { executionMs: number }).executionMs = 999;
    (config as { singleCommandMs: number }).singleCommandMs = 999;
    const round = ledger.beginRound();
    expect(ledger.snapshot()).toMatchObject({ operationId: 'captured', executionStartMs: 10, executionDeadlineMs: 40 });
    const command = ledger.admitExecutionCommand(round, 'CRUD');
    expect(command.timeoutMs).toBe(7);
    ledger.finishExecutionCommand(command);
    ledger.finishRound(round);
    ledger.startConfirmation('UNKNOWN_RESULT');
    const confirmation = ledger.admitNextUnknownConfirmation();
    ledger.settleNoEffectConfirmed(confirmation);
    ledger.authorizeContinuation({});
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(ownerState.calls).toBeGreaterThan(0);
  });

  test('admits three rounds, rejects a fourth, and lets the third admitted round finish late', () => {
    const h = harness();
    finishRoundWithoutCommands(h.ledger);
    finishRoundWithoutCommands(h.ledger);
    const third = h.ledger.beginRound();
    h.clock.advance(15_000);
    expectCode(() => h.ledger.admitExecutionCommand(third, 'CRUD'), 'EXECUTION_DEADLINE');
    expect(() => h.ledger.finishRound(third)).not.toThrow();
    expectCode(() => h.ledger.beginRound(), 'EXECUTION_ROUNDS_EXHAUSTED');
  });

  test('execution deadline forbids a new round even when round count remains', () => {
    const h = harness();
    finishRoundWithoutCommands(h.ledger);
    h.clock.advance(15_000);
    expectCode(() => h.ledger.beginRound(), 'EXECUTION_DEADLINE');
  });

  test('enforces one active round, one command in flight, and finish ordering', () => {
    const h = harness();
    const round = h.ledger.beginRound();
    expectCode(() => h.ledger.beginRound(), 'ROUND_ACTIVE');
    const command = h.ledger.admitExecutionCommand(round, 'CRUD');
    expectCode(() => h.ledger.admitExecutionCommand(round, 'CRUD'), 'COMMAND_IN_FLIGHT');
    expectCode(() => h.ledger.finishRound(round), 'COMMAND_IN_FLIGHT');
    h.ledger.finishExecutionCommand(command);
    h.ledger.finishRound(round);
  });

  test('admits at most one INITIAL_COMMIT per round but permits one in a new round', () => {
    const h = harness();
    const first = h.ledger.beginRound();
    const commit = h.ledger.admitExecutionCommand(first, 'INITIAL_COMMIT');
    h.ledger.finishExecutionCommand(commit);
    expectCode(() => h.ledger.admitExecutionCommand(first, 'INITIAL_COMMIT'), 'EXECUTION_NOT_ADMITTED');
    h.ledger.finishRound(first);
    const second = h.ledger.beginRound();
    expect(h.ledger.admitExecutionCommand(second, 'INITIAL_COMMIT').kind).toBe('INITIAL_COMMIT');
  });

  test('execution timeouts are exact at full, short, deadline-1, and exact deadline', () => {
    const h = harness();
    const round = h.ledger.beginRound();
    const full = h.ledger.admitExecutionCommand(round, 'CRUD');
    expect(full.timeoutMs).toBe(2_000);
    h.ledger.finishExecutionCommand(full);
    h.clock.advance(14_999);
    const last = h.ledger.admitExecutionCommand(round, 'INITIAL_COMMIT');
    expect(last.timeoutMs).toBe(1);
    h.ledger.finishExecutionCommand(last);
    h.clock.advance(1);
    expectCode(() => h.ledger.admitExecutionCommand(round, 'CRUD'), 'EXECUTION_DEADLINE');
  });

  test('initial commit neither starts confirmation nor consumes confirmation slots', () => {
    const h = harness();
    const round = h.ledger.beginRound();
    const commit = h.ledger.admitExecutionCommand(round, 'INITIAL_COMMIT');
    h.ledger.finishExecutionCommand(commit);
    expect(h.ledger.snapshot()).toMatchObject({ confirmationStartMs: null, confirmationSlotsRemaining: 7 });
  });
});

describe('G05b confirmation cadence and shared slots', () => {
  test('confirmation cannot start before a round or while an execution command is in flight', () => {
    const h = harness();
    expectCode(() => h.ledger.startConfirmation('UNKNOWN_RESULT'), 'EXECUTION_NOT_ADMITTED');
    const round = h.ledger.beginRound();
    const command = h.ledger.admitExecutionCommand(round, 'CRUD');
    expectCode(() => h.ledger.startConfirmation('UNKNOWN_RESULT'), 'COMMAND_IN_FLIGHT');
    h.ledger.finishExecutionCommand(command);
    h.ledger.startConfirmation('UNKNOWN_RESULT');
  });

  test('invalid origins and unknown confirmation before start are ordinary denials', () => {
    const h = harness();
    expectCode(() => (h.ledger.startConfirmation as (origin: string) => void)('INVALID'), 'CONFIRMATION_NOT_STARTED');
    expectCode(() => h.ledger.admitNextUnknownConfirmation(), 'CONFIRMATION_NOT_STARTED');
    expect(h.ledger.snapshot().frozen).toBe(false);
  });

  test.each([
    ['UNKNOWN_RESULT', 'PRECOMMIT_CLEANUP'],
    ['PRECOMMIT_CLEANUP', 'UNKNOWN_RESULT'],
  ] as const)('the first %s start fixes the earlier start/deadline and later %s does not refresh it', (first, second) => {
    const h = harness();
    finishRoundWithoutCommands(h.ledger);
    h.ledger.startConfirmation(first);
    const initial = h.ledger.snapshot();
    h.clock.advance(500);
    h.ledger.startConfirmation(second);
    expect(h.ledger.snapshot()).toMatchObject({
      confirmationStartMs: initial.confirmationStartMs,
      confirmationDeadlineMs: initial.confirmationDeadlineMs,
    });
  });

  test('unknown cadence is immediate ORIGINAL, +1s CANONICAL, +2s ORIGINAL, then +2s alternating', () => {
    const h = harness();
    startUnknownAfterRound(h);
    const expected = ['ORIGINAL_COMMIT', 'CANONICAL_READ', 'ORIGINAL_COMMIT', 'CANONICAL_READ'] as const;
    const delays = [1_000, 2_000, 2_000];
    for (let index = 0; index < expected.length; index += 1) {
      const permit = h.ledger.admitNextUnknownConfirmation();
      expect(permit).toMatchObject({ kind: expected[index], attempt: index });
      h.ledger.settleStillUnknown(permit);
      const delay = delays[index];
      if (delay !== undefined) {
        h.clock.advance(delay - 1);
        expectCode(() => h.ledger.admitNextUnknownConfirmation(), 'CONFIRMATION_NOT_DUE');
        h.clock.advance(1);
      }
    }
    expect(h.ledger.snapshot()).toMatchObject({ confirmationSlotsRemaining: 3, confirmationAttempt: 4 });
  });

  test('caller cannot choose kind or parallelize confirmations', () => {
    const h = harness();
    startUnknownAfterRound(h);
    const first = (h.ledger.admitNextUnknownConfirmation as (...args: unknown[]) => ConfirmationPermit)('CANONICAL_READ');
    expect(first.kind).toBe('ORIGINAL_COMMIT');
    expectCode(() => h.ledger.admitNextUnknownConfirmation(), 'CONFIRMATION_IN_FLIGHT');
  });

  test('original confirmation requires >=2000ms and always uses fixed 2000ms', () => {
    const h = harness({ config: { confirmationMs: 2_000 } });
    startUnknownAfterRound(h);
    expect(h.ledger.admitNextUnknownConfirmation().timeoutMs).toBe(2_000);
    const h2 = harness({ config: { confirmationMs: 1_999 } });
    startUnknownAfterRound(h2);
    expectCode(() => h2.ledger.admitNextUnknownConfirmation(), 'CONFIRMATION_WINDOW');
    expect(h2.ledger.snapshot().confirmationSlotsRemaining).toBe(7);
  });

  test('canonical timeout is min(2000, remaining) and exact expiry admits no zero timeout', () => {
    const h = harness();
    startUnknownAfterRound(h);
    const first = h.ledger.admitNextUnknownConfirmation();
    h.ledger.settleStillUnknown(first);
    h.clock.advance(9_999);
    const canonical = h.ledger.admitNextUnknownConfirmation();
    expect(canonical).toMatchObject({ kind: 'CANONICAL_READ', timeoutMs: 1 });
    h.ledger.settleStillUnknown(canonical);
    h.clock.advance(2_000);
    expectCode(() => h.ledger.admitNextUnknownConfirmation(), 'CONFIRMATION_WINDOW');
  });

  test('admission immediately spends a slot and unknown, failure-like settlement, and no-effect never refund', () => {
    const h = harness();
    startUnknownAfterRound(h);
    const first = h.ledger.admitNextUnknownConfirmation();
    expect(h.ledger.snapshot().confirmationSlotsRemaining).toBe(6);
    h.ledger.settleStillUnknown(first);
    expect(h.ledger.snapshot().confirmationSlotsRemaining).toBe(6);
    h.clock.advance(1_000);
    const second = h.ledger.admitNextUnknownConfirmation();
    h.ledger.settleNoEffectConfirmed(second);
    expect(h.ledger.snapshot()).toMatchObject({ confirmationSlotsRemaining: 5, confirmationResult: 'NO_EFFECT_CONFIRMED' });
  });

  test.each([
    ['canonical', (ledger: BudgetLedger, permit: ConfirmationPermit) => ledger.settleConfirmed(permit), 'CANONICAL_RESULT'],
    ['no-effect', (ledger: BudgetLedger, permit: ConfirmationPermit) => ledger.settleNoEffectConfirmed(permit), 'NO_EFFECT_CONFIRMED'],
  ] as const)('%s settlement is terminal for further unknown sends', (_name, settle, result) => {
    const h = harness();
    startUnknownAfterRound(h);
    const permit = h.ledger.admitNextUnknownConfirmation();
    settle(h.ledger, permit);
    expect(h.ledger.snapshot().confirmationResult).toBe(result);
    expectCode(() => h.ledger.admitNextUnknownConfirmation(), 'CONFIRMATION_ALREADY_CONFIRMED');
  });

  test('all seven single slots can be spent and the eighth is rejected', () => {
    const h = harness({ config: { confirmationMs: 30_000 } });
    startUnknownAfterRound(h);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const permit = h.ledger.admitNextUnknownConfirmation();
      h.ledger.settleStillUnknown(permit);
      h.clock.advance(attempt === 0 ? 1_000 : 2_000);
    }
    expect(h.ledger.snapshot().confirmationSlotsRemaining).toBe(0);
    expectCode(() => h.ledger.admitNextUnknownConfirmation(), 'CONFIRMATION_SLOTS_EXHAUSTED');
  });
});

describe('G05b native precommit groups', () => {
  test('requires cleanup seen, a live confirmation window, and at least two slots', () => {
    const h = harness();
    finishRoundWithoutCommands(h.ledger);
    h.ledger.startConfirmation('UNKNOWN_RESULT');
    expectCode(() => h.ledger.reserveNativePrecommitGroup(), 'NATIVE_GROUP_NOT_ALLOWED');

    const low = harness({ config: { confirmationMs: 30_000 } });
    finishRoundWithoutCommands(low.ledger);
    low.ledger.startConfirmation('UNKNOWN_RESULT');
    low.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const permit = low.ledger.admitNextUnknownConfirmation();
      low.ledger.settleStillUnknown(permit);
      low.clock.advance(attempt === 0 ? 1_000 : 2_000);
    }
    expectCode(() => low.ledger.reserveNativePrecommitGroup(), 'NATIVE_GROUP_SLOTS_EXHAUSTED');

    const expired = harness();
    finishRoundWithoutCommands(expired.ledger);
    expired.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    expired.clock.advance(10_000);
    expectCode(() => expired.ledger.reserveNativePrecommitGroup(), 'NATIVE_GROUP_WINDOW');
  });

  test('reserves two slots without refund, is exclusive, and supports multiple sequential groups', () => {
    const h = harness();
    finishRoundWithoutCommands(h.ledger);
    h.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    for (let groupIndex = 1; groupIndex <= 3; groupIndex += 1) {
      const group = h.ledger.reserveNativePrecommitGroup();
      expect(group.timeoutMs).toBe(2_000);
      expectCode(() => h.ledger.reserveNativePrecommitGroup(), 'NATIVE_GROUP_ACTIVE');
      h.ledger.finishNativePrecommitGroup(group, 'STILL_UNKNOWN');
      expect(h.ledger.snapshot()).toMatchObject({
        confirmationSlotsRemaining: 7 - (groupIndex * 2), nativeGroupsReserved: groupIndex,
      });
    }
    expectCode(() => h.ledger.reserveNativePrecommitGroup(), 'NATIVE_GROUP_SLOTS_EXHAUSTED');
  });

  test('two sends share one 2000ms own deadline, have no interval, and never admit a third', () => {
    const h = harness();
    finishRoundWithoutCommands(h.ledger);
    h.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    const group = h.ledger.reserveNativePrecommitGroup();
    const first = h.ledger.admitNativePrecommitCommand(group);
    expect(first).toMatchObject({ attempt: 0, timeoutMs: 2_000 });
    h.ledger.finishNativePrecommitCommand(first);
    const second = h.ledger.admitNativePrecommitCommand(group);
    expect(second).toMatchObject({ attempt: 1, timeoutMs: 2_000 });
    h.ledger.finishNativePrecommitCommand(second);
    expectCode(() => h.ledger.admitNativePrecommitCommand(group), 'NATIVE_GROUP_COMMANDS_EXHAUSTED');
  });

  test('a group may be admitted with 1ms confirmation remaining and finish across confirmation, but not its own deadline', () => {
    const h = harness();
    finishRoundWithoutCommands(h.ledger);
    h.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    h.clock.advance(9_999);
    const group = h.ledger.reserveNativePrecommitGroup();
    h.clock.advance(1_999);
    const command = h.ledger.admitNativePrecommitCommand(group);
    expect(command.timeoutMs).toBe(1);
    h.ledger.finishNativePrecommitCommand(command);
    h.clock.advance(1);
    expectCode(() => h.ledger.admitNativePrecommitCommand(group), 'NATIVE_GROUP_WINDOW');
  });

  test.each(['STILL_UNKNOWN', 'NO_EFFECT_CONFIRMED'] as const)('records native outcome %s distinctly', (outcome) => {
    const h = harness();
    finishRoundWithoutCommands(h.ledger);
    h.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    const group = h.ledger.reserveNativePrecommitGroup();
    h.ledger.finishNativePrecommitGroup(group, outcome);
    expect(h.ledger.snapshot().confirmationResult).toBe(outcome);
  });

  test('an initial commit makes native cleanup unavailable', () => {
    const h = harness();
    const round = h.ledger.beginRound();
    const commit = h.ledger.admitExecutionCommand(round, 'INITIAL_COMMIT');
    h.ledger.finishExecutionCommand(commit);
    h.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    expectCode(() => h.ledger.reserveNativePrecommitGroup(), 'NATIVE_GROUP_NOT_ALLOWED');
  });
});

describe('G05b continuation', () => {
  test('requires no-effect plus opaque evidence, authorizes exactly one next round, and preserves every budget', () => {
    const h = harness();
    startUnknownAfterRound(h);
    settleNoEffect(h);
    const before = h.ledger.snapshot();
    const evidence = Object.freeze({ opaque: true });
    h.ledger.authorizeContinuation(evidence);
    expectCode(() => h.ledger.authorizeContinuation({}), 'EXECUTION_NOT_ADMITTED');
    const next = h.ledger.beginRound();
    const after = h.ledger.snapshot();
    expect(next.round).toBe(2);
    expect(after).toMatchObject({
      executionStartMs: before.executionStartMs,
      executionDeadlineMs: before.executionDeadlineMs,
      confirmationStartMs: before.confirmationStartMs,
      confirmationDeadlineMs: before.confirmationDeadlineMs,
      confirmationSlotsRemaining: before.confirmationSlotsRemaining,
      confirmationAttempt: before.confirmationAttempt,
      continuationAuthorized: false,
    });
    expectCode(() => h.ledger.beginRound(), 'EXECUTION_NOT_ADMITTED');
  });

  test('a new continuation cycle requires a new no-effect result and new evidence', () => {
    const h = harness();
    startUnknownAfterRound(h);
    settleNoEffect(h);
    const firstEvidence = {};
    h.ledger.authorizeContinuation(firstEvidence);
    const secondRound = h.ledger.beginRound();
    h.ledger.finishRound(secondRound);
    expectCode(() => h.ledger.authorizeContinuation({}), 'EXECUTION_NOT_ADMITTED');
    h.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    const group = h.ledger.reserveNativePrecommitGroup();
    h.ledger.finishNativePrecommitGroup(group, 'NO_EFFECT_CONFIRMED');
    h.ledger.authorizeContinuation({});
    expect(h.ledger.beginRound().round).toBe(3);
  });

  test('canonical result rejects continuation without invoking verifier or freezing', () => {
    const h = harness();
    startUnknownAfterRound(h);
    const permit = h.ledger.admitNextUnknownConfirmation();
    h.ledger.settleConfirmed(permit);
    expectCode(() => h.ledger.authorizeContinuation({}), 'CONFIRMATION_ALREADY_CONFIRMED');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.ledger.snapshot().frozen).toBe(false);
  });

  test('continuation before lifecycle and while a round remains active are ordinary denials', () => {
    const before = harness();
    expectCode(() => before.ledger.authorizeContinuation({}), 'EXECUTION_NOT_ADMITTED');
    expect(before.verify).not.toHaveBeenCalled();

    const active = harness();
    active.ledger.beginRound();
    active.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    const group = active.ledger.reserveNativePrecommitGroup();
    active.ledger.finishNativePrecommitGroup(group, 'NO_EFFECT_CONFIRMED');
    expectCode(() => active.ledger.authorizeContinuation({}), 'COMMAND_IN_FLIGHT');
    expect(active.verify).not.toHaveBeenCalled();
  });

  test('reusing consumed evidence in a later valid cycle permanently freezes', () => {
    const h = harness();
    startUnknownAfterRound(h);
    settleNoEffect(h);
    const evidence = {};
    h.ledger.authorizeContinuation(evidence);
    const second = h.ledger.beginRound();
    h.ledger.finishRound(second);
    h.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    const group = h.ledger.reserveNativePrecommitGroup();
    h.ledger.finishNativePrecommitGroup(group, 'NO_EFFECT_CONFIRMED');
    expectCode(() => h.ledger.authorizeContinuation(evidence), 'CONTINUATION_EVIDENCE_REJECTED');
    expect(h.ledger.snapshot().frozen).toBe(true);
  });

  test.each([null, undefined, 0, 'evidence', true] as const)('primitive evidence %p freezes', (evidence) => {
    const h = harness();
    startUnknownAfterRound(h);
    settleNoEffect(h);
    expectCode(() => h.ledger.authorizeContinuation(evidence), 'CONTINUATION_EVIDENCE_REJECTED');
    expect(h.ledger.snapshot().frozen).toBe(true);
  });

  test.each([
    ['nonundefined', (): unknown => 1],
    ['throw', (): unknown => { throw new Error('rejected'); }],
    ['BudgetError', (): unknown => { throw new BudgetLedgerError('OWNER_STALE', 'foreign', 'foreign'); }],
    ['async resolve', (): unknown => Promise.resolve()],
    ['async reject', (): unknown => Promise.reject(new Error('async rejected'))],
  ] as const)('verifier %s freezes with no unhandled rejection', async (_name, verifier) => {
    const h = harness({ assertContinuationEvidence: verifier });
    startUnknownAfterRound(h);
    settleNoEffect(h);
    expectCode(() => h.ledger.authorizeContinuation({}), 'CONTINUATION_EVIDENCE_REJECTED');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ledger.snapshot().frozen).toBe(true);
  });

  test('a verifier result with a throwing then getter freezes', () => {
    const result = Object.defineProperty({}, 'then', { get: () => { throw new Error('getter'); } });
    const h = harness({ assertContinuationEvidence: () => result });
    startUnknownAfterRound(h);
    settleNoEffect(h);
    expectCode(() => h.ledger.authorizeContinuation({}), 'CONTINUATION_EVIDENCE_REJECTED');
    expect(h.ledger.snapshot().frozen).toBe(true);
  });

  test('caught verifier reentry still freezes the ledger', () => {
    let ledger!: BudgetLedger;
    const verifier = (): void => {
      try { ledger.snapshot(); } catch { /* malicious verifier catches reentry */ }
    };
    const h = harness({ assertContinuationEvidence: verifier });
    ledger = h.ledger;
    startUnknownAfterRound(h);
    settleNoEffect(h);
    expectCode(() => h.ledger.authorizeContinuation({}), 'CONTINUATION_EVIDENCE_REJECTED');
    expect(h.ledger.snapshot().frozen).toBe(true);
  });

  test('round three and exact execution deadline reject before verifier without freezing', () => {
    const roundLimit = harness();
    finishRoundWithoutCommands(roundLimit.ledger);
    finishRoundWithoutCommands(roundLimit.ledger);
    const third = roundLimit.ledger.beginRound();
    roundLimit.ledger.finishRound(third);
    roundLimit.ledger.startConfirmation('UNKNOWN_RESULT');
    settleNoEffect(roundLimit);
    expectCode(() => roundLimit.ledger.authorizeContinuation({}), 'EXECUTION_ROUNDS_EXHAUSTED');
    expect(roundLimit.verify).not.toHaveBeenCalled();
    expect(roundLimit.ledger.snapshot().frozen).toBe(false);

    const deadline = harness();
    startUnknownAfterRound(deadline);
    settleNoEffect(deadline);
    deadline.clock.advance(15_000);
    expectCode(() => deadline.ledger.authorizeContinuation({}), 'EXECUTION_DEADLINE');
    expect(deadline.verify).not.toHaveBeenCalled();
    expect(deadline.ledger.snapshot().frozen).toBe(false);
  });

  test('deadline-1 succeeds, including after confirmation expired while execution remains valid', () => {
    const lastMs = harness();
    startUnknownAfterRound(lastMs);
    settleNoEffect(lastMs);
    lastMs.clock.advance(14_999);
    expect(() => lastMs.ledger.authorizeContinuation({})).not.toThrow();

    const expiredConfirmation = harness({ config: { executionMs: 30_000 } });
    startUnknownAfterRound(expiredConfirmation);
    settleNoEffect(expiredConfirmation);
    expiredConfirmation.clock.advance(10_001);
    expect(() => expiredConfirmation.ledger.authorizeContinuation({})).not.toThrow();
  });
});

describe('G05b capability provenance and permanent fail-closed behavior', () => {
  test('foreign permits freeze only the receiving ledger; distinct ledgers remain independent', () => {
    const a = harness();
    const b = harness();
    const foreign = a.ledger.beginRound();
    expectCode(() => b.ledger.finishRound(foreign), 'INVALID_PERMIT');
    expect(b.ledger.snapshot().frozen).toBe(true);
    expect(a.ledger.snapshot().frozen).toBe(false);
    a.ledger.finishRound(foreign);
  });

  test('foreign execution, confirmation, native group, and native command permits are all rejected fail-closed', () => {
    {
      const source = harness(); const receiver = harness();
      const round = source.ledger.beginRound();
      const permit = source.ledger.admitExecutionCommand(round, 'CRUD');
      expectCode(() => receiver.ledger.finishExecutionCommand(permit), 'INVALID_PERMIT');
      expect(receiver.ledger.snapshot().frozen).toBe(true);
    }
    {
      const source = harness(); const receiver = harness();
      startUnknownAfterRound(source);
      const permit = source.ledger.admitNextUnknownConfirmation();
      expectCode(() => receiver.ledger.settleStillUnknown(permit), 'INVALID_PERMIT');
      expect(receiver.ledger.snapshot().frozen).toBe(true);
    }
    {
      const source = harness(); const receiver = harness();
      finishRoundWithoutCommands(source.ledger); source.ledger.startConfirmation('PRECOMMIT_CLEANUP');
      const permit = source.ledger.reserveNativePrecommitGroup();
      expectCode(() => receiver.ledger.finishNativePrecommitGroup(permit, 'STILL_UNKNOWN'), 'INVALID_PERMIT');
      expect(receiver.ledger.snapshot().frozen).toBe(true);
    }
    {
      const source = harness(); const receiver = harness();
      finishRoundWithoutCommands(source.ledger); source.ledger.startConfirmation('PRECOMMIT_CLEANUP');
      const group = source.ledger.reserveNativePrecommitGroup();
      const permit = source.ledger.admitNativePrecommitCommand(group);
      expectCode(() => receiver.ledger.finishNativePrecommitCommand(permit), 'INVALID_PERMIT');
      expect(receiver.ledger.snapshot().frozen).toBe(true);
    }
  });

  test('primitive forged permits are rejected for every capability kind', () => {
    const cases: Array<() => void> = [
      () => harness().ledger.finishRound(null as never),
      () => harness().ledger.finishExecutionCommand(1 as never),
      () => harness().ledger.settleStillUnknown('permit' as never),
      () => harness().ledger.finishNativePrecommitGroup(undefined as never, 'STILL_UNKNOWN'),
      () => harness().ledger.finishNativePrecommitCommand(false as never),
    ];
    for (const run of cases) expect(run).toThrow(BudgetLedgerError);
  });

  test('double-used and stale round, execution, confirmation, native group, and native command permits freeze', () => {
    const cases: Array<() => void> = [
      () => { const h = harness(); const p = h.ledger.beginRound(); h.ledger.finishRound(p); h.ledger.finishRound(p); },
      () => { const h = harness(); const r = h.ledger.beginRound(); const p = h.ledger.admitExecutionCommand(r, 'CRUD'); h.ledger.finishExecutionCommand(p); h.ledger.finishExecutionCommand(p); },
      () => { const h = harness(); startUnknownAfterRound(h); const p = h.ledger.admitNextUnknownConfirmation(); h.ledger.settleStillUnknown(p); h.ledger.settleStillUnknown(p); },
      () => { const h = harness(); finishRoundWithoutCommands(h.ledger); h.ledger.startConfirmation('PRECOMMIT_CLEANUP'); const p = h.ledger.reserveNativePrecommitGroup(); h.ledger.finishNativePrecommitGroup(p, 'STILL_UNKNOWN'); h.ledger.finishNativePrecommitGroup(p, 'STILL_UNKNOWN'); },
      () => { const h = harness(); finishRoundWithoutCommands(h.ledger); h.ledger.startConfirmation('PRECOMMIT_CLEANUP'); const g = h.ledger.reserveNativePrecommitGroup(); const p = h.ledger.admitNativePrecommitCommand(g); h.ledger.finishNativePrecommitCommand(p); h.ledger.finishNativePrecommitCommand(p); },
    ];
    for (const run of cases) expect(run).toThrow(BudgetLedgerError);
  });

  test.each([
    ['throw', (): unknown => { throw new Error('stale'); }],
    ['BudgetError', (): unknown => { throw new BudgetLedgerError('OWNER_STALE', 'foreign', 'stale'); }],
    ['nonundefined', (): unknown => 1],
    ['Promise resolve', (): unknown => Promise.resolve()],
    ['Promise reject', (): unknown => Promise.reject(new Error('stale async'))],
  ] as const)('owner fence %s permanently freezes', async (_name, assertCurrent) => {
    const h = harness({ ownerFence: { assertCurrent: assertCurrent as () => void } });
    expectCode(() => h.ledger.beginRound(), 'OWNER_STALE');
    await Promise.resolve();
    expect(h.ledger.snapshot().frozen).toBe(true);
    expectCode(() => h.ledger.beginRound(), 'BUDGET_FROZEN');
  });

  test('caught owner reentry permanently freezes', () => {
    let ledger!: BudgetLedger;
    const h = harness({ ownerFence: { assertCurrent: () => { try { ledger.snapshot(); } catch { /* caught */ } } } });
    ledger = h.ledger;
    expectCode(() => ledger.beginRound(), 'OWNER_STALE');
    expect(ledger.snapshot().frozen).toBe(true);
  });

  test.each([
    ['throw', (): unknown => { throw new Error('clock'); }],
    ['BudgetError', (): unknown => { throw new BudgetLedgerError('CLOCK_FAILURE', 'foreign', 'clock'); }],
    ['nonnumber', (): unknown => '1'],
    ['negative', (): unknown => -1],
    ['fraction', (): unknown => 1.5],
    ['unsafe', (): unknown => Number.MAX_SAFE_INTEGER + 1],
    ['Promise resolve', (): unknown => Promise.resolve(1)],
    ['Promise reject', (): unknown => Promise.reject(new Error('clock async'))],
  ] as const)('clock %s permanently freezes', async (_name, nowMs) => {
    const h = harness({ clock: { nowMs: nowMs as () => number } });
    expectCode(() => h.ledger.beginRound(), 'CLOCK_FAILURE');
    await Promise.resolve();
    expect(h.ledger.snapshot().frozen).toBe(true);
  });

  test('clock rollback and deadline overflow permanently freeze', () => {
    const rollback = harness();
    const round = rollback.ledger.beginRound();
    rollback.clock.value -= 1;
    expectCode(() => rollback.ledger.admitExecutionCommand(round, 'CRUD'), 'CLOCK_ROLLBACK');
    expect(rollback.ledger.snapshot().frozen).toBe(true);

    const overflow = harness({ clock: { nowMs: () => Number.MAX_SAFE_INTEGER } });
    expectCode(() => overflow.ledger.beginRound(), 'DEADLINE_OVERFLOW');
    expect(overflow.ledger.snapshot().frozen).toBe(true);
  });

  test('caught clock reentry permanently freezes', () => {
    let ledger!: BudgetLedger;
    const h = harness({ clock: { nowMs: () => { try { ledger.snapshot(); } catch { /* caught */ } return 1; } } });
    ledger = h.ledger;
    expectCode(() => ledger.beginRound(), 'CLOCK_FAILURE');
    expect(ledger.snapshot().frozen).toBe(true);
  });

  test('snapshots and ledger are frozen readonly views without capabilities; only snapshot works after freeze', () => {
    const h = harness();
    const snapshot = h.ledger.snapshot();
    expect(Object.isFrozen(h.ledger)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.keys(snapshot)).not.toEqual(expect.arrayContaining(['beginRound', 'clock', 'ownerFence']));
    expectCode(() => h.ledger.finishRound({ round: 1 } as RoundPermit), 'INVALID_PERMIT');
    expect(() => h.ledger.snapshot()).not.toThrow();
    expectCode(() => h.ledger.beginRound(), 'BUDGET_FROZEN');
  });
});

describe('G05b static internal boundary', () => {
  test('ledger stays internal-only and is not exported by application, package root, or package exports', async () => {
    const projectRoot = path.resolve(__dirname, '../../..');
    const [applicationIndex, rootIndex, packageJson] = await Promise.all([
      readFile(path.join(projectRoot, 'src/access/application/index.ts'), 'utf8'),
      readFile(path.join(projectRoot, 'src/index.ts'), 'utf8'),
      readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    ]);
    expect(applicationIndex).not.toMatch(/budget-ledger|createBudgetLedger|BudgetLedger/);
    expect(rootIndex).not.toMatch(/budget-ledger|createBudgetLedger|BudgetLedger/);
    expect(JSON.parse(packageJson).exports).toEqual(expect.not.objectContaining({ './internal': expect.anything() }));
  });

  test('production ledger has no forbidden infrastructure, timers, retries, parallelism, or budget release vocabulary', async () => {
    const projectRoot = path.resolve(__dirname, '../../..');
    const source = await readFile(path.join(projectRoot, 'src/access/application/internal/budget-ledger.ts'), 'utf8');
    const forbidden = [
      /from ['"][^'"]*(?:mongo|driver|session|http|auth|g05c|use-cases?)/i,
      /\b(?:setTimeout|setInterval|sleep|withTransaction|refund|reset|releaseUnknown|safeTerminal)\b/,
      /Promise\.all\s*\(/,
      /\bretry\b/i,
    ];
    for (const pattern of forbidden) expect(source).not.toMatch(pattern);
  });
});
