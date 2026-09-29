import { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from 'node:process';
import { TextDecoder } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { validateRuntimeLogRecord } from './runtime-log-schema.js';

/**
 * Private AF_UNIX control client.  It is intentionally an executable module,
 * not a package export: the public API never acquires the maintenance plane.
 *
 * Usage (after build):
 *   node dist/src/runtime/internal/runtime-control-cli.js /absolute/runtime-control.sock < request.ndjson
 */

const MAX_REQUEST_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 256 * 1024;
const NORMAL_DEADLINE_MS = 8_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const revision = /^(?:0|[1-9][0-9]*)$/u;
const errorCodes = new Set([
  'INVALID_REQUEST', 'STALE_EPOCH', 'STALE_RUN', 'STALE_REVISION', 'REQUEST_CONTROL_CONFLICT',
  'CONTROL_BUSY', 'MANUAL_HOLD_EXISTS', 'NO_MANUAL_HOLD', 'CONTROL_ID_MISMATCH',
  'MAINTENANCE_HOLD_EXISTS', 'LOG_READ_UNAVAILABLE', 'INTERNAL_UNAVAILABLE',
]);

type CliDisposition =
  | Readonly<{ readonly exitCode: 0; readonly stdout: Buffer; readonly stderr: Buffer }>
  | Readonly<{ readonly exitCode: 2; readonly stdout: Buffer; readonly stderr: Buffer }>
  | Readonly<{ readonly exitCode: 3; readonly stdout: Buffer; readonly stderr: Buffer }>;

export interface RuntimeControlCliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

/** Runs one private request.  This is not exported by any public barrel. */
export async function runRuntimeControlCli(socketPath: string, io: RuntimeControlCliIo): Promise<number> {
  // The command's deadline begins when the CLI accepts its input stream, not
  // after stdin happens to reach EOF.  Otherwise a caller could keep stdin
  // open forever without ever contacting the private socket.
  const startedAt = performance.now();
  const input = await readOneRequest(io.stdin, startedAt);
  const disposition = input.kind === 'TIMED_OUT'
    ? timeoutFailure()
    : input.kind === 'INVALID'
      ? protocolFailure()
      : await exchange(socketPath, input.request, startedAt + requestDeadline(input.request));
  await writeAll(io.stdout, disposition.stdout);
  await writeAll(io.stderr, disposition.stderr);
  return disposition.exitCode;
}

type RequestReadResult =
  | Readonly<{ readonly kind: 'REQUEST'; readonly request: Buffer }>
  | Readonly<{ readonly kind: 'INVALID' }>
  | Readonly<{ readonly kind: 'TIMED_OUT' }>;

/**
 * The input protocol is EOF-delimited.  A complete, exact DRAIN candidate
 * earns its finite total budget as soon as its one NDJSON line is received;
 * EOF remains mandatory before it may be sent.  This matters for a slow
 * producer: the command budget begins at CLI start, not at EOF.  No partial
 * object, malformed candidate, or arbitrary open stdin can extend the normal
 * acquisition bound.
 */
function readOneRequest(input: Readable, startedAt: number): Promise<RequestReadResult> {
  const chunks: Buffer[] = [];
  let length = 0;
  return new Promise((resolve) => {
    let settled = false;
    let deadlineAt = startedAt + NORMAL_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout>;
    const armDeadline = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(Object.freeze({ kind: 'TIMED_OUT' as const }), true),
        Math.max(0, Math.ceil(deadlineAt - performance.now())),
      );
    };
    const finish = (result: RequestReadResult, destroyInput: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      if (destroyInput && !input.destroyed) input.destroy();
      resolve(result);
    };
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      let bytes: Buffer;
      try { bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); } catch {
        finish(Object.freeze({ kind: 'INVALID' as const }), true);
        return;
      }
      if (bytes.length > MAX_REQUEST_BYTES - length) {
        finish(Object.freeze({ kind: 'INVALID' as const }), true);
        return;
      }
      chunks.push(bytes);
      length += bytes.length;

      const candidate = Buffer.concat(chunks, length);
      const firstLf = candidate.indexOf(0x0a);
      if (firstLf !== -1) {
        // An EOF-delimited input can contain exactly one final LF.  Once a
        // candidate line exists, any byte after it is irrevocably invalid;
        // do not leave such a stream open until its deadline.
        if (firstLf !== candidate.length - 1) {
          finish(Object.freeze({ kind: 'INVALID' as const }), true);
          return;
        }
        const drainDeadline = exactDrainCandidateDeadline(candidate, startedAt);
        if (drainDeadline !== undefined && drainDeadline > deadlineAt) {
          deadlineAt = drainDeadline;
          armDeadline();
        }
      }
    };
    const onEnd = (): void => {
      const line = Buffer.concat(chunks, length);
      finish(isSingleUtf8Ndjson(line, MAX_REQUEST_BYTES)
        ? Object.freeze({ kind: 'REQUEST' as const, request: line })
        : Object.freeze({ kind: 'INVALID' as const }), false);
    };
    const onError = (): void => finish(Object.freeze({ kind: 'INVALID' as const }), false);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    armDeadline();
    input.resume();
  });
}

