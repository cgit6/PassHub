const accessScopeContextBrand: unique symbol = Symbol('AccessScopeContext');

/** Opaque runtime context passed only from a live access scope to a port. */
export interface AccessScopeContext {
  readonly [accessScopeContextBrand]: true;
}

export function createAccessScopeContext(): AccessScopeContext {
  return Object.freeze({
    [accessScopeContextBrand]: true as const,
  });
}
