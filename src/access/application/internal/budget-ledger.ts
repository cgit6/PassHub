/**
 * The budget ledger is deliberately a synchronous, per-operation capability.
 * It owns both execution and confirmation accounting; callers only receive
 * frozen, single-use permits and cannot alter the accounting state.
 */

export interface TrustedBudgetClock {
  nowMs(): number;
}

export interface BudgetOwnerFence {
  assertCurrent(): void;
}

/** Trusted continuation evidence is intentionally opaque to this ledger. */
export type ContinuationEvidenceVerifier = (evidence: unknown) => unknown;

/** Trusted bootstrap calibration; public callers cannot supply these values. */
export interface BudgetLedgerConfig {
  readonly executionMs: number;
  readonly maxRounds: number;
  readonly singleCommandMs: number;
  readonly confirmationMs: number;
  readonly confirmationSlots: number;
  readonly nativeGroupSlots: number;
  readonly nativeGroupMs: number;
}

export interface BudgetLedgerOptions {
  readonly clock: TrustedBudgetClock;
  readonly ownerFence: BudgetOwnerFence;
  readonly operationId: string;
  readonly assertContinuationEvidence: ContinuationEvidenceVerifier;
  readonly config?: Partial<BudgetLedgerConfig>;
}

export type ExecutionCommandKind = 'CRUD' | 'INITIAL_COMMIT';
export type ConfirmationOrigin = 'UNKNOWN_RESULT' | 'PRECOMMIT_CLEANUP';
export type ConfirmationKind = 'ORIGINAL_COMMIT' | 'CANONICAL_READ';
export type ConfirmationResult = 'STILL_UNKNOWN' | 'CANONICAL_RESULT' | 'NO_EFFECT_CONFIRMED';
export type NativePrecommitOutcome = 'STILL_UNKNOWN' | 'NO_EFFECT_CONFIRMED';

export type BudgetErrorCode =
  | 'BUDGET_FROZEN'
  | 'CLOCK_FAILURE'
  | 'CLOCK_ROLLBACK'
  | 'DEADLINE_OVERFLOW'
  | 'OWNER_STALE'
  | 'CONTINUATION_EVIDENCE_REJECTED'
  | 'REENTRANT'
  | 'INVALID_PERMIT'
  | 'PERMIT_ALREADY_USED'
  | 'EXECUTION_NOT_ADMITTED'
  | 'EXECUTION_ROUNDS_EXHAUSTED'
  | 'EXECUTION_DEADLINE'
  | 'ROUND_ACTIVE'
  | 'COMMAND_IN_FLIGHT'
  | 'COMMAND_NOT_IN_FLIGHT'
  | 'CONFIRMATION_NOT_STARTED'
  | 'CONFIRMATION_NOT_DUE'
  | 'CONFIRMATION_WINDOW'
  | 'CONFIRMATION_SLOTS_EXHAUSTED'
  | 'CONFIRMATION_IN_FLIGHT'
  | 'CONFIRMATION_ALREADY_CONFIRMED'
  | 'NATIVE_GROUP_ACTIVE'
  | 'NATIVE_GROUP_NOT_ALLOWED'
  | 'NATIVE_GROUP_SLOTS_EXHAUSTED'
  | 'NATIVE_GROUP_WINDOW'
  | 'NATIVE_GROUP_COMMANDS_EXHAUSTED';

export class BudgetLedgerError extends Error {
  readonly code: BudgetErrorCode;
  readonly operationId: string;

  constructor(code: BudgetErrorCode, operationId: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'BudgetLedgerError';
    this.code = code;
    this.operationId = operationId;
  }
}

declare const roundPermitBrand: unique symbol;
declare const executionCommandPermitBrand: unique symbol;
declare const confirmationPermitBrand: unique symbol;
declare const nativeGroupPermitBrand: unique symbol;
declare const nativeGroupCommandPermitBrand: unique symbol;

export interface RoundPermit {
  readonly [roundPermitBrand]: never;
  readonly round: number;
}

export interface ExecutionCommandPermit {
  readonly [executionCommandPermitBrand]: never;
  readonly kind: ExecutionCommandKind;
  readonly timeoutMs: number;
}

export interface ConfirmationPermit {
  readonly [confirmationPermitBrand]: never;
  readonly kind: ConfirmationKind;
  readonly attempt: number;
  readonly timeoutMs: number;
}

export interface NativePrecommitGroupPermit {
  readonly [nativeGroupPermitBrand]: never;
  readonly timeoutMs: number;
}

