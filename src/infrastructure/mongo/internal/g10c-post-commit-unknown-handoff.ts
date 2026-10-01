import type { ClientSession } from 'mongodb';

import type {
  AccessScopeContext,
  FaceMappingSnapshot,
  ManagementQualificationSnapshot,
  QualificationSnapshot,
} from '../../../access/ports/index.js';
import type { G10bScopedPersistenceBinding } from './g10b-scoped-persistence-sidecar.js';
import { readAccessScopeContextClaims } from '../../../shared/access-scope-context.js';
import {
  admitOperationUnknownCommitConfirmationAction,
  assertOperationUnknownCommitCanonicalReadDue,
  assertOperationUnknownCommitConfirmationTerminal,
  assertOperationUnknownCommitConfirmationCurrent,
  settleOperationUnknownCommitConfirmationAction,
  startOperationUnknownCommitConfirmation,
  type OperationBudgetBinding,
  type OperationUnknownCommitConfirmationAction,
  type OperationUnknownCommitConfirmationOutcome,
  type OperationUnknownCommitConfirmation,
} from '../../../access/application/internal/operation-budget-binding.js';
import type { G04bMongoPersistenceAdapter } from '../g04b-persistence-adapter.js';

/**
 * An opaque, single-use claim over a transaction whose initial commit sender
 * ran but whose result is unknown.  It deliberately exposes neither the
 * Mongo session nor any G10b persistence/budget authority.
 */
declare const g10cPostCommitUnknownHandoffBrand: unique symbol;

export interface G10cPostCommitUnknownHandoff {
  readonly [g10cPostCommitUnknownHandoffBrand]: never;
}

declare const g10cPostCommitUnknownConfirmationActionBrand: unique symbol;

/**
 * The future G10c sender sees only the next command's safe facts.  Its raw
 * BudgetLedger permit, ClientSession, and persistence authority stay private
 * to this handoff boundary.
 */
export interface G10cPostCommitUnknownConfirmationAction {
  readonly [g10cPostCommitUnknownConfirmationActionBrand]: never;
  readonly kind: 'ORIGINAL_COMMIT' | 'CANONICAL_READ';
  readonly attempt: number;
  readonly timeoutMs: number;
}

export type G10cPostCommitUnknownConfirmationOutcome = OperationUnknownCommitConfirmationOutcome;

/**
 * The deliberately narrow result of resending the original commit command.
 * A resolved driver command confirms the transaction outcome; a rejected
 * command remains unknown and must proceed to the later canonical-read phase.
 */
export type G10cRetainedOriginalCommitAttemptResult = Readonly<{
  readonly delivery: 'COMMIT_CONFIRMED' | 'REJECTED_STILL_UNKNOWN';
  readonly attempt: number;
  readonly timeoutMs: number;
}>;

export type G10cRetainedOriginalCommitTerminatorErrorCode =
  | 'TERMINATOR_CLOSED'
  | 'TERMINATOR_NOT_INITIAL';

export class G10cRetainedOriginalCommitTerminatorError extends Error {
  readonly code: G10cRetainedOriginalCommitTerminatorErrorCode;

  constructor(code: G10cRetainedOriginalCommitTerminatorErrorCode, message: string) {
    super(message);
    this.name = 'G10cRetainedOriginalCommitTerminatorError';
    this.code = code;
  }
}

/**
 * A single, retained-session attempt to resend the original commit.  It owns
 * no cleanup, canonical read, or result interpretation authority.
 */
export interface G10cRetainedOriginalCommitTerminator {
  attemptOriginalCommit(): Promise<G10cRetainedOriginalCommitAttemptResult>;
}

/**
 * The one terminal resource-release capability for a taken G10c handoff.
 * It is available only after the binding has a genuine confirmed result and
 * never exposes the retained session or an abort operation.
 */
export interface G10cPostCommitUnknownTerminalCleaner {
  cleanupAfterConfirmedOutcome(): Promise<void>;
}

/** The adapter-facing, synchronous receiver for an opaque handoff only. */
export interface G10cPostCommitUnknownHandoffSink {
  retain(handoff: G10cPostCommitUnknownHandoff): void;
}

/**
 * The future confirmation owner may inspect its queue and claim an item once.
 * Claiming does not execute any Mongo command in this G10c increment.
 */
export interface G10cPostCommitUnknownHandoffOwner {
  pending(): readonly G10cPostCommitUnknownHandoff[];
  take(handoff: G10cPostCommitUnknownHandoff): G10cPostCommitUnknownHandoff;
  admitNextConfirmation(
    handoff: G10cPostCommitUnknownHandoff,
  ): G10cPostCommitUnknownConfirmationAction;
  settleConfirmation(
    handoff: G10cPostCommitUnknownHandoff,
    action: G10cPostCommitUnknownConfirmationAction,
    outcome: G10cPostCommitUnknownConfirmationOutcome,
  ): void;
}

export interface G10cPostCommitUnknownHandoffBundle {
  readonly sink: G10cPostCommitUnknownHandoffSink;
  readonly owner: G10cPostCommitUnknownHandoffOwner;
}

