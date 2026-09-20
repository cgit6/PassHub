import type { StartupComparisonVector } from '../../src/access/application/comparison/index.js';

// These answers were generated independently with shell byte tools and OpenSSL.
// Never derive them from the production codec during module initialization.
export const FIXED_TEST_HMAC_KEY = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);

export const FIXED_COMPARISON_REFERENCE_ID =
  '11111111-1111-4111-8111-111111111111';

export const FIXED_STARTUP_VECTORS: readonly StartupComparisonVector[] = [
  {
    input: { kind: 'QR_SCANNED', token: 'A' },
    expectedFrameHex:
      '5b22506173734875622f6964656d2f7632222c2251525f5343414e4e4544222c5b312c2241225d5d',
    expectedHmacHex:
      '1035cbfb48da122da36a14350fdd5e43942923570c45dcfb50007a4d1dba93ae',
  },
  {
    input: {
      kind: 'FACE_MATCHED',
      provider: 'DemoFace',
      externalSubjectId: '中😀',
    },
    expectedFrameHex:
      '5b22506173734875622f6964656d2f7632222c22464143455f4d415443484544222c5b382c2244656d6f46616365225d2c5b372c22e4b8adf09f9880225d5d',
    expectedHmacHex:
      'b414e2e7b0a1ea756132cd1038e6648dd065b05beb771d14caf72a8b3d560873',
  },
  {
    input: { kind: 'FACE_UNKNOWN' },
    expectedFrameHex:
      '5b22506173734875622f6964656d2f7632222c22464143455f554e4b4e4f574e225d',
    expectedHmacHex:
      '4c2c59f9a184f54901874d198ce64e0b225d3603cc53525437451048af08bb65',
  },
];
