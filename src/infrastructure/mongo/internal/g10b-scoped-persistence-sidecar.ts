import type { AccessScopeContext } from '../../../access/ports/index.js';
import type { G04bMongoPersistenceAdapter } from '../g04b-persistence-adapter.js';

/**
 * Opaque value captured when a G10b-owned scope opens its Mongo transaction.
 * Its meaning remains in composition; Mongo only retains it for a later seam.
 */
export type G10bScopedPersistenceBinding = object;

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