/**
 * Return the absolute DRAIN deadline only for an already complete, strict,
 * one-line DTO.  It deliberately repeats the input validation boundary here:
 * a syntactically plausible prefix must never buy more time before EOF.
 */
function exactDrainCandidateDeadline(line: Buffer, startedAt: number): number | undefined {
  if (!isSingleUtf8Ndjson(line, MAX_REQUEST_BYTES)) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line);
    const body = text.slice(0, -1);
    if (hasArbitraryDepthDuplicateKey(body)) return undefined;
    const parsed: unknown = JSON.parse(body);
    if (!isCompleteDrainRequest(parsed)) return undefined;
    return startedAt + parsed.timeoutMs + 7_000;
  } catch { return undefined; }
}

function isSingleUtf8Ndjson(line: Buffer, maximumBytes: number): boolean {
  if (line.length === 0 || line.length > maximumBytes || line[line.length - 1] !== 0x0a
    || line.indexOf(0x0a) !== line.length - 1) return false;
  if (line.length >= 3 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) return false;
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line);
    return true;
  } catch { return false; }
}

async function exchange(socketPath: string, request: Buffer, deadlineAt: number): Promise<CliDisposition> {
  // A syntactically complete request may still be DTO-invalid; D184 leaves
  // that classification to the server.  We can nevertheless derive the one
  // response correlation value that a server is permitted to echo.  This is
  // deliberately the same conservative rule as the protocol boundary: a
  // duplicate key makes the whole object ambiguous, so it has no ID.
  const expectedRequestControlId = deriveExpectedRequestControlId(request);
  const beforePreflightMs = Math.ceil(deadlineAt - performance.now());
  if (beforePreflightMs <= 0) return timeoutFailure();
  const privateSocket = await beforeDeadline(isSameUserPrivateSocket(socketPath), beforePreflightMs);
  if (privateSocket === 'TIMED_OUT') return timeoutFailure();
  if (!privateSocket) return connectFailed();
  const remainingMs = Math.ceil(deadlineAt - performance.now());
  if (remainingMs <= 0) return timeoutFailure();
  return new Promise<CliDisposition>((resolve) => {
    let socket: Socket;
    try { socket = createConnection(socketPath); } catch { resolve(connectFailed()); return; }
    const received: Buffer[] = [];
    let length = 0;
    let connected = false;
    let finished = false;
    let deadlineElapsed = false;
    const finish = (result: CliDisposition): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const terminal = (receivedEof: boolean): void => {
      const response = Buffer.concat(received, length);
      const complete = classifyCompleteResponse(response, expectedRequestControlId);
      // A valid envelope becomes a response only after the peer's EOF.  A
      // server that writes a syntactically valid prefix then dies has not
      // completed the one-response protocol and must be reported as partial.
      if (receivedEof && complete !== undefined) { finish(complete); return; }
      // A fully framed malformed candidate has protocol priority even when
      // the terminal event was an error rather than clean EOF.
      if (!receivedEof && complete !== undefined && complete.exitCode === 3
        && complete.stderr.equals(Buffer.from('CONTROL_PROTOCOL_ERROR\n', 'utf8'))) {
        finish(complete);
        return;
      }
      if (response.length > 0) { finish(partialFailure()); return; }
      if (deadlineElapsed) { finish(timeoutFailure()); return; }
      finish(connected ? transportFailure() : connectFailed());
    };
    const timer = setTimeout(() => {
      deadlineElapsed = true;
      terminal(false);
    }, remainingMs);
    socket.once('connect', () => {
      if (finished) return;
      connected = true;
      try {
        // A successful `end()` transmits the request then half-closes, which
        // is the server's explicit acquisition delimiter.
        socket.end(request);
      } catch { terminal(false); }
    });
    socket.on('data', (chunk: Buffer) => {
      if (finished) return;
      if (!Buffer.isBuffer(chunk) || chunk.length > MAX_RESPONSE_BYTES - length) {
        // Oversized data is a response framing fault, not a partial timeout.
        finish(protocolFailure());
        return;
      }
      received.push(chunk);
      length += chunk.length;
    });
    socket.once('end', () => terminal(true));
    socket.once('error', () => terminal(false));
    socket.once('close', () => terminal(false));
  });
}

