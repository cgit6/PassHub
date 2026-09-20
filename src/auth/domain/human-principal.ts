export const HUMAN_ROLES = Object.freeze(['OPERATOR', 'VIEWER'] as const);

export type HumanRole = (typeof HUMAN_ROLES)[number];

/**
 * An intentionally empty, opaque value.  A HumanAuth instance only accepts
 * principals that it issued and registered in its private WeakMap.
 */
export class HumanPrincipal {
  public constructor() {
    Object.freeze(this);
  }
}

export interface HumanPrincipalFacts {
  readonly userId: string;
  readonly role: HumanRole;
}