export interface NativePrecommitCommandPermit {
  readonly [nativeGroupCommandPermitBrand]: never;
  readonly timeoutMs: number;
  readonly attempt: number;
}

export interface BudgetLedgerSnapshot {
  readonly operationId: string;
  readonly frozen: boolean;
  readonly executionStartMs: number | null;
  readonly executionDeadlineMs: number | null;
  readonly roundsStarted: number;
  readonly activeRound: number | null;
  readonly executionCommandInFlight: boolean;
  readonly confirmationStartMs: number | null;
  readonly confirmationDeadlineMs: number | null;
  readonly confirmationSlotsRemaining: number;
  readonly confirmationAttempt: number;
  readonly confirmationInFlight: boolean;
  readonly confirmationConfirmed: boolean;
  readonly confirmationResult: ConfirmationResult | null;
  readonly continuationAuthorized: boolean;
  readonly nativeGroupActive: boolean;
  readonly nativeGroupsReserved: number;
}

export interface BudgetLedger {
  beginRound(): RoundPermit;
  finishRound(permit: RoundPermit): void;
  admitExecutionCommand(permit: RoundPermit, kind: ExecutionCommandKind): ExecutionCommandPermit;
  finishExecutionCommand(permit: ExecutionCommandPermit): void;
  startConfirmation(origin: ConfirmationOrigin): void;
  admitNextUnknownConfirmation(): ConfirmationPermit;
  settleStillUnknown(permit: ConfirmationPermit): void;
  settleConfirmed(permit: ConfirmationPermit): void;
  settleNoEffectConfirmed(permit: ConfirmationPermit): void;
  authorizeContinuation(evidence: unknown): void;
  reserveNativePrecommitGroup(): NativePrecommitGroupPermit;
  admitNativePrecommitCommand(permit: NativePrecommitGroupPermit): NativePrecommitCommandPermit;
  finishNativePrecommitCommand(permit: NativePrecommitCommandPermit): void;
  finishNativePrecommitGroup(permit: NativePrecommitGroupPermit, outcome: NativePrecommitOutcome): void;
  snapshot(): BudgetLedgerSnapshot;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DEFAULT_CONFIG: BudgetLedgerConfig = Object.freeze({
  executionMs: 15_000,
  maxRounds: 3,
  singleCommandMs: 2_000,
  confirmationMs: 10_000,
  confirmationSlots: 7,
  nativeGroupSlots: 2,
  nativeGroupMs: 2_000,
});

interface RoundState {
  readonly ledger: object;
  readonly generation: number;
  readonly permit: RoundPermit;
  active: boolean;
  initialCommitAdmitted: boolean;
}

interface ExecutionCommandState {
  readonly ledger: object;
  readonly round: RoundState;
  readonly permit: ExecutionCommandPermit;
  active: boolean;
}

interface ConfirmationState {
  readonly ledger: object;
  readonly permit: ConfirmationPermit;
  active: boolean;
}

interface NativeGroupState {
  readonly ledger: object;
  readonly permit: NativePrecommitGroupPermit;
  readonly deadlineMs: number;
  readonly generation: number;
  active: boolean;
  attempts: number;
  command: NativeCommandState | null;
}

interface NativeCommandState {
  readonly ledger: object;
  readonly group: NativeGroupState;
  readonly permit: NativePrecommitCommandPermit;
  active: boolean;
}

export function createBudgetLedger(options: BudgetLedgerOptions): BudgetLedger {
  assertConstructionOptions(options);

  // Capture every trusted dependency and every config scalar at construction.
  // No later mutation of the caller-owned option graph can affect this ledger.
  const operationId = options.operationId;
  const clockNowMs = options.clock.nowMs.bind(options.clock);
  const ownerAssertCurrent = options.ownerFence.assertCurrent.bind(options.ownerFence);
  const verifyContinuationEvidence = options.assertContinuationEvidence;
  const config = captureConfig(options.config);
  const ledgerIdentity = Object.freeze({});

  const rounds = new WeakMap<object, RoundState>();
  const executionCommands = new WeakMap<object, ExecutionCommandState>();
  const confirmations = new WeakMap<object, ConfirmationState>();
  const nativeGroups = new WeakMap<object, NativeGroupState>();
  const nativeCommands = new WeakMap<object, NativeCommandState>();
  const consumedContinuationEvidence = new WeakSet<object>();

  let frozen = false;
  let transitioning = false;
  let lastNowMs: number | null = null;
  let executionStartMs: number | null = null;
  let executionDeadlineMs: number | null = null;
  let roundsStarted = 0;
  let activeRound: RoundState | null = null;
  let lastRoundInitialCommit = false;
  let executionCommand: ExecutionCommandState | null = null;
  let confirmationStartMs: number | null = null;
  let confirmationDeadlineMs: number | null = null;
  let confirmationSlotsRemaining = config.confirmationSlots;
  let confirmationAttempt = 0;
  let confirmationNextAtMs: number | null = null;
  let confirmationCommand: ConfirmationState | null = null;
  let confirmationConfirmed = false;
  let confirmationResult: ConfirmationResult | null = null;
  let continuationAuthorized = false;
  let unknownResultSeen = false;
  let precommitCleanupSeen = false;
  let nativeGroup: NativeGroupState | null = null;
  let nativeGroupsReserved = 0;

  const failClosed = (code: BudgetErrorCode, message: string, cause?: unknown): never => {
    frozen = true;
    throw new BudgetLedgerError(code, operationId, message, cause === undefined ? undefined : { cause });
  };

  const assertOwner = (): void => {
    let result: unknown;
    try {
      result = ownerAssertCurrent();
    } catch (error: unknown) {
      failClosed('OWNER_STALE', 'budget ledger owner is stale', error);
    }
    if (frozen) failClosed('OWNER_STALE', 'owner fence reentered the budget ledger');
    rejectAsyncTrustResult(result, 'OWNER_STALE', 'owner fence must be synchronous');
    if (result !== undefined) failClosed('OWNER_STALE', 'owner fence must return undefined');
  };

  const readNow = (): number => {
    let result: unknown;
    try {
      result = clockNowMs();
    } catch (error: unknown) {
      failClosed('CLOCK_FAILURE', 'trusted budget clock failed', error);
    }
    if (frozen) failClosed('CLOCK_FAILURE', 'trusted budget clock reentered the budget ledger');
    rejectAsyncTrustResult(result, 'CLOCK_FAILURE', 'trusted budget clock must be synchronous');
    if (typeof result !== 'number') {
      failClosed('CLOCK_FAILURE', 'trusted budget clock must return a number');
    }
    const nowMs = result as number;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      failClosed('CLOCK_FAILURE', 'trusted budget clock must return a safe non-negative integer');
    }
    if (lastNowMs !== null && nowMs < lastNowMs) {
      failClosed('CLOCK_ROLLBACK', 'trusted budget clock moved backwards');
    }
    lastNowMs = nowMs;
    return nowMs;
  };

