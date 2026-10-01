import type { AccessScopeContext } from '../../../access/ports/index.js';
import {
  assertOperationBudgetBindingProvenance,
  beginOperationExecutionRound,
  executeOperationCrud,
  executeOperationInitialCommit,
  finishOperationExecutionRound,
  executeOperationPrecommitAbort,
  reserveOperationPrecommitAbortGroup,
  startOperationPrecommitTermination,
  terminateOperationPrecommit,
  type OperationBudgetBinding,
  type OperationPrecommitAbortGroup,
  type OperationPrecommitTermination,
  type OperationBudgetRound,
  type OperationExecutionCommandContext,
} from '../../../access/application/internal/operation-budget-binding.js';
import type { NativePrecommitOutcome } from '../../../access/application/internal/budget-ledger.js';
import type { PrecommitAbortCommandContext } from '../../../access/application/internal/precommit-termination-lifecycle.js';
import type { G04bMongoPersistenceAdapter } from '../g04b-persistence-adapter.js';

/**
 * Opaque value captured when a G10b-owned scope opens its Mongo transaction.
 * Its meaning remains in composition; Mongo only retains it for a later seam.
 */
export type G10bScopedPersistenceBinding = object;

/**
 * One G04b transaction's private G10b command gateway.  It is created only
 * after the attached sidecar has resolved a genuine binding, and it owns the
 * binding's one active execution round until the initial commit is settled.
 */
export interface G10bScopedPersistenceExecutionFacade {
  executeCrud<T>(send: (context: OperationExecutionCommandContext) => T | PromiseLike<T>): Promise<T>;
  executeInitialCommit<T>(send: (context: OperationExecutionCommandContext) => T | PromiseLike<T>): Promise<T>;
  finish(): void;
  beginPrecommitTermination(): G10bScopedPersistencePrecommitAuthority;
}

/**
 * One sealed transaction's binding-owned authority for exactly one high-level
 * native precommit abort.  Mongo receives this narrow authority, never the
 * binding, round, or raw precommit permits.
 */
export interface G10bScopedPersistencePrecommitAuthority {
  abortOnce(send: (context: PrecommitAbortCommandContext) => void | PromiseLike<void>): Promise<NativePrecommitOutcome>;
  terminate(outcome: NativePrecommitOutcome): void;
}

declare const g10bScopedPersistenceBindingResolverBrand: unique symbol;

/**
 * Internal-only, branded resolver.  Composition can construct one through the
 * factory below, but infrastructure never imports composition to interpret it.
 */
export interface G10bScopedPersistenceBindingResolver {
  readonly [g10bScopedPersistenceBindingResolverBrand]: never;
}

type ResolveBinding = (scope: AccessScopeContext) => G10bScopedPersistenceBinding;
type ObserveBindingCapture = (binding: G10bScopedPersistenceBinding) => void;

const concreteAdapters = new WeakSet<object>();
const attachedResolvers = new WeakMap<object, G10bScopedPersistenceBindingResolver>();
const resolverFunctions = new WeakMap<object, ResolveBinding>();
const captureObservers = new WeakMap<object, ObserveBindingCapture>();
const scopedTransactionBegunAdapters = new WeakSet<object>();
interface ExecutionFacadeState {
  readonly binding: OperationBudgetBinding;
  readonly round: OperationBudgetRound;
  active: boolean;
  sealed: boolean;
}

interface PrecommitAuthorityState {
  readonly facade: ExecutionFacadeState;
  readonly precommit: OperationPrecommitTermination;
  readonly group: OperationPrecommitAbortGroup;
  active: boolean;
  abortInvoked: boolean;
}

const executionFacades = new WeakMap<object, ExecutionFacadeState>();
const precommitAuthorities = new WeakMap<object, PrecommitAuthorityState>();

/** Create a composition-owned resolver that can be used only as this sidecar. */
export function createG10bScopedPersistenceBindingResolver(
  resolve: ResolveBinding,
): G10bScopedPersistenceBindingResolver {
  if (typeof resolve !== 'function') throw new TypeError('G10b scoped persistence binding resolver is invalid');
  const resolver = Object.freeze({}) as G10bScopedPersistenceBindingResolver;
  resolverFunctions.set(resolver as object, resolve);
  return resolver;
}

