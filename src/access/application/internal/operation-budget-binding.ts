import {
  createBudgetLedger,
  type BudgetLedger,
  type BudgetLedgerConfig,
  type ContinuationEvidenceVerifier,
  type ExecutionCommandKind,
  type ExecutionCommandPermit,
  type NativePrecommitOutcome,
  type RoundPermit,
  type TrustedBudgetClock,
} from './budget-ledger.js';
import {
  createPrecommitTerminationLifecycle,
  type PrecommitAbortCommandContext,
  type PrecommitAbortGroupPermit,
  type PrecommitTerminationLifecycle,
} from './precommit-termination-lifecycle.js';
import type { WriteOperationContext } from './write-operation-coordinator.js';

/**
 * The G10b bridge between the coordinator's *real* active write context and
 * the per-original-write ledger.
 *
 * This module is deliberately internal.  Its public binding and round
 * capabilities are nominal; all operation IDs, owner callbacks, ledger
 * permits, and lifecycle state remain in module-private WeakMaps.  In
 * particular, neither an HTTP DTO nor a persistence adapter can manufacture
 * a usable binding.
 */

export type OperationBudgetBindingErrorCode =
  | 'BINDING_FROZEN'
  | 'INVALID_CONTEXT'
  | 'BINDING_ALREADY_CREATED'
  | 'BINDING_CONTEXT_MISMATCH'
  | 'INVALID_BINDING'
  | 'INVALID_ROUND'
  | 'INVALID_COMMAND'
  | 'INVALID_PRECOMMIT'
  | 'PRECOMMIT_ALREADY_STARTED'
  | 'OWNER_STALE'
  | 'REENTRANT';

export class OperationBudgetBindingError extends Error {
  readonly code: OperationBudgetBindingErrorCode;

  constructor(code: OperationBudgetBindingErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'OperationBudgetBindingError';
    this.code = code;
  }
}

declare const bindingBrand: unique symbol;
declare const factoryBrand: unique symbol;
declare const roundBrand: unique symbol;
declare const precommitBrand: unique symbol;
declare const precommitGroupBrand: unique symbol;

/** Opaque, per-original-write capability.  It deliberately has no fields. */
export interface OperationBudgetBinding {
  readonly [bindingBrand]: never;
}

/**
 * Trusted bootstrap dependency.  Its only operational authority is to bind a
 * coordinator-issued active context; per-operation callers cannot select a
 * clock, calibration, or continuation verifier.
 */
export interface OperationBudgetBindingFactory {
  readonly [factoryBrand]: never;
  bind(context: WriteOperationContext): OperationBudgetBinding;
}

/** Opaque wrapper around this binding's one active execution round. */
export interface OperationBudgetRound {
  readonly [roundBrand]: never;
}

/** The only execution facts a CRUD or initial-commit sender needs. */
export interface OperationExecutionCommandContext {
  readonly kind: ExecutionCommandKind;
  readonly timeoutMs: number;
}

/** Opaque wrapper around the precommit-only native-abort lifecycle. */
export interface OperationPrecommitTermination {
  readonly [precommitBrand]: never;
}

/** Opaque wrapper around one native precommit group. */
export interface OperationPrecommitAbortGroup {
  readonly [precommitGroupBrand]: never;
}

/**
 * Composition/bootstrap-only inputs.  This is deliberately separate from
 * the context-level factory interface so no individual write can override
 * shared budget policy or trusted dependencies.
 */
export interface TrustedOperationBudgetBindingFactoryOptions {
  readonly clock: TrustedBudgetClock;
  readonly assertContinuationEvidence: ContinuationEvidenceVerifier;
  readonly config?: Partial<BudgetLedgerConfig>;
}

interface TrustedContextState {
  readonly context: WriteOperationContext;
  readonly operationId: string;
  readonly assertOwnerCurrent: () => void;
}

