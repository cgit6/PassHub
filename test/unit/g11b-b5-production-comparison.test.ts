import { sameG11bProductionComparisonArtifact } from '../../src/deployment/internal/g11b-production-comparison.js';
import { verifyStartupVectorsAndCreateComparisonCapability } from '../../src/access/application/comparison/index.js';
import { FIXED_COMPARISON_REFERENCE_ID, FIXED_STARTUP_VECTORS, FIXED_TEST_HMAC_KEY } from '../fixtures/comparison-vectors.js';

function capability(reference = FIXED_COMPARISON_REFERENCE_ID) {
  return verifyStartupVectorsAndCreateComparisonCapability({
    hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: reference, vectors: FIXED_STARTUP_VECTORS,
  });
}

describe('production registry comparison artifact equality', () => {
  test('genuine equal inputs match, different content and different reference reject', () => {
    const first = capability();
    const foreign = capability('99999999-9999-4999-8999-999999999999');
    const a = first.create({ kind: 'QR_SCANNED', token: 'A' });
    const equal = first.create({ kind: 'QR_SCANNED', token: 'A' });
    const different = first.create({ kind: 'QR_SCANNED', token: 'B' });
    const differentReference = foreign.create({ kind: 'QR_SCANNED', token: 'A' });
    expect(sameG11bProductionComparisonArtifact(a, equal)).toBe(true);
    expect(sameG11bProductionComparisonArtifact(a, different)).toBe(false);
    expect(sameG11bProductionComparisonArtifact(a, differentReference)).toBe(false);
    expect(sameG11bProductionComparisonArtifact(a, { ...a })).toBe(false);
    expect(sameG11bProductionComparisonArtifact({ ...a }, equal)).toBe(false);
    expect(sameG11bProductionComparisonArtifact({}, {})).toBe(false);
  });
});
