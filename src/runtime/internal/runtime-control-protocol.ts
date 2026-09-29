import { types as nodeTypes } from 'node:util';
import {
  assertRuntimeControl,
  RuntimeControlError,
  type RuntimeControl,
  type RuntimeControlResult,
  type RuntimeControlSnapshot,
} from './runtime-control.js';

/**
 * This is deliberately a transport-free protocol core.  The Unix-socket
 * adapter owns byte decoding, connection limits, deadlines, and writing.  It
 * passes its completed-frame findings here as data so this module can make the
 * contractual no-response versus INVALID_REQUEST distinction without gaining
 * a net/fs dependency.
 */
export interface RuntimeControlProtocolFrame {
  readonly text: string;
  readonly utf8Valid: boolean;
  readonly hasBom: boolean;
  readonly singleFinalLf: boolean;
  readonly byteLength: number;
}

export type RuntimeControlProtocolCommand = 'STATUS' | 'HOLD' | 'RELEASE' | 'DRAIN';
export type RuntimeControlProtocolOutcome = 'STATUS' | 'HELD' | 'RELEASED' | 'DRAINED' | 'NOT_DRAINED';
export type RuntimeControlProtocolErrorCode =
  | 'INVALID_REQUEST' | 'STALE_EPOCH' | 'STALE_RUN' | 'STALE_REVISION' | 'REQUEST_CONTROL_CONFLICT'
  | 'CONTROL_BUSY' | 'MANUAL_HOLD_EXISTS' | 'NO_MANUAL_HOLD' | 'CONTROL_ID_MISMATCH'
  | 'MAINTENANCE_HOLD_EXISTS' | 'INTERNAL_UNAVAILABLE';

export interface RuntimeControlProtocolSuccess {
  readonly v: 'c1';
  readonly requestControlId: string;
  readonly ok: true;
  readonly command: RuntimeControlProtocolCommand;
  readonly outcome: RuntimeControlProtocolOutcome;
  readonly revision: string;
  readonly controlId: string | null;
  readonly snapshot: RuntimeControlSnapshot | null;
  readonly records: null;
  readonly truncated: null;
}
export interface RuntimeControlProtocolError {
  readonly v: 'c1';
  readonly requestControlId: string | null;
  readonly ok: false;
  readonly code: RuntimeControlProtocolErrorCode;
}
export type RuntimeControlProtocolResponse = RuntimeControlProtocolSuccess | RuntimeControlProtocolError;

/**
 * Private transport context.  The protocol keeps its direct, deterministic
 * API for unit callers; the AF_UNIX composition alone supplies a signal when
 * its processing watchdog expires.
 */
export interface RuntimeControlProtocolDispatchOptions {
  readonly signal?: AbortSignal;
  readonly abortOutcome?: 'INTERNAL_UNAVAILABLE';
}

/**
 * The only non-response produced by the synchronous control boundary.
 *
 * It is intentionally data-only.  In particular, it contains neither a
 * callback nor a Promise: the socket service may use it solely to install
 * DRAIN's cancellable observation watchdog before it invokes the async
 * dispatch path.  STATUS, HOLD, and RELEASE never cross that path.
 */
export interface RuntimeControlProtocolDrainPending {
  readonly kind: 'DRAIN_PENDING';
  readonly timeoutMs: number;
}

export type RuntimeControlProtocolSynchronousDispatch =
  | RuntimeControlProtocolResponse
  | RuntimeControlProtocolDrainPending
  | undefined;

const frameKeys = ['text', 'utf8Valid', 'hasBom', 'singleFinalLf', 'byteLength'] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revisionPattern = /^(?:0|[1-9][0-9]*)$/;
const controlErrorCodes = new Set<RuntimeControlProtocolErrorCode>([
  'INVALID_REQUEST', 'STALE_EPOCH', 'STALE_RUN', 'STALE_REVISION', 'REQUEST_CONTROL_CONFLICT',
  'CONTROL_BUSY', 'MANUAL_HOLD_EXISTS', 'NO_MANUAL_HOLD', 'CONTROL_ID_MISMATCH',
  'MAINTENANCE_HOLD_EXISTS', 'INTERNAL_UNAVAILABLE',
]);

/**
 * Returns undefined only for transport/framing violations, for which D184
 * mandates destroy-without-response.  Every complete valid frame receives an
 * exact success/error envelope.
 */
