import {
  BUSINESS_ROUTE_IDS,
  type BusinessRouteId,
} from '../../shared/internal/http/index.js';

declare const admissionWorkTokenBrand: unique symbol;

export interface AdmissionWorkToken {
  readonly [admissionWorkTokenBrand]: never;
}

export interface AdmissionWorkTokenIssuer {
  issue(routeId: BusinessRouteId): AdmissionWorkToken;
}

export interface AdmissionWorkTokenClaimer {
  claim(token: AdmissionWorkToken, expectedRouteId: BusinessRouteId): AdmissionWorkToken;
}

export interface AdmissionWorkHandoffBundle {
  readonly issuer: AdmissionWorkTokenIssuer;
  readonly claimer: AdmissionWorkTokenClaimer;
}

interface TokenState {
  readonly routeId: BusinessRouteId;
  claimed: boolean;
}

const handoffBundles = new WeakSet<object>();

export function assertAdmissionWorkHandoffBundle(
  bundle: AdmissionWorkHandoffBundle,
): void {
  if ((typeof bundle !== 'object' && typeof bundle !== 'function')
    || bundle === null
    || !handoffBundles.has(bundle)) {
    throw new TypeError('admission work handoff bundle has no runtime provenance');
  }
}

/**
 * Issues payload-free, route-scoped capabilities. Trusted validator/work
 * composition may keep its own canonical payload in a WeakMap keyed by token;
 * G07b neither receives nor retains that payload.
 */
export function createAdmissionWorkHandoffBundle(): AdmissionWorkHandoffBundle {
  const tokens = new WeakMap<object, TokenState>();

  const issuer: AdmissionWorkTokenIssuer = Object.freeze({
    issue(routeId: BusinessRouteId): AdmissionWorkToken {
      if (!BUSINESS_ROUTE_IDS.includes(routeId)) {
        throw new TypeError('admission work route scope is invalid');
      }
      const token = Object.freeze({}) as AdmissionWorkToken;
      tokens.set(token, { routeId, claimed: false });
      return token;
    },
  });
  const claimer: AdmissionWorkTokenClaimer = Object.freeze({
    claim(token: AdmissionWorkToken, expectedRouteId: BusinessRouteId): AdmissionWorkToken {
      if ((typeof token !== 'object' && typeof token !== 'function') || token === null) {
        throw new TypeError('admission work token is invalid');
      }
      const state = tokens.get(token);
      if (state === undefined) {
        throw new TypeError('admission work token has foreign or forged provenance');
      }
      if (state.claimed) throw new TypeError('admission work token was already claimed');
      state.claimed = true;
      if (state.routeId !== expectedRouteId) {
        throw new TypeError('admission work token has the wrong route scope');
      }
      if (!Object.isFrozen(token) || Reflect.ownKeys(token).length !== 0) {
        throw new TypeError('admission work token is not canonical');
      }
      return token;
    },
  });

  const bundle = Object.freeze({ issuer, claimer });
  handoffBundles.add(bundle);
  return bundle;
}
