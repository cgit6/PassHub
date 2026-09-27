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
  /** Internal provenance check; must not re-encode or mint another artifact. */
  readonly matches?: (
    input: RecognitionComparisonInput,
    stored: Readonly<{ inputHmac: string; comparisonReferenceId: string }>,
  ) => boolean;
}

const verifiedComparisonPorts = new WeakSet<object>();

export function isVerifiedComparisonPort(value: unknown): value is ComparisonPort {
  return typeof value === 'object' && value !== null && verifiedComparisonPorts.has(value);
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
  const port = Object.freeze({
    validate: assertRecognitionComparisonInput,
    qrCredential,
    artifact,
    matches: (input: RecognitionComparisonInput, stored: Readonly<{
      readonly inputHmac: string;
      readonly comparisonReferenceId: string;
    }>): boolean => capability.matches(input, stored),
  });
  verifiedComparisonPorts.add(port);
  return port;
}