export async function dispatchRuntimeControlProtocol(
  control: RuntimeControl,
  frame: RuntimeControlProtocolFrame,
  options?: RuntimeControlProtocolDispatchOptions,
): Promise<RuntimeControlProtocolResponse | undefined> {
  assertRuntimeControl(control);
  const prepared = prepareDispatch(frame);
  if (prepared.kind === 'NO_RESPONSE') return undefined;
  if (prepared.kind === 'ERROR') return prepared.response;

  const requestControlId = prepared.requestControlId;
  try {
    const { request } = prepared;
    switch (request.command) {
      case 'STATUS':
      case 'HOLD':
      case 'RELEASE':
        return dispatchSynchronousRequest(control, request, requestControlId);
      case 'DRAIN': {
        const result = await control.drain(toControlMutation(request, options));
        return resultEnvelope(request, result);
      }
    }
  } catch (error) {
    if (error instanceof RuntimeControlError && controlErrorCodes.has(error.code)) {
      return errorEnvelope(requestControlId, error.code);
    }
    if (error instanceof ProtocolInvalidRequest) return errorEnvelope(requestControlId, 'INVALID_REQUEST');
    return errorEnvelope(requestControlId, 'INTERNAL_UNAVAILABLE');
  }
}

/**
 * Executes the three D186 synchronous critical-section commands without
 * accepting a transport context, callback, signal, or Promise.  A valid
 * DRAIN is deliberately returned as data instead; only the service may turn
 * that marker into the separately cancellable asynchronous observation.
 */
export function dispatchRuntimeControlProtocolSynchronously(
  control: RuntimeControl,
  frame: RuntimeControlProtocolFrame,
): RuntimeControlProtocolSynchronousDispatch {
  assertRuntimeControl(control);
  const prepared = prepareDispatch(frame);
  if (prepared.kind === 'NO_RESPONSE') return undefined;
  if (prepared.kind === 'ERROR') return prepared.response;
  if (prepared.request.command === 'DRAIN') {
    return Object.freeze({ kind: 'DRAIN_PENDING' as const, timeoutMs: prepared.request.timeoutMs });
  }
  return dispatchSynchronousRequest(control, prepared.request, prepared.requestControlId);
}

type PreparedDispatch =
  | Readonly<{ readonly kind: 'NO_RESPONSE' }>
  | Readonly<{ readonly kind: 'ERROR'; readonly response: RuntimeControlProtocolError }>
  | Readonly<{ readonly kind: 'REQUEST'; readonly request: CapturedRequest; readonly requestControlId: string | null }>;

function prepareDispatch(frame: RuntimeControlProtocolFrame): PreparedDispatch {
  const capturedFrame = captureFrame(frame);
  if (capturedFrame === undefined) return Object.freeze({ kind: 'NO_RESPONSE' as const });
  let parsed: unknown;
  try {
    // This scanner runs before JSON.parse by contract.  It compares decoded
    // property names, so {"a":1,"\\u0061":2} is also a duplicate.
    if (hasArbitraryDepthDuplicateKey(capturedFrame.text.slice(0, -1))) throw new ProtocolInvalidRequest();
    parsed = JSON.parse(capturedFrame.text);
  } catch {
    return Object.freeze({ kind: 'ERROR' as const, response: errorEnvelope(null, 'INVALID_REQUEST') });
  }
  const requestControlId = extractCanonicalRequestControlId(parsed);
  try {
    return Object.freeze({ kind: 'REQUEST' as const, request: captureRequest(parsed), requestControlId });
  } catch (error) {
    if (error instanceof ProtocolInvalidRequest) {
      return Object.freeze({ kind: 'ERROR' as const, response: errorEnvelope(requestControlId, 'INVALID_REQUEST') });
    }
    return Object.freeze({ kind: 'ERROR' as const, response: errorEnvelope(requestControlId, 'INTERNAL_UNAVAILABLE') });
  }
}

function dispatchSynchronousRequest(
  control: RuntimeControl,
  request: CapturedStatus | CapturedHold | CapturedRelease,
  requestControlId: string | null,
): RuntimeControlProtocolResponse {
  try {
    switch (request.command) {
      case 'STATUS': {
        // Capture once.  A STATUS response is a single immutable view, rather
        // than three independently sampled views of mutable runtime state.
        const snapshot = control.snapshot();
        assertEpochRun(request, snapshot);
        return successEnvelope(request, 'STATUS', snapshot.revision, null, snapshot);
      }
      case 'HOLD':
        return resultEnvelope(request, control.hold(toControlMutation(request)));
      case 'RELEASE':
        return resultEnvelope(request, control.release(toControlMutation(request)));
    }
  } catch (error) {
    if (error instanceof RuntimeControlError && controlErrorCodes.has(error.code)) {
      return errorEnvelope(requestControlId, error.code);
    }
    if (error instanceof ProtocolInvalidRequest) return errorEnvelope(requestControlId, 'INVALID_REQUEST');
    return errorEnvelope(requestControlId, 'INTERNAL_UNAVAILABLE');
  }
}

