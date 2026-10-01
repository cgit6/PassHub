import { randomUUID } from 'node:crypto';

import type { WriteOperationRegistrationReceipt } from '../../access/application/internal/write-operation-coordinator.js';
import type { AcceptedIngress } from '../../shared/internal/http/index.js';
import { type RuntimeIdentity } from '../../runtime/internal/runtime-control.js';
import { createRuntimeLogRecord } from '../../runtime/internal/runtime-log-schema.js';
import { getG10aIngressIdentity, readG10aIngressIdentity } from './g10a-ingress-identity.js';
import { assertG10aRuntimeCapabilities, type G10aRuntimeCapabilities } from './g10a-runtime-owner.js';

/** Internal-only bridge between one coordinator receipt and its ingress fact. */
export interface G10aOperationIdentityBinding {
  bind(accepted: AcceptedIngress, receipt: WriteOperationRegistrationReceipt): RuntimeIdentity;
  /** Records the coordinator's fail-closed BLOCKED lifecycle transition once. */
  blocked(receipt: WriteOperationRegistrationReceipt): void;
  /** Releases a completed coordinator receipt's private attribution state. */
  settled(receipt: WriteOperationRegistrationReceipt): void;
}

const bindings = new WeakSet<object>();
const boundIngresses = new WeakSet<object>();

interface BoundOperation {
  readonly receipt: WriteOperationRegistrationReceipt;
  readonly identity: RuntimeIdentity;
  blockedLogged: boolean;
}

export function createG10aOperationIdentityBinding(runtime: G10aRuntimeCapabilities): G10aOperationIdentityBinding {
  assertG10aRuntimeCapabilities(runtime);
  const operations = new Map<string, BoundOperation>();
  const binding = Object.freeze({
    bind(accepted: AcceptedIngress, receipt: WriteOperationRegistrationReceipt): RuntimeIdentity {
      const ingress = getG10aIngressIdentity(accepted);
      if (ingress === undefined) throw new TypeError('G10a writer ingress identity is missing');
      if (boundIngresses.has(ingress as object)) throw new TypeError('G10a writer ingress identity is already bound');
      const facts = readG10aIngressIdentity(ingress);
      if (facts.runtimeIdentity !== null || !facts.pendingOperationBinding
        || (facts.route !== 'MANAGEMENT_CREATE' && facts.route !== 'MANAGEMENT_UPDATE'
          && facts.route !== 'MANAGEMENT_REVOKE' && facts.route !== 'RECOGNITION')) {
        throw new TypeError('G10a writer ingress identity is not pending');
      }
      if (!isUuid(receipt.operationId)) throw new TypeError('G10a operation receipt is invalid');
      const ownerRef = randomUUID();
      const token = runtime.identityIssuer.issueBusinessToken({ operationUUID: receipt.operationId, ownerRef });
      const identity = runtime.identityIssuer.issue({ requestUUID: facts.requestUUID, operationToken: token, route: facts.route });
      const issued = runtime.identityIssuer.read(identity);
      if (issued.requestUUID !== facts.requestUUID || issued.operationUUID !== receipt.operationId
        || issued.ownerRef !== ownerRef || issued.route !== facts.route) {
        throw new TypeError('G10a operation identity is inconsistent');
      }
      boundIngresses.add(ingress as object);
      if (operations.has(receipt.operationId)) throw new TypeError('G10a operation receipt is already bound');
      operations.set(receipt.operationId, { receipt, identity, blockedLogged: false });
      appendAdmissionLog(runtime, issued, 'OPERATION_REGISTERED');
      return identity;
    },
    blocked(receipt: WriteOperationRegistrationReceipt): void {
      const operation = operations.get(receipt.operationId);
      // Only the original coordinator receipt can produce a BLOCKED record.
      // A repeated lifecycle callback is observationally idempotent.
      if (operation === undefined || operation.receipt !== receipt || operation.blockedLogged) return;
      operation.blockedLogged = true;
      try {
        appendAdmissionLog(runtime, runtime.identityIssuer.read(operation.identity), 'OPERATION_BLOCKED');
      } catch { /* logging is best effort and cannot change lifecycle outcome */ }
    },
    settled(receipt: WriteOperationRegistrationReceipt): void {
      const operation = operations.get(receipt.operationId);
      if (operation?.receipt === receipt) operations.delete(receipt.operationId);
    },
  });
  bindings.add(binding);
  return binding;
}

function appendAdmissionLog(
  runtime: G10aRuntimeCapabilities,
  identity: ReturnType<G10aRuntimeCapabilities['identityIssuer']['read']>,
  code: 'OPERATION_REGISTERED' | 'OPERATION_BLOCKED',
): void {
  try {
    runtime.runtimeLogSink.append(createRuntimeLogRecord({
      schemaVersion: 'g10a.log.v1', timestamp: new Date().toISOString(), kind: 'RUNTIME', code,
      requestUUID: identity.requestUUID, operationUUID: identity.operationUUID, datasetEpoch: identity.datasetEpoch,
      processRunId: identity.processRunId, ownerRef: identity.ownerRef, route: identity.route, phase: 'ADMISSION',
      round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null, commandName: null,
      driverRequestId: null, requestControlId: null, controlId: null, revision: null,
    }));
  } catch { /* logging is best effort and cannot change admission */ }
}

export function assertG10aOperationIdentityBinding(value: unknown): asserts value is G10aOperationIdentityBinding {
  if (typeof value !== 'object' || value === null || !bindings.has(value)) {
    throw new TypeError('G10a operation identity binding is not trusted');
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}
