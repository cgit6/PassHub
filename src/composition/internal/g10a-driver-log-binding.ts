import type {
  RuntimeIdentity,
  RuntimeIdentityFacts,
} from '../../runtime/internal/runtime-control.js';
import { runWithRuntimeDriverLogContext } from '../../runtime/internal/runtime-driver-log-context.js';
import {
  assertG10aRuntimeCapabilities,
  type G10aRuntimeCapabilities,
} from './g10a-runtime-owner.js';

/** Nominal private bridge from a G10 runtime identity into Mongo monitoring. */
export interface G10aDriverLogBinding {
  run<T>(identity: RuntimeIdentity, operation: () => T): T;
}

const bindings = new WeakSet<object>();

export function createG10aDriverLogBinding(runtime: G10aRuntimeCapabilities): G10aDriverLogBinding {
  assertG10aRuntimeCapabilities(runtime);
  const binding = Object.freeze({
    run<T>(identity: RuntimeIdentity, operation: () => T): T {
      if (typeof operation !== 'function') throw new TypeError('G10a driver operation must be a function');
      const facts = runtime.identityIssuer.read(identity);
      assertDriverFacts(facts);
      return runWithRuntimeDriverLogContext(Object.freeze({
        runtimeLogSink: runtime.runtimeLogSink,
        requestUUID: facts.requestUUID,
        operationUUID: facts.operationUUID,
        datasetEpoch: facts.datasetEpoch,
        processRunId: facts.processRunId,
        ownerRef: facts.ownerRef,
        route: facts.route,
      }), operation);
    },
  });
  bindings.add(binding);
  return binding;
}

export function assertG10aDriverLogBinding(value: unknown): asserts value is G10aDriverLogBinding {
  if (typeof value !== 'object' || value === null || !bindings.has(value)) {
    throw new TypeError('G10a driver log binding is not trusted');
  }
}

function assertDriverFacts(facts: RuntimeIdentityFacts): asserts facts is Extract<RuntimeIdentityFacts, {
  readonly requestUUID: string;
  readonly route: 'MANAGEMENT_CREATE' | 'MANAGEMENT_UPDATE' | 'MANAGEMENT_REVOKE' | 'RECOGNITION' | 'QUERY' | 'LOGIN';
}> {
  const business = facts.route === 'MANAGEMENT_CREATE' || facts.route === 'MANAGEMENT_UPDATE'
    || facts.route === 'MANAGEMENT_REVOKE' || facts.route === 'RECOGNITION';
  const read = facts.route === 'QUERY' || facts.route === 'LOGIN';
  if (!business && !read) throw new TypeError('G10a driver identity route is invalid');
  if (business && (facts.operationUUID === null || facts.ownerRef === null)) {
    throw new TypeError('G10a driver writer identity is incomplete');
  }
  if (read && (facts.operationUUID !== null || facts.ownerRef !== null)) {
    throw new TypeError('G10a driver read identity must not carry writer attribution');
  }
}