interface BindingState {
  readonly binding: OperationBudgetBinding;
  readonly context: TrustedContextState;
  readonly ledger: BudgetLedger;
  readonly lifecycle: PrecommitTerminationLifecycle;
  readonly rounds: WeakMap<object, RoundState>;
  readonly precommits: WeakMap<object, PrecommitState>;
  readonly groups: WeakMap<object, GroupState>;
  frozen: boolean;
  transitioning: boolean;
  precommit: PrecommitState | null;
}

interface RoundState {
  readonly binding: BindingState;
  readonly raw: RoundPermit;
  active: boolean;
}

interface CommandState {
  readonly binding: BindingState;
  readonly raw: ExecutionCommandPermit;
  readonly context: OperationExecutionCommandContext;
  active: boolean;
}

interface PrecommitState {
  readonly binding: BindingState;
  active: boolean;
}

interface GroupState {
  readonly binding: BindingState;
  readonly precommit: PrecommitState;
  readonly raw: PrecommitAbortGroupPermit;
  active: boolean;
}

const trustedContexts = new WeakMap<object, TrustedContextState>();
const bindingByContext = new WeakMap<object, BindingState>();
const bindings = new WeakMap<object, BindingState>();

/**
 * Called only by the coordinator immediately after it freezes an active
 * context.  It is intentionally absent from every barrel export; consumers
 * must receive the coordinator-issued context, not construct one.
 */
export function registerTrustedWriteOperationContext(context: WriteOperationContext): void {
  if (!isObject(context) || !Object.isFrozen(context) || !isObject(context.owner) || !Object.isFrozen(context.owner)) {
    throw new TypeError('trusted write operation context must be frozen');
  }
  if (typeof context.operationId !== 'string' || context.operationId.length === 0
    || typeof context.assertCurrent !== 'function' || typeof context.owner.assertCurrent !== 'function'
    || context.assertCurrent !== context.owner.assertCurrent) {
    throw new TypeError('trusted write operation context is invalid');
  }
  if (trustedContexts.has(context)) throw new TypeError('trusted write operation context is already registered');
  const assertOwnerCurrent = context.assertCurrent.bind(context);
  trustedContexts.set(context, Object.freeze({ context, operationId: context.operationId, assertOwnerCurrent }));
}

export function createOperationBudgetBindingFactory(
  options: TrustedOperationBudgetBindingFactoryOptions,
): OperationBudgetBindingFactory {
  assertFactoryOptions(options);

  // Capture the bootstrap dependencies once.  The factory exposes neither
  // these capabilities nor any mutable policy surface to individual writes.
  const clock = Object.freeze({ nowMs: options.clock.nowMs.bind(options.clock) });
  const assertContinuationEvidence = options.assertContinuationEvidence;
  const config = options.config === undefined ? undefined : Object.freeze({ ...options.config });

  return Object.freeze({
    bind: (context: WriteOperationContext): OperationBudgetBinding => createBinding(
      context,
      clock,
      assertContinuationEvidence,
      config,
    ),
  }) as OperationBudgetBindingFactory;
}

/**
 * Composition-only provenance assertion.  It intentionally is not re-exported
 * from an application barrel: the G10b composition bridge needs to reject a
 * structurally forged opaque binding before recording it against a scope.
 */
export function assertOperationBudgetBindingProvenance(binding: OperationBudgetBinding): void {
  requireBinding(binding);
}

/**
 * Composition-only ownership assertion.  A genuine opaque binding is useful
 * only for the exact coordinator context that created it; matching public
 * operation facts alone is deliberately insufficient.
 */
export function assertOperationBudgetBindingOwnership(
  binding: OperationBudgetBinding,
  context: WriteOperationContext,
): void {
  const state = requireBinding(binding);
  if (state.context.context !== context) {
    throw new OperationBudgetBindingError(
      'BINDING_CONTEXT_MISMATCH',
      'operation budget binding belongs to a different write operation context',
    );
  }
}

/** Composition-only liveness assertion for a binding before it reaches a scope. */
export function assertOperationBudgetBindingCurrent(binding: OperationBudgetBinding): void {
  const state = requireBinding(binding);
  transition(state, () => undefined);
}

