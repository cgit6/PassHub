import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

const TICKET_VERSION = 'g11b.run-ticket.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ParsedRunTicket {
  readonly v: typeof TICKET_VERSION;
  readonly ticketId: string;
  readonly datasetEpoch: string;
  readonly processRunId: string;
}

export class RunTicketWireError extends Error {
  constructor(readonly bindingMismatch = false) {
    super(bindingMismatch ? 'PROCESS_BINDING_MISMATCH' : 'TICKET_INVALID');
    this.name = 'RunTicketWireError';
  }
}

export function isCanonicalUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}

/** Parses ordinary JSON formatting while rejecting duplicate decoded keys. */
export function parseRunTicketWire(bytes: Buffer, expectedProcessRunId: string): ParsedRunTicket {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new RunTicketWireError();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new RunTicketWireError();
  }
  if (text.startsWith('\ufeff') || !text.endsWith('\n')
    || text.indexOf('\n') !== text.length - 1 || text.includes('\r')) {
    throw new RunTicketWireError();
  }
  const json = text.slice(0, -1);
  try {
    new DuplicateKeyJsonScanner(json).scan();
  } catch {
    throw new RunTicketWireError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new RunTicketWireError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new RunTicketWireError();
  const value = parsed as Record<string, unknown>;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = ['datasetEpoch', 'processRunId', 'ticketId', 'v'];
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || value.v !== TICKET_VERSION
    || typeof value.ticketId !== 'string'
    || typeof value.datasetEpoch !== 'string'
    || typeof value.processRunId !== 'string'
    || !UUID_V4.test(value.ticketId)
    || !UUID_V4.test(value.datasetEpoch)
    || !UUID_V4.test(value.processRunId)) {
    throw new RunTicketWireError();
  }
  if (value.processRunId !== expectedProcessRunId) throw new RunTicketWireError(true);
  return Object.freeze({
    v: TICKET_VERSION,
    ticketId: value.ticketId,
    datasetEpoch: value.datasetEpoch,
    processRunId: value.processRunId,
  });
}

class DuplicateKeyJsonScanner {
  #offset = 0;

  constructor(private readonly input: string) {}

  scan(): void {
    this.#whitespace();
    this.#value();
    this.#whitespace();
    if (this.#offset !== this.input.length) throw new Error('trailing JSON input');
  }

  #value(): void {
    const current = this.input[this.#offset];
    if (current === '{') return this.#object();
    if (current === '[') return this.#array();
    if (current === '"') { this.#string(); return; }
    if (current === 't') return this.#literal('true');
    if (current === 'f') return this.#literal('false');
    if (current === 'n') return this.#literal('null');
    this.#number();
  }

  #object(): void {
    this.#offset += 1;
    this.#whitespace();
    if (this.input[this.#offset] === '}') { this.#offset += 1; return; }
    const keys = new Set<string>();
    for (;;) {
      if (this.input[this.#offset] !== '"') throw new Error('object key');
      const key = this.#string();
      if (keys.has(key)) throw new Error('duplicate object key');
      keys.add(key);
      this.#whitespace();
      if (this.input[this.#offset] !== ':') throw new Error('object colon');
      this.#offset += 1;
      this.#whitespace();
      this.#value();
      this.#whitespace();
      if (this.input[this.#offset] === '}') { this.#offset += 1; return; }
      if (this.input[this.#offset] !== ',') throw new Error('object delimiter');
      this.#offset += 1;
      this.#whitespace();
    }
  }

  #array(): void {
    this.#offset += 1;
    this.#whitespace();
    if (this.input[this.#offset] === ']') { this.#offset += 1; return; }
    for (;;) {
      this.#value();
      this.#whitespace();
      if (this.input[this.#offset] === ']') { this.#offset += 1; return; }
      if (this.input[this.#offset] !== ',') throw new Error('array delimiter');
      this.#offset += 1;
      this.#whitespace();
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    for (;;) {
      const character = this.input[this.#offset];
      if (character === undefined || character.charCodeAt(0) < 0x20) throw new Error('JSON string');
      if (character === '"') {
        this.#offset += 1;
        return JSON.parse(this.input.slice(start, this.#offset)) as string;
      }
      if (character === '\\') { this.#offset += 2; continue; }
      this.#offset += 1;
    }
  }

  #literal(literal: string): void {
    if (!this.input.startsWith(literal, this.#offset)) throw new Error('JSON literal');
    this.#offset += literal.length;
  }

  #number(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.input.slice(this.#offset));
    if (match === null) throw new Error('JSON value');
    this.#offset += match[0].length;
  }

  #whitespace(): void {
    while (this.input[this.#offset] === ' ' || this.input[this.#offset] === '\t'
      || this.input[this.#offset] === '\r' || this.input[this.#offset] === '\n') this.#offset += 1;
  }
}
