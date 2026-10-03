import type {
  PostCommitUnknownRecoveryHandle,
  PostCommitUnknownRecoveryOwner,
  WriteOperationSettlement,
} from '../../access/application/internal/write-operation-coordinator.js';
import type { AdmissionWorkContext, AdmissionWriterOutcome } from './g07b-admission-handler.js';
import type { RedactedAccessEventProjection } from '../../access/ports/index.js';
import { readG10bScopedPersistenceForAdmission } from './g10b-operation-bridge.js';
import type { IssuedPersistenceLease } from '../../runtime/internal/runtime-control.js';
import type { G04bMongoPersistenceAdapter } from '../../infrastructure/mongo/g04b-persistence-adapter.js';
import {
  assertG10cPostCommitUnknownHandoffBinding,
  attachG10cPostCommitUnknownHandoffSink,
  createG10cPostCommitUnknownTerminalCleaner,
  createG10cPostCommitUnknownForwardingSink,
  createG10cRetainedOriginalCommitTerminator,
  readG10cPostCommitUnknownCanonicalRecognitionEvent,
  type G10cPostCommitUnknownHandoff,
  type G10cPostCommitUnknownHandoffBundle,
  type G10cRetainedOriginalCommitTerminator,
} from '../../infrastructure/mongo/internal/g10c-post-commit-unknown-handoff.js';
import {
  createG10cCanonicalConfirmationReader,
  type G10cCanonicalConfirmationReader,
} from '../../infrastructure/mongo/internal/g10c-canonical-confirmation-reader.js';

/**
 * Private bridge between G07's issued-persistence accounting and the G10c
 * opaque commit-unknown handoff.  It owns no Mongo command, confirmation
 * timer, recovery result, or public HTTP capability.
 */
export interface G10cG07RecoveryBridge {
  /**
   * Bind the coordinator-owned recovery authority once, before any writer
   * starts.  The bridge never manufactures this authority itself.
   */
  bindRecoveryOwner(owner: PostCommitUnknownRecoveryOwner): void;
  beginIssuedPersistence(
    context: AdmissionWorkContext,
    lease: IssuedPersistenceLease,
    kind: G10cG07RecoveryWorkKind,
    recognitionSettlement?: G10cRecognitionRecoverySettlement,
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
  /** Internal queue owned by the future G10c confirmation coordinator. */
  readonly pausedTickets: G10cG07PausedTicketOwner;
}

declare const g10cG07PausedTicketBrand: unique symbol;

/**
 * Opaque, one-to-one pairing of one G07 writer recovery lease, one retained
 * G04b handoff and one issued-persistence lease.  It has no session, image,
 * scope or result fields.
 */
export interface G10cG07PausedTicket {
  readonly [g10cG07PausedTicketBrand]: never;
}

/** The future coordinator can inspect and claim a single paused ticket. */
export interface G10cG07PausedTicketOwner {
  pending(): readonly G10cG07PausedTicket[];
  claim(ticket: G10cG07PausedTicket): G10cG07PausedTicketTerminal;
}

/**
 * Claimed ticket capability.  It exposes only existing opaque G10c command
 * primitives and exactly one terminal decision; Mongo session and canonical
 * expected images remain encapsulated in the handoff implementation.
 */
export interface G10cG07PausedTicketTerminal {
  /**
   * Classification is deliberately limited to scheduler policy.  It does not
   * disclose a request, session, scope, or business input.
   */
  readonly kind: G10cG07RecoveryWorkKind;
  createOriginalCommitTerminator(): G10cRetainedOriginalCommitTerminator;
  createCanonicalConfirmationReader(): G10cCanonicalConfirmationReader;
  /**
   * Publish a private confirmation sentinel after Mongo has already proved
   * the retained transaction.  A recovery worker cannot invent a business
   * response or re-run the original CRUD callback.
   */
  confirmedPersisted(): Promise<void>;
  failClosed(error: unknown): void;
}

export type G10cG07RecoveryWorkKind = 'MANAGEMENT' | 'RECOGNITION';

/** Paired G07 settlement invoked only after canonical recognition proof. */
export interface G10cRecognitionRecoverySettlement {
  canonicalMatched(event: RedactedAccessEventProjection): void;
}

export interface G10cG07RecoveryBridgeOptions {
  readonly adapter: G04bMongoPersistenceAdapter;
  readonly handoffs: G10cPostCommitUnknownHandoffBundle;
  /** Composition-owned wake-up; it never carries a ticket or business data. */
  readonly onPausedTicket?: () => void;
}

interface ActiveInvocation {
  readonly context: AdmissionWorkContext;
  readonly lease: IssuedPersistenceLease;
  readonly kind: G10cG07RecoveryWorkKind;
  readonly recognitionSettlement: G10cRecognitionRecoverySettlement | null;
  handoff: G10cPostCommitUnknownHandoff | null;
  ticket: G10cG07PausedTicket | null;
  finished: boolean;
  paused: boolean;
  leaseReleased: boolean;
}

interface PausedTicketState {
  readonly invocation: ActiveInvocation;
  readonly handoff: G10cPostCommitUnknownHandoff;
  readonly recovery: PostCommitUnknownRecoveryHandle;
  claimed: boolean;
  terminal: boolean;
}

const bridges = new WeakSet<object>();
const pausedTicketOwners = new WeakSet<object>();
// This value is only a coordinator lifecycle sentinel.  It has no HTTP plan,
// external payload, or domain success fields, so a delayed confirmation can
// never fabricate a result to the original caller.
const CONFIRMED_RECOVERY_SENTINEL = Object.freeze({});

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
  let recoveryOwner: PostCommitUnknownRecoveryOwner | null = null;
  const queuedTickets: G10cG07PausedTicket[] = [];
  const ticketStates = new WeakMap<object, PausedTicketState>();
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
  const wakeScheduler = options.onPausedTicket;