/**
 * The immutable result image produced by the original recognition write.
 * It is deliberately installed by the concrete adapter before commit and is
 * never accepted from a canonical worker.  Mongo-generated Event identity and
 * recordedAt are not predictable before the original commit, so the trusted
 * idempotency pair stays private to this material.
 */
export interface G10cRecognitionExpectedImage {
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly event: Readonly<{
    direction: 'ENTRY' | 'EXIT';
    kind: 'QR_SCANNED' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
    outcome: 'ACCEPTED' | 'REJECTED';
    reasonCode: string;
    receivedAtMs: number;
    qualificationId: string | null;
    presenceTransition: Readonly<{
      from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
      to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
    }> | null;
  }>;
  readonly qualification: QualificationSnapshot | null;
  readonly mapping: FaceMappingSnapshot | null;
  readonly guardVersions: Readonly<{ qr: number; face: number }>;
}

/**
 * The immutable image of a management transaction.  Qualification identity,
 * incarnation, and post-write version are the durable anchor: a worker must
 * not treat a later qualification that merely has similar mutable fields as
 * confirmation of this original transaction.
 */
export interface G10cManagementExpectedImage {
  /** Immutable receipt ID written inside the original management transaction. */
  readonly operationId: string;
  readonly operation: 'CREATE' | 'UPDATE' | 'REVOKE' | 'EXPIRE';
  readonly qualification: ManagementQualificationSnapshot;
  readonly mapping: FaceMappingSnapshot | null;
  readonly guardVersions: Readonly<{ qr: number; face: number }>;
}

declare const g10cRecognitionImageCaptureBrand: unique symbol;

/** Adapter-private capability; ordinary recovery workers cannot prepare data. */
export interface G10cRecognitionExpectedImageCapture {
  readonly [g10cRecognitionImageCaptureBrand]: never;
}

declare const g10cManagementImageCaptureBrand: unique symbol;

/** Adapter-private capability for a management transaction's post-write image. */
export interface G10cManagementExpectedImageCapture {
  readonly [g10cManagementImageCaptureBrand]: never;
}

/**
 * Internal G10c composition seam: validate that a confirmation worker owns
 * this exact taken handoff before it can admit a canonical-read action.  It
 * intentionally returns no state, session, or persistence authority.
 */
export function assertG10cPostCommitUnknownHandoffOwnership(
  owner: G10cPostCommitUnknownHandoffOwner,
  handoff: G10cPostCommitUnknownHandoff,
): void {
  const sink = ownerSinks.get(owner as object);
  if (sink === undefined) throw new TypeError('G10c post-commit unknown handoff owner is foreign');
  requireTakenHandoff(sink, handoff);
}

/**
 * Private, opaque phase probe for the canonical-read worker.  It validates
 * the original owner and asks the ledger whether CANONICAL_READ (not merely
 * some next action) is due without allocating a permit.
 */
export function assertG10cPostCommitUnknownCanonicalReadDue(
  owner: G10cPostCommitUnknownHandoffOwner,
  handoff: G10cPostCommitUnknownHandoff,
): void {
  const sink = ownerSinks.get(owner as object);
  if (sink === undefined) throw new TypeError('G10c post-commit unknown handoff owner is foreign');
  const state = requireTakenHandoff(sink, handoff);
  assertOperationUnknownCommitCanonicalReadDue(state.binding, state.confirmation);
}

interface HandoffState {
  readonly adapter: G04bMongoPersistenceAdapter;
  readonly scope: AccessScopeContext;
  readonly session: ClientSession;
  readonly binding: OperationBudgetBinding;
  readonly confirmation: OperationUnknownCommitConfirmation;
  readonly sink: G10cPostCommitUnknownHandoffSink;
  status: 'RETAINED' | 'TAKEN';
  originalCommitTerminatorClaimed: boolean;
  confirmationActionAdmitted: boolean;
  terminalCleanupClaimed: boolean;
  readonly expectedRecognitionImage: G10cRecognitionExpectedImage | null;
  readonly expectedManagementImage: G10cManagementExpectedImage | null;
}

interface ConfirmationActionState {
  readonly handoff: G10cPostCommitUnknownHandoff;
  readonly raw: OperationUnknownCommitConfirmationAction;
  active: boolean;
}

const concreteAdapters = new WeakSet<object>();
const attachedSinks = new WeakMap<object, G10cPostCommitUnknownHandoffSink>();
const bundleSinks = new WeakSet<object>();
const forwardingDestinations = new WeakMap<object, G10cPostCommitUnknownHandoffSink>();
const ownerSinks = new WeakMap<object, G10cPostCommitUnknownHandoffSink>();
const handoffs = new WeakMap<object, HandoffState>();
const handedOffContexts = new WeakMap<object, WeakSet<object>>();
const confirmationActions = new WeakMap<object, ConfirmationActionState>();
const preparedExpectedImages = new WeakMap<object, WeakMap<object, G10cRecognitionExpectedImage>>();
const expectedImageCaptures = new WeakMap<object, G04bMongoPersistenceAdapter>();
const adapterExpectedImageCaptures = new WeakMap<object, G10cRecognitionExpectedImageCapture>();
const preparedManagementImages = new WeakMap<object, WeakMap<object, G10cManagementExpectedImage>>();
const managementImageCaptures = new WeakMap<object, G04bMongoPersistenceAdapter>();
const adapterManagementImageCaptures = new WeakMap<object, G10cManagementExpectedImageCapture>();
const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Called only by the concrete G04b adapter constructor. */
export function registerG10cConcreteG04bMongoPersistenceAdapter(
  adapter: G04bMongoPersistenceAdapter,
): void {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new TypeError('G10c concrete G04b adapter is invalid');
  }
  concreteAdapters.add(adapter as object);
}