function createBinding(
  context: WriteOperationContext,
  clock: TrustedBudgetClock,
  assertContinuationEvidence: ContinuationEvidenceVerifier,
  config: Partial<BudgetLedgerConfig> | undefined,
): OperationBudgetBinding {
  const trustedContext = trustedContexts.get(context);
  if (trustedContext === undefined || trustedContext.context !== context) {
    throw new OperationBudgetBindingError('INVALID_CONTEXT', 'operation budget binding requires a coordinator-issued write context');
  }
  assertTrustedContextOwnerCurrent(trustedContext);
  if (bindingByContext.has(context)) {
    throw new OperationBudgetBindingError('BINDING_ALREADY_CREATED', 'an operation budget binding already exists for this write context');
  }

  // Capture the real coordinator owner fence once.  The ledger and the
  // precommit lifecycle each receive this same captured fence; no consumer
  // can replace it by mutating a caller-owned option object later.
  const ownerFence = Object.freeze({ assertCurrent: trustedContext.assertOwnerCurrent });
  const ledgerOptions = {
    clock,
    ownerFence,
    operationId: trustedContext.operationId,
    assertContinuationEvidence,
  };
  const ledger = config === undefined
    ? createBudgetLedger(ledgerOptions)
    : createBudgetLedger({ ...ledgerOptions, config });
  const lifecycle = createPrecommitTerminationLifecycle({ ledger, ownerFence });
  const binding = Object.freeze({}) as OperationBudgetBinding;
  const state: BindingState = {
    binding,
    context: trustedContext,
    ledger,
    lifecycle,
    rounds: new WeakMap<object, RoundState>(),
    precommits: new WeakMap<object, PrecommitState>(),
    groups: new WeakMap<object, GroupState>(),
    frozen: false,
    transitioning: false,
    precommit: null,
  };
  bindingByContext.set(context, state);
  bindings.set(binding, state);
  return binding;
}

function assertTrustedContextOwnerCurrent(context: TrustedContextState): void {
  let result: unknown;
  try {
    result = context.assertOwnerCurrent();
  } catch (error: unknown) {
    throw new OperationBudgetBindingError(
      'OWNER_STALE',
      'operation budget binding owner is stale before binding creation',
      { cause: error },
    );
  }
  if (result !== undefined) {
    throw new OperationBudgetBindingError(
      'OWNER_STALE',
      'operation budget binding owner fence must be synchronous and return undefined before binding creation',
    );
  }
}

export function beginOperationExecutionRound(binding: OperationBudgetBinding): OperationBudgetRound {
  const state = requireBinding(binding);
  return transition(state, () => {
    const raw = state.ledger.beginRound();
    const token = Object.freeze({}) as OperationBudgetRound;
    state.rounds.set(token, { binding: state, raw, active: true });
    return token;
  });
}

export async function executeOperationCrud(
  binding: OperationBudgetBinding,
  round: OperationBudgetRound,
  send: (context: OperationExecutionCommandContext) => void | PromiseLike<void>,
): Promise<void> {
  return executeOperationCommand(binding, round, 'CRUD', send);
}

export async function executeOperationInitialCommit(
  binding: OperationBudgetBinding,
  round: OperationBudgetRound,
  send: (context: OperationExecutionCommandContext) => void | PromiseLike<void>,
): Promise<void> {
  return executeOperationCommand(binding, round, 'INITIAL_COMMIT', send);
}

export function finishOperationExecutionRound(binding: OperationBudgetBinding, round: OperationBudgetRound): void {
  const state = requireBinding(binding);
  transition(state, () => {
    const roundState = requireRound(state, round);
    state.ledger.finishRound(roundState.raw);
    roundState.active = false;
  });
}

/**
 * Atomically starts the precommit confirmation window and seals its matching
 * lifecycle.  It is intentionally distinct from G10c unknown confirmation.
 */
