import { once } from 'node:events';
import {
  request as nodeHttpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import {
  createConnection,
  type Socket,
} from 'node:net';

import {
  HTTP_SERVER_LIMITS,
  createPassHubHttpApplication,
  type PassHubHttpApplication,
} from '../../src/composition/internal/http-application.js';
import {
  INGRESS_LIMITS,
  type AcceptedIngress,
} from '../../src/shared/internal/http/index.js';

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface RawHttpResult {
  readonly status: number;
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly body: string;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const SENSITIVE = 'g07a-never-echo-this-secret';

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function waitUntil(assertion: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (assertion()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`condition was not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function waitForConnectionCount(
  application: PassHubHttpApplication,
  expected: number,
  timeoutMs = 3_000,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      application.server.getConnections((error, count) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (count === expected) {
          resolve();
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`connection count remained ${count}; expected ${expected}`));
          return;
        }
        setTimeout(check, 10);
      });
    };
    check();
  });
}

function portOf(application: PassHubHttpApplication): number {
  const address = application.server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no TCP port');
  return address.port;
}

function httpRequest(
  port: number,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Readonly<Record<string, string | number>>;
    readonly body?: Uint8Array | string;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: options.headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

function parseRawResponse(buffer: Buffer): RawHttpResult | undefined {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return undefined;
  const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const statusMatch = /^HTTP\/1\.1 ([0-9]{3}) /u.exec(lines[0] ?? '');
  if (statusMatch === null) throw new Error('invalid HTTP response status line');
  const headers = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error('invalid HTTP response header');
    const name = line.slice(0, colon).toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(line.slice(colon + 1).trim());
    headers.set(name, values);
  }
  const contentLength = Number(headers.get('content-length')?.[0] ?? 0);
  const bodyStart = headerEnd + 4;
  if (buffer.byteLength < bodyStart + contentLength) return undefined;
  return {
    status: Number(statusMatch[1]),
    headers,
    body: buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8'),
  };
}

function rawRequest(port: number, wireRequest: string | Buffer): Promise<RawHttpResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw HTTP response timed out'));
    }, 5_000);
    socket.once('connect', () => socket.write(wireRequest));
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      try {
        const parsed = parseRawResponse(Buffer.concat(chunks));
        if (parsed === undefined) return;
        clearTimeout(timer);
        socket.destroy();
        resolve(parsed);
      } catch (error: unknown) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function expectIngressError(
  result: HttpResult | RawHttpResult,
  status: number,
  code: string,
): void {
  expect(result.status).toBe(status);
  expect(result.body).toBe(JSON.stringify({ code }));
  const cacheControl = result.headers instanceof Map
    ? (result.headers as ReadonlyMap<string, readonly string[]>).get('cache-control')?.[0]
    : (result.headers as IncomingHttpHeaders)['cache-control'];
  expect(cacheControl).toBe('no-store');
  expect(result.body).not.toContain(SENSITIVE);
  expect(result.body).not.toMatch(/stack|SyntaxError|at /iu);
}

describe('G07a real Node/Nest/Express HTTP ingress', () => {
  let application: PassHubHttpApplication;
  let port: number;
  const accepted: AcceptedIngress[] = [];
  let downstreamInvocations = 0;
  let abortedDownstreamFinished = 0;
  let abortGate = deferred();

  beforeAll(async () => {
    application = await createPassHubHttpApplication(async (value, request, response) => {
      downstreamInvocations += 1;
      if (request.url === '/downstream-throw') throw new Error(SENSITIVE);
      if (request.url === '/downstream-reject') return Promise.reject(new Error(SENSITIVE));
      if (request.url === '/accepted-client-abort') {
        await abortGate.promise;
        abortedDownstreamFinished += 1;
        if (!response.destroyed) response.end();
        return;
      }
      accepted.push(value);
      response.statusCode = 204;
      response.end();
    });
    await application.nestApplication.listen(0, '127.0.0.1');
    port = portOf(application);
  });

  afterAll(async () => {
    abortGate.resolve();
    await application.nestApplication.close();
  });

  test('uses the exact configured limits on the one Nest-owned Node server', () => {
    expect(application.server).toBe(application.nestApplication.getHttpServer());
    expect(application.server.listening).toBe(true);
    expect(application.server.maxConnections).toBe(HTTP_SERVER_LIMITS.maxConnections);
    expect(application.server.headersTimeout).toBe(HTTP_SERVER_LIMITS.headersTimeoutMs);
    expect(application.server.keepAliveTimeout).toBe(HTTP_SERVER_LIMITS.keepAliveTimeoutMs);
    expect(application.server.keepAliveTimeoutBuffer).toBe(HTTP_SERVER_LIMITS.keepAliveTimeoutBufferMs);
    expect(HTTP_SERVER_LIMITS).toEqual({
      connectionsCheckingIntervalMs: 250,
      headersTimeoutMs: 5_000,
      keepAliveTimeoutMs: 5_000,
      keepAliveTimeoutBufferMs: 0,
      maxConnections: 64,
    });
    expect(INGRESS_LIMITS).toEqual({
      maxBodyBytes: 16_384,
      maxReaders: 16,
      uploadTimeoutMs: 5_000,
    });
  });

  test('accepts exactly 16,384 bytes and hands off a parsed body without Express parsing it', async () => {
    const prefix = '{"value":"ok"}';
    const body = prefix + ' '.repeat(INGRESS_LIMITS.maxBodyBytes - Buffer.byteLength(prefix));
    const before = accepted.length;
    const result = await httpRequest(port, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Encoding': 'identity',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });

    expect(result.status).toBe(204);
    expect(accepted).toHaveLength(before + 1);
    expect(accepted.at(-1)?.body).toEqual({ value: 'ok' });
    expect(application.ingress.snapshot().activeReaders).toBe(0);
  });

  test('rejects a declared 16,385-byte body before acquiring a reader', async () => {
    const body = '{}'.padEnd(INGRESS_LIMITS.maxBodyBytes + 1, ' ');
    const result = await httpRequest(port, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    expectIngressError(result, 413, 'REQUEST_BODY_TOO_LARGE');
    expect(application.ingress.snapshot().activeReaders).toBe(0);
  });

  test('rejects an undeclared chunked body at byte 16,385 and returns its reader exactly once', async () => {
    const body = '{}'.padEnd(INGRESS_LIMITS.maxBodyBytes + 1, ' ');
    const result = await httpRequest(port, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
      body,
    });
    expectIngressError(result, 413, 'REQUEST_BODY_TOO_LARGE');
    await waitUntil(() => application.ingress.snapshot().activeReaders === 0);
  });

  test.each([
    ['missing content type', undefined, undefined, 415, 'UNSUPPORTED_CONTENT_TYPE'],
    ['wrong media type', 'text/plain', undefined, 415, 'UNSUPPORTED_CONTENT_TYPE'],
    ['extra media parameter', 'application/json; charset=utf-8; profile=x', undefined, 415, 'UNSUPPORTED_CONTENT_TYPE'],
    ['quoted charset', 'application/json; charset="utf-8"', undefined, 415, 'UNSUPPORTED_CONTENT_TYPE'],
    ['non UTF-8 charset', 'application/json; charset=latin1', undefined, 415, 'UNSUPPORTED_CONTENT_TYPE'],
    ['gzip encoding', 'application/json', 'gzip', 415, 'UNSUPPORTED_CONTENT_ENCODING'],
    ['multiple encodings', 'application/json', 'identity, gzip', 415, 'UNSUPPORTED_CONTENT_ENCODING'],
  ])('rejects unsupported media metadata: %s', async (
    _label,
    contentType,
    contentEncoding,
    status,
    code,
  ) => {
    const headers: Record<string, string> = {};
    if (contentType !== undefined) headers['Content-Type'] = contentType;
    if (contentEncoding !== undefined) headers['Content-Encoding'] = contentEncoding;
    const result = await httpRequest(port, { method: 'POST', headers, body: '{}' });
    expectIngressError(result, status, code);
    expect(result.headers.connection).toBe('close');
  });

  test.each([
    ['content-type', 'application/json', 'application/json; charset=utf-8'],
    ['content-encoding', 'identity', 'identity'],
    ['authorization', `Bearer ${SENSITIVE}`, `Source ${SENSITIVE}`],
    ['passhub-dataset-epoch', SENSITIVE, 'second-epoch'],
    ['passhub-retry-mode', 'existing-only', SENSITIVE],
  ])('rejects duplicate owned raw header lines before Node/Express merging: %s', async (
    name,
    first,
    second,
  ) => {
    const result = await rawRequest(port, Buffer.from(
      `POST /duplicate HTTP/1.1\r\nHost: 127.0.0.1\r\n${name}: ${first}\r\n${name}: ${second}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      'latin1',
    ));
    expectIngressError(result, 400, 'INVALID_HTTP_HEADERS');
    expect(result.headers.get('connection')).toEqual(['close']);
  });

  test('passes unique owned raw headers through without normalization', async () => {
    const result = await httpRequest(port, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'identity',
        Authorization: `Source ${SENSITIVE}`,
        'PassHub-Dataset-Epoch': 'epoch-literal',
        'PassHub-Retry-Mode': 'existing-only',
      },
      body: '{}',
    });
    expect(result.status).toBe(204);
    expect(accepted.at(-1)?.headers).toEqual({
      contentType: 'application/json',
      contentEncoding: 'identity',
      authorization: `Source ${SENSITIVE}`,
      datasetEpoch: 'epoch-literal',
      retryMode: 'existing-only',
    });
  });

  test.each([
    ['literal duplicate', '/events?limit=1&limit=2'],
    ['percent-decoded duplicate', '/events?name=one&n%61me=two'],
    ['plus-decoded duplicate', '/events?a+b=one&a%20b=two'],
  ])('rejects decoded duplicate query names: %s', async (_label, path) => {
    const result = await httpRequest(port, { path });
    expectIngressError(result, 400, 'INVALID_QUERY');
  });

  test('rejects malformed percent encoding and accepts distinct decoded query pairs', async () => {
    expectIngressError(await httpRequest(port, { path: `/events?bad=%ZZ&secret=${SENSITIVE}` }), 400, 'INVALID_QUERY');
    const result = await httpRequest(port, { path: '/events?name=hello+world&other=%E8%A8%AA%E5%AE%A2' });
    expect(result.status).toBe(204);
    expect(accepted.at(-1)?.query).toEqual([
      { name: 'name', value: 'hello world' },
      { name: 'other', value: '訪客' },
    ]);
  });

  test('rejects any framed body on a non-body method', async () => {
    const result = await rawRequest(port, Buffer.from(
      'GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
      'latin1',
    ));
    expectIngressError(result, 400, 'BODY_NOT_ALLOWED');
  });

  test('strict body failures are redacted and explicitly non-cacheable', async () => {
    const result = await httpRequest(port, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"password":"${SENSITIVE}",}`,
    });
    expectIngressError(result, 400, 'INVALID_JSON_BODY');
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(application.ingress.snapshot().activeReaders).toBe(0);
  });

  test('rejects fatal UTF-8 and BOM through the real transport', async () => {
    const invalidUtf8 = await httpRequest(port, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    });
    expectIngressError(invalidUtf8, 400, 'INVALID_JSON_BODY');

    const bom = await httpRequest(port, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]),
    });
    expectIngressError(bom, 400, 'INVALID_JSON_BODY');
  });

  test.each([
    ['array value', '{"items":[]}'],
    ['third object layer', '{"outer":{"inner":{"tooDeep":true}}}'],
    ['native trailing comma', '{"name":"value",}'],
    ['non-object root', 'true'],
    ['cooked duplicate in root', '{"kind":"one","k\\u0069nd":"two"}'],
    ['cooked duplicate in nested scope', '{"face":{"provider":"one","pro\\u0076ider":"two"}}'],
  ])('enforces the strict structure/grammar/duplicate pipeline over HTTP: %s', async (
    _label,
    body,
  ) => {
    const result = await httpRequest(port, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expectIngressError(result, 400, 'INVALID_JSON_BODY');
  });

  test('keeps duplicate-key scopes independent over HTTP', async () => {
    const result = await httpRequest(port, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"root","child":{"name":"nested"}}',
    });
    expect(result.status).toBe(204);
    expect(accepted.at(-1)?.body).toEqual({ name: 'root', child: { name: 'nested' } });
  });

  test('the five-second upload deadline is absolute and is not refreshed by chunks', async () => {
    const started = Date.now();
    const result = await new Promise<HttpResult>((resolve, reject) => {
      const request = nodeHttpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/slow',
        headers: { 'Content-Type': 'application/json' },
        agent: false,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('error', reject);
      request.write('{');
      const interval = setInterval(() => {
        if (!request.destroyed) request.write(' ');
      }, 600);
      request.once('close', () => clearInterval(interval));
    });
    const elapsed = Date.now() - started;
    expectIngressError(result, 408, 'REQUEST_BODY_TIMEOUT');
    expect(elapsed).toBeGreaterThanOrEqual(4_700);
    expect(elapsed).toBeLessThan(6_500);
    await waitUntil(() => application.ingress.snapshot().activeReaders === 0);
  }, 10_000);

  test('holds exactly 16 raw readers, rejects the 17th with 503, and restores capacity after aborts', async () => {
    const holders: ClientRequest[] = [];
    try {
      for (let index = 0; index < INGRESS_LIMITS.maxReaders; index += 1) {
        const request = nodeHttpRequest({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/reader-${index}`,
          headers: { 'Content-Type': 'application/json' },
          agent: false,
        });
        request.on('error', () => undefined);
        request.write('{');
        holders.push(request);
      }
      await waitUntil(() => application.ingress.snapshot().activeReaders === INGRESS_LIMITS.maxReaders);
      expect(application.ingress.snapshot()).toEqual({ activeReaders: 16, maxReaders: 16 });

      const seventeenth = await httpRequest(port, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expectIngressError(seventeenth, 503, 'RAW_READER_CAPACITY_EXHAUSTED');
      expect(application.ingress.snapshot().activeReaders).toBe(16);
    } finally {
      for (const request of holders) request.destroy();
    }
    await waitUntil(() => application.ingress.snapshot().activeReaders === 0);
    const recovered = await httpRequest(port, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(recovered.status).toBe(204);
    expect(application.ingress.snapshot().activeReaders).toBe(0);
  });

  test('an incomplete client abort neither hands off nor double-releases its reader', async () => {
    const before = downstreamInvocations;
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.write(
      'POST /aborted HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n',
    );
    await waitUntil(() => application.ingress.snapshot().activeReaders === 1);
    socket.destroy();
    await waitUntil(() => application.ingress.snapshot().activeReaders === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(application.ingress.snapshot().activeReaders).toBe(0);
    expect(downstreamInvocations).toBe(before);
  });

  test('a client close after complete handoff does not cancel the downstream promise', async () => {
    abortGate = deferred();
    const beforeInvocations = downstreamInvocations;
    const beforeFinished = abortedDownstreamFinished;
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.write(
      'POST /accepted-client-abort HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
    );
    await waitUntil(() => downstreamInvocations === beforeInvocations + 1);
    socket.destroy();
    abortGate.resolve();
    await waitUntil(() => abortedDownstreamFinished === beforeFinished + 1);
    expect(application.ingress.snapshot().activeReaders).toBe(0);
  });

  test.each(['/downstream-throw', '/downstream-reject'])(
    'turns downstream throw/rejection into one generic 500 without leaking its error: %s',
    async (path) => {
      const before = downstreamInvocations;
      const result = await httpRequest(port, {
        method: 'POST',
        path,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(result.status).toBe(500);
      expect(result.body).toBe('{"statusCode":500,"message":"Internal server error"}');
      expect(result.body).not.toContain(SENSITIVE);
      expect(downstreamInvocations).toBe(before + 1);
      expect(application.ingress.snapshot().activeReaders).toBe(0);
    },
  );

  test('enforces the 64-connection server limit and emits a drop for the 65th socket', async () => {
    const sockets: Socket[] = [];
    try {
      for (let index = 0; index < HTTP_SERVER_LIMITS.maxConnections; index += 1) {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.on('error', () => undefined);
        await once(socket, 'connect');
        sockets.push(socket);
      }
      const connectionCount = await new Promise<number>((resolve, reject) => {
        application.server.getConnections((error, count) => error === null ? resolve(count) : reject(error));
      });
      expect(connectionCount).toBe(64);

      const drop = once(application.server, 'drop');
      const extra = createConnection({ host: '127.0.0.1', port });
      extra.on('error', () => undefined);
      sockets.push(extra);
      const [dropData] = await Promise.race([
        drop,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error('65th connection was not dropped')),
          2_000,
        )),
      ]);
      expect(dropData).toMatchObject({ localPort: port });
    } finally {
      for (const socket of sockets) socket.destroy();
    }
    await waitForConnectionCount(application, 0);
    await waitUntil(() => application.ingress.snapshot().activeReaders === 0);
  }, 15_000);

  test('closes an incomplete header at the configured absolute header timeout', async () => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    await once(socket, 'connect');
    const started = Date.now();
    socket.write('POST /headers HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Never-Finished:');
    await once(socket, 'close');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(6_500);
    expect(Buffer.concat(chunks).toString('latin1')).toMatch(/^HTTP\/1\.1 408 /u);
  }, 10_000);

  test('closes an otherwise idle keep-alive socket at the configured timeout', async () => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
    });
    await once(socket, 'connect');
    socket.write('GET /keepalive HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    await waitUntil(() => response.includes(Buffer.from('\r\n\r\n')));
    expect(response.toString('latin1')).toMatch(/^HTTP\/1\.1 204 /u);
    const idleStarted = Date.now();
    await once(socket, 'close');
    const idleElapsed = Date.now() - idleStarted;
    expect(idleElapsed).toBeGreaterThanOrEqual(4_500);
    expect(idleElapsed).toBeLessThan(6_500);
  }, 10_000);
});

describe('G07a application server ownership', () => {
  test('starts and closes the same sole server through Nest lifecycle methods', async () => {
    const application = await createPassHubHttpApplication((_accepted, _request, response) => {
      response.statusCode = 204;
      response.end();
    });
    const server = application.server;
    expect(server).toBe(application.nestApplication.getHttpServer());
    expect(server.listening).toBe(false);
    await application.nestApplication.listen(0, '127.0.0.1');
    expect(server).toBe(application.nestApplication.getHttpServer());
    expect(server.listening).toBe(true);
    await application.nestApplication.close();
    expect(server.listening).toBe(false);
  });
});