/**
 * Attach a single composition-owned sink before any unknown result is handed
 * off.  This is intentionally separate from G10b's persistence sidecar: it
 * has no transaction command or budget authority.
 */
export function attachG10cPostCommitUnknownHandoffSink(
  adapter: G04bMongoPersistenceAdapter,
  sink: G10cPostCommitUnknownHandoffSink,
): void {
  if (!concreteAdapters.has(adapter as object)) {
    throw new TypeError('G10c handoff requires a concrete G04b Mongo persistence adapter');
  }
  if (!bundleSinks.has(sink as object)) {
    throw new TypeError('G10c post-commit unknown handoff sink is foreign');
  }
  if (attachedSinks.has(adapter as object)) {
    throw new TypeError('G10c post-commit unknown handoff sink is already attached');
  }
  attachedSinks.set(adapter as object, sink);
}

/**
 * Creates an internal forwarding sink for the G07 lifetime bridge.  The
 * adapter still hands off only its opaque token; this wrapper lets the
 * composition layer bind that token to the already-admitted writer without
 * exposing a session, expected image, or command authority.
 */
export function createG10cPostCommitUnknownForwardingSink(
  destination: G10cPostCommitUnknownHandoffSink,
  observeRetained: (handoff: G10cPostCommitUnknownHandoff) => void,
): G10cPostCommitUnknownHandoffSink {
  if (!bundleSinks.has(destination as object)) {
    throw new TypeError('G10c post-commit unknown forwarding destination is foreign');
  }
  if (typeof observeRetained !== 'function') {
    throw new TypeError('G10c post-commit unknown forwarding observer is invalid');
  }
  const retainDestination = destination.retain.bind(destination);
  const sink = Object.freeze({
    retain(handoff: G10cPostCommitUnknownHandoff): void {
      // Verify adapter/scope ownership before the destination queue observes
      // the token.  A bad bridge cannot orphan a retained transaction in the
      // recovery queue and then claim a different G07 writer's lease.
      requireHandoff(handoff);
      observeRetained(handoff);
      retainDestination(handoff);
    },
  }) as G10cPostCommitUnknownHandoffSink;
  bundleSinks.add(sink as object);
  forwardingDestinations.set(sink as object, destination);
  return sink;
}

/** Internal composition proof for the G07 issued-persistence lifetime seam. */
export function assertG10cPostCommitUnknownHandoffBinding(
  adapter: G04bMongoPersistenceAdapter,
  scope: AccessScopeContext,
  handoff: G10cPostCommitUnknownHandoff,
): void {
  if (!concreteAdapters.has(adapter as object)) {
    throw new TypeError('G10c handoff binding requires a concrete G04b Mongo persistence adapter');
  }
  const state = requireHandoff(handoff);
  if (state.adapter !== adapter || state.scope !== scope) {
    throw new TypeError('G10c post-commit unknown handoff does not belong to this adapter scope');
  }
}

/**
 * Concrete adapter-only preparation seam.  The original transaction installs
 * its own deterministic result image before the first commit command.  The
 * scope key prevents a recovery worker from supplying a different image after
 * the outcome becomes unknown.
 */
export function createG10cRecognitionExpectedImageCapture(
  adapter: G04bMongoPersistenceAdapter,
): G10cRecognitionExpectedImageCapture {
  if (!concreteAdapters.has(adapter as object)) {
    throw new TypeError('G10c expected image requires a concrete G04b Mongo persistence adapter');
  }
  if (adapterExpectedImageCaptures.has(adapter as object)) {
    throw new TypeError('G10c expected image capture is already bound to this adapter');
  }
  const capture = Object.freeze({}) as G10cRecognitionExpectedImageCapture;
  expectedImageCaptures.set(capture as object, adapter);
  adapterExpectedImageCaptures.set(adapter as object, capture);
  return capture;
}

export function prepareG10cRecognitionExpectedImage(
  capture: G10cRecognitionExpectedImageCapture,
  scope: AccessScopeContext,
  image: G10cRecognitionExpectedImage,
): void {
  const adapter = expectedImageCaptures.get(capture as object);
  if (adapter === undefined) throw new TypeError('G10c expected image capture capability is foreign');
  const claims = readAccessScopeContextClaims(scope);
  if (claims === null || claims.owner.length === 0) throw new TypeError('G10c expected image scope is untrusted');
  assertExpectedImage(image);
  let byScope = preparedExpectedImages.get(adapter as object);
  if (byScope === undefined) {
    byScope = new WeakMap<object, G10cRecognitionExpectedImage>();
    preparedExpectedImages.set(adapter as object, byScope);
  }
  if (byScope.has(scope as object)) throw new TypeError('G10c expected image is already prepared for this scope');
  byScope.set(scope as object, freezeExpectedImage(image));
}

