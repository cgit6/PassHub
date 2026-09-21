/**
 * An intentionally empty, opaque value. A SourceAuth instance only accepts
 * principals that it issued and registered in its private WeakMap.
 */
export class SourcePrincipal {
  public constructor() {
    Object.freeze(this);
  }
}

export interface SourcePrincipalFacts {
  readonly sourceId: string;
}