/** Local filesystem preflight is part of the CLI's total request deadline. */
function beforeDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T | 'TIMED_OUT'> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve('TIMED_OUT'); }
    }, timeoutMs);
    task.then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve('TIMED_OUT'); } },
    );
  });
}

/** Same-UID/DAC is the selected D185 trust boundary; no peer-credential claim. */
async function isSameUserPrivateSocket(socketPath: string): Promise<boolean> {
  if (typeof process.getuid !== 'function') return false;
  try {
    const info = await lstat(socketPath);
    return info.isSocket() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600;
  } catch { return false; }
}

function requestDeadline(request: Buffer): number {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(request);
    const body = text.slice(0, -1);
    if (hasArbitraryDepthDuplicateKey(body)) return NORMAL_DEADLINE_MS;
    const parsed: unknown = JSON.parse(body);
    if (isCompleteDrainRequest(parsed)) {
      return parsed.timeoutMs + 7_000;
    }
  } catch { /* invalid requests remain server-owned and use the normal bound */ }
  return NORMAL_DEADLINE_MS;
}

/** Only the exact DRAIN DTO earns its larger end-to-end request budget. */
function isCompleteDrainRequest(value: unknown): value is { readonly timeoutMs: number } {
  return isPlainObject(value)
    && exactKeys(value, ['v', 'requestControlId', 'command', 'epoch', 'run', 'expectedRevision', 'timeoutMs'])
    && value.v === 'c1'
    && typeof value.requestControlId === 'string' && uuid.test(value.requestControlId)
    && value.command === 'DRAIN'
    && typeof value.epoch === 'string' && uuid.test(value.epoch)
    && typeof value.run === 'string' && uuid.test(value.run)
    && typeof value.expectedRevision === 'string' && revision.test(value.expectedRevision)
    && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 1 && value.timeoutMs <= 30_000;
}