/** Allocate the separate private writer capability owned by the G04b adapter. */
export function createG10cManagementExpectedImageCapture(
  adapter: G04bMongoPersistenceAdapter,
): G10cManagementExpectedImageCapture {
  if (!concreteAdapters.has(adapter as object)) {
    throw new TypeError('G10c management expected image requires a concrete G04b Mongo persistence adapter');
  }
  if (adapterManagementImageCaptures.has(adapter as object)) {
    throw new TypeError('G10c management expected image capture is already bound to this adapter');
  }
  const capture = Object.freeze({}) as G10cManagementExpectedImageCapture;
  managementImageCaptures.set(capture as object, adapter);
  adapterManagementImageCaptures.set(adapter as object, capture);
  return capture;
}

/**
 * Store the exact post-write management image before the first commit.  This
 * intentionally shares neither a public DTO nor a recovery-worker input.
 */
export function prepareG10cManagementExpectedImage(
  capture: G10cManagementExpectedImageCapture,
  scope: AccessScopeContext,
  image: G10cManagementExpectedImage,
): void {
  const adapter = managementImageCaptures.get(capture as object);
  if (adapter === undefined) throw new TypeError('G10c management expected image capture capability is foreign');
  const claims = readAccessScopeContextClaims(scope);
  if (claims === null || claims.owner.length === 0) throw new TypeError('G10c management expected image scope is untrusted');
  assertManagementExpectedImage(image);
  let byScope = preparedManagementImages.get(adapter as object);
  if (byScope === undefined) {
    byScope = new WeakMap<object, G10cManagementExpectedImage>();
    preparedManagementImages.set(adapter as object, byScope);
  }
  if (byScope.has(scope as object)) throw new TypeError('G10c management expected image is already prepared for this scope');
  byScope.set(scope as object, freezeManagementExpectedImage(image));
}

/**
 * Retain an unknown initial-commit transaction exactly once for the attached
 * future confirmation owner.  The adapter invokes this synchronously in its
 * initial-commit error path; no transport, persistence, abort, or cleanup
 * action occurs here.
 */
export function handoffG10cPostCommitUnknown(
  adapter: G04bMongoPersistenceAdapter,
  scope: AccessScopeContext,
  session: ClientSession,
  binding: G10bScopedPersistenceBinding,
): void {
  const sink = attachedSinks.get(adapter as object);
  if (sink === undefined) return;
  const claims = readAccessScopeContextClaims(scope);
  if (claims === null || claims.owner.length === 0) {
    throw new TypeError('G10c post-commit unknown handoff scope is untrusted');
  }
  let contexts = handedOffContexts.get(adapter as object);
  if (contexts?.has(scope as object)) {
    throw new TypeError('G10c post-commit unknown handoff was already retained for this transaction');
  }
  // This starts the common confirmation clock and seals COMMIT_UNKNOWN before
  // the opaque value escapes.  A precommit abort group is now forbidden.
  // The G04b adapter deliberately knows this only as the opaque G10b sidecar
  // value.  Provenance is checked by the G10c budget wrapper before it can
  // establish the unknown-result lifecycle.
  const operationBinding = binding as OperationBudgetBinding;
  const confirmation = startOperationUnknownCommitConfirmation(operationBinding);
  if (contexts === undefined) {
    contexts = new WeakSet<object>();
    handedOffContexts.set(adapter as object, contexts);
  }
  contexts.add(scope as object);
  const handoff = Object.freeze({}) as G10cPostCommitUnknownHandoff;
  const expectedRecognitionImage = preparedExpectedImages.get(adapter as object)?.get(scope as object) ?? null;
  const expectedManagementImage = preparedManagementImages.get(adapter as object)?.get(scope as object) ?? null;
  if (expectedRecognitionImage !== null && expectedManagementImage !== null) {
    throw new TypeError('G10c transaction has conflicting canonical image kinds');
  }
  handoffs.set(handoff as object, {
    adapter,
    scope,
    session,
    binding: operationBinding,
    confirmation,
    sink,
    status: 'RETAINED',
    originalCommitTerminatorClaimed: false,
    confirmationActionAdmitted: false,
    terminalCleanupClaimed: false,
    expectedRecognitionImage,
    expectedManagementImage,
  });
  sink.retain(handoff);
}

/** Refuse to spend a confirmation slot when the original write has no image. */
export function assertG10cPostCommitUnknownCanonicalMaterial(
  owner: G10cPostCommitUnknownHandoffOwner,
  handoff: G10cPostCommitUnknownHandoff,
): void {
  const sink = ownerSinks.get(owner as object);
  if (sink === undefined) throw new TypeError('G10c post-commit unknown handoff owner is foreign');
  const state = requireTakenHandoff(sink, handoff);
  if (state.expectedRecognitionImage === null && state.expectedManagementImage === null) {
    throw new TypeError('G10c canonical confirmation material is unavailable');
  }
}

/**
 * The only path that performs the canonical Mongo observation.  It keeps the
 * adapter, private idempotency anchor and expected image together in the
 * taken handoff; callers never inject a reader or result object.
 */
