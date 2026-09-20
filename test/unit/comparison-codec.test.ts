import {
  ComparisonInputError,
  assertExternalEventId,
  assertExternalSubjectId,
  assertProvider,
  assertRecognitionQrToken,
  encodeComparisonFrame,
} from '../../src/access/application/comparison/index.js';

test('fixed JSON v2 frames preserve exact values and UTF-8 byte lengths', () => {
  expect(
    encodeComparisonFrame({ kind: 'QR_SCANNED', token: 'A' }).toString(),
  ).toBe('["PassHub/idem/v2","QR_SCANNED",[1,"A"]]');
  expect(
    encodeComparisonFrame({
      kind: 'FACE_MATCHED',
      provider: 'DemoFace',
      externalSubjectId: '中😀',
    }).toString(),
  ).toBe('["PassHub/idem/v2","FACE_MATCHED",[8,"DemoFace"],[7,"中😀"]]');
  expect(
    encodeComparisonFrame({ kind: 'FACE_UNKNOWN' }).toString(),
  ).toBe('["PassHub/idem/v2","FACE_UNKNOWN"]');
});

test('length framing and JSON escaping distinguish ambiguous raw strings', () => {
  const left = encodeComparisonFrame({
    kind: 'FACE_MATCHED',
    provider: 'ab',
    externalSubjectId: 'c',
  });
  const right = encodeComparisonFrame({
    kind: 'FACE_MATCHED',
    provider: 'a',
    externalSubjectId: 'bc',
  });
  expect(left).not.toEqual(right);

  expect(
    encodeComparisonFrame({
      kind: 'FACE_MATCHED',
      provider: 'DemoFace',
      externalSubjectId: ' "\\" ',
    }).toString(),
  ).toBe('["PassHub/idem/v2","FACE_MATCHED",[8,"DemoFace"],[5," \\"\\\\\\" "]]');
});

test('comparison input preserves whitespace and Unicode normalization form', () => {
  const spaced = encodeComparisonFrame({
    kind: 'FACE_MATCHED',
    provider: 'DemoFace',
    externalSubjectId: '   ',
  });
  expect(spaced.toString()).toMatch(/\[3,"   "\]/u);

  const composed = encodeComparisonFrame({
    kind: 'FACE_MATCHED',
    provider: 'DemoFace',
    externalSubjectId: 'é',
  });
  const decomposed = encodeComparisonFrame({
    kind: 'FACE_MATCHED',
    provider: 'DemoFace',
    externalSubjectId: 'é',
  });
  expect(composed).not.toEqual(decomposed);
});

test('QR, provider, and event ID validators enforce exact length and grammar', () => {
  expect(() => assertRecognitionQrToken('A'.repeat(128))).not.toThrow();
  expect(() => assertProvider(`A${'a'.repeat(63)}`)).not.toThrow();
  expect(() => assertExternalEventId(`A${'a'.repeat(127)}`)).not.toThrow();

  for (const action of [
    () => assertRecognitionQrToken(''),
    () => assertRecognitionQrToken('A'.repeat(129)),
    () => assertRecognitionQrToken('a.b'),
    () => assertProvider('1provider'),
    () => assertProvider(`A${'a'.repeat(64)}`),
    () => assertExternalEventId('-bad'),
    () => assertExternalEventId(`A${'a'.repeat(128)}`),
  ]) {
    expect(action).toThrow(ComparisonInputError);
  }
});

test('subject validator counts UTF-8 bytes and rejects unsafe Unicode only', () => {
  expect(() => assertExternalSubjectId('a'.repeat(256))).not.toThrow();
  expect(() => assertExternalSubjectId('😀'.repeat(64))).not.toThrow();
  expect(() => assertExternalSubjectId('\u00a0')).not.toThrow();

  for (const value of [
    '',
    'a'.repeat(257),
    '😀'.repeat(65),
    '\u0000',
    '\u0009',
    '\u001f',
    '\u007f',
    '\u0085',
    '\u2028',
    '\u2029',
    '\ud800',
    '\udc00',
  ]) {
    expect(() => assertExternalSubjectId(value)).toThrow(ComparisonInputError);
  }
});

test('runtime non-string fields and null or unknown kinds fail closed', () => {
  const malformedInputs: unknown[] = [
    null,
    { kind: 'NOT_A_KIND' },
    { kind: null },
    { kind: 'QR_SCANNED', token: 42 },
    { kind: 'FACE_MATCHED', provider: 42, externalSubjectId: 'subject' },
    { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: null },
  ];

  for (const input of malformedInputs) {
    expect(() => encodeComparisonFrame(input as Parameters<typeof encodeComparisonFrame>[0])).toThrow(
      ComparisonInputError,
    );
  }
});