  function rejectAsyncTrustResult(result: unknown, code: 'OWNER_STALE' | 'CLOCK_FAILURE', message: string): void {
    if ((typeof result !== 'object' && typeof result !== 'function') || result === null) return;
    let then: unknown;
    try {
      then = (result as { readonly then?: unknown }).then;
    } catch (error: unknown) {
      failClosed(code, message, error);
    }
    if (typeof then !== 'function') return;
    try {
      void Promise.resolve(result).catch(() => undefined);
    } catch (error: unknown) {
      failClosed(code, message, error);
    }
    failClosed(code, message);
  }

  const addDeadline = (nowMs: number, durationMs: number): number => {
    if (nowMs > MAX_SAFE - durationMs) {
      failClosed('DEADLINE_OVERFLOW', 'budget deadline overflow');
    }
    return nowMs + durationMs;
  };

  const transition = <T>(work: () => T): T => {
    if (transitioning) failClosed('REENTRANT', 'budget transition is reentrant');
    if (frozen) throw new BudgetLedgerError('BUDGET_FROZEN', operationId, 'budget ledger is permanently frozen');
    transitioning = true;
    try {
      assertOwner();
      return work();
    } finally {
      transitioning = false;
    }
  };

  const requireRound = (permit: RoundPermit): RoundState => {
    if ((typeof permit !== 'object' && typeof permit !== 'function') || permit === null) {
      failClosed('INVALID_PERMIT', 'round permit is invalid');
    }
    const state = rounds.get(permit);
    if (state === undefined || state.ledger !== ledgerIdentity) {
      failClosed('INVALID_PERMIT', 'round permit belongs to another ledger');
    }
    if (!(state as RoundState).active) failClosed('PERMIT_ALREADY_USED', 'round permit is no longer active');
    return state as RoundState;
  };