export async function confirmG10cPostCommitUnknownCanonicalResult(
  owner: G10cPostCommitUnknownHandoffOwner,
  handoff: G10cPostCommitUnknownHandoff,
  timeoutMs: number,
): Promise<'MATCHED' | 'INCONCLUSIVE'> {
  const sink = ownerSinks.get(owner as object);
  if (sink === undefined) throw new TypeError('G10c post-commit unknown handoff owner is foreign');
  const state = requireTakenHandoff(sink, handoff);
  if (state.expectedRecognitionImage === null && state.expectedManagementImage === null) {
    throw new TypeError('G10c canonical confirmation material is unavailable');
  }
  try {
    if (state.expectedRecognitionImage !== null) {
      const snapshot = await state.adapter.readG10cCanonicalSnapshot(
        state.expectedRecognitionImage.sourceId,
        state.expectedRecognitionImage.externalEventId,
        timeoutMs,
      );
      return snapshot !== null && matchesRecognitionExpectedImage(snapshot, state.expectedRecognitionImage)
        ? 'MATCHED'
        : 'INCONCLUSIVE';
    }
    const expected = state.expectedManagementImage!;
    const snapshot = await state.adapter.readG10cManagementCanonicalSnapshot(
      expected.operationId,
      timeoutMs,
    );
    return snapshot !== null && matchesManagementExpectedImage(snapshot, expected)
      ? 'MATCHED'
      : 'INCONCLUSIVE';
  } catch (_error: unknown) {
    return 'INCONCLUSIVE';
  }
}

/**
 * Claim the one terminal release path for a taken handoff.  The claim is made
 * only after the owner-fenced budget lifecycle reports a confirmed result;
 * this avoids treating a sender rejection, a delayed read, or an in-flight
 * confirmation as permission to close the original Mongo session.
 */
export function createG10cPostCommitUnknownTerminalCleaner(
  owner: G10cPostCommitUnknownHandoffOwner,
  handoff: G10cPostCommitUnknownHandoff,
): G10cPostCommitUnknownTerminalCleaner {
  const sink = ownerSinks.get(owner as object);
  if (sink === undefined) throw new TypeError('G10c terminal cleaner owner is foreign');
  const state = requireTakenHandoff(sink, handoff);
  assertOperationUnknownCommitConfirmationTerminal(state.binding, state.confirmation);
  if (state.terminalCleanupClaimed) {
    throw new TypeError('G10c terminal cleaner was already claimed');
  }
  state.terminalCleanupClaimed = true;
  let closed = false;

  return Object.freeze({
    cleanupAfterConfirmedOutcome: async (): Promise<void> => {
      if (closed) throw new TypeError('G10c terminal cleaner is closed');
      closed = true;

      // Recheck immediately before the only session operation.  A stale
      // owner or an unexpectedly active confirmation freezes its own
      // authority rather than releasing a session on ambiguous ownership.
      try {
        assertOperationUnknownCommitConfirmationTerminal(state.binding, state.confirmation);
        await state.adapter.releaseG10cConfirmedRetainedTransaction(state.scope, state.session);
      } finally {
        // Whether session release succeeds or reports an unsafe driver error,
        // this cleaner is terminally spent.  Drop recovery material and the
        // opaque handoff so no code can retry, abort, or issue a late command
        // against the original transaction.
        releaseTerminalHandoffState(handoff, state);
      }
    },
  });
}

/** Remove all recovery-only references after the adapter has ended the session. */
function releaseTerminalHandoffState(
  handoff: G10cPostCommitUnknownHandoff,
  state: HandoffState,
): void {
  preparedExpectedImages.get(state.adapter as object)?.delete(state.scope as object);
  preparedManagementImages.get(state.adapter as object)?.delete(state.scope as object);
  handoffs.delete(handoff as object);
}

