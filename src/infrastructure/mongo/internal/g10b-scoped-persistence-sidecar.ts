import type { AccessScopeContext } from '../../../access/ports/index.js';
import {
  assertOperationBudgetBindingProvenance,
  beginOperationExecutionRound,
  executeOperationCrud,
  executeOperationInitialCommit,
  finishOperationExecutionRound,
  type OperationBudgetBinding,
  type OperationBudgetRound,
  type OperationExecutionCommandContext,
} from '../../../access/application/internal/operation-budget-binding.js';
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
const executionFacades = new WeakMap<object, { readonly binding: OperationBudgetBinding; readonly round: OperationBudgetRound; active: boolean }>();

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
  }) as G10bScopedPersistenceExecutionFacade;
  executionFacades.set(facade as object, { binding: operationBinding, round, active: true });
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

function requireExecutionFacade(
  facade: G10bScopedPersistenceExecutionFacade,
): { readonly binding: OperationBudgetBinding; readonly round: OperationBudgetRound; active: boolean } {
  const state = executionFacades.get(facade as object);
  if (state === undefined || !state.active) throw new TypeError('G10b execution facade is no longer active');
  return state;
}