function classifyCompleteResponse(line: Buffer, expectedRequestControlId: string | null): CliDisposition | undefined {
  // A frame needs an EOF and exactly one final LF.  Any other bytes after a
  // candidate are a framing violation, not an incomplete response.
  if (line.length === 0) return undefined;
  if (line.length > MAX_RESPONSE_BYTES) return protocolFailure();
  const firstLf = line.indexOf(0x0a);
  if (line[line.length - 1] !== 0x0a || firstLf !== line.length - 1) {
    return firstLf === -1 ? undefined : protocolFailure();
  }
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line);
    if (text.charCodeAt(0) === 0xfeff || hasArbitraryDepthDuplicateKey(text.slice(0, -1))) return protocolFailure();
    value = JSON.parse(text);
  } catch { return protocolFailure(); }
  if (!isProtocolResponse(value) || value.requestControlId !== expectedRequestControlId) return protocolFailure();
  if (value.ok === true) return Object.freeze({ exitCode: 0, stdout: line, stderr: Buffer.alloc(0) });
  return Object.freeze({ exitCode: 2, stdout: line, stderr: Buffer.from(`${value.code}\n`, 'utf8') });
}

/**
 * This is correlation extraction, not client-side DTO validation.  In
 * particular, a unique canonical ID on an otherwise semantically-invalid
 * request remains expected: D184 requires the server's INVALID_REQUEST
 * envelope to retain it.  Frames that cannot unambiguously carry such an ID
 * expect the protocol's null envelope instead.
 */
function deriveExpectedRequestControlId(request: Buffer): string | null {
  if (!isSingleUtf8Ndjson(request, MAX_REQUEST_BYTES)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(request);
    const body = text.slice(0, -1);
    if (hasArbitraryDepthDuplicateKey(body)) return null;
    const value: unknown = JSON.parse(body);
    if (!isPlainObject(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'requestControlId');
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string' && uuid.test(descriptor.value)
      ? descriptor.value
      : null;
  } catch { return null; }
}

function isProtocolResponse(value: unknown): value is { readonly ok: boolean; readonly code?: string; readonly requestControlId: string | null } {
  if (!isPlainObject(value) || value.v !== 'c1' || typeof value.ok !== 'boolean') return false;
  if (value.ok === false) return exactKeys(value, ['v', 'requestControlId', 'ok', 'code'])
    && (value.requestControlId === null || (typeof value.requestControlId === 'string' && uuid.test(value.requestControlId)))
    && typeof value.code === 'string' && errorCodes.has(value.code);
  if (typeof value.requestControlId !== 'string' || !uuid.test(value.requestControlId)) return false;
  if (!exactKeys(value, ['v', 'requestControlId', 'ok', 'command', 'outcome', 'revision', 'controlId', 'snapshot', 'records', 'truncated'])
    || !isCommand(value.command) || !isOutcome(value.outcome) || !revision.test(value.revision)
    || !(value.controlId === null || (typeof value.controlId === 'string' && uuid.test(value.controlId)))) return false;
  const logs = value.command === 'LOGS_READ';
  if ((value.command === 'STATUS' && value.outcome !== 'STATUS')
    || (value.command === 'HOLD' && value.outcome !== 'HELD')
    || (value.command === 'RELEASE' && value.outcome !== 'RELEASED')
    || (value.command === 'DRAIN' && value.outcome !== 'DRAINED' && value.outcome !== 'NOT_DRAINED')
    || (logs && value.outcome !== 'LOGS_READ')) return false;
  if (logs) return value.controlId === null && value.snapshot === null && Array.isArray(value.records)
    && typeof value.truncated === 'boolean' && value.records.every(isRuntimeLogRecord);
  if (value.records !== null || value.truncated !== null || !isSnapshot(value.snapshot)) return false;
  if (value.command === 'STATUS') return value.controlId === null;
  return value.controlId !== null;
}

function isSnapshot(value: unknown): boolean {
  if (!isPlainObject(value) || !exactKeys(value, ['epoch', 'run', 'revision', 'phase', 'manual', 'maintenance', 'writers', 'issuedPersistence', 'activeQueryReads', 'registryUnknown', 'logging'])
    || typeof value.epoch !== 'string' || !uuid.test(value.epoch) || typeof value.run !== 'string' || !uuid.test(value.run)
    || typeof value.revision !== 'string' || !revision.test(value.revision)
    || !['RUNNING', 'MANUAL_HOLD', 'MAINTENANCE_DRAINING', 'MAINTENANCE_HELD', 'MANUAL_AND_MAINTENANCE_DRAINING', 'MANUAL_AND_MAINTENANCE_HELD'].includes(value.phase)
    || !isVeto(value.manual, false) || !isVeto(value.maintenance, true) || !isWriters(value.writers) || !isNonNegativeSafe(value.issuedPersistence)
    || !isNonNegativeSafe(value.activeQueryReads) || !isNonNegativeSafe(value.registryUnknown) || !isLogging(value.logging)) return false;
  const manualActive = value.manual.active;
  const maintenance = value.maintenance;
  const phase = value.phase;
  if (manualActive !== phase.startsWith('MANUAL')) return false;
  if (maintenance.active !== phase.includes('MAINTENANCE')) return false;
  if (maintenance.active && ((maintenance.outcome === 'WAITING') !== phase.endsWith('DRAINING'))) return false;
  return true;
}

function isVeto(value: unknown, maintenance: boolean): boolean {
  if (!isPlainObject(value)) return false;
  const expected = maintenance ? ['active', 'controlId', 'outcome'] : ['active', 'controlId'];
  if (!exactKeys(value, expected) || typeof value.active !== 'boolean'
    || !(value.controlId === null || (typeof value.controlId === 'string' && uuid.test(value.controlId)))) return false;
  if (value.active !== (value.controlId !== null)) return false;
  if (!maintenance) return true;
  const outcome = value.outcome;
  return (value.active && ['WAITING', 'DRAINED', 'NOT_DRAINED', 'INTERNAL_UNAVAILABLE'].includes(outcome)) || (!value.active && outcome === null);
}

function isWriters(value: unknown): boolean {
  return isPlainObject(value) && exactKeys(value, ['provisional', 'queued', 'running', 'blocked', 'unknown'])
    && Object.values(value).every(isNonNegativeSafe);
}
function isLogging(value: unknown): boolean {
  return isPlainObject(value) && exactKeys(value, ['status', 'droppedCount'])
    && (value.status === 'HEALTHY' || value.status === 'LOGGING_DEGRADED') && isNonNegativeSafe(value.droppedCount);
}
function isRuntimeLogRecord(value: unknown): boolean {
  try { validateRuntimeLogRecord(value); return true; } catch { return false; }
}
function isCommand(value: unknown): value is string { return value === 'STATUS' || value === 'HOLD' || value === 'RELEASE' || value === 'DRAIN' || value === 'LOGS_READ'; }
function isOutcome(value: unknown): value is string { return value === 'STATUS' || value === 'HELD' || value === 'RELEASED' || value === 'DRAINED' || value === 'NOT_DRAINED' || value === 'LOGS_READ'; }
function isNonNegativeSafe(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isPlainObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key)); }