export function createG10cPostCommitUnknownHandoffBundle(): G10cPostCommitUnknownHandoffBundle {
  const queued: G10cPostCommitUnknownHandoff[] = [];
  const sink: G10cPostCommitUnknownHandoffSink = Object.freeze({
    retain(handoff: G10cPostCommitUnknownHandoff): void {
      const state = requireHandoff(handoff);
      if (!sameRecoveryQueue(state.sink, sink) || state.status !== 'RETAINED' || queued.includes(handoff)) {
        throw new TypeError('G10c post-commit unknown handoff cannot be retained');
      }
      queued.push(handoff);
    },
  });
  bundleSinks.add(sink as object);

  const owner: G10cPostCommitUnknownHandoffOwner = Object.freeze({
    pending(): readonly G10cPostCommitUnknownHandoff[] {
      return Object.freeze([...queued]);
    },
    take(handoff: G10cPostCommitUnknownHandoff): G10cPostCommitUnknownHandoff {
      const state = requireHandoff(handoff);
      if (!sameRecoveryQueue(state.sink, sink) || state.status !== 'RETAINED') {
        throw new TypeError('G10c post-commit unknown handoff owner is foreign or stale');
      }
      const index = queued.indexOf(handoff);
      if (index < 0) throw new TypeError('G10c post-commit unknown handoff is not queued');
      // The opaque claim remains bound to the same original operation owner;
      // a coordinator queue identity alone is never authority to continue it.
      assertOperationUnknownCommitConfirmationCurrent(state.binding, state.confirmation);
      queued.splice(index, 1);
      state.status = 'TAKEN';
      return handoff;
    },
    admitNextConfirmation(
      handoff: G10cPostCommitUnknownHandoff,
    ): G10cPostCommitUnknownConfirmationAction {
      const state = requireTakenHandoff(sink, handoff);
      const admission = admitOperationUnknownCommitConfirmationAction(state.binding, state.confirmation);
      state.confirmationActionAdmitted = true;
      const action = Object.freeze({
        kind: admission.context.kind,
        attempt: admission.context.attempt,
        timeoutMs: admission.context.timeoutMs,
      }) as G10cPostCommitUnknownConfirmationAction;
      confirmationActions.set(action, { handoff, raw: admission.action, active: true });
      return action;
    },
    settleConfirmation(
      handoff: G10cPostCommitUnknownHandoff,
      action: G10cPostCommitUnknownConfirmationAction,
      outcome: G10cPostCommitUnknownConfirmationOutcome,
    ): void {
      const state = requireTakenHandoff(sink, handoff);
      const actionState = requireConfirmationAction(handoff, action);
      settleOperationUnknownCommitConfirmationAction(
        state.binding,
        state.confirmation,
        actionState.raw,
        outcome,
      );
      actionState.active = false;
      state.confirmationActionAdmitted = false;
      // A rejected original sender is not terminal.  After the intervening
      // canonical read also remains unknown, the ledger deliberately makes a
      // later ORIGINAL_COMMIT due again.  Release this construction claim so
      // a future cadence coordinator can obtain a fresh one-shot sender.
      if (action.kind === 'ORIGINAL_COMMIT' && outcome === 'STILL_UNKNOWN') {
        state.originalCommitTerminatorClaimed = false;
      }
    },
  });
  ownerSinks.set(owner as object, sink);
  return Object.freeze({ sink, owner });
}

/**
 * Create one sender for the currently due ORIGINAL_COMMIT turn.  Each sender
 * itself is one-shot.  A rejected original sender releases only its local
 * construction claim after settlement, so a future (not yet implemented)
 * cadence coordinator can issue the next ORIGINAL_COMMIT after an intervening
 * canonical read also remains unknown.  The retained Mongo session stays
 * encapsulated here; callers receive neither it nor a raw budget permit.
 */
export function createG10cRetainedOriginalCommitTerminator(
  owner: G10cPostCommitUnknownHandoffOwner,
  handoff: G10cPostCommitUnknownHandoff,
): G10cRetainedOriginalCommitTerminator {
  const sink = ownerSinks.get(owner as object);
  if (sink === undefined) {
    throw new TypeError('G10c retained original commit terminator owner is foreign');
  }
  const state = requireTakenHandoff(sink, handoff);
  if (state.originalCommitTerminatorClaimed || state.confirmationActionAdmitted) {
    throw new G10cRetainedOriginalCommitTerminatorError(
      'TERMINATOR_NOT_INITIAL',
      'G10c retained original commit terminator requires an idle original confirmation turn',
    );
  }
  state.originalCommitTerminatorClaimed = true;
  const commitTransaction = state.session.commitTransaction.bind(state.session);
  let closed = false;

  return Object.freeze({
    attemptOriginalCommit: async (): Promise<G10cRetainedOriginalCommitAttemptResult> => {
      if (closed) {
        throw new G10cRetainedOriginalCommitTerminatorError(
          'TERMINATOR_CLOSED',
          'G10c retained original commit terminator cannot send a second command',
        );
      }
      closed = true;

      const action = owner.admitNextConfirmation(handoff);
      if (action.kind !== 'ORIGINAL_COMMIT') {
        // Never route a canonical-read permit to commitTransaction.
        owner.settleConfirmation(handoff, action, 'STILL_UNKNOWN');
        throw new G10cRetainedOriginalCommitTerminatorError(
          'TERMINATOR_NOT_INITIAL',
          'G10c retained original commit terminator was not prescribed an original commit',
        );
      }

      try {
        await commitTransaction({ timeoutMS: action.timeoutMs });
      } catch (_error: unknown) {
        // A driver/transport rejection does not establish no effect.  Keep
        // the handoff in the unknown state for the canonical-read phase.
        owner.settleConfirmation(handoff, action, 'STILL_UNKNOWN');
        return Object.freeze({
          delivery: 'REJECTED_STILL_UNKNOWN',
          attempt: action.attempt,
          timeoutMs: action.timeoutMs,
        });
      }
      // A resolved resend is Mongo's confirmation of the same retained
      // transaction.  Settlement is deliberately outside the send catch:
      // an owner/budget failure must not be recast as a transport failure.
      owner.settleConfirmation(handoff, action, 'CANONICAL_RESULT');
      return Object.freeze({
        delivery: 'COMMIT_CONFIRMED',
        attempt: action.attempt,
        timeoutMs: action.timeoutMs,
      });
    },
  });
}

function requireHandoff(handoff: G10cPostCommitUnknownHandoff): HandoffState {
  if ((typeof handoff !== 'object' && typeof handoff !== 'function') || handoff === null
    || !Object.isFrozen(handoff) || Reflect.ownKeys(handoff).length !== 0) {
    throw new TypeError('G10c post-commit unknown handoff is invalid');
  }
  const state = handoffs.get(handoff as object);
  if (state === undefined) throw new TypeError('G10c post-commit unknown handoff is foreign or forged');
  return state;
}

