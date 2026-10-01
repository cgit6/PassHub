import type { ClientSession } from 'mongodb';

import type { AccessScopeContext } from '../../../access/ports/index.js';
import type { G10bScopedPersistenceBinding } from './g10b-scoped-persistence-sidecar.js';
import { readAccessScopeContextClaims } from '../../../shared/access-scope-context.js';
import {
  assertOperationUnknownCommitConfirmationCurrent,
  startOperationUnknownCommitConfirmation,
  type OperationBudgetBinding,
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
}

const concreteAdapters = new WeakSet<object>();
const attachedSinks = new WeakMap<object, G10cPostCommitUnknownHandoffSink>();
const bundleSinks = new WeakSet<object>();
const handoffs = new WeakMap<object, HandoffState>();
const handedOffContexts = new WeakMap<object, WeakSet<object>>();

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
  });
  return Object.freeze({ sink, owner });
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