export function startOperationPrecommitTermination(binding: OperationBudgetBinding): OperationPrecommitTermination {
  const state = requireBinding(binding);
  return transition(state, () => {
    if (state.precommit !== null) failClosed(state, 'PRECOMMIT_ALREADY_STARTED', 'precommit termination already started');
    state.ledger.startConfirmation('PRECOMMIT_CLEANUP');
    try {
      state.lifecycle.sealScope('PRECOMMIT');
    } catch (error: unknown) {
      failClosed(state, 'OWNER_STALE', 'precommit lifecycle could not be sealed after confirmation started', error);
    }
    const token = Object.freeze({}) as OperationPrecommitTermination;
    const precommit: PrecommitState = { binding: state, active: true };
    state.precommits.set(token, precommit);
    state.precommit = precommit;
    return token;
  });
}

export function reserveOperationPrecommitAbortGroup(
  binding: OperationBudgetBinding,
  precommit: OperationPrecommitTermination,
): OperationPrecommitAbortGroup {
  const state = requireBinding(binding);
  return transition(state, () => {
    const precommitState = requirePrecommit(state, precommit);
    const raw = state.lifecycle.reserveAbortGroup();
    const token = Object.freeze({}) as OperationPrecommitAbortGroup;
    state.groups.set(token, { binding: state, precommit: precommitState, raw, active: true });
    return token;
  });
}

export async function executeOperationPrecommitAbort(
  binding: OperationBudgetBinding,
  group: OperationPrecommitAbortGroup,
  send: (context: PrecommitAbortCommandContext) => void | PromiseLike<void>,
): Promise<void> {
  const state = requireBinding(binding);
  const raw = transition(state, () => {
    const groupState = requireGroup(state, group);
    if (typeof send !== 'function') failClosed(state, 'INVALID_PRECOMMIT', 'precommit abort sender is required');
    return groupState.raw;
  });
  // The lifecycle owns the asynchronous permit and independently checks the
  // same captured owner fence at command admission and settlement.
  await state.lifecycle.executeAbort(raw, send);
}

export function terminateOperationPrecommit(
  binding: OperationBudgetBinding,
  group: OperationPrecommitAbortGroup,
  outcome: NativePrecommitOutcome,
): void {
  const state = requireBinding(binding);
  transition(state, () => {
    const groupState = requireGroup(state, group);
    state.lifecycle.terminate(groupState.raw, outcome);
    groupState.active = false;
    groupState.precommit.active = false;
    state.precommit = null;
  });
}

function executeOperationCommand(
  binding: OperationBudgetBinding,
  round: OperationBudgetRound,
  kind: ExecutionCommandKind,
  send: (context: OperationExecutionCommandContext) => void | PromiseLike<void>,
): Promise<void> {
  const state = requireBinding(binding);
  const command = transition(state, () => {
    if (typeof send !== 'function') failClosed(state, 'INVALID_COMMAND', 'operation execution sender is required');
    const roundState = requireRound(state, round);
    const raw = state.ledger.admitExecutionCommand(roundState.raw, kind);
    const context = Object.freeze({ kind: raw.kind, timeoutMs: raw.timeoutMs });
    return { binding: state, raw, context, active: true } satisfies CommandState;
  });

  // Like the native precommit lifecycle, command admission and initial sender
  // invocation are synchronous.  The raw permit never leaves this module and
  // is settled exactly once after every sync or async sender outcome.
  let result: void | PromiseLike<void>;
  try {
    result = send(command.context);
  } catch (error: unknown) {
    try {
      settleOperationCommand(command);
    } catch (settlementError: unknown) {
      return Promise.reject(settlementError);
    }
    return Promise.reject(error);
  }
  return Promise.resolve(result).then(
    () => { settleOperationCommand(command); },
    (error: unknown) => {
      try {
        settleOperationCommand(command);
      } catch (settlementError: unknown) {
        throw settlementError;
      }
      throw error;
    },
  );
}

