import {
  ComparisonCompatibilityError,
  computeQrLookupDigest,
  issueQrToken,
  verifyStartupVectorsAndCreateComparisonCapability,
  type StartupComparisonVector,
} from '../../src/access/application/comparison/index.js';
import {
  FIXED_COMPARISON_REFERENCE_ID,
  FIXED_STARTUP_VECTORS,
  FIXED_TEST_HMAC_KEY,
} from '../fixtures/comparison-vectors.js';

function createCapability(
  overrides: Partial<
    Parameters<typeof verifyStartupVectorsAndCreateComparisonCapability>[0]
  > = {},
) {
  return verifyStartupVectorsAndCreateComparisonCapability({
    hmacKey: FIXED_TEST_HMAC_KEY,
    comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
    vectors: FIXED_STARTUP_VECTORS,
    ...overrides,
  });
}

test('independent literal vectors unlock one frozen comparison capability', () => {
  const key = Buffer.from(FIXED_TEST_HMAC_KEY);
  const capability = createCapability({ hmacKey: key });
  key.fill(0xff);

  expect(Object.isFrozen(capability)).toBe(true);
  const artifact = capability.create({ kind: 'QR_SCANNED', token: 'A' });
  expect(JSON.parse(JSON.stringify(artifact))).toEqual({
    inputHmac:
      '1035cbfb48da122da36a14350fdd5e43942923570c45dcfb50007a4d1dba93ae',
    comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
  });
  expect(Object.isFrozen(artifact)).toBe(true);
  expect(
    capability.matches({ kind: 'QR_SCANNED', token: 'A' }, artifact),
  ).toBe(true);
  expect(
    capability.matches({ kind: 'QR_SCANNED', token: 'B' }, artifact),
  ).toBe(false);
});

test('startup fails closed for wrong key, wrong frame, and incomplete evidence', () => {
  expect(
    () => createCapability({ hmacKey: Buffer.alloc(32, 0xff) }),
  ).toThrow(ComparisonCompatibilityError);

  const changedFrame: StartupComparisonVector[] = FIXED_STARTUP_VECTORS.map(
    (vector, index) =>
      index === 0
        ? { ...vector, expectedFrameHex: `${vector.expectedFrameHex.slice(0, -2)}00` }
        : vector,
  );
  expect(
    () => createCapability({ vectors: changedFrame }),
  ).toThrow(ComparisonCompatibilityError);
  expect(
    () => createCapability({ vectors: FIXED_STARTUP_VECTORS.slice(0, 2) }),
  ).toThrow(ComparisonCompatibilityError);
  expect(
    () =>
      createCapability({
        vectors: [
          FIXED_STARTUP_VECTORS[0]!,
          FIXED_STARTUP_VECTORS[0]!,
          FIXED_STARTUP_VECTORS[2]!,
        ],
      }),
  ).toThrow(ComparisonCompatibilityError);
});

test('reference mismatch and malformed stored digest are compatibility errors', () => {
  const capability = createCapability();
  expect(
    () =>
      capability.matches(
        { kind: 'FACE_UNKNOWN' },
        {
          inputHmac: FIXED_STARTUP_VECTORS[2]!.expectedHmacHex,
          comparisonReferenceId: '22222222-2222-4222-8222-222222222222',
        },
      ),
  ).toThrow(ComparisonCompatibilityError);
  expect(
    () =>
      capability.matches(
        { kind: 'FACE_UNKNOWN' },
        {
          inputHmac: 'ABC',
          comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
        },
      ),
  ).toThrow(ComparisonCompatibilityError);
});

test('QR lookup digest is domain-separated and token issuing has fixed shape', () => {
  expect(
    computeQrLookupDigest('A'),
  ).toBe('67a65222958bb899a7d7a341910c5af940b9356bfae0bf9f31c6c6d006632338');

  const tokens = Array.from({ length: 64 }, () => issueQrToken());
  for (const token of tokens) {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token.includes('=')).toBe(false);
  }
  expect(new Set(tokens).size).toBe(tokens.length);
});

test('startup configuration rejects null, wrong types, and malformed vectors', () => {
  const malformed: unknown[] = [
    null,
    'config',
    { hmacKey: 'key', comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS },
    { hmacKey: Buffer.alloc(0), comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: FIXED_STARTUP_VECTORS },
    { hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: null },
    { hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: 'vectors' },
    { hmacKey: FIXED_TEST_HMAC_KEY, comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID, vectors: [null, FIXED_STARTUP_VECTORS[1], FIXED_STARTUP_VECTORS[2]] },
    {
      hmacKey: FIXED_TEST_HMAC_KEY,
      comparisonReferenceId: FIXED_COMPARISON_REFERENCE_ID,
      vectors: [
        { ...FIXED_STARTUP_VECTORS[0], expectedFrameHex: 42 },
        FIXED_STARTUP_VECTORS[1],
        FIXED_STARTUP_VECTORS[2],
      ],
    },
  ];

  for (const config of malformed) {
    expect(() =>
      verifyStartupVectorsAndCreateComparisonCapability(config),
    ).toThrow(ComparisonCompatibilityError);
  }
});
