import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { performance } from 'node:perf_hooks';

import {
  parseStrictJsonObject,
  type StrictJsonObject,
} from './strict-json-object.js';

export const INGRESS_LIMITS = Object.freeze({
  maxBodyBytes: 16_384,
  maxReaders: 16,
  uploadTimeoutMs: 5_000,
} as const);

export const INGRESS_ERROR_CODES = Object.freeze([
  'INVALID_HTTP_HEADERS',
  'INVALID_QUERY',
  'BODY_NOT_ALLOWED',
  'INVALID_JSON_BODY',
  'REQUEST_BODY_TIMEOUT',
  'REQUEST_BODY_TOO_LARGE',
  'UNSUPPORTED_CONTENT_TYPE',
  'UNSUPPORTED_CONTENT_ENCODING',
  'RAW_READER_CAPACITY_EXHAUSTED',
] as const);

export type IngressErrorCode = (typeof INGRESS_ERROR_CODES)[number];

export interface DecodedQueryPair {
  readonly name: string;
  readonly value: string;
}

export interface IngressHeaders {
  readonly contentType?: string;
  readonly contentEncoding?: string;
  readonly authorization?: string;
  readonly datasetEpoch?: string;
  readonly retryMode?: string;
}

export interface AcceptedIngress {
  readonly method: string;
  readonly body: StrictJsonObject | null;
  readonly query: readonly DecodedQueryPair[];
  readonly headers: IngressHeaders;
}

export type AcceptedIngressHandler = (
  accepted: AcceptedIngress,
  request: Request,
  response: Response,
  next: NextFunction,
) => void | Promise<void>;

export interface BoundedJsonIngress {
  readonly middleware: RequestHandler;
  readonly snapshot: () => Readonly<{ activeReaders: number; maxReaders: number }>;
}

const OWNED_HEADERS = Object.freeze([
  'content-type',
  'content-encoding',
  'authorization',
  'passhub-dataset-epoch',
  'passhub-retry-mode',
] as const);

type OwnedHeaderName = (typeof OWNED_HEADERS)[number];

class IngressRejection extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: IngressErrorCode,
    public readonly closeConnection = false,
  ) {
    super(code);
    this.name = 'IngressRejection';
  }
}

function reject(status: number, code: IngressErrorCode, closeConnection = false): never {
  throw new IngressRejection(status, code, closeConnection);
}

function readRawHeaders(request: Request): ReadonlyMap<string, readonly string[]> {
  const rawHeaders: unknown = request.rawHeaders;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    reject(400, 'INVALID_HTTP_HEADERS', true);
  }
  const headers = new Map<string, string[]>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const rawName: unknown = rawHeaders[index];
    const rawValue: unknown = rawHeaders[index + 1];
    if (typeof rawName !== 'string' || typeof rawValue !== 'string') {
      reject(400, 'INVALID_HTTP_HEADERS', true);
    }
    const name = rawName.toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(rawValue);
    headers.set(name, values);
  }
  return headers;
}

function exactOptionalHeader(
  headers: ReadonlyMap<string, readonly string[]>,
  name: OwnedHeaderName,
): string | undefined {
  const values = headers.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) reject(400, 'INVALID_HTTP_HEADERS', true);
  return values[0];
}

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, '');
}

function validateContentType(value: string | undefined, required: boolean): void {
  if (value === undefined) {
    if (required) reject(415, 'UNSUPPORTED_CONTENT_TYPE', true);
    return;
  }
  const segments = value.split(';');
  if (segments.length > 2 || trimOws(segments[0] ?? '').toLowerCase() !== 'application/json') {
    reject(415, 'UNSUPPORTED_CONTENT_TYPE', true);
  }
  if (segments.length === 2
      && !/^[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*$/iu.test(segments[1] ?? '')) {
    reject(415, 'UNSUPPORTED_CONTENT_TYPE', true);
  }
}

function validateContentEncoding(value: string | undefined): void {
  if (value !== undefined && trimOws(value).toLowerCase() !== 'identity') {
    reject(415, 'UNSUPPORTED_CONTENT_ENCODING', true);
  }
}

function strictFormDecode(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    return reject(400, 'INVALID_QUERY');
  }
}

