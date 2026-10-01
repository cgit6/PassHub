import type { WriteOperationSettlement } from '../../access/application/internal/write-operation-coordinator.js';
import type { AdmissionWorkContext, AdmissionWriterOutcome } from './g07b-admission-handler.js';
import { readG10bScopedPersistenceForAdmission } from './g10b-operation-bridge.js';
import type { IssuedPersistenceLease } from '../../runtime/internal/runtime-control.js';
import type { G04bMongoPersistenceAdapter } from '../../infrastructure/mongo/g04b-persistence-adapter.js';
import {
  assertG10cPostCommitUnknownHandoffBinding,
  attachG10cPostCommitUnknownHandoffSink,
  createG10cPostCommitUnknownForwardingSink,
  type G10cPostCommitUnknownHandoff,
  type G10cPostCommitUnknownHandoffBundle,
} from '../../infrastructure/mongo/internal/g10c-post-commit-unknown-handoff.js';

/**
 * Private bridge between G07's issued-persistence accounting and the G10c
 * opaque commit-unknown handoff.  It owns no Mongo command, confirmation
 * timer, recovery result, or public HTTP capability.
 */
export interface G10cG07RecoveryBridge {
  beginIssuedPersistence(
    context: AdmissionWorkContext,
    lease: IssuedPersistenceLease,
  ): void;
  finishIssuedPersistence(context: AdmissionWorkContext): void;
  /** Returns true only for the exact G10c handoff retained during this work. */
  pausePostCommitUnknown(
    context: AdmissionWorkContext,
    settlement: WriteOperationSettlement<AdmissionWriterOutcome>,
    error: unknown,
  ): boolean;
  /** Reject a contradictory known result after a genuine unknown handoff. */
  assertNoRetainedHandoff(context: AdmissionWorkContext): void;
}

export interface G10cG07RecoveryBridgeOptions {
  readonly adapter: G04bMongoPersistenceAdapter;
  readonly handoffs: G10cPostCommitUnknownHandoffBundle;
}

interface ActiveInvocation {
  readonly context: AdmissionWorkContext;
  readonly lease: IssuedPersistenceLease;
  handoff: G10cPostCommitUnknownHandoff | null;
  finished: boolean;
  paused: boolean;
}

const bridges = new WeakSet<object>();

/**
 * Attach one composition-owned forwarding sink to one concrete adapter.
 * G07 begins the bridge exactly around its existing G08 writer invocation;
 * the adapter can therefore retain only that invocation's issued lease.
 */
export function createG10cG07RecoveryBridge(
  options: G10cG07RecoveryBridgeOptions,
): G10cG07RecoveryBridge {
  if (!isObject(options) || !isObject(options.adapter) || !isObject(options.handoffs)) {
    throw new TypeError('G10c G07 recovery bridge options are invalid');
  }

  let active: ActiveInvocation | null = null;
  const observeRetained = (handoff: G10cPostCommitUnknownHandoff): void => {
    const current = active;
    if (current === null || current.finished || current.handoff !== null) {
      throw new TypeError('G10c post-commit unknown handoff has no active G07 writer');
    }
    // The G10b bridge is the only source of the scope relationship.  This
    // prevents a serial-but-unrelated writer from adopting another scope's
    // retained Mongo transaction merely because it happens to be active.
    const scope = readG10bScopedPersistenceForAdmission(current.context);
    assertG10cPostCommitUnknownHandoffBinding(options.adapter, scope, handoff);
    current.handoff = handoff;
  };
  const forwarding = createG10cPostCommitUnknownForwardingSink(
    options.handoffs.sink,
    observeRetained,
  );
  attachG10cPostCommitUnknownHandoffSink(options.adapter, forwarding);

  const bridge: G10cG07RecoveryBridge = Object.freeze({
    beginIssuedPersistence(context: AdmissionWorkContext, lease: IssuedPersistenceLease): void {
      if (active !== null) throw new TypeError('G10c G07 recovery bridge already has an active writer');
      if (!isObject(context) || !Object.isFrozen(context) || !isObject(lease)
        || typeof lease.release !== 'function') {
        throw new TypeError('G10c G07 recovery bridge invocation is invalid');
      }
      active = { context, lease, handoff: null, finished: false, paused: false };
    },
    finishIssuedPersistence(context: AdmissionWorkContext): void {
      const current = requireActive(context);
      if (current.finished) throw new TypeError('G10c G07 recovery bridge writer is already finished');
      current.finished = true;
      if (current.handoff === null) {
        active = null;
        current.lease.release();
      }
      // A retained handoff deliberately keeps the lease.  The future G10c
      // confirmation owner, not this invoke-finally callback, owns terminal
      // release after it has made a safe result decision.
    },
    pausePostCommitUnknown(
      context: AdmissionWorkContext,
      settlement: WriteOperationSettlement<AdmissionWriterOutcome>,
      error: unknown,
    ): boolean {
      const current = active;
      if (current === null || current.context !== context || current.handoff === null) return false;
      if (!current.finished || current.paused) {
        throw new TypeError('G10c G07 recovery bridge handoff is not ready to pause');
      }
      if (error === undefined || error === null) throw new TypeError('G10c post-commit unknown pause requires an error');
      settlement.pausePostCommitUnknown(error);
      current.paused = true;
      return true;
    },
    assertNoRetainedHandoff(context: AdmissionWorkContext): void {
      const current = active;
      if (current === null || current.context !== context) return;
      if (current.handoff !== null) {
        throw new TypeError('G10c post-commit unknown handoff cannot produce a known writer outcome');
      }
    },
  });
  bridges.add(bridge as object);
  return bridge;

  function requireActive(context: AdmissionWorkContext): ActiveInvocation {
    const current = active;
    if (current === null || current.context !== context) {
      throw new TypeError('G10c G07 recovery bridge writer is foreign or stale');
    }
    return current;
  }
}

export function assertG10cG07RecoveryBridge(
  value: unknown,
): asserts value is G10cG07RecoveryBridge {
  if (!isObject(value) || !bridges.has(value)) {
    throw new TypeError('G10c G07 recovery bridge is not trusted');
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