  const requireExecutionCommand = (permit: ExecutionCommandPermit): ExecutionCommandState => {
    if ((typeof permit !== 'object' && typeof permit !== 'function') || permit === null) {
      failClosed('INVALID_PERMIT', 'execution command permit is invalid');
    }
    const state = executionCommands.get(permit);
    if (state === undefined || state.ledger !== ledgerIdentity) {
      failClosed('INVALID_PERMIT', 'execution command permit belongs to another ledger');
    }
    if (!(state as ExecutionCommandState).active) failClosed('PERMIT_ALREADY_USED', 'execution command permit is no longer active');
    return state as ExecutionCommandState;
  };

  const requireConfirmation = (permit: ConfirmationPermit): ConfirmationState => {
    if ((typeof permit !== 'object' && typeof permit !== 'function') || permit === null) {
      failClosed('INVALID_PERMIT', 'confirmation permit is invalid');
    }
    const state = confirmations.get(permit);
    if (state === undefined || state.ledger !== ledgerIdentity) {
      failClosed('INVALID_PERMIT', 'confirmation permit belongs to another ledger');
    }
    if (!(state as ConfirmationState).active) failClosed('PERMIT_ALREADY_USED', 'confirmation permit is no longer active');
    return state as ConfirmationState;
  };

  const requireNativeGroup = (permit: NativePrecommitGroupPermit): NativeGroupState => {
    if ((typeof permit !== 'object' && typeof permit !== 'function') || permit === null) {
      failClosed('INVALID_PERMIT', 'native group permit is invalid');
    }
    const state = nativeGroups.get(permit);
    if (state === undefined || state.ledger !== ledgerIdentity) {
      failClosed('INVALID_PERMIT', 'native group permit belongs to another ledger');
    }
    if (!(state as NativeGroupState).active) failClosed('PERMIT_ALREADY_USED', 'native group permit is no longer active');
    return state as NativeGroupState;
  };

  const requireNativeCommand = (permit: NativePrecommitCommandPermit): NativeCommandState => {
    if ((typeof permit !== 'object' && typeof permit !== 'function') || permit === null) {
      failClosed('INVALID_PERMIT', 'native command permit is invalid');
    }
    const state = nativeCommands.get(permit);
    if (state === undefined || state.ledger !== ledgerIdentity) {
      failClosed('INVALID_PERMIT', 'native command permit belongs to another ledger');
    }
    if (!(state as NativeCommandState).active) failClosed('PERMIT_ALREADY_USED', 'native command permit is no longer active');
    return state as NativeCommandState;
  };

  const makeSnapshot = (): BudgetLedgerSnapshot => Object.freeze({
    operationId,
    frozen,
    executionStartMs,
    executionDeadlineMs,
    roundsStarted,
    activeRound: activeRound?.generation ?? null,
    executionCommandInFlight: executionCommand !== null,
    confirmationStartMs,
    confirmationDeadlineMs,
    confirmationSlotsRemaining,
    confirmationAttempt,
    confirmationInFlight: confirmationCommand !== null,
    confirmationConfirmed,
    confirmationResult,
    continuationAuthorized,
    nativeGroupActive: nativeGroup !== null,
    nativeGroupsReserved,
  });

