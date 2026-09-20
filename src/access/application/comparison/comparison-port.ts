import {
  assertRecognitionComparisonInput,
  type RecognitionComparisonInput,
} from './recognition-input.js';
import { computeQrLookupDigest } from './digests.js';

export type { RecognitionComparisonInput } from './recognition-input.js';

export interface QrCredentialPort {
  lookupDigest(token: string): string;
}

export interface ComparisonPort {
  validate(input: RecognitionComparisonInput): void;
  readonly qrCredential: QrCredentialPort;
}

const qrCredential: QrCredentialPort = Object.freeze({
  lookupDigest: computeQrLookupDigest,
});

export const defaultComparisonPort: ComparisonPort = Object.freeze({
  validate: assertRecognitionComparisonInput,
  qrCredential,
});
