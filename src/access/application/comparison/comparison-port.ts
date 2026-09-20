import {
  assertRecognitionComparisonInput,
  type RecognitionComparisonInput,
} from './recognition-input.js';
import { computeQrLookupDigest } from './digests.js';
import type { ComparisonArtifactIssuer } from '../../ports/comparison-artifact.js';
import type { ComparisonCapability } from './comparison-capability.js';

export type { RecognitionComparisonInput } from './recognition-input.js';

export interface QrCredentialPort {
  lookupDigest(token: string): string;
}

export interface ComparisonPort {
  validate(input: RecognitionComparisonInput): void;
  readonly qrCredential: QrCredentialPort;
  /** Present only after startup vectors have been verified. */
  readonly artifact: ComparisonArtifactIssuer;
}

const qrCredential: QrCredentialPort = Object.freeze({
  lookupDigest: computeQrLookupDigest,
});

/** Adapt the startup-verified capability into the required narrow port. */
export function createVerifiedComparisonPort(
  capability: ComparisonCapability,
): ComparisonPort {
  if (typeof capability !== 'object' || capability === null) {
    throw new TypeError('verified comparison capability is required');
  }
  const artifact: ComparisonArtifactIssuer = Object.freeze({
    create: (input: unknown) => capability.create(input),
  });
  return Object.freeze({
    validate: assertRecognitionComparisonInput,
    qrCredential,
    artifact,
  });
}