  const ledger: BudgetLedger = {
    beginRound: (): RoundPermit => transition(() => {
      if (confirmationStartMs !== null && !continuationAuthorized) {
        throw denial('EXECUTION_NOT_ADMITTED', 'execution cannot begin after confirmation starts without continuation evidence');
      }
      if (nativeGroup !== null) throw denial('NATIVE_GROUP_ACTIVE', 'execution is blocked by an active native group');
      if (activeRound !== null) throw denial('ROUND_ACTIVE', 'an execution round is already active');
      if (roundsStarted >= config.maxRounds) throw denial('EXECUTION_ROUNDS_EXHAUSTED', 'execution round budget is exhausted');
      const nowMs = readNow();
      if (executionDeadlineMs !== null && nowMs >= executionDeadlineMs) {
        throw denial('EXECUTION_DEADLINE', 'execution deadline has passed');
      }
      if (executionStartMs === null) {
        executionStartMs = nowMs;
        executionDeadlineMs = addDeadline(nowMs, config.executionMs);
      }
      const continuing = continuationAuthorized;
      roundsStarted += 1;
      const permit = Object.freeze({ round: roundsStarted }) as RoundPermit;
      const state: RoundState = { ledger: ledgerIdentity, generation: roundsStarted, permit, active: true, initialCommitAdmitted: false };
      rounds.set(permit, state);
      activeRound = state;
      continuationAuthorized = false;
      if (continuing) confirmationResult = null;
      return permit;
    }),

    finishRound: (permit: RoundPermit): void => transition(() => {
      const state = requireRound(permit);
      if (activeRound !== state) failClosed('INVALID_PERMIT', 'round permit is not current');
      if (executionCommand !== null) throw denial('COMMAND_IN_FLIGHT', 'execution command is still in flight');
      lastRoundInitialCommit = state.initialCommitAdmitted;
      state.active = false;
      activeRound = null;
    }),

    admitExecutionCommand: (permit: RoundPermit, kind: ExecutionCommandKind): ExecutionCommandPermit => transition(() => {
      const round = requireRound(permit);
      if (activeRound !== round) failClosed('INVALID_PERMIT', 'round permit is not current');
      if (kind !== 'CRUD' && kind !== 'INITIAL_COMMIT') throw denial('EXECUTION_NOT_ADMITTED', 'execution command kind is invalid');
      if (confirmationStartMs !== null) throw denial('EXECUTION_NOT_ADMITTED', 'execution is closed after confirmation starts');
      if (nativeGroup !== null) throw denial('NATIVE_GROUP_ACTIVE', 'execution is blocked by an active native group');
      if (executionCommand !== null) throw denial('COMMAND_IN_FLIGHT', 'another execution command is in flight');
      if (kind === 'INITIAL_COMMIT' && round.initialCommitAdmitted) {
        throw denial('EXECUTION_NOT_ADMITTED', 'each execution round admits at most one initial commit');
      }
      const nowMs = readNow();
      const deadlineMs = executionDeadlineMs;
      if (deadlineMs === null || nowMs >= deadlineMs) throw denial('EXECUTION_DEADLINE', 'execution deadline has passed');
      const remainingMs = deadlineMs - nowMs;
      if (remainingMs < 1) throw denial('EXECUTION_DEADLINE', 'execution has less than one millisecond remaining');
      const timeoutMs = Math.min(config.singleCommandMs, remainingMs);
      if (timeoutMs < 1) throw denial('EXECUTION_DEADLINE', 'execution command timeout would be zero');
      if (kind === 'INITIAL_COMMIT') round.initialCommitAdmitted = true;
      const permitResult = Object.freeze({ kind, timeoutMs }) as ExecutionCommandPermit;
      const state: ExecutionCommandState = { ledger: ledgerIdentity, round, permit: permitResult, active: true };
      executionCommands.set(permitResult, state);
      executionCommand = state;
      return permitResult;
    }),

    finishExecutionCommand: (permit: ExecutionCommandPermit): void => transition(() => {
      const state = requireExecutionCommand(permit);
      if (executionCommand !== state) failClosed('INVALID_PERMIT', 'execution command permit is not current');
      state.active = false;
      executionCommand = null;
    }),

    startConfirmation: (origin: ConfirmationOrigin): void => transition(() => {
      if (origin !== 'UNKNOWN_RESULT' && origin !== 'PRECOMMIT_CLEANUP') {
        throw denial('CONFIRMATION_NOT_STARTED', 'confirmation origin is invalid');
      }
      if (confirmationStartMs === null && executionStartMs === null) {
        throw denial('EXECUTION_NOT_ADMITTED', 'confirmation requires an execution round to have begun');
      }
      if (confirmationStartMs === null && executionCommand !== null) {
        throw denial('COMMAND_IN_FLIGHT', 'cannot start confirmation with command in flight');
      }
      if (origin === 'UNKNOWN_RESULT') unknownResultSeen = true;
      else precommitCleanupSeen = true;
      if (confirmationStartMs !== null) return;
      const nowMs = readNow();
      confirmationStartMs = nowMs;
      confirmationDeadlineMs = addDeadline(nowMs, config.confirmationMs);
      confirmationNextAtMs = nowMs;
    }),

    admitNextUnknownConfirmation: (): ConfirmationPermit => transition(() => {
      if (confirmationStartMs === null || confirmationDeadlineMs === null || confirmationNextAtMs === null) {
        throw denial('CONFIRMATION_NOT_STARTED', 'confirmation has not started');
      }
      if (!unknownResultSeen) throw denial('CONFIRMATION_NOT_STARTED', 'unknown-result confirmation has not started');
      if (confirmationConfirmed) throw denial('CONFIRMATION_ALREADY_CONFIRMED', 'confirmation is already confirmed');
      if (confirmationResult === 'NO_EFFECT_CONFIRMED') throw denial('CONFIRMATION_ALREADY_CONFIRMED', 'confirmation has a no-effect result');
      if (confirmationCommand !== null) throw denial('CONFIRMATION_IN_FLIGHT', 'confirmation command is in flight');
      if (nativeGroup !== null) throw denial('NATIVE_GROUP_ACTIVE', 'confirmation is blocked by an active native group');
      if (confirmationSlotsRemaining < 1) throw denial('CONFIRMATION_SLOTS_EXHAUSTED', 'confirmation slots are exhausted');
      const nowMs = readNow();
      if (nowMs < confirmationNextAtMs) throw denial('CONFIRMATION_NOT_DUE', 'confirmation is not due yet');
      const remainingMs = confirmationDeadlineMs - nowMs;
      const kind: ConfirmationKind = confirmationAttempt % 2 === 0 ? 'ORIGINAL_COMMIT' : 'CANONICAL_READ';
      if (kind === 'ORIGINAL_COMMIT' && remainingMs < config.singleCommandMs) {
        throw denial('CONFIRMATION_WINDOW', 'original confirmation requires two seconds remaining');
      }
      if (remainingMs < 1) throw denial('CONFIRMATION_WINDOW', 'confirmation window has passed');
      const timeoutMs = kind === 'ORIGINAL_COMMIT' ? config.singleCommandMs : Math.min(config.singleCommandMs, remainingMs);
      if (timeoutMs < 1) throw denial('CONFIRMATION_WINDOW', 'confirmation timeout would be zero');
      const permit = Object.freeze({ kind, attempt: confirmationAttempt, timeoutMs }) as ConfirmationPermit;
      const state: ConfirmationState = { ledger: ledgerIdentity, permit, active: true };
      confirmations.set(permit, state);
      confirmationCommand = state;
      confirmationSlotsRemaining -= 1;
      return permit;
    }),

    settleStillUnknown: (permit: ConfirmationPermit): void => transition(() => {
      const state = requireConfirmation(permit);
      if (confirmationCommand !== state) failClosed('INVALID_PERMIT', 'confirmation permit is not current');
      const nowMs = readNow();
      state.active = false;
      confirmationCommand = null;
      confirmationAttempt += 1;
      confirmationResult = 'STILL_UNKNOWN';
      const delayMs = confirmationAttempt === 1 ? 1_000 : 2_000;
      confirmationNextAtMs = addDeadline(nowMs, delayMs);
    }),

    settleConfirmed: (permit: ConfirmationPermit): void => transition(() => {
      const state = requireConfirmation(permit);
      if (confirmationCommand !== state) failClosed('INVALID_PERMIT', 'confirmation permit is not current');
      state.active = false;
      confirmationCommand = null;
      confirmationConfirmed = true;
      confirmationResult = 'CANONICAL_RESULT';
    }),

    settleNoEffectConfirmed: (permit: ConfirmationPermit): void => transition(() => {
      const state = requireConfirmation(permit);
      if (confirmationCommand !== state) failClosed('INVALID_PERMIT', 'confirmation permit is not current');
      state.active = false;
      confirmationCommand = null;
      confirmationResult = 'NO_EFFECT_CONFIRMED';
    }),

    authorizeContinuation: (evidence: unknown): void => transition(() => {
      if (executionStartMs === null || confirmationStartMs === null) {
        throw denial('EXECUTION_NOT_ADMITTED', 'continuation requires execution and confirmation lifecycles');
      }
      if (activeRound !== null || executionCommand !== null || confirmationCommand !== null || nativeGroup !== null) {
        throw denial('COMMAND_IN_FLIGHT', 'continuation requires all commands and groups to be settled');
      }
      if (continuationAuthorized) throw denial('EXECUTION_NOT_ADMITTED', 'continuation is already authorized for the next round');
      if (confirmationResult !== 'NO_EFFECT_CONFIRMED') {
        throw denial(
          confirmationResult === 'CANONICAL_RESULT' || confirmationConfirmed
            ? 'CONFIRMATION_ALREADY_CONFIRMED'
            : 'EXECUTION_NOT_ADMITTED',
          'only a trusted no-effect confirmation can authorize continuation',
        );
      }
      if (roundsStarted >= config.maxRounds) {
        throw denial('EXECUTION_ROUNDS_EXHAUSTED', 'no execution round remains for continuation');
      }
      if (executionDeadlineMs === null) {
        throw denial('EXECUTION_NOT_ADMITTED', 'execution deadline is not established');
      }
      const nowMs = readNow();
      if (nowMs >= executionDeadlineMs) {
        throw denial('EXECUTION_DEADLINE', 'execution deadline has passed for continuation');
      }
      if (executionDeadlineMs - nowMs < 1) {
        throw denial('EXECUTION_DEADLINE', 'continuation has less than one millisecond remaining');
      }
      if ((typeof evidence !== 'object' && typeof evidence !== 'function') || evidence === null) {
        failClosed('CONTINUATION_EVIDENCE_REJECTED', 'continuation evidence must be an opaque object or function');
      }
      const opaqueEvidence = evidence as object;
      if (consumedContinuationEvidence.has(opaqueEvidence)) {
        failClosed('CONTINUATION_EVIDENCE_REJECTED', 'continuation evidence was already consumed');
      }
      let verifierResult: unknown;
      try {
        verifierResult = verifyContinuationEvidence(evidence);
      } catch (error: unknown) {
        failClosed('CONTINUATION_EVIDENCE_REJECTED', 'continuation evidence was rejected', error);
      }
      if (frozen) failClosed('CONTINUATION_EVIDENCE_REJECTED', 'continuation evidence verifier reentered the ledger');
      let thenProperty: unknown;
      try {
        thenProperty = (verifierResult as { readonly then?: unknown } | null)?.then;
      } catch (error: unknown) {
        failClosed('CONTINUATION_EVIDENCE_REJECTED', 'continuation verifier result could not be inspected', error);
      }
      if (typeof thenProperty === 'function') {
        try {
          void Promise.resolve(verifierResult).catch(() => undefined);
        } catch {
          // Promise.resolve is defensive only; authorization is still denied.
        }
        failClosed('CONTINUATION_EVIDENCE_REJECTED', 'continuation verifier must be synchronous');
      }
      if (verifierResult !== undefined) {
        failClosed('CONTINUATION_EVIDENCE_REJECTED', 'continuation verifier must return undefined');
      }
      if (frozen) failClosed('CONTINUATION_EVIDENCE_REJECTED', 'continuation evidence verifier reentered the ledger');
      consumedContinuationEvidence.add(opaqueEvidence);
      continuationAuthorized = true;
    }),

    reserveNativePrecommitGroup: (): NativePrecommitGroupPermit => transition(() => {
      if (confirmationStartMs === null || confirmationDeadlineMs === null || !precommitCleanupSeen) {
        throw denial('NATIVE_GROUP_NOT_ALLOWED', 'precommit cleanup confirmation is not active');
      }
      const currentRoundHadInitialCommit = activeRound?.initialCommitAdmitted ?? lastRoundInitialCommit;
      if (confirmationConfirmed || currentRoundHadInitialCommit) throw denial('NATIVE_GROUP_NOT_ALLOWED', 'native cleanup is no longer precommit');
      if (confirmationCommand !== null || executionCommand !== null) throw denial('COMMAND_IN_FLIGHT', 'a command is in flight');
      if (nativeGroup !== null) throw denial('NATIVE_GROUP_ACTIVE', 'a native group is already active');
      if (confirmationSlotsRemaining < config.nativeGroupSlots) throw denial('NATIVE_GROUP_SLOTS_EXHAUSTED', 'native group slots are exhausted');
      const nowMs = readNow();
      if (nowMs >= confirmationDeadlineMs) {
        throw denial('NATIVE_GROUP_WINDOW', 'native group no longer has a confirmation window');
      }
      const deadlineMs = addDeadline(nowMs, config.nativeGroupMs);
      const permit = Object.freeze({ timeoutMs: config.nativeGroupMs }) as NativePrecommitGroupPermit;
      const state: NativeGroupState = { ledger: ledgerIdentity, permit, deadlineMs, generation: nativeGroupsReserved + 1, active: true, attempts: 0, command: null };
      nativeGroups.set(permit, state);
      nativeGroup = state;
      nativeGroupsReserved += 1;
      confirmationSlotsRemaining -= config.nativeGroupSlots;
      return permit;
    }),

    admitNativePrecommitCommand: (permit: NativePrecommitGroupPermit): NativePrecommitCommandPermit => transition(() => {
      const group = requireNativeGroup(permit);
      if (nativeGroup !== group) failClosed('INVALID_PERMIT', 'native group permit is not current');
      if (confirmationCommand !== null || executionCommand !== null) throw denial('COMMAND_IN_FLIGHT', 'another command is in flight');
      if (group.command !== null) throw denial('COMMAND_IN_FLIGHT', 'native command is in flight');
      if (group.attempts >= 2) throw denial('NATIVE_GROUP_COMMANDS_EXHAUSTED', 'native group has used both sends');
      const nowMs = readNow();
      const remainingMs = group.deadlineMs - nowMs;
      if (remainingMs < 1) throw denial('NATIVE_GROUP_WINDOW', 'native group window has passed');
      const permitResult = Object.freeze({ timeoutMs: remainingMs, attempt: group.attempts }) as NativePrecommitCommandPermit;
      const state: NativeCommandState = { ledger: ledgerIdentity, group, permit: permitResult, active: true };
      nativeCommands.set(permitResult, state);
      group.command = state;
      group.attempts += 1;
      return permitResult;
    }),

    finishNativePrecommitCommand: (permit: NativePrecommitCommandPermit): void => transition(() => {
      const state = requireNativeCommand(permit);
      if (state.group.command !== state) failClosed('INVALID_PERMIT', 'native command permit is not current');
      state.active = false;
      state.group.command = null;
    }),

    finishNativePrecommitGroup: (permit: NativePrecommitGroupPermit, outcome: NativePrecommitOutcome): void => transition(() => {
      const state = requireNativeGroup(permit);
      if (nativeGroup !== state) failClosed('INVALID_PERMIT', 'native group permit is not current');
      if (state.command !== null) throw denial('COMMAND_IN_FLIGHT', 'native command is still in flight');
      if (outcome !== 'STILL_UNKNOWN' && outcome !== 'NO_EFFECT_CONFIRMED') {
        throw denial('NATIVE_GROUP_NOT_ALLOWED', 'native group outcome is invalid');
      }
      state.active = false;
      nativeGroup = null;
      confirmationResult = outcome;
    }),

    snapshot: (): BudgetLedgerSnapshot => frozen ? makeSnapshot() : transition(makeSnapshot),
  };