interface CapturedBase {
  readonly v: 'c1';
  readonly requestControlId: string;
  readonly command: RuntimeControlProtocolCommand;
  readonly epoch: string;
  readonly run: string;
}
interface CapturedStatus extends CapturedBase { readonly command: 'STATUS'; }
interface CapturedHold extends CapturedBase { readonly command: 'HOLD'; readonly expectedRevision: string; }
interface CapturedRelease extends CapturedBase { readonly command: 'RELEASE'; readonly expectedRevision: string; readonly controlId: string; }
interface CapturedDrain extends CapturedBase { readonly command: 'DRAIN'; readonly expectedRevision: string; readonly timeoutMs: number; }
type CapturedRequest = CapturedStatus | CapturedHold | CapturedRelease | CapturedDrain;

class ProtocolInvalidRequest extends Error {}

function captureFrame(input: unknown): Readonly<RuntimeControlProtocolFrame> | undefined {
  try {
    const value = captureExactRecord(input, frameKeys);
    if (typeof value.text !== 'string' || typeof value.utf8Valid !== 'boolean' || typeof value.hasBom !== 'boolean'
      || typeof value.singleFinalLf !== 'boolean' || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
      return undefined;
    }
    if (!value.utf8Valid || value.hasBom || !value.singleFinalLf || value.byteLength > 4096
      || new TextEncoder().encode(value.text).byteLength !== value.byteLength
      || !value.text.endsWith('\n') || value.text.indexOf('\n') !== value.text.length - 1) return undefined;
    return Object.freeze({ text: value.text, utf8Valid: value.utf8Valid, hasBom: value.hasBom, singleFinalLf: value.singleFinalLf, byteLength: value.byteLength });
  } catch { return undefined; }
}

function captureRequest(input: unknown): CapturedRequest {
  const base = captureExactRecord(input, ['v', 'requestControlId', 'command', 'epoch', 'run'], [
    ['v', 'requestControlId', 'command', 'epoch', 'run'],
    ['v', 'requestControlId', 'command', 'epoch', 'run', 'expectedRevision'],
    ['v', 'requestControlId', 'command', 'epoch', 'run', 'expectedRevision', 'controlId'],
    ['v', 'requestControlId', 'command', 'epoch', 'run', 'expectedRevision', 'timeoutMs'],
  ]);
  if (base.v !== 'c1' || !isUuid(base.requestControlId) || !isUuid(base.epoch) || !isUuid(base.run) || typeof base.command !== 'string') throw new ProtocolInvalidRequest();
  const common = Object.freeze({ v: 'c1' as const, requestControlId: base.requestControlId, epoch: base.epoch, run: base.run });
  if (base.command === 'STATUS') {
    requireKeySet(base, ['v', 'requestControlId', 'command', 'epoch', 'run']);
    return Object.freeze({ ...common, command: 'STATUS' as const });
  }
  if (base.command === 'HOLD') {
    requireKeySet(base, ['v', 'requestControlId', 'command', 'epoch', 'run', 'expectedRevision']);
    if (!isRevision(base.expectedRevision)) throw new ProtocolInvalidRequest();
    return Object.freeze({ ...common, command: 'HOLD' as const, expectedRevision: base.expectedRevision });
  }
  if (base.command === 'RELEASE') {
    requireKeySet(base, ['v', 'requestControlId', 'command', 'epoch', 'run', 'expectedRevision', 'controlId']);
    if (!isRevision(base.expectedRevision) || !isUuid(base.controlId)) throw new ProtocolInvalidRequest();
    return Object.freeze({ ...common, command: 'RELEASE' as const, expectedRevision: base.expectedRevision, controlId: base.controlId });
  }
  if (base.command === 'DRAIN') {
    requireKeySet(base, ['v', 'requestControlId', 'command', 'epoch', 'run', 'expectedRevision', 'timeoutMs']);
    if (!isRevision(base.expectedRevision) || !Number.isSafeInteger(base.timeoutMs) || base.timeoutMs < 1 || base.timeoutMs > 30_000) throw new ProtocolInvalidRequest();
    return Object.freeze({ ...common, command: 'DRAIN' as const, expectedRevision: base.expectedRevision, timeoutMs: base.timeoutMs });
  }
  throw new ProtocolInvalidRequest();
}