/** Called solely by the concrete G04b adapter constructor. */
export function registerG10bConcreteG04bMongoPersistenceAdapter(
  adapter: G04bMongoPersistenceAdapter,
): void {
  if (typeof adapter !== 'object' || adapter === null) throw new TypeError('G10b concrete G04b adapter is invalid');
  concreteAdapters.add(adapter as object);
}

/**
 * Attach exactly one sidecar to one concrete adapter.  This deliberately sits
 * outside the adapter constructor so the public constructor stays unchanged.
 */
export function attachG10bScopedPersistenceBindingResolver(
  adapter: G04bMongoPersistenceAdapter,
  resolver: G10bScopedPersistenceBindingResolver,
): void {
  if (!concreteAdapters.has(adapter as object)) throw new TypeError('G10b sidecar requires a concrete G04b Mongo persistence adapter');
  if (!resolverFunctions.has(resolver as object)) throw new TypeError('G10b scoped persistence binding resolver is foreign');
  if (scopedTransactionBegunAdapters.has(adapter as object)) throw new TypeError('G10b sidecar must attach before a G04b scoped transaction begins');
  if (attachedResolvers.has(adapter as object)) throw new TypeError('G10b sidecar is already attached to this G04b Mongo persistence adapter');
  attachedResolvers.set(adapter as object, resolver);
}

/** Called by G04b immediately before it captures the optional sidecar value. */
export function markG10bScopedTransactionBegin(adapter: G04bMongoPersistenceAdapter): void {
  if (!concreteAdapters.has(adapter as object)) throw new TypeError('G10b sidecar requires a concrete G04b Mongo persistence adapter');
  scopedTransactionBegunAdapters.add(adapter as object);
}

/**
 * Returns undefined for the historical unattached adapter path.  An attached
 * resolver is invoked before Mongo session allocation by the G04b adapter.
 */
export function resolveG10bScopedPersistenceBinding(
  adapter: G04bMongoPersistenceAdapter,
  scope: AccessScopeContext,
): G10bScopedPersistenceBinding | undefined {
  const resolver = attachedResolvers.get(adapter as object);
  if (resolver === undefined) return undefined;
  const resolve = resolverFunctions.get(resolver as object);
  if (resolve === undefined) throw new TypeError('G10b scoped persistence binding resolver provenance is missing');
  const binding = resolve(scope);
  if (typeof binding !== 'object' || binding === null) throw new TypeError('G10b scoped persistence binding is invalid');
  return binding;
}

/**
 * Test-only internal observation seam for the concrete adapter's capture.
 * The returned disposer owns removal, so an integration probe cannot retain
 * a closure or affect a later adapter use.
 */
export function observeG10bScopedPersistenceBindingCapture(
  adapter: G04bMongoPersistenceAdapter,
  observe: ObserveBindingCapture,
): () => void {
  if (!concreteAdapters.has(adapter as object)) throw new TypeError('G10b capture observation requires a concrete G04b Mongo persistence adapter');
  if (typeof observe !== 'function') throw new TypeError('G10b capture observation is invalid');
  if (captureObservers.has(adapter as object)) throw new TypeError('G10b capture observation is already attached to this G04b Mongo persistence adapter');
  captureObservers.set(adapter as object, observe);
  let removed = false;
  return (): void => {
    if (removed) return;
    removed = true;
    captureObservers.delete(adapter as object);
  };
}

/** Called by G04b immediately after resolver output is retained in state. */
export function captureG10bScopedPersistenceBinding(
  adapter: G04bMongoPersistenceAdapter,
  binding: G10bScopedPersistenceBinding | undefined,
): void {
  const observe = captureObservers.get(adapter as object);
  if (observe === undefined || binding === undefined) return;
  observe(binding);
}

/**
 * Convert an attached composition binding into a transaction-local command
 * facade.  The G04b adapter receives only this facade, never a raw round or
 * budget binding, so its CRUD and initial commit cannot bypass G10b command
 * admission.  Undefined preserves the historical unattached adapter path.
 */
