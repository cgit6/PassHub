import {
  assertG10cPostCommitUnknownCanonicalMaterial,
  assertG10cPostCommitUnknownCanonicalReadDue,
  assertG10cPostCommitUnknownHandoffOwnership,
  confirmG10cPostCommitUnknownCanonicalResult,
  type G10cPostCommitUnknownHandoff,
  type G10cPostCommitUnknownHandoffOwner,
} from './g10c-post-commit-unknown-handoff.js';

export type G10cCanonicalConfirmationResult = Readonly<{
  readonly result: 'MATCHED' | 'INCONCLUSIVE';
  readonly attempt: number;
  readonly timeoutMs: number;
}>;

export interface G10cCanonicalConfirmationReader {
  confirmCanonicalRead(): Promise<G10cCanonicalConfirmationResult>;
}

/**
 * A recovery worker supplies neither a Mongo reader nor an expected image:
 * both are fixed by the original adapter and scope in the opaque handoff.
 */
export function createG10cCanonicalConfirmationReader(
  owner: G10cPostCommitUnknownHandoffOwner,
  handoff: G10cPostCommitUnknownHandoff,
): G10cCanonicalConfirmationReader {
  assertG10cPostCommitUnknownHandoffOwnership(owner, handoff);
  let closed = false;

  return Object.freeze({
    confirmCanonicalRead: async (): Promise<G10cCanonicalConfirmationResult> => {
      if (closed) throw new TypeError('G10c canonical confirmation reader is closed');
      // These checks are non-consuming.  An early worker must not burn the
      // ORIGINAL_COMMIT turn, and absent trusted material cannot be guessed.
      assertG10cPostCommitUnknownCanonicalReadDue(owner, handoff);
      assertG10cPostCommitUnknownCanonicalMaterial(owner, handoff);
      closed = true;

      const action = owner.admitNextConfirmation(handoff);
      if (action.kind !== 'CANONICAL_READ') {
        // The synchronous due probe makes this an integrity failure.  Do not
        // settle it as another command class or silently advance the cadence.
        throw new TypeError('G10c canonical confirmation action kind is invalid');
      }
      const result = await confirmG10cPostCommitUnknownCanonicalResult(owner, handoff, action.timeoutMs);
      owner.settleConfirmation(handoff, action, result === 'MATCHED' ? 'CANONICAL_RESULT' : 'STILL_UNKNOWN');
      return Object.freeze({ result, attempt: action.attempt, timeoutMs: action.timeoutMs });
    },
  });
}