function protocolFailure(): CliDisposition { return Object.freeze({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_PROTOCOL_ERROR\n', 'utf8') }); }
function partialFailure(): CliDisposition { return Object.freeze({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_RESPONSE_PARTIAL\n', 'utf8') }); }
function timeoutFailure(): CliDisposition { return Object.freeze({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_REQUEST_TIMEOUT\n', 'utf8') }); }
function transportFailure(): CliDisposition { return Object.freeze({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_TRANSPORT_ERROR\n', 'utf8') }); }
function connectFailed(): CliDisposition { return Object.freeze({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_CONNECT_FAILED\n', 'utf8') }); }

function writeAll(stream: Writable, bytes: Buffer): Promise<void> {
  if (bytes.length === 0) return Promise.resolve();
  return new Promise((resolve) => { stream.write(bytes, () => resolve()); });
}

/** Iterative scanner: duplicate decoded keys are protocol errors before parse. */
function hasArbitraryDepthDuplicateKey(text: string): boolean {
  type Frame = { readonly kind: 'OBJECT' | 'ARRAY'; state: 'KEY_OR_END' | 'COLON' | 'VALUE' | 'COMMA_OR_END' | 'VALUE_OR_END'; readonly keys?: Set<string> };
  const frames: Frame[] = []; let index = 0; let rootSeen = false;
  const skip = (): void => { while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index]!)) index += 1; };
  const string = (): string | null => { if (text[index] !== '"') return null; index += 1; let out = ''; while (index < text.length) { const c = text[index++]!; if (c === '"') return out; if (c === '\\') { const e = text[index++]!; if (e === '"' || e === '\\' || e === '/') out += e; else if (e === 'b') out += '\b'; else if (e === 'f') out += '\f'; else if (e === 'n') out += '\n'; else if (e === 'r') out += '\r'; else if (e === 't') out += '\t'; else if (e === 'u') { const h = text.slice(index, index + 4); if (!/^[0-9a-fA-F]{4}$/u.test(h)) return null; out += String.fromCharCode(Number.parseInt(h, 16)); index += 4; } else return null; } else { if (c < ' ') return null; out += c; } } return null; };
  const atom = (): boolean => { const start = index; while (index < text.length && !/[\u0009\u000a\u000d\u0020,\]\}]/u.test(text[index]!)) index += 1; return index > start; };
  const done = (): void => { if (frames.length === 0) rootSeen = true; else frames[frames.length - 1]!.state = 'COMMA_OR_END'; };
  while (true) { skip(); const frame = frames[frames.length - 1]; if (frame === undefined) { if (rootSeen) { skip(); return false; } if (index >= text.length) return false; const c = text[index]!; if (c === '{') { index += 1; frames.push({ kind: 'OBJECT', state: 'KEY_OR_END', keys: new Set() }); continue; } if (c === '[') { index += 1; frames.push({ kind: 'ARRAY', state: 'VALUE_OR_END' }); continue; } if (c === '"') { if (string() === null) return false; done(); continue; } if (!atom()) return false; done(); continue; } if (frame.kind === 'OBJECT' && frame.state === 'KEY_OR_END') { if (text[index] === '}') { index += 1; frames.pop(); done(); continue; } const key = string(); if (key === null) return false; if (frame.keys!.has(key)) return true; frame.keys!.add(key); frame.state = 'COLON'; continue; } if (frame.kind === 'OBJECT' && frame.state === 'COLON') { if (text[index] !== ':') return false; index += 1; frame.state = 'VALUE'; continue; } if (frame.state === 'COMMA_OR_END') { const close = frame.kind === 'OBJECT' ? '}' : ']'; if (text[index] === close) { index += 1; frames.pop(); done(); continue; } if (text[index] !== ',') return false; index += 1; frame.state = frame.kind === 'OBJECT' ? 'KEY_OR_END' : 'VALUE_OR_END'; continue; } if (frame.kind === 'ARRAY' && frame.state === 'VALUE_OR_END' && text[index] === ']') { index += 1; frames.pop(); done(); continue; } const c = text[index]; if (c === '{') { index += 1; frames.push({ kind: 'OBJECT', state: 'KEY_OR_END', keys: new Set() }); continue; } if (c === '[') { index += 1; frames.push({ kind: 'ARRAY', state: 'VALUE_OR_END' }); continue; } if (c === '"') { if (string() === null) return false; done(); continue; } if (!atom()) return false; done(); }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('runtime-control-cli.js')) {
  const path = process.argv.length === 3 ? process.argv[2] : undefined;
  if (path === undefined) {
    void writeAll(processStderr, Buffer.from('CONTROL_CONNECT_FAILED\n', 'utf8')).then(() => { process.exitCode = 3; });
  } else {
    void runRuntimeControlCli(path, { stdin: processStdin, stdout: processStdout, stderr: processStderr })
      .then((exitCode) => { process.exitCode = exitCode; })
      .catch(() => writeAll(processStderr, Buffer.from('CONTROL_PROTOCOL_ERROR\n', 'utf8'))
        .then(() => { process.exitCode = 3; }));
  }
}
