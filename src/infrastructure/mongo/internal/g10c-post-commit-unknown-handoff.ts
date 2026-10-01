import type { ClientSession } from 'mongodb';

import type { AccessScopeContext } from '../../../access/ports/index.js';
import type { G10bScopedPersistenceBinding } from './g10b-scoped-persistence-sidecar.js';
import { readAccessScopeContextClaims } from '../../../shared/access-scope-context.js';
import {
  admitOperationUnknownCommitConfirmationAction,
  assertOperationUnknownCommitConfirmationCurrent,
  settleOperationUnknownCommitConfirmationAction,
  startOperationUnknownCommitConfirmation,
  type OperationBudgetBinding,
  type OperationUnknownCommitConfirmationAction,
  type OperationUnknownCommitConfirmationOutcome,
  type OperationUnknownCommitConfirmation,
} from '../../../access/application/internal/operation-budget-binding.js';
import type { G04bMongoPersistenceAdapter } from '../g04b-persistence-adapter.js';

/**
 * An opaque, single-use claim over a transaction whose initial commit sender
 * ran but whose result is unknown.  It deliberately exposes neither the
 * Mongo session nor any G10b persistence/budget authority.
 */
declare const g10cPostCommitUnknownHandoffBrand: unique symbol;

export interface G10cPostCommitUnknownHandoff {
  readonly [g10cPostCommitUnknownHandoffBrand]: never;
}

declare const g10cPostCommitUnknownConfirmationActionBrand: unique symbol;

/**
 * The future G10c sender sees only the next command's safe facts.  Its raw
 * BudgetLedger permit, ClientSession, and persistence authority stay private
 * to this handoff boundary.
 */
export interface G10cPostCommitUnknownConfirmationAction {
  readonly [g10cPostCommitUnknownConfirmationActionBrand]: never;
  readonly kind: 'ORIGINAL_COMMIT' | 'CANONICAL_READ';
  readonly attempt: number;
  readonly timeoutMs: number;
}

export type G10cPostCommitUnknownConfirmationOutcome = OperationUnknownCommitConfirmationOutcome;

/**
 * The deliberately narrow result of resending the original commit command.
 * A resolved driver command confirms the transaction outcome; a rejected
 * command remains unknown and must proceed to the later canonical-read phase.
 */
export type G10cRetainedOriginalCommitAttemptResult = Readonly<{
  readonly delivery: 'COMMIT_CONFIRMED' | 'REJECTED_STILL_UNKNOWN';
  readonly attempt: number;
  readonly timeoutMs: number;
}>;

export type G10cRetainedOriginalCommitTerminatorErrorCode =
  | 'TERMINATOR_CLOSED'
  | 'TERMINATOR_NOT_INITIAL';

export class G10cRetainedOriginalCommitTerminatorError extends Error {
  readonly code: G10cRetainedOriginalCommitTerminatorErrorCode;

  constructor(code: G10cRetainedOriginalCommitTerminatorErrorCode, message: string) {
    super(message);
    this.name = 'G10cRetainedOriginalCommitTerminatorError';
    this.code = code;
  }
}

/**
 * A single, retained-session attempt to resend the original commit.  It owns
 * no cleanup, canonical read, or result interpretation authority.
 */
export interface G10cRetainedOriginalCommitTerminator {
  attemptOriginalCommit(): Promise<G10cRetainedOriginalCommitAttemptResult>;
}

/** The adapter-facing, synchronous receiver for an opaque handoff only. */
export interface G10cPostCommitUnknownHandoffSink {
  retain(handoff: G10cPostCommitUnknownHandoff): void;
}

/**
 * The future confirmation owner may inspect its queue and claim an item once.
 * Claiming does not execute any Mongo command in this G10c increment.
 */
export interface G10cPostCommitUnknownHandoffOwner {
  pending(): readonly G10cPostCommitUnknownHandoff[];
  take(handoff: G10cPostCommitUnknownHandoff): G10cPostCommitUnknownHandoff;
  admitNextConfirmation(
    handoff: G10cPostCommitUnknownHandoff,
  ): G10cPostCommitUnknownConfirmationAction;
  settleConfirmation(
    handoff: G10cPostCommitUnknownHandoff,
    action: G10cPostCommitUnknownConfirmationAction,
    outcome: G10cPostCommitUnknownConfirmationOutcome,
  ): void;
}