function assertEpochRun(request: CapturedBase, snapshot: RuntimeControlSnapshot): void {
  if (request.epoch !== snapshot.epoch) throw new RuntimeControlError('STALE_EPOCH');
  if (request.run !== snapshot.run) throw new RuntimeControlError('STALE_RUN');
}

function toControlMutation(request: CapturedHold): { readonly requestControlId: string; readonly epoch: string; readonly run: string; readonly expectedRevision: string };
function toControlMutation(request: CapturedRelease): { readonly requestControlId: string; readonly epoch: string; readonly run: string; readonly expectedRevision: string; readonly controlId: string };
function toControlMutation(request: CapturedDrain, options?: RuntimeControlProtocolDispatchOptions): { readonly requestControlId: string; readonly epoch: string; readonly run: string; readonly expectedRevision: string; readonly timeoutMs: number; readonly signal?: AbortSignal; readonly abortOutcome?: 'INTERNAL_UNAVAILABLE' };
function toControlMutation(request: CapturedHold | CapturedRelease | CapturedDrain, options?: RuntimeControlProtocolDispatchOptions): object {
  const base = { requestControlId: request.requestControlId, epoch: request.epoch, run: request.run, expectedRevision: request.expectedRevision };
  if (request.command === 'RELEASE') return Object.freeze({ ...base, controlId: request.controlId });
  if (request.command === 'DRAIN') return Object.freeze({
    ...base,
    timeoutMs: request.timeoutMs,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.abortOutcome === undefined ? {} : { abortOutcome: options.abortOutcome }),
  });
  return Object.freeze(base);
}

function resultEnvelope(request: CapturedHold | CapturedRelease | CapturedDrain, result: RuntimeControlResult): RuntimeControlProtocolSuccess {
  const outcome = result.outcome === 'HELD' || result.outcome === 'RELEASED' || result.outcome === 'DRAINED' || result.outcome === 'NOT_DRAINED'
    ? result.outcome : undefined;
  if (outcome === undefined) throw new Error('runtime control returned an unencodable result');
  return successEnvelope(request, outcome, result.revision, result.controlId, result.snapshot);
}

function successEnvelope(
  request: CapturedRequest,
  outcome: RuntimeControlProtocolOutcome,
  revision: string,
  controlId: string | null,
  snapshot: RuntimeControlSnapshot,
): RuntimeControlProtocolSuccess {
  if (!isRevision(revision) || (controlId !== null && !isUuid(controlId))) throw new Error('runtime control result is invalid');
  return Object.freeze({
    v: 'c1', requestControlId: request.requestControlId, ok: true, command: request.command, outcome,
    revision, controlId, snapshot, records: null, truncated: null,
  });
}

function errorEnvelope(requestControlId: string | null, code: RuntimeControlProtocolErrorCode): RuntimeControlProtocolError {
  return Object.freeze({ v: 'c1', requestControlId, ok: false, code });
}

function extractCanonicalRequestControlId(value: unknown): string | null {
  // Only preserve an ID after the duplicate scan and full JSON parse have made
  // the root unambiguous.  DTO-invalid but structurally safe requests retain
  // it, exactly as the error-envelope contract requires.
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'requestControlId');
  return descriptor !== undefined && 'value' in descriptor && isUuid(descriptor.value) ? descriptor.value : null;
}

function captureExactRecord(input: unknown, required: readonly string[], allowedSets?: readonly (readonly string[])[]): Record<string, any> {
  if (nodeTypes.isProxy(input) || typeof input !== 'object' || input === null || Object.getPrototypeOf(input) !== Object.prototype) throw new ProtocolInvalidRequest();
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string') || keys.length < required.length || required.some((key) => !keys.includes(key))) throw new ProtocolInvalidRequest();
  if (allowedSets !== undefined && !allowedSets.some((set) => set.length === keys.length && set.every((key) => keys.includes(key)))) throw new ProtocolInvalidRequest();
  const values: Record<string, any> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new ProtocolInvalidRequest();
    values[key as string] = descriptor.value;
  }
  return values;
}
function requireKeySet(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) throw new ProtocolInvalidRequest();
}
function isUuid(value: unknown): value is string { return typeof value === 'string' && uuidPattern.test(value); }
function isRevision(value: unknown): value is string { return typeof value === 'string' && revisionPattern.test(value); }

