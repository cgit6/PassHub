import type { ClientSession } from 'mongodb';

import {
  type NativePrecommitOutcome,
} from '../../../access/application/internal/budget-ledger.js';
import {
  type PrecommitTerminationLifecycle,
} from '../../../access/application/internal/precommit-termination-lifecycle.js';

/**
 * G10b-only internal seam for a real MongoDB precommit abort.
 *
 * It deliberately does not know how a transaction was created, does not run
 * CRUD, and cannot be selected for an unknown-commit recovery.  Its single
 * purpose is to make the ordering around the public driver abort API
 * inspectable: seal the caller scope synchronously, settle the lifecycle's
 * bounded native group, then end the session exactly once.
 */

export interface G10bPrecommitScopeFence {
  /** Must synchronously make the caller's transaction scope unusable. */
  sealPrecommitScope(): void;
}

export interface G10bPrecommitMongoTerminatorOptions {
  readonly session: Pick<ClientSession, 'abortTransaction' | 'endSession'>;
  readonly lifecycle: PrecommitTerminationLifecycle;
  readonly scopeFence: G10bPrecommitScopeFence;
}

export type G10bPrecommitTerminationResult = Readonly<{
  readonly outcome: NativePrecommitOutcome;
  /** Exactly one high-level ClientSession.abortTransaction() invocation. */
  readonly abortAttempts: 1;
}>;

export type G10bPrecommitMongoTerminatorErrorCode =
  | 'TERMINATOR_CLOSED'
  | 'SCOPE_FENCE_INVALID'
  | 'UNKNOWN_COMMIT_FORBIDDEN'
  | 'LIFECYCLE_NOT_OPEN'
  | 'END_SESSION_FAILED';

export class G10bPrecommitMongoTerminatorError extends Error {
  readonly code: G10bPrecommitMongoTerminatorErrorCode;

  constructor(code: G10bPrecommitMongoTerminatorErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'G10bPrecommitMongoTerminatorError';
    this.code = code;
  }
}

export interface G10bPrecommitMongoTerminator {
  /**
   * Runs the complete native precommit termination group.
   *
   * This seam invokes ClientSession.abortTransaction() exactly once.  MongoDB
   * driver 7.6 owns its own retryable-write retry within that one call, then
   * transitions the session to ABORTED in its finally block.  A second
   * high-level call here could therefore exceed the intended two wire abort
   * commands.  A rejected/throwing call instead becomes terminal
   * `STILL_UNKNOWN`; no commit recovery, CRUD cleanup, or late driver command
   * is attempted by this seam.
   */
  terminatePrecommit(): Promise<G10bPrecommitTerminationResult>;
}

type TerminatorState = 'OPEN' | 'TERMINATING' | 'ENDED' | 'FAILED_BEFORE_GROUP_TERMINAL';

