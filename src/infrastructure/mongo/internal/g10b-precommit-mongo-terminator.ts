import type { ClientSession } from 'mongodb';

import type { NativePrecommitOutcome } from '../../../access/application/internal/budget-ledger.js';
import type { G10bScopedPersistencePrecommitAuthority } from './g10b-scoped-persistence-sidecar.js';

/**
 * Attached-G04b-only terminal seam for a pre-initial-commit transaction.
 * The authority has already sealed the execution facade, finished its round,
 * and reserved the binding-owned native precommit group. This class owns one
 * high-level Mongo abort call and ends the session only after that group is
 * terminally settled.
 */
export interface G10bPrecommitMongoTerminatorOptions {
  readonly session: Pick<ClientSession, 'abortTransaction' | 'endSession' | 'inTransaction'>;
  readonly authority: G10bScopedPersistencePrecommitAuthority;
}

export type G10bPrecommitTerminationResult = Readonly<{
  readonly outcome: NativePrecommitOutcome;
  readonly abortAttempts: 1;
}>;

export type G10bPrecommitMongoTerminatorErrorCode =
  | 'TERMINATOR_CLOSED'
  | 'SESSION_STILL_ACTIVE'
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
  terminatePrecommit(): Promise<G10bPrecommitTerminationResult>;
}

export function createG10bPrecommitMongoTerminator(
  options: G10bPrecommitMongoTerminatorOptions,
): G10bPrecommitMongoTerminator {
  assertOptions(options);
  const abortTransaction = options.session.abortTransaction.bind(options.session);
  const endSession = options.session.endSession.bind(options.session);
  const inTransaction = options.session.inTransaction.bind(options.session);
  const authority = options.authority;
  let closed = false;

  return Object.freeze({
    terminatePrecommit: async (): Promise<G10bPrecommitTerminationResult> => {
      if (closed) {
        throw new G10bPrecommitMongoTerminatorError(
          'TERMINATOR_CLOSED',
          'G10b Mongo precommit terminator cannot send commands after it has started',
        );
      }
      closed = true;

      // abortOnce admits exactly one authority-owned native command and
      // supplies its fixed 2s timeout. A callback failure becomes terminal
      // STILL_UNKNOWN only after that command is settled; an authority error
      // remains unsafe and deliberately skips both terminal settle/endSession.
      const outcome = await authority.abortOnce((context) => abortTransaction({ timeoutMS: context.timeoutMs }));
      authority.terminate(outcome);
      if (inTransaction()) {
        throw new G10bPrecommitMongoTerminatorError(
          'SESSION_STILL_ACTIVE',
          'G10b Mongo session remains active after terminal precommit abort settlement',
        );
      }
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
    },
  });
}

function assertOptions(options: G10bPrecommitMongoTerminatorOptions): void {
  if (typeof options !== 'object' || options === null) throw new TypeError('G10b Mongo terminator options are required');
  if (typeof options.session !== 'object' || options.session === null
    || typeof options.session.abortTransaction !== 'function'
    || typeof options.session.endSession !== 'function'
    || typeof options.session.inTransaction !== 'function') {
    throw new TypeError('G10b Mongo terminator ClientSession is required');
  }
  if (typeof options.authority !== 'object' || options.authority === null
    || typeof options.authority.abortOnce !== 'function'
    || typeof options.authority.terminate !== 'function') {
    throw new TypeError('G10b Mongo terminator precommit authority is required');
  }
}