/** Iterative JSON scanner for duplicate decoded object keys, before JSON.parse. */
function hasArbitraryDepthDuplicateKey(text: string): boolean {
  type Frame = { readonly kind: 'OBJECT' | 'ARRAY'; state: 'KEY_OR_END' | 'COLON' | 'VALUE' | 'COMMA_OR_END' | 'VALUE_OR_END'; readonly keys?: Set<string> };
  const frames: Frame[] = [];
  let index = 0;
  let rootSeen = false;
  const skipSpace = (): void => { while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index]!)) index += 1; };
  const parseString = (): string | null => {
    if (text[index] !== '"') return null;
    index += 1;
    let decoded = '';
    while (index < text.length) {
      const char = text[index++]!;
      if (char === '"') return decoded;
      if (char === '\\') {
        const escape = text[index++]!;
        if (escape === '"' || escape === '\\' || escape === '/') decoded += escape;
        else if (escape === 'b') decoded += '\b'; else if (escape === 'f') decoded += '\f'; else if (escape === 'n') decoded += '\n'; else if (escape === 'r') decoded += '\r'; else if (escape === 't') decoded += '\t';
        else if (escape === 'u') {
          const code = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(code)) return null;
          decoded += String.fromCharCode(Number.parseInt(code, 16)); index += 4;
        } else return null;
      } else {
        if (char < ' ') return null;
        decoded += char;
      }
    }
    return null;
  };
  const consumeAtom = (): boolean => {
    const start = index;
    while (index < text.length && !/[\u0009\u000a\u000d\u0020,\]\}]/u.test(text[index]!)) index += 1;
    return index > start;
  };
  const valueComplete = (): void => {
    if (frames.length === 0) { rootSeen = true; return; }
    frames[frames.length - 1]!.state = 'COMMA_OR_END';
  };
  while (true) {
    skipSpace();
    const frame = frames[frames.length - 1];
    if (frame === undefined) {
      if (rootSeen) { skipSpace(); return false; }
      if (index >= text.length) return false;
      const char = text[index]!;
      if (char === '{') { index += 1; frames.push({ kind: 'OBJECT', state: 'KEY_OR_END', keys: new Set() }); continue; }
      if (char === '[') { index += 1; frames.push({ kind: 'ARRAY', state: 'VALUE_OR_END' }); continue; }
      if (char === '"') { if (parseString() === null) return false; valueComplete(); continue; }
      if (!consumeAtom()) return false; valueComplete(); continue;
    }
    if (frame.kind === 'OBJECT' && frame.state === 'KEY_OR_END') {
      if (text[index] === '}') { index += 1; frames.pop(); valueComplete(); continue; }
      const key = parseString(); if (key === null) return false;
      if (frame.keys!.has(key)) return true;
      frame.keys!.add(key); frame.state = 'COLON'; continue;
    }
    if (frame.kind === 'OBJECT' && frame.state === 'COLON') { if (text[index] !== ':') return false; index += 1; frame.state = 'VALUE'; continue; }
    if (frame.state === 'COMMA_OR_END') {
      const close = frame.kind === 'OBJECT' ? '}' : ']';
      if (text[index] === close) { index += 1; frames.pop(); valueComplete(); continue; }
      if (text[index] !== ',') return false;
      index += 1; frame.state = frame.kind === 'OBJECT' ? 'KEY_OR_END' : 'VALUE_OR_END'; continue;
    }
    if (frame.kind === 'ARRAY' && frame.state === 'VALUE_OR_END' && text[index] === ']') { index += 1; frames.pop(); valueComplete(); continue; }
    // Both OBJECT/VALUE and ARRAY/VALUE_OR_END parse a value.
    const char = text[index];
    if (char === '{') { index += 1; frames.push({ kind: 'OBJECT', state: 'KEY_OR_END', keys: new Set() }); continue; }
    if (char === '[') { index += 1; frames.push({ kind: 'ARRAY', state: 'VALUE_OR_END' }); continue; }
    if (char === '"') { if (parseString() === null) return false; valueComplete(); continue; }
    if (!consumeAtom()) return false;
    valueComplete();
  }
}
