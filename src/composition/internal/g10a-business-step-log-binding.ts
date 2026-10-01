import {
  type RuntimeIdentity,
  type RuntimeIdentityFacts,
} from '../../runtime/internal/runtime-control.js';
import { createRuntimeLogRecord } from '../../runtime/internal/runtime-log-schema.js';
import { assertG10aRuntimeCapabilities, type G10aRuntimeCapabilities } from './g10a-runtime-owner.js';

/**
 * Nominal bridge from the one owner-issued writer identity to the three
 * records surrounding the *whole* G08 writer promise.  It has no filesystem,
 * database, HTTP, or control dependency and is never publicly exported.
 */
export interface G10aBusinessStepLogBinding {
  begin(identity: RuntimeIdentity): G10aBusinessStepLog;
}

export interface G10aBusinessStepLog {
  issued(): void;
  settled(): void;
}

const bindings = new WeakSet<object>();
const logs = new WeakSet<object>();

export function createG10aBusinessStepLogBinding(runtime: G10aRuntimeCapabilities): G10aBusinessStepLogBinding {
  assertG10aRuntimeCapabilities(runtime);
  const begin = (identity: RuntimeIdentity): G10aBusinessStepLog => {
    // `read` is also the provenance check: an identity issued by a different
    // process/runtime cannot be turned into a persistence log context.
    const facts = runtime.identityIssuer.read(identity);
    assertBusinessFacts(facts);
    const fixed = Object.freeze({
      requestUUID: facts.requestUUID,
      operationUUID: facts.operationUUID,
      datasetEpoch: facts.datasetEpoch,
      processRunId: facts.processRunId,
      ownerRef: facts.ownerRef,
      route: facts.route,
    });
    let issued = false;
    let settled = false;
    const append = (code: 'BUSINESS_STEP_REGISTERED' | 'BUSINESS_STEP_ISSUED' | 'BUSINESS_STEP_SETTLED'): void => {
      try {
        runtime.runtimeLogSink.append(createRuntimeLogRecord({
          schemaVersion: 'g10a.log.v1', timestamp: new Date().toISOString(), kind: 'RUNTIME', code,
          requestUUID: fixed.requestUUID, operationUUID: fixed.operationUUID, datasetEpoch: fixed.datasetEpoch,
          processRunId: fixed.processRunId, ownerRef: fixed.ownerRef, route: fixed.route, phase: 'PERSISTENCE',
          // G10a has no driver/confirmation budget producer yet.  The closed
          // schema explicitly allows all four persistence budget fields null.
          round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
          commandName: null, driverRequestId: null, requestControlId: null, controlId: null, revision: null,
        }));
      } catch { /* observability is strictly best effort */ }
    };
    append('BUSINESS_STEP_REGISTERED');
    const log = Object.freeze({
      issued(): void {
        if (issued || settled) return;
        issued = true;
        append('BUSINESS_STEP_ISSUED');
      },
      settled(): void {
        if (!issued || settled) return;
        settled = true;
        append('BUSINESS_STEP_SETTLED');
      },
    });
    logs.add(log);
    return log;
  };
  const binding = Object.freeze({ begin });
  bindings.add(binding);
  return binding;
}

export function assertG10aBusinessStepLogBinding(value: unknown): asserts value is G10aBusinessStepLogBinding {
  if (typeof value !== 'object' || value === null || !bindings.has(value)) {
    throw new TypeError('G10a business step log binding is not trusted');
  }
}

export function assertG10aBusinessStepLog(value: unknown): asserts value is G10aBusinessStepLog {
  if (typeof value !== 'object' || value === null || !logs.has(value)) {
    throw new TypeError('G10a business step log is not trusted');
  }
}

function assertBusinessFacts(facts: RuntimeIdentityFacts): asserts facts is Extract<RuntimeIdentityFacts, { readonly operationUUID: string }> {
  if (facts.operationUUID === null || facts.ownerRef === null
    || (facts.route !== 'MANAGEMENT_CREATE' && facts.route !== 'MANAGEMENT_UPDATE'
      && facts.route !== 'MANAGEMENT_REVOKE' && facts.route !== 'RECOGNITION')) {
    throw new TypeError('G10a business step identity is not a writer');
  }
}