export interface G10cPostCommitUnknownHandoffBundle {
  readonly sink: G10cPostCommitUnknownHandoffSink;
  readonly owner: G10cPostCommitUnknownHandoffOwner;
}

interface HandoffState {
  readonly adapter: G04bMongoPersistenceAdapter;
  readonly scope: AccessScopeContext;
  readonly session: ClientSession;
  readonly binding: OperationBudgetBinding;
  readonly confirmation: OperationUnknownCommitConfirmation;
  readonly sink: G10cPostCommitUnknownHandoffSink;
  status: 'RETAINED' | 'TAKEN';
  originalCommitTerminatorClaimed: boolean;
  confirmationActionAdmitted: boolean;
}

interface ConfirmationActionState {
  readonly handoff: G10cPostCommitUnknownHandoff;
  readonly raw: OperationUnknownCommitConfirmationAction;
  active: boolean;
}

const concreteAdapters = new WeakSet<object>();
const attachedSinks = new WeakMap<object, G10cPostCommitUnknownHandoffSink>();
const bundleSinks = new WeakSet<object>();
const ownerSinks = new WeakMap<object, G10cPostCommitUnknownHandoffSink>();
const handoffs = new WeakMap<object, HandoffState>();
const handedOffContexts = new WeakMap<object, WeakSet<object>>();
const confirmationActions = new WeakMap<object, ConfirmationActionState>();

/** Called only by the concrete G04b adapter constructor. */
export function registerG10cConcreteG04bMongoPersistenceAdapter(
  adapter: G04bMongoPersistenceAdapter,
): void {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new TypeError('G10c concrete G04b adapter is invalid');
  }
  concreteAdapters.add(adapter as object);
}

/**
 * Attach a single composition-owned sink before any unknown result is handed
 * off.  This is intentionally separate from G10b's persistence sidecar: it
 * has no transaction command or budget authority.
 */
export function attachG10cPostCommitUnknownHandoffSink(
  adapter: G04bMongoPersistenceAdapter,
  sink: G10cPostCommitUnknownHandoffSink,
): void {
  if (!concreteAdapters.has(adapter as object)) {
    throw new TypeError('G10c handoff requires a concrete G04b Mongo persistence adapter');
  }
  if (!bundleSinks.has(sink as object)) {
    throw new TypeError('G10c post-commit unknown handoff sink is foreign');
  }
  if (attachedSinks.has(adapter as object)) {
    throw new TypeError('G10c post-commit unknown handoff sink is already attached');
  }
  attachedSinks.set(adapter as object, sink);
}

/**
 * Retain an unknown initial-commit transaction exactly once for the attached
 * future confirmation owner.  The adapter invokes this synchronously in its
 * initial-commit error path; no transport, persistence, abort, or cleanup
 * action occurs here.
 */
export function handoffG10cPostCommitUnknown(
  adapter: G04bMongoPersistenceAdapter,
  scope: AccessScopeContext,
  session: ClientSession,
  binding: G10bScopedPersistenceBinding,
): void {
  const sink = attachedSinks.get(adapter as object);
  if (sink === undefined) return;
  const claims = readAccessScopeContextClaims(scope);
  if (claims === null || claims.owner.length === 0) {
    throw new TypeError('G10c post-commit unknown handoff scope is untrusted');
  }
  let contexts = handedOffContexts.get(adapter as object);
  if (contexts?.has(scope as object)) {
    throw new TypeError('G10c post-commit unknown handoff was already retained for this transaction');
  }
  // This starts the common confirmation clock and seals COMMIT_UNKNOWN before
  // the opaque value escapes.  A precommit abort group is now forbidden.
  // The G04b adapter deliberately knows this only as the opaque G10b sidecar
  // value.  Provenance is checked by the G10c budget wrapper before it can
  // establish the unknown-result lifecycle.
  const operationBinding = binding as OperationBudgetBinding;
  const confirmation = startOperationUnknownCommitConfirmation(operationBinding);
  if (contexts === undefined) {
    contexts = new WeakSet<object>();
    handedOffContexts.set(adapter as object, contexts);
  }
  contexts.add(scope as object);
  const handoff = Object.freeze({}) as G10cPostCommitUnknownHandoff;
  handoffs.set(handoff as object, {
    adapter,
    scope,
    session,
    binding: operationBinding,
    confirmation,
    sink,
    status: 'RETAINED',
    originalCommitTerminatorClaimed: false,
    confirmationActionAdmitted: false,
  });
  sink.retain(handoff);
}