function settleOperationCommand(command: CommandState): void {
  transition(command.binding, () => {
    if (!command.active) failClosed(command.binding, 'INVALID_COMMAND', 'operation execution command is no longer active');
    command.binding.ledger.finishExecutionCommand(command.raw);
    command.active = false;
  });
}

function requireBinding(binding: OperationBudgetBinding): BindingState {
  if (!isObject(binding)) {
    throw new OperationBudgetBindingError('INVALID_BINDING', 'operation budget binding is invalid');
  }
  const state = bindings.get(binding);
  if (state === undefined || state.binding !== binding) {
    throw new OperationBudgetBindingError('INVALID_BINDING', 'operation budget binding provenance is invalid');
  }
  if (state.frozen) throw new OperationBudgetBindingError('BINDING_FROZEN', 'operation budget binding is permanently frozen');
  return state;
}

function requireRound(state: BindingState, token: OperationBudgetRound): RoundState {
  if (!isObject(token)) failClosed(state, 'INVALID_ROUND', 'operation execution round is invalid');
  const round = state.rounds.get(token);
  if (round === undefined || round.binding !== state || !round.active) {
    failClosed(state, 'INVALID_ROUND', 'operation execution round provenance is invalid');
  }
  return round as RoundState;
}

function requirePrecommit(state: BindingState, token: OperationPrecommitTermination): PrecommitState {
  if (!isObject(token)) failClosed(state, 'INVALID_PRECOMMIT', 'operation precommit lifecycle is invalid');
  const precommit = state.precommits.get(token);
  if (precommit === undefined || precommit.binding !== state || !precommit.active || state.precommit !== precommit) {
    failClosed(state, 'INVALID_PRECOMMIT', 'operation precommit lifecycle provenance is invalid');
  }
  return precommit as PrecommitState;
}

function requireGroup(state: BindingState, token: OperationPrecommitAbortGroup): GroupState {
  if (!isObject(token)) failClosed(state, 'INVALID_PRECOMMIT', 'operation precommit abort group is invalid');
  const group = state.groups.get(token);
  if (group === undefined || group.binding !== state || !group.active || !group.precommit.active) {
    failClosed(state, 'INVALID_PRECOMMIT', 'operation precommit abort group provenance is invalid');
  }
  return group as GroupState;
}

function transition<T>(state: BindingState, work: () => T): T {
  if (state.transitioning) failClosed(state, 'REENTRANT', 'operation budget binding is reentrant');
  if (state.frozen) throw new OperationBudgetBindingError('BINDING_FROZEN', 'operation budget binding is permanently frozen');
  state.transitioning = true;
  try {
    assertOwner(state);
    return work();
  } finally {
    state.transitioning = false;
  }
}

function assertOwner(state: BindingState): void {
  let result: unknown;
  try {
    result = state.context.assertOwnerCurrent();
  } catch (error: unknown) {
    failClosed(state, 'OWNER_STALE', 'operation budget binding owner is stale', error);
  }
  if (state.frozen) failClosed(state, 'OWNER_STALE', 'operation budget binding owner reentered the binding');
  if (result !== undefined) failClosed(state, 'OWNER_STALE', 'operation budget binding owner fence must return undefined');
}

function failClosed(
  state: BindingState,
  code: Exclude<OperationBudgetBindingErrorCode, 'BINDING_FROZEN' | 'INVALID_BINDING' | 'BINDING_ALREADY_CREATED' | 'INVALID_CONTEXT'>,
  message: string,
  cause?: unknown,
): never {
  state.frozen = true;
  throw new OperationBudgetBindingError(code, message, cause === undefined ? undefined : { cause });
}

function assertFactoryOptions(options: TrustedOperationBudgetBindingFactoryOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('operation budget binding factory options are required');
  }
  if (typeof options.clock !== 'object' || options.clock === null || typeof options.clock.nowMs !== 'function') {
    throw new TypeError('operation budget binding clock is required');
  }
  if (typeof options.assertContinuationEvidence !== 'function') {
    throw new TypeError('operation budget binding continuation evidence verifier is required');
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