function requireTakenHandoff(
  sink: G10cPostCommitUnknownHandoffSink,
  handoff: G10cPostCommitUnknownHandoff,
): HandoffState {
  const state = requireHandoff(handoff);
  if (!sameRecoveryQueue(state.sink, sink) || state.status !== 'TAKEN') {
    throw new TypeError('G10c post-commit unknown handoff owner is foreign or stale');
  }
  assertOperationUnknownCommitConfirmationCurrent(state.binding, state.confirmation);
  return state;
}

/** A forwarding sink has no owner; its approved destination keeps ownership. */
function sameRecoveryQueue(
  retainedSink: G10cPostCommitUnknownHandoffSink,
  queueSink: G10cPostCommitUnknownHandoffSink,
): boolean {
  return retainedSink === queueSink || forwardingDestinations.get(retainedSink as object) === queueSink;
}

function requireConfirmationAction(
  handoff: G10cPostCommitUnknownHandoff,
  action: G10cPostCommitUnknownConfirmationAction,
): ConfirmationActionState {
  if ((typeof action !== 'object' && typeof action !== 'function') || action === null
    || !Object.isFrozen(action)) {
    throw new TypeError('G10c post-commit unknown confirmation action is invalid');
  }
  const state = confirmationActions.get(action as object);
  if (state === undefined || state.handoff !== handoff || !state.active) {
    throw new TypeError('G10c post-commit unknown confirmation action is foreign or stale');
  }
  return state;
}

function assertExpectedImage(image: G10cRecognitionExpectedImage): void {
  if (!isPlainRecord(image) || !nonEmptyString(image.sourceId) || !nonEmptyString(image.externalEventId)
    || !isPlainRecord(image.event) || !nonEmptyString(image.event.reasonCode)
    || !Number.isSafeInteger(image.event.receivedAtMs)
    || !isPlainRecord(image.guardVersions)
    || !validVersion(image.guardVersions.qr) || !validVersion(image.guardVersions.face)) {
    throw new TypeError('G10c recognition expected image is invalid');
  }
}

function freezeExpectedImage(image: G10cRecognitionExpectedImage): G10cRecognitionExpectedImage {
  return Object.freeze({
    sourceId: image.sourceId,
    externalEventId: image.externalEventId,
    event: Object.freeze({
      direction: image.event.direction,
      kind: image.event.kind,
      outcome: image.event.outcome,
      reasonCode: image.event.reasonCode,
      receivedAtMs: image.event.receivedAtMs,
      qualificationId: image.event.qualificationId,
      presenceTransition: image.event.presenceTransition === null ? null : Object.freeze({
        from: image.event.presenceTransition.from,
        to: image.event.presenceTransition.to,
      }),
    }),
    qualification: image.qualification === null ? null : Object.freeze({
      qualificationId: image.qualification.qualificationId,
      incarnation: image.qualification.incarnation,
      version: image.qualification.version,
      state: Object.freeze({ ...image.qualification.state }),
    }),
    mapping: image.mapping === null ? null : Object.freeze({ ...image.mapping }),
    guardVersions: Object.freeze({ qr: image.guardVersions.qr, face: image.guardVersions.face }),
  });
}

function assertManagementExpectedImage(image: G10cManagementExpectedImage): void {
  if (!isPlainRecord(image)
    || !CANONICAL_UUID_V4.test(image.operationId)
    || (image.operation !== 'CREATE' && image.operation !== 'UPDATE' && image.operation !== 'REVOKE' && image.operation !== 'EXPIRE')
    || !isManagementQualificationSnapshot(image.qualification)
    || !isPlainRecord(image.guardVersions)
    || !validVersion(image.guardVersions.qr)
    || !validVersion(image.guardVersions.face)
    || (image.mapping !== null && !isFaceMappingSnapshot(image.mapping))) {
    throw new TypeError('G10c management expected image is invalid');
  }
  if (image.mapping !== null && (
    image.mapping.qualificationId !== image.qualification.qualificationId
    || image.mapping.qualificationIncarnation !== image.qualification.incarnation
  )) {
    throw new TypeError('G10c management expected image mapping is not owned by qualification');
  }
}

function freezeManagementExpectedImage(image: G10cManagementExpectedImage): G10cManagementExpectedImage {
  return Object.freeze({
    operationId: image.operationId,
    operation: image.operation,
    qualification: Object.freeze({
      qualificationId: image.qualification.qualificationId,
      incarnation: image.qualification.incarnation,
      version: image.qualification.version,
      displayName: image.qualification.displayName,
      createdAtMs: image.qualification.createdAtMs,
      updatedAtMs: image.qualification.updatedAtMs,
      state: Object.freeze({ ...image.qualification.state }),
    }),
    mapping: image.mapping === null ? null : Object.freeze({ ...image.mapping }),
    guardVersions: Object.freeze({ qr: image.guardVersions.qr, face: image.guardVersions.face }),
  });
}