export function createG10cPostCommitUnknownHandoffBundle(): G10cPostCommitUnknownHandoffBundle {
  const queued: G10cPostCommitUnknownHandoff[] = [];
  const sink: G10cPostCommitUnknownHandoffSink = Object.freeze({
    retain(handoff: G10cPostCommitUnknownHandoff): void {
      const state = requireHandoff(handoff);
      if (state.sink !== sink || state.status !== 'RETAINED' || queued.includes(handoff)) {
        throw new TypeError('G10c post-commit unknown handoff cannot be retained');
      }
      queued.push(handoff);
    },
  });
  bundleSinks.add(sink as object);

  const owner: G10cPostCommitUnknownHandoffOwner = Object.freeze({
    pending(): readonly G10cPostCommitUnknownHandoff[] {
      return Object.freeze([...queued]);
    },
    take(handoff: G10cPostCommitUnknownHandoff): G10cPostCommitUnknownHandoff {
      const state = requireHandoff(handoff);
      if (state.sink !== sink || state.status !== 'RETAINED') {
        throw new TypeError('G10c post-commit unknown handoff owner is foreign or stale');
      }
      const index = queued.indexOf(handoff);
      if (index < 0) throw new TypeError('G10c post-commit unknown handoff is not queued');
      // The opaque claim remains bound to the same original operation owner;
      // a coordinator queue identity alone is never authority to continue it.
      assertOperationUnknownCommitConfirmationCurrent(state.binding, state.confirmation);
      queued.splice(index, 1);
      state.status = 'TAKEN';
      return handoff;
    },
    admitNextConfirmation(
      handoff: G10cPostCommitUnknownHandoff,
    ): G10cPostCommitUnknownConfirmationAction {
      const state = requireTakenHandoff(sink, handoff);
      const admission = admitOperationUnknownCommitConfirmationAction(state.binding, state.confirmation);
      state.confirmationActionAdmitted = true;
      const action = Object.freeze({
        kind: admission.context.kind,
        attempt: admission.context.attempt,
        timeoutMs: admission.context.timeoutMs,
      }) as G10cPostCommitUnknownConfirmationAction;
      confirmationActions.set(action, { handoff, raw: admission.action, active: true });
      return action;
    },
    settleConfirmation(
      handoff: G10cPostCommitUnknownHandoff,
      action: G10cPostCommitUnknownConfirmationAction,
      outcome: G10cPostCommitUnknownConfirmationOutcome,
    ): void {
      const state = requireTakenHandoff(sink, handoff);
      const actionState = requireConfirmationAction(handoff, action);
      settleOperationUnknownCommitConfirmationAction(
        state.binding,
        state.confirmation,
        actionState.raw,
        outcome,
      );
      actionState.active = false;
    },
  });
  ownerSinks.set(owner as object, sink);
  return Object.freeze({ sink, owner });
}

/**
 * Create the first G10c command sender for a taken handoff.  It can only be
 * claimed before any other confirmation action, which makes the ledger's
 * first prescribed action unambiguously ORIGINAL_COMMIT.  The retained Mongo
 * session stays encapsulated here; callers receive neither it nor a raw
 * budget permit.
 */