  const releaseInvocationLease = (current: ActiveInvocation): void => {
    if (current.leaseReleased) return;
    current.leaseReleased = true;
    current.lease.release();
  };

  const completeTicketTerminal = (ticket: G10cG07PausedTicket, state: PausedTicketState): void => {
    if (state.terminal) return;
    state.terminal = true;
    const index = queuedTickets.indexOf(ticket);
    if (index >= 0) queuedTickets.splice(index, 1);
    ticketStates.delete(ticket as object);
    if (active === state.invocation) active = null;
    releaseInvocationLease(state.invocation);
  };

  /**
   * An unsafe terminal does close the ticket capability, but deliberately
   * keeps the bridge invocation and issued-persistence lease alive.  The
   * writer coordinator is blocked and RuntimeControl must not report DRAINED
   * while the retained session/outcome cannot be proved safe.
   */
  const retainUnsafeInvocation = (ticket: G10cG07PausedTicket, state: PausedTicketState): void => {
    if (state.terminal) return;
    state.terminal = true;
    const index = queuedTickets.indexOf(ticket);
    if (index >= 0) queuedTickets.splice(index, 1);
    ticketStates.delete(ticket as object);
  };

  let pausedTickets!: G10cG07PausedTicketOwner;
  pausedTickets = Object.freeze({
    pending(): readonly G10cG07PausedTicket[] {
      return Object.freeze([...queuedTickets]);
    },
    claim(ticket: G10cG07PausedTicket): G10cG07PausedTicketTerminal {
      const state = ticketStates.get(ticket as object);
      if (state === undefined || state.terminal || state.claimed || !queuedTickets.includes(ticket)
        || active !== state.invocation || !state.invocation.paused) {
        throw new TypeError('G10c G07 paused recovery ticket is foreign or stale');
      }
      state.claimed = true;
      const index = queuedTickets.indexOf(ticket);
      queuedTickets.splice(index, 1);
      let terminal!: G10cG07PausedTicketTerminal;
      const assertCurrent = (): void => {
        if (state.terminal || active !== state.invocation || !state.claimed) {
          throw new TypeError('G10c G07 paused recovery ticket is stale');
        }
        state.recovery.assertCurrent();
      };
      terminal = Object.freeze({
        createOriginalCommitTerminator(this: unknown): G10cRetainedOriginalCommitTerminator {
          if (this !== terminal) throw new TypeError('G10c G07 paused recovery terminal is foreign');
          assertCurrent();
          return createG10cRetainedOriginalCommitTerminator(options.handoffs.owner, state.handoff);
        },
        createCanonicalConfirmationReader(this: unknown): G10cCanonicalConfirmationReader {
          if (this !== terminal) throw new TypeError('G10c G07 paused recovery terminal is foreign');
          assertCurrent();
          return createG10cCanonicalConfirmationReader(options.handoffs.owner, state.handoff);
        },
        kind: state.invocation.kind,
        async confirmedPersisted(this: unknown): Promise<void> {
          if (this !== terminal) throw new TypeError('G10c G07 paused recovery terminal is foreign');
          assertCurrent();
          // Canonical MATCHED must first close the G07 operation registry and
          // install its replay plan.  Session cleanup is deliberately later;
          // if this paired settlement fails, the ticket remains fail-closed.
          if (state.invocation.kind === 'RECOGNITION') {
            const settle = state.invocation.recognitionSettlement;
            // Legacy/unit compositions that predate the paired registry port
            // may still exercise only session cleanup.  The real G07 path
            // always supplies the port; when it is absent, leave registry
            // state untouched rather than inventing a replay result.
            if (settle !== null) {
              const event = readG10cPostCommitUnknownCanonicalRecognitionEvent(options.handoffs.owner, state.handoff);
              if (event === null) throw new Error('G10c canonical recognition event is not confirmed');
              settle.canonicalMatched(event);
            }
          }
          let cleaner;
          try {
            // This succeeds only after the retained original sender or a
            // canonical reader has terminally confirmed the exact handoff.
            cleaner = createG10cPostCommitUnknownTerminalCleaner(options.handoffs.owner, state.handoff);
          } catch (error: unknown) {
            // A premature "confirmed" call is not terminal and must leave
            // the ticket recoverable for its genuine confirmation path.
            throw error;
          }
          try {
            await cleaner.cleanupAfterConfirmedOutcome();
            if (!state.recovery.businessResultPersisted(CONFIRMED_RECOVERY_SENTINEL)) {
              // The coordinator's lifecycle observer already rejected and
              // fenced FIFO work.  Its failure means the G07 terminal was not
              // successfully published, so do not make RuntimeControl appear
              // drained even though Mongo cleanup itself completed.
              retainUnsafeInvocation(ticket, state);
              throw new Error('G10c G07 confirmed recovery lifecycle failed');
            }
          } catch (error: unknown) {
            // Session cleanup or coordinator publication failed after the
            // terminal claim.  It is no longer safe to resume FIFO work or
            // let RuntimeControl drain; retain the issued lease as a safety
            // fence even after the ticket capability has been spent.
            try { state.recovery.failClosed(error); } catch { /* already fail-closed */ }
            retainUnsafeInvocation(ticket, state);
            throw error;
          }
          completeTicketTerminal(ticket, state);
        },
        failClosed(this: unknown, error: unknown): void {
          if (this !== terminal) throw new TypeError('G10c G07 paused recovery terminal is foreign');
          if (error === undefined || error === null) throw new TypeError('G10c G07 fail-closed error is required');
          assertCurrent();
          try {
            state.recovery.failClosed(error);
          } finally {
            retainUnsafeInvocation(ticket, state);
          }
        },
      }) as G10cG07PausedTicketTerminal;
      return terminal;
    },
  });

