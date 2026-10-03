import { compareComparisonArtifacts, isComparisonArtifact } from '../../access/application/comparison/comparison-capability.js';

/** Registry equality consumes only startup-verified artifacts and constant-time digest comparison. */
export function sameG11bProductionComparisonArtifact(left: unknown, right: unknown): boolean {
  return isComparisonArtifact(left) && isComparisonArtifact(right) && compareComparisonArtifacts(left, right);
}
