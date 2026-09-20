const accessScopeContextBrand: unique symbol = Symbol('AccessScopeContext');
const contextClaims = new WeakMap<object, AccessScopeContextClaims>();
const retiredContexts = new WeakSet<object>();

export interface AccessScopeContextClaims {
  readonly epoch: string;
  readonly owner: string;
  readonly generation: string;
}

/** Opaque runtime context passed only from a live access scope to a port. */
export interface AccessScopeContext {
  readonly [accessScopeContextBrand]: true;
}

export function createAccessScopeContext(claims?: AccessScopeContextClaims): AccessScopeContext {
  const context = Object.freeze({
    [accessScopeContextBrand]: true as const,
  });
  if (claims !== undefined) contextClaims.set(context, Object.freeze({ ...claims }));
  return context;
}

export function readAccessScopeContextClaims(
  context: AccessScopeContext,
): AccessScopeContextClaims | null {
  return contextClaims.get(context as object) ?? null;
}

export function retireAccessScopeContext(context: AccessScopeContext): void {
  retiredContexts.add(context as object);
}

export function isAccessScopeContextRetired(context: AccessScopeContext): boolean {
  return retiredContexts.has(context as object);
}
