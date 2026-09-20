export {
  ComparisonInputError,
  assertExternalEventId,
  assertExternalSubjectId,
  assertProvider,
  assertRecognitionComparisonInput,
  assertRecognitionQrToken,
  type ComparisonInputErrorCode,
  type RecognitionComparisonInput,
} from './recognition-input.js';
export {
  COMPARISON_FRAME_VERSION,
  MAX_COMPARISON_FRAME_BYTES,
  encodeComparisonFrame,
} from './frame-codec.js';
export { computeQrLookupDigest, issueQrToken } from './digests.js';
export {
  ComparisonCompatibilityError,
  isComparisonArtifact,
  verifyStartupVectorsAndCreateComparisonCapability,
  type ComparisonArtifact,
  type ComparisonCapability,
  type StartupComparisonVector,
} from './comparison-capability.js';
export {
  createVerifiedComparisonPort,
  type ComparisonPort,
  type QrCredentialPort,
} from './comparison-port.js';
