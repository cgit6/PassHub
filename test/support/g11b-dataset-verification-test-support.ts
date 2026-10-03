import {
  createVerifiedDatasetVerifierWithInspector,
  type VerifiedDatasetVerifier,
} from '../../src/deployment/internal/g11b-dataset-verification-engine.js';

/** Test-only inspector seam; production binds the b2a Mongo inspector directly. */
export function createVerifiedDatasetVerifierForTest(
  target: object,
  inspect: () => unknown | Promise<unknown>,
): VerifiedDatasetVerifier {
  return createVerifiedDatasetVerifierWithInspector(target, inspect);
}
