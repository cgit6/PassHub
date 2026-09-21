import {
  STRICT_JSON_ERROR_CODES,
  StrictJsonObjectError,
  parseStrictJsonObject,
} from '../../src/shared/internal/http/strict-json-object.js';

const encode = (value: string): Uint8Array => Buffer.from(value, 'utf8');

function expectInvalid(bytes: Uint8Array): void {
  try {
    parseStrictJsonObject(bytes);
    throw new Error('expected strict JSON rejection');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(StrictJsonObjectError);
    expect(error).toMatchObject({
      name: 'StrictJsonObjectError',
      code: 'INVALID_JSON_BODY',
      message: 'JSON request body is invalid',
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  }
}

describe('G07a strict JSON object parser', () => {
  test('publishes one frozen, finite, redacted parser error code', () => {
    expect(STRICT_JSON_ERROR_CODES).toEqual(['INVALID_JSON_BODY']);
    expect(Object.isFrozen(STRICT_JSON_ERROR_CODES)).toBe(true);
  });

  test('accepts strict UTF-8 scalars and freezes both permitted object layers', () => {
    const parsed = parseStrictJsonObject(encode(
      '{"displayName":"訪客🙂","active":true,"count":12.5e1,"empty":null,"face":{"provider":"原值"}}',
    ));

    expect(parsed).toEqual({
      displayName: '訪客🙂',
      active: true,
      count: 125,
      empty: null,
      face: { provider: '原值' },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.face)).toBe(true);
  });

  test.each([
    ['invalid continuation', Uint8Array.of(0xc3, 0x28)],
    ['overlong encoding', Uint8Array.of(0xc0, 0xaf)],
    ['UTF-8 encoded surrogate', Uint8Array.of(0xed, 0xa0, 0x80)],
    ['truncated four-byte sequence', Uint8Array.of(0xf0, 0x9f, 0x92)],
  ])('rejects fatal UTF-8: %s', (_label, bytes) => {
    expectInvalid(bytes);
  });

  test('rejects a leading UTF-8 BOM instead of silently stripping it', () => {
    expectInvalid(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encode('{}')]));
  });

  test('accepts braces, brackets and escaped quotes inside strings without counting them', () => {
    expect(parseStrictJsonObject(encode('{"text":"{[}]\\\"","nested":{"text":"[{}]"}}')))
      .toEqual({ text: '{[}]"', nested: { text: '[{}]' } });
  });

  test('accepts exactly a root object plus one nested object layer', () => {
    expect(parseStrictJsonObject(encode('{"outer":{"inner":1}}')))
      .toEqual({ outer: { inner: 1 } });
  });

  test('rejects a third object layer before accepting the input', () => {
    expectInvalid(encode('{"outer":{"inner":{"tooDeep":true}}}'));
  });

  test.each([
    ['root array', '[]'],
    ['property array', '{"items":[]}'],
    ['deep array', '{"outer":{"items":[1]}}'],
  ])('rejects every JSON array position: %s', (_label, json) => {
    expectInvalid(encode(json));
  });

  test.each([
    ['string root', '"object"'],
    ['number root', '1'],
    ['boolean root', 'true'],
    ['null root', 'null'],
  ])('requires an object root: %s', (_label, json) => {
    expectInvalid(encode(json));
  });

  test.each([
    ['empty input', ''],
    ['trailing comma', '{"a":1,}'],
    ['single quoted key', "{'a':1}"],
    ['comment', '{"a":/* no */1}'],
    ['leading-zero number', '{"a":01}'],
    ['non-JSON number', '{"a":NaN}'],
    ['missing comma', '{"a":1 "b":2}'],
    ['trailing token', '{"a":1}false'],
    ['bad escape', '{"a":"\\x20"}'],
    ['unclosed object', '{"a":1'],
  ])('leaves complete grammar rejection to native JSON semantics: %s', (_label, json) => {
    expectInvalid(encode(json));
  });

  test('rejects an exact duplicate key in the root scope', () => {
    expectInvalid(encode('{"externalEventId":"one","externalEventId":"two"}'));
  });

  test('rejects cooked-equivalent escaped duplicate keys in the root scope', () => {
    expectInvalid(encode('{"kind":"one","k\\u0069nd":"two"}'));
  });

  test('rejects cooked-equivalent duplicates in a nested scope', () => {
    expectInvalid(encode('{"face":{"provider":"one","pro\\u0076ider":"two"}}'));
  });

  test('tracks duplicate keys independently per object scope', () => {
    expect(parseStrictJsonObject(encode('{"name":"root","child":{"name":"nested"}}')))
      .toEqual({ name: 'root', child: { name: 'nested' } });
    expect(parseStrictJsonObject(encode('{"left":{"name":"a"},"right":{"name":"b"}}')))
      .toEqual({ left: { name: 'a' }, right: { name: 'b' } });
  });

  test('retains an own __proto__ JSON key without changing the object prototype', () => {
    const parsed = parseStrictJsonObject(encode('{"__proto__":"literal"}'));
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(parsed.__proto__).toBe('literal');
  });
});