export function createG10cRetainedOriginalCommitTerminator(
  owner: G10cPostCommitUnknownHandoffOwner,
  handoff: G10cPostCommitUnknownHandoff,
): G10cRetainedOriginalCommitTerminator {
  const sink = ownerSinks.get(owner as object);
  if (sink === undefined) {
    throw new TypeError('G10c retained original commit terminator owner is foreign');
  }
  const state = requireTakenHandoff(sink, handoff);
  if (state.originalCommitTerminatorClaimed || state.confirmationActionAdmitted) {
    throw new G10cRetainedOriginalCommitTerminatorError(
      'TERMINATOR_NOT_INITIAL',
      'G10c retained original commit terminator requires the initial confirmation action',
    );
  }
  state.originalCommitTerminatorClaimed = true;
  const commitTransaction = state.session.commitTransaction.bind(state.session);
  let closed = false;

  return Object.freeze({
    attemptOriginalCommit: async (): Promise<G10cRetainedOriginalCommitAttemptResult> => {
      if (closed) {
        throw new G10cRetainedOriginalCommitTerminatorError(
          'TERMINATOR_CLOSED',
          'G10c retained original commit terminator cannot send a second command',
        );
      }
      closed = true;

      const action = owner.admitNextConfirmation(handoff);
      if (action.kind !== 'ORIGINAL_COMMIT') {
        // The construction guard above makes this unreachable for an honest
        // owner.  Never route a canonical-read permit to commitTransaction.
        owner.settleConfirmation(handoff, action, 'STILL_UNKNOWN');
        throw new G10cRetainedOriginalCommitTerminatorError(
          'TERMINATOR_NOT_INITIAL',
          'G10c retained original commit terminator was not prescribed an original commit',
        );
      }

      try {
        await commitTransaction({ timeoutMS: action.timeoutMs });
      } catch (_error: unknown) {
        // A driver/transport rejection does not establish no effect.  Keep
        // the handoff in the unknown state for the canonical-read phase.
        owner.settleConfirmation(handoff, action, 'STILL_UNKNOWN');
        return Object.freeze({
          delivery: 'REJECTED_STILL_UNKNOWN',
          attempt: action.attempt,
          timeoutMs: action.timeoutMs,
        });
      }
      // A resolved resend is Mongo's confirmation of the same retained
      // transaction.  Settlement is deliberately outside the send catch:
      // an owner/budget failure must not be recast as a transport failure.
      owner.settleConfirmation(handoff, action, 'CANONICAL_RESULT');
      return Object.freeze({
        delivery: 'COMMIT_CONFIRMED',
        attempt: action.attempt,
        timeoutMs: action.timeoutMs,
      });
    },
  });
}

function requireHandoff(handoff: G10cPostCommitUnknownHandoff): HandoffState {
  if ((typeof handoff !== 'object' && typeof handoff !== 'function') || handoff === null
    || !Object.isFrozen(handoff) || Reflect.ownKeys(handoff).length !== 0) {
    throw new TypeError('G10c post-commit unknown handoff is invalid');
  }
  const state = handoffs.get(handoff as object);
  if (state === undefined) throw new TypeError('G10c post-commit unknown handoff is foreign or forged');
  return state;
}

function requireTakenHandoff(
  sink: G10cPostCommitUnknownHandoffSink,
  handoff: G10cPostCommitUnknownHandoff,
): HandoffState {
  const state = requireHandoff(handoff);
  if (state.sink !== sink || state.status !== 'TAKEN') {
    throw new TypeError('G10c post-commit unknown handoff owner is foreign or stale');
  }
  assertOperationUnknownCommitConfirmationCurrent(state.binding, state.confirmation);
  return state;
}

function requireConfirmationAction(
  handoff: G10cPostCommitUnknownHandoff,
  action: G10cPostCommitUnknownConfirmationAction,
): ConfirmationActionState {
  if ((typeof action !== 'object' && typeof action !== 'function') || action === null
    || !Object.isFrozen(action)) {
    throw new TypeError('G10c post-commit unknown confirmation action is invalid');
  }
  const state = confirmationActions.get(action as object);
  if (state === undefined || state.handoff !== handoff || !state.active) {
    throw new TypeError('G10c post-commit unknown confirmation action is foreign or stale');
  }
  return state;
}