export function createG10bScopedPersistenceExecutionFacade(
  binding: G10bScopedPersistenceBinding | undefined,
): G10bScopedPersistenceExecutionFacade | undefined {
  if (binding === undefined) return undefined;
  const operationBinding = binding as OperationBudgetBinding;
  assertOperationBudgetBindingProvenance(operationBinding);
  const round = beginOperationExecutionRound(operationBinding);
  const facade = Object.freeze({
    executeCrud: async <T>(send: (context: OperationExecutionCommandContext) => T | PromiseLike<T>): Promise<T> => {
      const state = requireExecutionFacade(facade);
      return executeFacadeCommand(state.binding, state.round, executeOperationCrud, send);
    },
    executeInitialCommit: async <T>(send: (context: OperationExecutionCommandContext) => T | PromiseLike<T>): Promise<T> => {
      const state = requireExecutionFacade(facade);
      return executeFacadeCommand(state.binding, state.round, executeOperationInitialCommit, send);
    },
    finish: (): void => {
      const state = requireExecutionFacade(facade);
      finishOperationExecutionRound(state.binding, state.round);
      state.active = false;
    },
    beginPrecommitTermination: (): G10bScopedPersistencePrecommitAuthority => {
      const state = requireExecutionFacade(facade);
      // Seal the transaction-local facade before touching the binding's
      // precommit lifecycle: no subsequent CRUD or commit can race abort.
      state.sealed = true;
      finishOperationExecutionRound(state.binding, state.round);
      state.active = false;
      const precommit = startOperationPrecommitTermination(state.binding);
      const group = reserveOperationPrecommitAbortGroup(state.binding, precommit);
      return createPrecommitAuthority(state, precommit, group);
    },
  }) as G10bScopedPersistenceExecutionFacade;
  executionFacades.set(facade as object, { binding: operationBinding, round, active: true, sealed: false });
  return facade;
}

async function executeFacadeCommand<T>(
  binding: OperationBudgetBinding,
  round: OperationBudgetRound,
  execute: (
    commandBinding: OperationBudgetBinding,
    commandRound: OperationBudgetRound,
    send: (context: OperationExecutionCommandContext) => void | PromiseLike<void>,
  ) => Promise<void>,
  send: (context: OperationExecutionCommandContext) => T | PromiseLike<T>,
): Promise<T> {
  let completed = false;
  let result!: T;
  await execute(binding, round, async (context) => {
    result = await send(context);
    completed = true;
  });
  if (!completed) throw new TypeError('G10b execution facade command did not complete');
  return result;
}

function requireExecutionFacade(facade: G10bScopedPersistenceExecutionFacade): ExecutionFacadeState {
  const state = executionFacades.get(facade as object);
  if (state === undefined || !state.active || state.sealed) throw new TypeError('G10b execution facade is no longer active');
  return state;
}

function createPrecommitAuthority(
  facade: ExecutionFacadeState,
  precommit: OperationPrecommitTermination,
  group: OperationPrecommitAbortGroup,
): G10bScopedPersistencePrecommitAuthority {
  const authority = Object.freeze({
    abortOnce: async (send: (context: PrecommitAbortCommandContext) => void | PromiseLike<void>): Promise<NativePrecommitOutcome> => {
      const state = requirePrecommitAuthority(authority);
      if (state.abortInvoked) throw new TypeError('G10b precommit authority abort was already invoked');
      state.abortInvoked = true;
      let senderFailure: unknown = undefined;
      try {
        await executeOperationPrecommitAbort(state.facade.binding, state.group, async (context) => {
          try {
            await send(context);
          } catch (error: unknown) {
            senderFailure = error;
            throw error;
          }
        });
        return 'NO_EFFECT_CONFIRMED';
      } catch (error: unknown) {
        // The lower layer settles a sender rejection before exposing it.  An
        // authority/lifecycle failure is not terminally safe and must remain
        // visible to the terminator, which will consequently not endSession.
        if (senderFailure === error) return 'STILL_UNKNOWN';
        throw error;
      }
    },
    terminate: (outcome: NativePrecommitOutcome): void => {
      const state = requirePrecommitAuthority(authority);
      terminateOperationPrecommit(state.facade.binding, state.group, outcome);
      state.active = false;
    },
  }) as G10bScopedPersistencePrecommitAuthority;
  precommitAuthorities.set(authority as object, { facade, precommit, group, active: true, abortInvoked: false });
  return authority;
}

function requirePrecommitAuthority(authority: G10bScopedPersistencePrecommitAuthority): PrecommitAuthorityState {
  const state = precommitAuthorities.get(authority as object);
  if (state === undefined || !state.active) throw new TypeError('G10b precommit authority is no longer active');
  return state;
}