function matchesRecognitionExpectedImage(
  snapshot: import('../g04b-persistence-adapter.js').G04bCanonicalSnapshot,
  expected: G10cRecognitionExpectedImage,
): boolean {
  const event = snapshot.event;
  return event.sourceId === expected.sourceId
    && event.direction === expected.event.direction
    && event.kind === expected.event.kind
    && event.outcome === expected.event.outcome
    && event.reasonCode === expected.event.reasonCode
    && event.receivedAtMs === expected.event.receivedAtMs
    && event.qualificationId === expected.event.qualificationId
    && sameTransition(event.presenceTransition, expected.event.presenceTransition)
    && sameQualification(snapshot.qualification, expected.qualification)
    && sameMapping(snapshot.mapping, expected.mapping)
    && snapshot.guardVersions.qr === expected.guardVersions.qr
    && snapshot.guardVersions.face === expected.guardVersions.face;
}

function matchesManagementExpectedImage(
  snapshot: import('../g04b-persistence-adapter.js').G04bManagementCanonicalSnapshot,
  expected: G10cManagementExpectedImage,
): boolean {
  return snapshot.receipt.operationId === expected.operationId
    && snapshot.receipt.operation === expected.operation
    && snapshot.receipt.qualificationId === expected.qualification.qualificationId
    && snapshot.receipt.qualificationIncarnation === expected.qualification.incarnation
    && snapshot.receipt.qualificationVersion === expected.qualification.version
    && sameManagementQualification(snapshot.qualification, expected.qualification)
    && sameMapping(snapshot.mapping, expected.mapping)
    && snapshot.guardVersions.qr === expected.guardVersions.qr
    && snapshot.guardVersions.face === expected.guardVersions.face;
}

function sameQualification(left: QualificationSnapshot | null, right: QualificationSnapshot | null): boolean {
  return left === null || right === null
    ? left === right
    : left.qualificationId === right.qualificationId
      && left.incarnation === right.incarnation
      && left.version === right.version
      && left.state.validFromMs === right.state.validFromMs
      && left.state.validUntilMs === right.state.validUntilMs
      && left.state.presence === right.state.presence
      && left.state.enteredAtMs === right.state.enteredAtMs
      && left.state.exitedAtMs === right.state.exitedAtMs
      && left.state.revokedAtMs === right.state.revokedAtMs
      && left.state.revocationReason === right.state.revocationReason
      && left.state.expiredTerminalAtMs === right.state.expiredTerminalAtMs;
}

function sameManagementQualification(
  left: ManagementQualificationSnapshot,
  right: ManagementQualificationSnapshot,
): boolean {
  return left.qualificationId === right.qualificationId
    && left.incarnation === right.incarnation
    && left.version === right.version
    && left.displayName === right.displayName
    && left.createdAtMs === right.createdAtMs
    && left.updatedAtMs === right.updatedAtMs
    && left.state.validFromMs === right.state.validFromMs
    && left.state.validUntilMs === right.state.validUntilMs
    && left.state.presence === right.state.presence
    && left.state.enteredAtMs === right.state.enteredAtMs
    && left.state.exitedAtMs === right.state.exitedAtMs
    && left.state.revokedAtMs === right.state.revokedAtMs
    && left.state.revocationReason === right.state.revocationReason
    && left.state.expiredTerminalAtMs === right.state.expiredTerminalAtMs;
}

function sameMapping(left: FaceMappingSnapshot | null, right: FaceMappingSnapshot | null): boolean {
  return left === null || right === null
    ? left === right
    : left.qualificationId === right.qualificationId
      && left.qualificationIncarnation === right.qualificationIncarnation
      && left.mappingIncarnation === right.mappingIncarnation
      && left.version === right.version;
}

function sameTransition(
  left: Readonly<{ from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED'; to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED' }> | null,
  right: G10cRecognitionExpectedImage['event']['presenceTransition'],
): boolean {
  return left === null || right === null
    ? left === right
    : left.from === right.from && left.to === right.to;
}

function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isManagementQualificationSnapshot(value: unknown): value is ManagementQualificationSnapshot {
  if (!isPlainRecord(value)
    || !nonEmptyString(value.qualificationId)
    || !nonEmptyString(value.incarnation)
    || !validVersion(value.version)
    || !nonEmptyString(value.displayName)
    || !Number.isSafeInteger(value.createdAtMs)
    || !Number.isSafeInteger(value.updatedAtMs)
    || !isPlainRecord(value.state)) return false;
  const state = value.state as Record<string, unknown>;
  return Number.isSafeInteger(state.validFromMs)
    && Number.isSafeInteger(state.validUntilMs)
    && (state.presence === 'NOT_ENTERED' || state.presence === 'INSIDE' || state.presence === 'EXITED')
    && nullableSafeInteger(state.enteredAtMs)
    && nullableSafeInteger(state.exitedAtMs)
    && nullableSafeInteger(state.revokedAtMs)
    && (state.revocationReason === null || nonEmptyString(state.revocationReason))
    && nullableSafeInteger(state.expiredTerminalAtMs);
}

function isFaceMappingSnapshot(value: unknown): value is FaceMappingSnapshot {
  return isPlainRecord(value)
    && nonEmptyString(value.qualificationId)
    && nonEmptyString(value.qualificationIncarnation)
    && nonEmptyString(value.mappingIncarnation)
    && validVersion(value.version);
}

function nullableSafeInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