function parseQuery(requestTarget: string | undefined): readonly DecodedQueryPair[] {
  if (requestTarget === undefined) reject(400, 'INVALID_QUERY');
  const question = requestTarget.indexOf('?');
  if (question < 0 || question === requestTarget.length - 1) return Object.freeze([]);
  const rawQuery = requestTarget.slice(question + 1);
  if (rawQuery.includes('#')) reject(400, 'INVALID_QUERY');
  const seenNames = new Set<string>();
  const pairs: DecodedQueryPair[] = [];
  for (const field of rawQuery.split('&')) {
    const equals = field.indexOf('=');
    const rawName = equals < 0 ? field : field.slice(0, equals);
    const rawValue = equals < 0 ? '' : field.slice(equals + 1);
    const name = strictFormDecode(rawName);
    const value = strictFormDecode(rawValue);
    if (seenNames.has(name)) reject(400, 'INVALID_QUERY');
    seenNames.add(name);
    pairs.push(Object.freeze({ name, value }));
  }
  return Object.freeze(pairs);
}

function hasFramedBody(headers: ReadonlyMap<string, readonly string[]>): boolean {
  const transferEncoding = headers.get('transfer-encoding');
  if (transferEncoding !== undefined) return true;
  const contentLengths = headers.get('content-length');
  if (contentLengths === undefined) return false;
  if (contentLengths.length !== 1 || !/^[\t ]*[0-9]+[\t ]*$/u.test(contentLengths[0] ?? '')) {
    reject(400, 'INVALID_HTTP_HEADERS', true);
  }
  try {
    return BigInt(trimOws(contentLengths[0] ?? '')) > 0n;
  } catch {
    return reject(400, 'INVALID_HTTP_HEADERS', true);
  }
}

function declaredBodyTooLarge(headers: ReadonlyMap<string, readonly string[]>): boolean {
  const values = headers.get('content-length');
  if (values === undefined) return false;
  if (values.length !== 1 || !/^[\t ]*[0-9]+[\t ]*$/u.test(values[0] ?? '')) {
    reject(400, 'INVALID_HTTP_HEADERS', true);
  }
  try {
    return BigInt(trimOws(values[0] ?? '')) > BigInt(INGRESS_LIMITS.maxBodyBytes);
  } catch {
    return reject(400, 'INVALID_HTTP_HEADERS', true);
  }
}

function freezeHeaders(
  contentType: string | undefined,
  contentEncoding: string | undefined,
  authorization: string | undefined,
  datasetEpoch: string | undefined,
  retryMode: string | undefined,
): IngressHeaders {
  const headers: {
    contentType?: string;
    contentEncoding?: string;
    authorization?: string;
    datasetEpoch?: string;
    retryMode?: string;
  } = {};
  if (contentType !== undefined) headers.contentType = contentType;
  if (contentEncoding !== undefined) headers.contentEncoding = contentEncoding;
  if (authorization !== undefined) headers.authorization = authorization;
  if (datasetEpoch !== undefined) headers.datasetEpoch = datasetEpoch;
  if (retryMode !== undefined) headers.retryMode = retryMode;
  return Object.freeze(headers);
}

function sendRejection(
  response: Response,
  rejection: IngressRejection,
): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  const body = JSON.stringify({ code: rejection.code });
  response.statusCode = rejection.status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Cache-Control', 'no-store');
  if (rejection.closeConnection) response.setHeader('Connection', 'close');
  response.end(body);
}

function closeAfterResponse(request: Request, response: Response): void {
  if (request.destroyed) return;
  if (response.writableFinished) {
    request.destroy();
    return;
  }
  response.once('finish', () => {
    if (!request.destroyed) request.destroy();
  });
}

