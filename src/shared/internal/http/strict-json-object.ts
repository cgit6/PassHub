import { TextDecoder } from 'node:util';

export type StrictJsonScalar = string | number | boolean | null;
export interface StrictJsonObject {
  readonly [key: string]: StrictJsonScalar | StrictJsonObject;
}

export const STRICT_JSON_ERROR_CODES = Object.freeze([
  'INVALID_JSON_BODY',
] as const);

export type StrictJsonErrorCode = (typeof STRICT_JSON_ERROR_CODES)[number];

export class StrictJsonObjectError extends Error {
  public readonly code: StrictJsonErrorCode;

  public constructor() {
    super('JSON request body is invalid');
    this.name = 'StrictJsonObjectError';
    this.code = 'INVALID_JSON_BODY';
  }
}

const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const decoder = new TextDecoder('utf-8', {
  fatal: true,
  // WHATWG semantics: true leaves a leading BOM in the decoded text so it can
  // be rejected explicitly rather than silently stripped.
  ignoreBOM: true,
});

function invalidJson(): never {
  throw new StrictJsonObjectError();
}

function assertRuntimeDecoder(): void {
  try {
    decoder.decode(Uint8Array.of(0xc3, 0x28));
  } catch {
    const bom = decoder.decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d));
    if (bom === '\uFEFF{}') return;
  }
  throw new Error('Required fatal UTF-8 decoder semantics are unavailable');
}

assertRuntimeDecoder();

/**
 * A deliberately small structural pre-filter. It is not a JSON parser: native
 * JSON.parse remains the grammar authority after the bounded depth/array check.
 */
function prefilterStructure(text: string): void {
  let index = 0;
  while (index < text.length && JSON_WHITESPACE.has(text[index] ?? '')) index += 1;
  if (text[index] !== '{') invalidJson();

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) invalidJson();
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[' || character === ']') invalidJson();
    if (character === '{') {
      depth += 1;
      if (depth > 2) invalidJson();
    } else if (character === '}') {
      depth -= 1;
      if (depth < 0) invalidJson();
    }
  }
  if (inString || escaped || depth !== 0) invalidJson();
}

function skipWhitespace(text: string, initial: number): number {
  let index = initial;
  while (index < text.length && JSON_WHITESPACE.has(text[index] ?? '')) index += 1;
  return index;
}

function scanStringEnd(text: string, start: number): number {
  if (text[start] !== '"') invalidJson();
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) invalidJson();
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return invalidJson();
}

function cookedKey(text: string, start: number, end: number): string {
  try {
    const value: unknown = JSON.parse(text.slice(start, end));
    if (typeof value !== 'string') invalidJson();
    return value;
  } catch (error: unknown) {
    if (error instanceof StrictJsonObjectError) throw error;
    return invalidJson();
  }
}

function scanPrimitiveEnd(text: string, start: number): number {
  if (text[start] === '"') return scanStringEnd(text, start);
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (character === ',' || character === '}') break;
    index += 1;
  }
  return skipWhitespace(text, index);
}

function rejectCookedDuplicateKeys(text: string): void {
  function scanObject(initial: number): number {
    let index = skipWhitespace(text, initial);
    if (text[index] !== '{') invalidJson();
    index = skipWhitespace(text, index + 1);
    const keys = new Set<string>();
    if (text[index] === '}') return index + 1;

    while (index < text.length) {
      const keyStart = index;
      const keyEnd = scanStringEnd(text, keyStart);
      const key = cookedKey(text, keyStart, keyEnd);
      if (keys.has(key)) invalidJson();
      keys.add(key);

      index = skipWhitespace(text, keyEnd);
      if (text[index] !== ':') invalidJson();
      index = skipWhitespace(text, index + 1);
      index = text[index] === '{'
        ? scanObject(index)
        : scanPrimitiveEnd(text, index);
      index = skipWhitespace(text, index);
      if (text[index] === '}') return index + 1;
      if (text[index] !== ',') invalidJson();
      index = skipWhitespace(text, index + 1);
    }
    return invalidJson();
  }

  const end = skipWhitespace(text, scanObject(0));
  if (end !== text.length) invalidJson();
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function freezeJsonObject(value: Record<string, unknown>): StrictJsonObject {
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (isPlainJsonObject(child)) {
      freezeJsonObject(child);
      continue;
    }
    if (child !== null
        && typeof child !== 'string'
        && typeof child !== 'number'
        && typeof child !== 'boolean') {
      invalidJson();
    }
  }
  return Object.freeze(value) as StrictJsonObject;
}

/** Decode and parse a root object with at most one nested object layer. */
export function parseStrictJsonObject(bytes: Uint8Array): StrictJsonObject {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return invalidJson();
  }
  if (text.startsWith('\uFEFF')) invalidJson();
  prefilterStructure(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidJson();
  }
  if (!isPlainJsonObject(parsed)) invalidJson();
  rejectCookedDuplicateKeys(text);
  return freezeJsonObject(parsed);
}