export function createG10bPrecommitMongoTerminator(
  options: G10bPrecommitMongoTerminatorOptions,
): G10bPrecommitMongoTerminator {
  assertOptions(options);

  // Capture methods once.  A caller cannot mutate an options object between
  // the synchronous scope fence and the later awaited driver operation.
  const abortTransaction = options.session.abortTransaction.bind(options.session);
  const endSession = options.session.endSession.bind(options.session);
  const sealPrecommitScope = options.scopeFence.sealPrecommitScope.bind(options.scopeFence);
  const lifecycle = options.lifecycle;

  let state: TerminatorState = 'OPEN';

  const terminalError = (): G10bPrecommitMongoTerminatorError => new G10bPrecommitMongoTerminatorError(
    'TERMINATOR_CLOSED',
    'G10b Mongo precommit terminator cannot send commands after it has started',
  );

  return Object.freeze({
    terminatePrecommit: async (): Promise<G10bPrecommitTerminationResult> => {
      if (state !== 'OPEN') throw terminalError();
      state = 'TERMINATING';

      // The terminator owns the seal transition.  Checking this before the
      // caller fence means a commit-unknown lifecycle cannot even ask a
      // caller to take the precommit-only path.
      const beforeSeal = lifecycle.snapshot();
      if (beforeSeal.scope === 'COMMIT_UNKNOWN' || beforeSeal.phase === 'SEALED_COMMIT_UNKNOWN') {
        state = 'FAILED_BEFORE_GROUP_TERMINAL';
        throw new G10bPrecommitMongoTerminatorError(
          'UNKNOWN_COMMIT_FORBIDDEN',
          'G10b Mongo precommit terminator cannot handle an unknown commit',
        );
      }
      if (beforeSeal.phase !== 'OPEN' || beforeSeal.scope !== null || beforeSeal.activeGroup) {
        state = 'FAILED_BEFORE_GROUP_TERMINAL';
        throw new G10bPrecommitMongoTerminatorError(
          'LIFECYCLE_NOT_OPEN',
          'G10b Mongo precommit terminator requires an open lifecycle',
        );
      }

      // This is intentionally before the lifecycle reservation and before any
      // call to ClientSession.  Promise-returning fences are rejected: an
      // asynchronous "seal" could race an abort send and would not satisfy
      // the G10b no-late-work boundary.
      let sealResult: unknown;
      try {
        sealResult = sealPrecommitScope();
      } catch (error: unknown) {
        state = 'FAILED_BEFORE_GROUP_TERMINAL';
        throw error;
      }
      if (sealResult !== undefined) {
        state = 'FAILED_BEFORE_GROUP_TERMINAL';
        throw new G10bPrecommitMongoTerminatorError(
          'SCOPE_FENCE_INVALID',
          'G10b precommit scope fence must synchronously return undefined',
        );
      }

      // The lifecycle only receives PRECOMMIT here.  A presealed unknown
      // commit was rejected by the snapshot guard before the caller fence;
      // unknown-commit confirmation belongs to G10c, never to this class.
      let group;
      try {
        lifecycle.sealScope('PRECOMMIT');
        group = lifecycle.reserveAbortGroup();

        let outcome: NativePrecommitOutcome = 'NO_EFFECT_CONFIRMED';
        try {
          await lifecycle.executeAbort(group, (context) => abortTransaction({ timeoutMS: context.timeoutMs }));
        } catch (error: unknown) {
          // A driver callback rejection is only handled after the lifecycle
          // has settled the command.  If settlement itself failed, the
          // lifecycle remains frozen or has an active command and cannot
          // truthfully be made terminal; preserve that fail-closed error and
          // do not begin endSession.
          const afterAbort = lifecycle.snapshot();
          if (afterAbort.frozen || afterAbort.abortCommandInFlight) throw error;

          // The lifecycle has settled its one-shot command before exposing a
          // sender rejection.  The driver may already have retried at the
          // wire level, so this outer seam must not issue another high-level
          // abort.  Its only safe conclusion is that no effect is confirmed.
          outcome = 'STILL_UNKNOWN';
        }

        // A group is terminal before endSession begins.  This close is
        // synchronous and permanently closes lifecycle-owned abort admission.
        lifecycle.terminate(group, outcome);
        state = 'ENDED';

        try {
          await endSession();
        } catch (error: unknown) {
          throw new G10bPrecommitMongoTerminatorError(
            'END_SESSION_FAILED',
            'G10b Mongo session end failed after terminal precommit cleanup',
            { cause: error },
          );
        }
        return Object.freeze({ outcome, abortAttempts: 1 });
      } catch (error: unknown) {
        // Reaching this branch before lifecycle.terminate means the caller
        // must treat the session as unsafe.  We deliberately do not call
        // endSession: doing so would violate the group-terminal-before-end
        // ordering this seam is responsible for proving.
        if (state !== 'ENDED') state = 'FAILED_BEFORE_GROUP_TERMINAL';
        throw error;
      }
    },
  });

}

function assertOptions(options: G10bPrecommitMongoTerminatorOptions): void {
  if (typeof options !== 'object' || options === null) throw new TypeError('G10b Mongo terminator options are required');
  if (typeof options.session !== 'object' || options.session === null
    || typeof options.session.abortTransaction !== 'function'
    || typeof options.session.endSession !== 'function') {
    throw new TypeError('G10b Mongo terminator ClientSession is required');
  }
  if (typeof options.lifecycle !== 'object' || options.lifecycle === null
    || typeof options.lifecycle.sealScope !== 'function'
    || typeof options.lifecycle.reserveAbortGroup !== 'function'
    || typeof options.lifecycle.executeAbort !== 'function'
    || typeof options.lifecycle.terminate !== 'function') {
    throw new TypeError('G10b Mongo terminator lifecycle is required');
  }
  if (typeof options.scopeFence !== 'object' || options.scopeFence === null
    || typeof options.scopeFence.sealPrecommitScope !== 'function') {
    throw new TypeError('G10b Mongo terminator synchronous scope fence is required');
  }
}