  const bridge: G10cG07RecoveryBridge = Object.freeze({
    bindRecoveryOwner(owner: PostCommitUnknownRecoveryOwner): void {
      if (active !== null || recoveryOwner !== null || !isObject(owner) || typeof owner.adopt !== 'function') {
        throw new TypeError('G10c G07 recovery owner binding is invalid');
      }
      recoveryOwner = owner;
    },
    beginIssuedPersistence(
      context: AdmissionWorkContext,
      lease: IssuedPersistenceLease,
      kind: G10cG07RecoveryWorkKind,
      recognitionSettlement?: G10cRecognitionRecoverySettlement,
    ): void {
      if (active !== null) throw new TypeError('G10c G07 recovery bridge already has an active writer');
      if (!isObject(context) || !Object.isFrozen(context) || !isObject(lease)
        || typeof lease.release !== 'function') {
        throw new TypeError('G10c G07 recovery bridge invocation is invalid');
      }
      if (kind !== 'MANAGEMENT' && kind !== 'RECOGNITION') {
        throw new TypeError('G10c G07 recovery bridge work kind is invalid');
      }
      if (recognitionSettlement !== undefined
        && (!isObject(recognitionSettlement) || typeof recognitionSettlement.canonicalMatched !== 'function')) {
        throw new TypeError('G10c recognition settlement port is invalid');
      }
      if (recoveryOwner === null) throw new TypeError('G10c G07 recovery owner is not bound');
      active = {
        context,
        lease,
        kind,
        recognitionSettlement: recognitionSettlement ?? null,
        handoff: null,
        ticket: null,
        finished: false,
        paused: false,
        leaseReleased: false,
      };
    },
    finishIssuedPersistence(context: AdmissionWorkContext): void {
      const current = requireActive(context);
      if (current.finished) throw new TypeError('G10c G07 recovery bridge writer is already finished');
      current.finished = true;
      if (current.handoff === null) {
        active = null;
        releaseInvocationLease(current);
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
      if (recoveryOwner === null) throw new TypeError('G10c G07 recovery owner is not bound');
      const recoveryLease = settlement.pausePostCommitUnknown(error);
      let recovery: PostCommitUnknownRecoveryHandle;
      try {
        recovery = recoveryOwner.adopt(recoveryLease);
      } catch (adoptionError: unknown) {
        // The pause has already been recorded.  A failed internal authority
        // handoff must remain blocked and retain its issued lease: releasing
        // it would let RuntimeControl claim DRAINED while the original commit
        // outcome/session is unsafe.
        throw adoptionError;
      }
      let handoff: G10cPostCommitUnknownHandoff;
      try {
        handoff = options.handoffs.owner.take(current.handoff);
      } catch (handoffError: unknown) {
        try { recovery.failClosed(handoffError); } catch { /* already blocked */ }
        // Keep `active` and its issued lease for the same fail-closed reason
        // as above.  A contradictory handoff can never become a drainable
        // completed writer.
        throw handoffError;
      }
      const ticket = Object.freeze({}) as G10cG07PausedTicket;
      ticketStates.set(ticket as object, {
        invocation: current,
        handoff,
        recovery,
        claimed: false,
        terminal: false,
      });
      queuedTickets.push(ticket);
      current.ticket = ticket;
      current.paused = true;
      // The ticket is now visible through the opaque owner.  Wake only the
      // composition-owned scheduler; no request or business payload crosses
      // this callback.  A wake failure must not turn a genuine unknown commit
      // into a known writer result.
      try { wakeScheduler?.(); } catch { /* scheduler failure is fail-closed */ }
      return true;
    },
    assertNoRetainedHandoff(context: AdmissionWorkContext): void {
      const current = active;
      if (current === null || current.context !== context) return;
      if (current.handoff !== null) {
        throw new TypeError('G10c post-commit unknown handoff cannot produce a known writer outcome');
      }
    },
    pausedTickets,
  });
  pausedTicketOwners.add(pausedTickets as object);
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

/** Reject a structural lookalike before it can claim a retained writer. */
export function assertG10cG07PausedTicketOwner(
  value: unknown,
): asserts value is G10cG07PausedTicketOwner {
  if (!isObject(value) || !pausedTicketOwners.has(value)) {
    throw new TypeError('G10c G07 paused ticket owner is not trusted');
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