export function createBoundedJsonIngress(
  onAccepted: AcceptedIngressHandler,
): BoundedJsonIngress {
  if (typeof onAccepted !== 'function') throw new TypeError('onAccepted handler is required');
  let activeReaders = 0;

  const handOff = (
    accepted: AcceptedIngress,
    request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    let result: void | Promise<void>;
    try {
      result = onAccepted(accepted, request, response, next);
    } catch (error: unknown) {
      next(error);
      return;
    }
    if (result !== undefined) {
      Promise.resolve(result).catch((error: unknown) => next(error));
    }
  };

  const middleware: RequestHandler = (request, response, next): void => {
    const uploadDeadline = performance.now() + INGRESS_LIMITS.uploadTimeoutMs;
    let rawHeaders: ReadonlyMap<string, readonly string[]>;
    let query: readonly DecodedQueryPair[];
    let contentType: string | undefined;
    let contentEncoding: string | undefined;
    let authorization: string | undefined;
    let datasetEpoch: string | undefined;
    let retryMode: string | undefined;
    const method = (request.method ?? '').toUpperCase();
    const hasJsonBody = method === 'POST' || method === 'PATCH';

    try {
      rawHeaders = readRawHeaders(request);
      query = parseQuery(request.originalUrl ?? request.url);
      contentType = exactOptionalHeader(rawHeaders, 'content-type');
      contentEncoding = exactOptionalHeader(rawHeaders, 'content-encoding');
      authorization = exactOptionalHeader(rawHeaders, 'authorization');
      datasetEpoch = exactOptionalHeader(rawHeaders, 'passhub-dataset-epoch');
      retryMode = exactOptionalHeader(rawHeaders, 'passhub-retry-mode');
      validateContentType(contentType, hasJsonBody);
      validateContentEncoding(contentEncoding);

      if (!hasJsonBody) {
        if (hasFramedBody(rawHeaders)) reject(400, 'BODY_NOT_ALLOWED', true);
        handOff(Object.freeze({
          method,
          body: null,
          query,
          headers: freezeHeaders(
            contentType,
            contentEncoding,
            authorization,
            datasetEpoch,
            retryMode,
          ),
        }), request, response, next);
        return;
      }
      if (declaredBodyTooLarge(rawHeaders)) {
        reject(413, 'REQUEST_BODY_TOO_LARGE', true);
      }
      if (activeReaders >= INGRESS_LIMITS.maxReaders) {
        reject(503, 'RAW_READER_CAPACITY_EXHAUSTED', true);
      }
    } catch (error: unknown) {
      const rejection = error instanceof IngressRejection
        ? error
        : new IngressRejection(400, 'INVALID_HTTP_HEADERS', true);
      request.pause();
      sendRejection(response, rejection);
      if (rejection.closeConnection) closeAfterResponse(request, response);
      return;
    }

    activeReaders += 1;
    let settled = false;
    let byteLength = 0;
    const bodyBuffer = Buffer.alloc(INGRESS_LIMITS.maxBodyBytes);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (wipeBuffer = true): boolean => {
      if (settled) return false;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      request.off('close', onClose);
      activeReaders -= 1;
      if (wipeBuffer) bodyBuffer.fill(0);
      return true;
    };

    const fail = (status: number, code: IngressErrorCode, closeConnection: boolean): void => {
      if (!cleanup()) return;
      request.pause();
      sendRejection(response, new IngressRejection(status, code, closeConnection));
      if (closeConnection) closeAfterResponse(request, response);
    };

    const onData = (chunk: unknown): void => {
      if (!Buffer.isBuffer(chunk)) {
        fail(400, 'INVALID_JSON_BODY', true);
        return;
      }
      if (chunk.byteLength > INGRESS_LIMITS.maxBodyBytes - byteLength) {
        fail(413, 'REQUEST_BODY_TOO_LARGE', true);
        return;
      }
      chunk.copy(bodyBuffer, byteLength);
      byteLength += chunk.byteLength;
    };

    const onEnd = (): void => {
      if (!cleanup(false)) return;
      let body: StrictJsonObject;
      try {
        body = parseStrictJsonObject(bodyBuffer.subarray(0, byteLength));
      } catch {
        const rejection = new IngressRejection(400, 'INVALID_JSON_BODY');
        sendRejection(response, rejection);
        return;
      } finally {
        bodyBuffer.fill(0);
      }
      handOff(Object.freeze({
        method,
        body,
        query,
        headers: freezeHeaders(
          contentType,
          contentEncoding,
          authorization,
          datasetEpoch,
          retryMode,
        ),
      }), request, response, next);
    };

    const onAborted = (): void => {
      cleanup();
    };
    const onError = (): void => {
      cleanup();
    };
    const onClose = (): void => {
      if (!request.complete) cleanup();
    };
    const remainingUploadTime = uploadDeadline - performance.now();
    if (remainingUploadTime <= 0) {
      fail(408, 'REQUEST_BODY_TIMEOUT', true);
      return;
    }
    timer = setTimeout(() => {
      fail(408, 'REQUEST_BODY_TIMEOUT', true);
    }, Math.ceil(remainingUploadTime));
    timer.unref();

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
    request.once('close', onClose);
  };

  return Object.freeze({
    middleware,
    snapshot: () => Object.freeze({
      activeReaders,
      maxReaders: INGRESS_LIMITS.maxReaders,
    }),
  });
}
