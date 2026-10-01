import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import {
  classifyBusinessRoute,
  type AcceptedIngress,
  type AcceptedIngressHandler,
  type BusinessRouteId,
} from '../../shared/internal/http/index.js';
import {
  type RuntimeIdentity,
  type RuntimeRoute,
} from '../../runtime/internal/runtime-control.js';
import {
  createRuntimeLogRecord,
  type RuntimeLogRoute,
} from '../../runtime/internal/runtime-log-schema.js';
import {
  assertG10aRuntimeCapabilities,
  type G10aRuntimeCapabilities,
} from './g10a-runtime-owner.js';
import {
  assertG10aDriverLogBinding,
  type G10aDriverLogBinding,
} from './g10a-driver-log-binding.js';

/**
 * A request-local, nominal ingress fact.  It is deliberately not an HTTP DTO:
 * the raw request cannot choose its UUID, route, epoch, or process identity.
 *
 * The ingress record cannot yet carry an operation UUID.  Under D184 that
 * field is required to be null for REQUEST_ACCEPTED; a later operation binding
 * will pair this fact with the existing coordinator operationId (and therefore
 * preserve a retry's shared operation identity) after admission establishes it.
 */
export interface G10aIngressIdentity { readonly __g10aIngressIdentity: unique symbol; }

export interface G10aIngressIdentityFacts {
  readonly requestUUID: string;
  readonly route: RuntimeRoute | null;
  /**
   * QUERY and LOGIN have no business operation, so ingress can issue their
   * owner-bound runtime identity immediately.  Writer routes deliberately
   * remain null until admission has created its real operation token.
   */
  readonly runtimeIdentity: RuntimeIdentity | null;
  readonly pendingOperationBinding: boolean;
}

export interface G10aIngressIdentityHandlerOptions {
  readonly handler: AcceptedIngressHandler;
  /**
   * One nominal, owner-issued capability bundle.  Ingress never accepts an
   * issuer and sink as independent inputs: mixing process identities and log
   * destinations would make a single request record internally inconsistent.
   */
  readonly runtime: G10aRuntimeCapabilities;
  /** Private Mongo monitoring attribution for QUERY/LOGIN only. */
  readonly driverLogBinding?: G10aDriverLogBinding;
  /** Internal clock seam for deterministic tests; default is the native wall clock. */
  readonly now?: () => Date;
}

const identities = new WeakMap<object, Readonly<{
  readonly requestUUID: string;
  readonly route: RuntimeRoute | null;
  readonly runtimeIdentity: RuntimeIdentity | null;
  readonly pendingOperationBinding: boolean;
}>>();

/**
 * Wraps the already strict, fully accepted HTTP seam.  Non-business paths still
 * receive a hidden request UUID so a future owner can reason about their
 * lifetime, but cannot create a schema-valid REQUEST_ACCEPTED record because
 * the log route allowlist intentionally has no catch-all value.
 */
export function createG10aIngressIdentityHandler(
  input: G10aIngressIdentityHandlerOptions,
): AcceptedIngressHandler {
  const options = captureOptions(input);
  return (accepted, request, response, next): void | Promise<void> => {
    const route = classifyAcceptedRoute(accepted, request);
    const identity = Object.freeze({}) as G10aIngressIdentity;
    const requestUUID = randomUUID();
    // Only a read route has all identity facts at this seam.  A writer needs
    // the coordinator's one-time operation token, which does not exist until
    // after admission; issuing a placeholder here would fabricate identity.
    const runtimeIdentity = route === 'QUERY' || route === 'LOGIN'
      ? options.runtime.identityIssuer.issue({
        requestUUID,
        operationToken: null,
        operationUUID: null,
        ownerRef: null,
        route,
      })
      : null;
    if (runtimeIdentity !== null) {
      const issuedFacts = options.runtime.identityIssuer.read(runtimeIdentity);
      if (issuedFacts.requestUUID !== requestUUID || issuedFacts.route !== route) {
        throw new TypeError('owner-issued ingress identity is inconsistent');
      }
    }
    identities.set(identity as object, Object.freeze({
      requestUUID,
      route,
      runtimeIdentity,
      pendingOperationBinding: route !== null && runtimeIdentity === null,
    }));
    // A WeakMap keyed by the accepted, frozen ingress value is deliberately
    // used rather than decorating Express Request or widening any public DTO.
    ingressByAccepted.set(accepted as object, identity);

    if (route !== null) {
      try {
        options.runtime.runtimeLogSink.append(createRuntimeLogRecord({
          schemaVersion: 'g10a.log.v1',
          timestamp: options.now().toISOString(),
          kind: 'RUNTIME',
          code: 'REQUEST_ACCEPTED',
          requestUUID: readG10aIngressIdentity(identity).requestUUID,
          operationUUID: null,
          datasetEpoch: options.runtimeFacts.datasetEpoch,
          processRunId: options.runtimeFacts.processRunId,
          ownerRef: null,
          route: route as RuntimeLogRoute,
          phase: 'INGRESS',
          round: null,
          group: null,
          budgetRemainingMs: null,
          budgetRemainingUnits: null,
          commandName: null,
          driverRequestId: null,
          requestControlId: null,
          controlId: null,
          revision: null,
        }));
      } catch {
        // Best-effort observability is never allowed to alter admission.
      }
    }
    if (runtimeIdentity !== null && options.driverLogBinding !== undefined) {
      return options.driverLogBinding.run(runtimeIdentity, () => options.handler(accepted, request, response, next));
    }
    return options.handler(accepted, request, response, next);
  };
}

