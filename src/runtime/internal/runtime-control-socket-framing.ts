import { Buffer } from 'node:buffer';
import { type Socket } from 'node:net';
import { TextDecoder } from 'node:util';
import {
  dispatchRuntimeControlProtocol,
  type RuntimeControlProtocolFrame,
} from './runtime-control-protocol.js';
import { assertRuntimeControl, type RuntimeControl } from './runtime-control.js';

const MAX_ACTIVE_CONNECTIONS = 8;
const MAX_REQUEST_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ACQUISITION_TIMEOUT_MS = 2_000;

export interface RuntimeControlSocketFramingAdapter {
  /** Internal listener callback; never export it through a public barrel. */
  readonly onConnection: (socket: Socket) => void;
}

/**
 * Binds the transport-free control protocol to already accepted AF_UNIX
 * sockets.  Listener lifecycle/path ownership deliberately remains in
 * runtime-control-socket-listener.ts, so this adapter owns only D184 framing:
 * one half-closed request, one bounded NDJSON response, then close.
 */
export function createRuntimeControlSocketFramingAdapter(
  control: RuntimeControl,
): RuntimeControlSocketFramingAdapter {
  assertRuntimeControl(control);
  let activeConnections = 0;

  const onConnection = (socket: Socket): void => {
    // This is a transport-level admission decision.  It must occur before
    // reading or dispatching the ninth socket, so it has no protocol effect.
    if (activeConnections >= MAX_ACTIVE_CONNECTIONS) {
      destroyQuietly(socket);
      return;
    }
    activeConnections += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activeConnections -= 1;
    };

    // Prevent an EventEmitter "error" without a consumer from escaping the
    // listener callback.  We do not turn a transport failure into a protocol
    // response or a control operation.
    socket.on('error', () => undefined);
    socket.once('close', release);

    let finishedInput = false;
    let fatal = false;
    let received = Buffer.alloc(0);
    const acquisitionTimer = setTimeout(() => {
      if (!finishedInput) fatalDestroy();
    }, ACQUISITION_TIMEOUT_MS);

    const clearAcquisitionTimer = (): void => { clearTimeout(acquisitionTimer); };
    const fatalDestroy = (): void => {
      if (fatal) return;
      fatal = true;
      clearAcquisitionTimer();
      destroyQuietly(socket);
    };

    // An asynchronous transport failure is fatal even while a valid request
    // is being dispatched or a response is draining.  The permanent no-op
    // listener above prevents an unhandled EventEmitter error; this one gives
    // the failure the same single teardown path as every other framing fault.
    socket.once('error', fatalDestroy);

    socket.on('data', (chunk: Buffer) => {
      if (fatal || finishedInput) return;
      // Buffer.concat is bounded before allocation by checking the source
      // chunk and accumulated length separately.
      if (!Buffer.isBuffer(chunk) || chunk.length > MAX_REQUEST_BYTES - received.length) {
        fatalDestroy();
        return;
      }
      received = Buffer.concat([received, chunk], received.length + chunk.length);
      // A LF may appear only at the final byte.  It is still provisional until
      // EOF, but any byte after it proves framing invalid immediately.
      const firstLf = received.indexOf(0x0a);
      if (firstLf !== -1 && firstLf !== received.length - 1) fatalDestroy();
    });

    socket.once('end', () => {
      if (fatal || finishedInput) return;
      finishedInput = true;
      clearAcquisitionTimer();
      const frame = decodeCompleteFrame(received);
      if (frame === undefined) {
        fatalDestroy();
        return;
      }
      void dispatchAndRespond(control, frame, socket, fatalDestroy);
    });
  };

  return Object.freeze({ onConnection });
}

async function dispatchAndRespond(
  control: RuntimeControl,
  frame: RuntimeControlProtocolFrame,
  socket: Socket,
  fatalDestroy: () => void,
): Promise<void> {
  try {
    const response = await dispatchRuntimeControlProtocol(control, frame);
    if (response === undefined) {
      fatalDestroy();
      return;
    }
    const line = encodeResponse(response);
    if (line === undefined) {
      // A server-owned response that cannot satisfy the wire contract is not
      // allowed to become a partial or malformed response on the socket.
      fatalDestroy();
      return;
    }
    writeOneResponse(socket, line, fatalDestroy);
  } catch {
    // The protocol core normally converts faults to INTERNAL_UNAVAILABLE.
    // This final guard is solely callback containment, never an effect retry.
    fatalDestroy();
  }
}

function decodeCompleteFrame(bytes: Buffer): RuntimeControlProtocolFrame | undefined {
  if (bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES || bytes[bytes.length - 1] !== 0x0a
    || bytes.indexOf(0x0a) !== bytes.length - 1) return undefined;
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (hasBom) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return Object.freeze({
    text,
    utf8Valid: true,
    hasBom: false,
    singleFinalLf: true,
    byteLength: bytes.length,
  });
}

function encodeResponse(value: unknown): Buffer | undefined {
  try {
    // JSON.stringify(undefined) produces no JSON text.  Interpolation would
    // turn that into the invalid wire token "undefined", so fail closed
    // before allocating or attempting any write.
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return undefined;
    const encoded = Buffer.from(`${json}\n`, 'utf8');
    if (encoded.length === 0 || encoded.length > MAX_RESPONSE_BYTES || encoded[encoded.length - 1] !== 0x0a
      || encoded.indexOf(0x0a) !== encoded.length - 1) return undefined;
    return encoded;
  } catch {
    return undefined;
  }
}

/**
 * Complete the single response under D184's strict write ownership rule.
 * `write()` returning false is not a harmless hint here: accepting a queued
 * response would make a slow peer consume an unbounded server lifetime, so
 * it is an immediate transport failure.  The callback and the close timer
 * are both guarded by the connection's idempotent fatal path.
 */
function writeOneResponse(socket: Socket, line: Buffer, fatalDestroy: () => void): void {
  let writeSettled = false;
  const deadline = setTimeout(() => {
    if (!writeSettled) fatalDestroy();
  }, ACQUISITION_TIMEOUT_MS);
  const clearDeadline = (): void => { clearTimeout(deadline); };

  socket.once('close', clearDeadline);
  try {
    const accepted = socket.write(line, (error) => {
      if (writeSettled) return;
      writeSettled = true;
      if (error !== undefined && error !== null) {
        clearDeadline();
        fatalDestroy();
        return;
      }
      clearDeadline();
      try {
        // The payload was already written above.  Ending without a second
        // payload makes double-response impossible and preserves half-close
        // semantics for the peer that already sent EOF.
        socket.end();
      } catch {
        clearDeadline();
        fatalDestroy();
      }
    });
    if (!accepted) {
      writeSettled = true;
      clearDeadline();
      fatalDestroy();
    }
  } catch {
    clearDeadline();
    fatalDestroy();
  }
}

function destroyQuietly(socket: Socket): void {
  try { socket.destroy(); } catch { /* socket teardown must never throw */ }
}
