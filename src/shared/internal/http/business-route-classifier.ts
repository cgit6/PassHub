/**
 * Internal, side-effect-free classification for the ten D150 business routes.
 *
 * This layer deliberately does not authenticate, validate DTOs, admit work,
 * or retain request/response objects.  It only turns an exact method/path and
 * the already de-duplicated retry header into a narrow routing fact.
 */

export const BUSINESS_ROUTE_IDS = Object.freeze([
  'AUTH_LOGIN',
  'QUALIFICATION_CREATE',
  'QUALIFICATION_UPDATE',
  'QUALIFICATION_REVOKE',
  'QUALIFICATION_LIST',
  'QUALIFICATION_INSIDE_LIST',
  'QUALIFICATION_DETAIL',
  'EVENT_LIST',
  'EVENT_DETAIL',
  'RECOGNITION_ATTEMPT',
] as const);

export type BusinessRouteId = (typeof BUSINESS_ROUTE_IDS)[number];
export type BusinessRouteRetryMode = 'NORMAL' | 'EXISTING_ONLY';

export interface BusinessRouteClassifierInput {
  readonly method: string;
  /** Origin-form request target; query text, when present, is ignored here. */
  readonly requestTarget: string;
  readonly retryMode?: string;
}

export type BusinessRouteClassification =
  | {
      readonly kind: 'MATCHED';
      readonly routeId: BusinessRouteId;
      readonly retryMode: BusinessRouteRetryMode;
      readonly parameters: Readonly<{ readonly id?: string }>;
    }
  | {
      readonly kind: 'INVALID_RETRY_MODE';
      readonly code: 'INVALID_RETRY_MODE';
      readonly routeId: BusinessRouteId;
    }
  | {
      readonly kind: 'NO_MATCH';
    };

interface RouteMatch {
  readonly routeId: BusinessRouteId;
  readonly parameters: Readonly<{ readonly id?: string }>;
}

const EMPTY_PARAMETERS = Object.freeze({});

export function classifyBusinessRoute(
  input: BusinessRouteClassifierInput,
): BusinessRouteClassification {
  if (typeof input !== 'object' || input === null) return Object.freeze({ kind: 'NO_MATCH' });
  if (typeof input.method !== 'string' || typeof input.requestTarget !== 'string') {
    return Object.freeze({ kind: 'NO_MATCH' });
  }

  const pathname = extractPathname(input.requestTarget);
  if (pathname === null) return Object.freeze({ kind: 'NO_MATCH' });
  const match = matchRoute(input.method, pathname);
  if (match === null) return Object.freeze({ kind: 'NO_MATCH' });

  if (input.retryMode !== undefined) {
    if (match.routeId !== 'RECOGNITION_ATTEMPT' || input.retryMode !== 'existing-only') {
      return Object.freeze({
        kind: 'INVALID_RETRY_MODE',
        code: 'INVALID_RETRY_MODE',
        routeId: match.routeId,
      });
    }
    return Object.freeze({
      kind: 'MATCHED',
      routeId: match.routeId,
      retryMode: 'EXISTING_ONLY',
      parameters: match.parameters,
    });
  }

  return Object.freeze({
    kind: 'MATCHED',
    routeId: match.routeId,
    retryMode: 'NORMAL',
    parameters: match.parameters,
  });
}

function extractPathname(requestTarget: string): string | null {
  if (!requestTarget.startsWith('/') || requestTarget.includes('#')) return null;
  const questionMark = requestTarget.indexOf('?');
  return questionMark < 0 ? requestTarget : requestTarget.slice(0, questionMark);
}

function matchRoute(method: string, pathname: string): RouteMatch | null {
  if (method === 'POST' && pathname === '/auth/login') return fixed('AUTH_LOGIN');
  if (method === 'POST' && pathname === '/qualifications') return fixed('QUALIFICATION_CREATE');
  if (method === 'GET' && pathname === '/qualifications') return fixed('QUALIFICATION_LIST');

  // Fixed route must win before the single-segment detail route.
  if (method === 'GET' && pathname === '/qualifications/inside') {
    return fixed('QUALIFICATION_INSIDE_LIST');
  }
  if (pathname === '/qualifications/inside' || pathname === '/qualifications/inside/revoke') {
    return null;
  }

  const qualificationRevokeId = dynamicId(pathname, '/qualifications/', '/revoke');
  if (method === 'POST' && qualificationRevokeId !== null) {
    return dynamic('QUALIFICATION_REVOKE', qualificationRevokeId);
  }

  const qualificationId = dynamicId(pathname, '/qualifications/');
  if (qualificationId !== null) {
    if (method === 'PATCH') return dynamic('QUALIFICATION_UPDATE', qualificationId);
    if (method === 'GET') return dynamic('QUALIFICATION_DETAIL', qualificationId);
  }

  if (method === 'GET' && pathname === '/events') return fixed('EVENT_LIST');
  const eventId = dynamicId(pathname, '/events/');
  if (method === 'GET' && eventId !== null) return dynamic('EVENT_DETAIL', eventId);
  if (method === 'POST' && pathname === '/recognition/attempts') {
    return fixed('RECOGNITION_ATTEMPT');
  }
  return null;
}

function dynamicId(pathname: string, prefix: string, suffix = ''): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const end = suffix.length === 0 ? pathname.length : pathname.length - suffix.length;
  const id = pathname.slice(prefix.length, end);
  if (id.length === 0 || id.includes('/')) return null;
  return id;
}

function fixed(routeId: BusinessRouteId): RouteMatch {
  return Object.freeze({ routeId, parameters: EMPTY_PARAMETERS });
}

function dynamic(routeId: BusinessRouteId, id: string): RouteMatch {
  return Object.freeze({ routeId, parameters: Object.freeze({ id }) });
}
