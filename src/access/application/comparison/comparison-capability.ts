import { createHmac, timingSafeEqual } from 'node:crypto';

import { encodeComparisonFrame } from './frame-codec.js';
import type { RecognitionComparisonInput } from './recognition-input.js';

const LOWER_HEX_32_BYTES = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const artifactBrand: unique symbol = Symbol('ComparisonArtifact');

export interface StartupComparisonVector {
  readonly input: RecognitionComparisonInput;
  readonly expectedFrameHex: string;
  readonly expectedHmacHex: string;
}

export interface ComparisonArtifact {
  readonly inputHmac: string;
  readonly comparisonReferenceId: string;
  readonly [artifactBrand]: true;
}

export class ComparisonCompatibilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ComparisonCompatibilityError';
  }
}

function assertLowerHexDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !LOWER_HEX_32_BYTES.test(value)) {
    throw new ComparisonCompatibilityError(
      `${label} must be exactly 64 lowercase hexadecimal characters`,
    );
  }
}

function digestFrame(key: Buffer, frame: Buffer): Buffer {
  return createHmac('sha256', key).update(frame).digest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredVectorName(input: RecognitionComparisonInput): string | null {
  switch (input.kind) {
    case 'QR_SCANNED':
      return input.token === 'A' ? 'QR_SCANNED:A' : null;
    case 'FACE_MATCHED':
      return input.provider === 'DemoFace' && input.externalSubjectId === '中😀'
        ? 'FACE_MATCHED:DemoFace:中😀'
        : null;
    case 'FACE_UNKNOWN':
      return 'FACE_UNKNOWN';
    default:
      return null;
  }
}

function makeArtifact(
  inputHmac: string,
  comparisonReferenceId: string,
): ComparisonArtifact {
  const artifact = {
    inputHmac,
    comparisonReferenceId,
  } as ComparisonArtifact;
  Object.defineProperty(artifact, artifactBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(artifact);
}

export interface ComparisonCapability {
  create(input: RecognitionComparisonInput): ComparisonArtifact;
  matches(
    input: RecognitionComparisonInput,
    stored: Readonly<{
      inputHmac: string;
      comparisonReferenceId: string;
    }>,
  ): boolean;
}

class VerifiedComparisonCapability implements ComparisonCapability {
  readonly #key: Buffer;
  readonly #comparisonReferenceId: string;

  public constructor(
    key: Buffer,
    comparisonReferenceId: string,
  ) {
    this.#key = Buffer.from(key);
    this.#comparisonReferenceId = comparisonReferenceId;
    Object.freeze(this);
  }

  public create(input: RecognitionComparisonInput): ComparisonArtifact {
    const digest = digestFrame(this.#key, encodeComparisonFrame(input));
    return makeArtifact(digest.toString('hex'), this.#comparisonReferenceId);
  }

  public matches(
    input: RecognitionComparisonInput,
    stored: Readonly<{
      inputHmac: string;
      comparisonReferenceId: string;
    }>,
  ): boolean {
    if (stored.comparisonReferenceId !== this.#comparisonReferenceId) {
      throw new ComparisonCompatibilityError(
        'stored comparison reference does not match the verified capability',
      );
    }
    assertLowerHexDigest(stored.inputHmac, 'stored input HMAC');
    const expected = digestFrame(this.#key, encodeComparisonFrame(input));
    return timingSafeEqual(expected, Buffer.from(stored.inputHmac, 'hex'));
  }
}

export function verifyStartupVectorsAndCreateComparisonCapability(
  input: unknown,
): ComparisonCapability {
  if (!isRecord(input)) {
    throw new ComparisonCompatibilityError(
      'startup comparison configuration must be an object',
    );
  }
  if (!Buffer.isBuffer(input.hmacKey) || input.hmacKey.byteLength === 0) {
    throw new ComparisonCompatibilityError('comparison HMAC key is empty');
  }
  if (
    typeof input.comparisonReferenceId !== 'string' ||
    !UUID_V4.test(input.comparisonReferenceId)
  ) {
    throw new ComparisonCompatibilityError(
      'comparison reference ID must be a canonical UUID v4',
    );
  }
  if (!Array.isArray(input.vectors) || input.vectors.length !== 3) {
    throw new ComparisonCompatibilityError(
      'startup evidence must contain exactly three fixed vectors',
    );
  }

  const seen = new Set<string>();
  for (const vector of input.vectors) {
    if (
      typeof vector !== 'object' ||
      vector === null ||
      Array.isArray(vector)
    ) {
      throw new ComparisonCompatibilityError(
        'startup evidence vector must be an object',
      );
    }
    const candidate = vector as Partial<StartupComparisonVector>;
    if (
      typeof candidate.expectedFrameHex !== 'string' ||
      typeof candidate.expectedHmacHex !== 'string' ||
      typeof candidate.input !== 'object' ||
      candidate.input === null ||
      Array.isArray(candidate.input)
    ) {
      throw new ComparisonCompatibilityError(
        'startup evidence vector has invalid field types',
      );
    }

    let name: string | null;
    let encoded: Buffer;
    try {
      encoded = encodeComparisonFrame(candidate.input);
      name = requiredVectorName(candidate.input);
    } catch {
      throw new ComparisonCompatibilityError(
        'startup evidence vector input is invalid',
      );
    }
    if (name === null || seen.has(name)) {
      throw new ComparisonCompatibilityError(
        'startup evidence has a missing, duplicate, or unexpected input vector',
      );
    }
    seen.add(name);
    assertLowerHexDigest(vector.expectedHmacHex, 'expected HMAC');
    if (
      vector.expectedFrameHex.length === 0 ||
      vector.expectedFrameHex.length % 2 !== 0 ||
      !/^[0-9a-f]+$/u.test(vector.expectedFrameHex)
    ) {
      throw new ComparisonCompatibilityError(
        'expected frame must be nonempty lowercase hexadecimal bytes',
      );
    }

    const literalFrame = Buffer.from(candidate.expectedFrameHex, 'hex');
    if (
      encoded.byteLength !== literalFrame.byteLength ||
      !timingSafeEqual(encoded, literalFrame)
    ) {
      throw new ComparisonCompatibilityError(
        `comparison frame is incompatible with startup vector ${name}`,
      );
    }

    const calculatedHmac = digestFrame(input.hmacKey, literalFrame);
    const expectedHmac = Buffer.from(candidate.expectedHmacHex, 'hex');
    if (!timingSafeEqual(calculatedHmac, expectedHmac)) {
      throw new ComparisonCompatibilityError(
        `comparison HMAC is incompatible with startup vector ${name}`,
      );
    }
  }

  if (seen.size !== 3) {
    throw new ComparisonCompatibilityError('startup evidence is incomplete');
  }
  return new VerifiedComparisonCapability(
    input.hmacKey,
    input.comparisonReferenceId,
  );
}