  return Object.freeze(ledger);

  function denial(code: BudgetErrorCode, message: string): BudgetLedgerError {
    return new BudgetLedgerError(code, operationId, message);
  }
}

export const createPerOperationBudgetLedger = createBudgetLedger;

function assertConstructionOptions(options: BudgetLedgerOptions): void {
  if (typeof options !== 'object' || options === null) throw new TypeError('budget ledger options are required');
  if (typeof options.clock !== 'object' || options.clock === null || typeof options.clock.nowMs !== 'function') {
    throw new TypeError('budget ledger clock is required');
  }
  if (typeof options.ownerFence !== 'object' || options.ownerFence === null || typeof options.ownerFence.assertCurrent !== 'function') {
    throw new TypeError('budget ledger owner fence is required');
  }
  if (typeof options.assertContinuationEvidence !== 'function') {
    throw new TypeError('budget ledger continuation evidence verifier is required');
  }
  if (typeof options.operationId !== 'string' || options.operationId.length === 0) {
    throw new TypeError('budget ledger operationId is required');
  }
}

function captureConfig(input: Partial<BudgetLedgerConfig> | undefined): BudgetLedgerConfig {
  const config = {
    executionMs: input?.executionMs ?? DEFAULT_CONFIG.executionMs,
    maxRounds: input?.maxRounds ?? DEFAULT_CONFIG.maxRounds,
    singleCommandMs: input?.singleCommandMs ?? DEFAULT_CONFIG.singleCommandMs,
    confirmationMs: input?.confirmationMs ?? DEFAULT_CONFIG.confirmationMs,
    confirmationSlots: input?.confirmationSlots ?? DEFAULT_CONFIG.confirmationSlots,
    nativeGroupSlots: input?.nativeGroupSlots ?? DEFAULT_CONFIG.nativeGroupSlots,
    nativeGroupMs: input?.nativeGroupMs ?? DEFAULT_CONFIG.nativeGroupMs,
  };
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`budget config ${name} must be a positive safe integer`);
  }
  if (config.maxRounds !== 3) throw new TypeError('budget maxRounds is fixed at 3');
  if (config.confirmationSlots !== 7) throw new TypeError('budget confirmationSlots is fixed at 7');
  if (config.nativeGroupSlots !== 2) throw new TypeError('budget nativeGroupSlots is fixed at 2');
  return Object.freeze(config);
}
