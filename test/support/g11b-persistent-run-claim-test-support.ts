import {
  createPersistentRunClaimerWithIo,
  type PersistentRunClaimer,
  type PersistentRunClaimIo,
} from '../../src/deployment/internal/g11b-persistent-run-claim-engine.js';
export {
  ClaimedPersistentRun,
  PersistentRunClaimer,
  PersistentRunClaimError,
  readClaimedPersistentRunForBridge,
  type ClaimedPersistentRunFacts,
  type PersistentRunClaimIo,
  type PersistentRunClaimOutcome,
  type PersistentRunClaimRequest,
  type PersistentRunClaimStatus,
} from '../../src/deployment/internal/g11b-persistent-run-claim-engine.js';
import type {
  VerifiedDatasetVerifier,
} from '../../src/deployment/internal/g11b-dataset-verification.js';

/** The sole b3a IO-injection seam. */
export function createPersistentRunClaimerForTest(
  target: object,
  verifier: VerifiedDatasetVerifier,
  io: PersistentRunClaimIo,
): PersistentRunClaimer {
  return createPersistentRunClaimerWithIo(target, verifier, io);
}