const ingressByAccepted = new WeakMap<object, G10aIngressIdentity>();

/** Internal bridge for later G10 producer wiring; no public DTO is expanded. */
export function getG10aIngressIdentity(accepted: AcceptedIngress): G10aIngressIdentity | undefined {
  return ingressByAccepted.get(accepted as object);
}

export function readG10aIngressIdentity(identity: G10aIngressIdentity): G10aIngressIdentityFacts {
  const state = identities.get(identity as object);
  if (state === undefined) throw new TypeError('G10a ingress identity is not trusted');
  return Object.freeze({
    requestUUID: state.requestUUID,
    route: state.route,
    runtimeIdentity: state.runtimeIdentity,
    pendingOperationBinding: state.pendingOperationBinding,
  });
}

function classifyAcceptedRoute(accepted: AcceptedIngress, request: { readonly originalUrl?: unknown; readonly url?: unknown }): RuntimeRoute | null {
  const requestTarget = typeof request.originalUrl === 'string' && request.originalUrl.length > 0
    ? request.originalUrl
    : request.url;
  if (typeof requestTarget !== 'string') return null;
  const classification = classifyBusinessRoute({
    method: accepted.method,
    requestTarget,
    ...(accepted.headers.retryMode === undefined ? {} : { retryMode: accepted.headers.retryMode }),
  });
  if (classification.kind === 'NO_MATCH') return null;
  return routeFor(classification.routeId);
}

function routeFor(route: BusinessRouteId): RuntimeRoute {
  if (route === 'AUTH_LOGIN') return 'LOGIN';
  if (route === 'QUALIFICATION_LIST'
    || route === 'QUALIFICATION_INSIDE_LIST'
    || route === 'QUALIFICATION_DETAIL'
    || route === 'EVENT_LIST'
    || route === 'EVENT_DETAIL') return 'QUERY';
  if (route === 'QUALIFICATION_CREATE') return 'MANAGEMENT_CREATE';
  if (route === 'QUALIFICATION_UPDATE') return 'MANAGEMENT_UPDATE';
  if (route === 'QUALIFICATION_REVOKE') return 'MANAGEMENT_REVOKE';
  return 'RECOGNITION';
}

function captureOptions(input: unknown): Readonly<{
  readonly handler: AcceptedIngressHandler;
  readonly runtime: G10aRuntimeCapabilities;
  readonly driverLogBinding: G10aDriverLogBinding | undefined;
  readonly runtimeFacts: Readonly<{ readonly datasetEpoch: string; readonly processRunId: string }>;
  readonly now: () => Date;
}> {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || nodeTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const record = input as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    const required = ['handler', 'runtime'];
    if (keys.some((key) => typeof key !== 'string')
      || keys.length < required.length || keys.length > required.length + 2
      || required.some((key) => !keys.includes(key))
      || keys.some((key) => key !== 'handler' && key !== 'runtime' && key !== 'now' && key !== 'driverLogBinding')) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(record);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error();
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
    }
    const handler = descriptors.handler?.value;
    const runtime = descriptors.runtime?.value;
    const now = descriptors.now?.value ?? (() => new Date());
    const driverLogBinding = descriptors.driverLogBinding?.value;
    if (nodeTypes.isProxy(handler) || nodeTypes.isProxy(now) || typeof handler !== 'function' || typeof now !== 'function') throw new Error();
    assertG10aRuntimeCapabilities(runtime);
    if (driverLogBinding !== undefined) assertG10aDriverLogBinding(driverLogBinding);
    // The issuer itself owns these immutable facts.  It exposes no public state;
    // issue/read a read-only nominal identity once to capture them safely.
    const probe = runtime.identityIssuer.issue({
      requestUUID: randomUUID(), operationToken: null, operationUUID: null, ownerRef: null, route: 'QUERY',
    });
    const facts = runtime.identityIssuer.read(probe);
    return Object.freeze({
      handler: handler as AcceptedIngressHandler,
      runtime,
      driverLogBinding: driverLogBinding as G10aDriverLogBinding | undefined,
      runtimeFacts: Object.freeze({ datasetEpoch: facts.datasetEpoch, processRunId: facts.processRunId }),
      now: now as () => Date,
    });
  } catch {
    throw new TypeError('G10a ingress identity options are invalid');
  }
}
