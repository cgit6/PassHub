import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { createRuntimeControlSocketService } from '../../src/runtime/internal/runtime-control-socket-service.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { createRuntimeControl, createRuntimeIdentityIssuer } from '../../src/runtime/internal/runtime-control.js';

const requestId = '33333333-3333-4333-8333-333333333333';
const epoch = '11111111-1111-4111-8111-111111111111';
const processRun = '22222222-2222-4222-8222-222222222222';

interface ChildResult { readonly exitCode: number | null; readonly stdout: Buffer; readonly stderr: Buffer; }

function request(command = 'STATUS'): Buffer {
  return Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: requestId, command, epoch, run: processRun })}\n`, 'utf8');
}

function drainRequest(timeoutMs: number): Buffer {
  return Buffer.from(`${JSON.stringify({
    v: 'c1', requestControlId: requestId, command: 'DRAIN', epoch, run: processRun,
    expectedRevision: '0', timeoutMs,
  })}\n`, 'utf8');
}

function success(): Buffer {
  return Buffer.from(`${JSON.stringify({
    v: 'c1', requestControlId: requestId, ok: true, command: 'STATUS', outcome: 'STATUS', revision: '0', controlId: null,
    snapshot: {
      epoch, run: processRun, revision: '0', phase: 'RUNNING', manual: { active: false, controlId: null },
      maintenance: { active: false, controlId: null, outcome: null },
      writers: { provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 0 },
      issuedPersistence: 0, activeQueryReads: 0, registryUnknown: 0, logging: { status: 'HEALTHY', droppedCount: 0 },
    }, records: null, truncated: null,
  })}\n`, 'utf8');
}

function nullInvalidRequest(): Buffer {
  return Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' })}\n`, 'utf8');
}

function productionControl() {
  return createRuntimeControl({
    epoch,
    run: processRun,
    identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: processRun }),
    clock: Object.freeze({ nowMs: () => performance.now() }),
    awaitObservation: () => undefined,
    controlIdFactory: randomUUID,
  });
}

async function listener(handler: (socket: Socket) => void): Promise<{ readonly parent: string; readonly path: string; readonly server: Server; readonly sockets: ReadonlySet<Socket> }> {
  const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-cli-'));
  const path = join(parent, 'runtime-control.sock');
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolveListen(); });
  });
  await chmod(path, 0o600);
  return Object.freeze({ parent, path, server, sockets });
}

async function close(fixture: { readonly parent: string; readonly server: Server; readonly sockets: ReadonlySet<Socket> }): Promise<void> {
  for (const socket of fixture.sockets) socket.destroy();
  await new Promise<void>((resolveClose) => fixture.server.close(() => resolveClose()));
  await rm(fixture.parent, { recursive: true, force: true });
}

async function run(path: string, input: Buffer): Promise<ChildResult> {
  const { child, result } = start(path);
  child.stdin!.end(input);
  return result;
}

function start(path: string): { readonly child: ChildProcess; readonly result: Promise<ChildResult> } {
  const child = spawn(process.execPath, [resolve(process.cwd(), 'dist/src/runtime/internal/runtime-control-cli.js'), path], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  const result = new Promise<ChildResult>((resolveRun, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode) => resolveRun(Object.freeze({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })));
  });
  return Object.freeze({ child, result });
}

describe('G10a private control CLI', () => {
  test('sends exactly one EOF-delimited request and returns a strict successful response unchanged', async () => {
    let received = Buffer.alloc(0);
    const fixture = await listener((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => { received = Buffer.concat(chunks); socket.end(success()); });
    });
    try {
      const result = await run(fixture.path, request());
      expect(received).toEqual(request());
      expect(result).toEqual({ exitCode: 0, stdout: success(), stderr: Buffer.alloc(0) });
    } finally { await close(fixture); }
  });

  test('maps a valid server error to exit 2 and writes only its code to stderr', async () => {
    const fixture = await listener((socket) => {
      socket.resume();
      socket.once('end', () => socket.end(Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: requestId, ok: false, code: 'STALE_EPOCH' })}\n`, 'utf8')));
    });
    try {
      await expect(run(fixture.path, request())).resolves.toEqual({
        exitCode: 2, stdout: Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: requestId, ok: false, code: 'STALE_EPOCH' })}\n`, 'utf8'), stderr: Buffer.from('STALE_EPOCH\n'),
      });
    } finally { await close(fixture); }
  });

  test('keeps the D184 server-owned INVALID_REQUEST mapping for a semantically invalid request with a canonical ID', async () => {
    const invalid = Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: requestId, command: 'NOT_A_COMMAND', epoch, run: processRun })}\n`, 'utf8');
    const error = Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: requestId, ok: false, code: 'INVALID_REQUEST' })}\n`, 'utf8');
    const fixture = await listener((socket) => {
      socket.resume();
      socket.once('end', () => socket.end(error));
    });
    try {
      await expect(run(fixture.path, invalid)).resolves.toEqual({
        exitCode: 2, stdout: error, stderr: Buffer.from('INVALID_REQUEST\n', 'utf8'),
      });
    } finally { await close(fixture); }
  });

  test('accepts the server-owned null INVALID_REQUEST envelope when the request has no canonical correlation ID', async () => {
    // The CLI must forward a complete but DTO-invalid request rather than
    // locally classifying it.  A non-canonical ID is deliberately not a
    // correlation value, so D184 permits only the null error envelope.
    const invalid = Buffer.from(`${JSON.stringify({
      v: 'c1', requestControlId: 'not-a-canonical-uuid', command: 'STATUS', epoch, run: processRun,
    })}\n`, 'utf8');
    const error = Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' })}\n`, 'utf8');
    let received = Buffer.alloc(0);
    const fixture = await listener((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => { received = Buffer.concat(chunks); socket.end(error); });
    });
    try {
      await expect(run(fixture.path, invalid)).resolves.toEqual({
        exitCode: 2, stdout: error, stderr: Buffer.from('INVALID_REQUEST\n', 'utf8'),
      });
      expect(received).toEqual(invalid);
    } finally { await close(fixture); }
  });

  test('derives null correlation for a duplicate-key request even when one apparent ID is canonical', async () => {
    // JSON.parse would retain one value, but the request boundary rejects
    // duplicate decoded keys before parsing.  The CLI must follow that same
    // rule and accept only the null INVALID_REQUEST envelope.
    const invalid = Buffer.from(`{"v":"c1","requestControlId":"${requestId}","requestControlId":"${requestId}","command":"STATUS","epoch":"${epoch}","run":"${processRun}"}\n`, 'utf8');
    const error = Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: null, ok: false, code: 'INVALID_REQUEST' })}\n`, 'utf8');
    let received = Buffer.alloc(0);
    const fixture = await listener((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => { received = Buffer.concat(chunks); socket.end(error); });
    });
    try {
      await expect(run(fixture.path, invalid)).resolves.toEqual({
        exitCode: 2, stdout: error, stderr: Buffer.from('INVALID_REQUEST\n', 'utf8'),
      });
      expect(received).toEqual(invalid);
    } finally { await close(fixture); }
  });

  test('gets the server-owned null INVALID_REQUEST response from the real control service for ambiguous request identities', async () => {
    // This deliberately avoids the mock listener used by the CLI-focused
    // cases above.  The complete input must travel through the built CLI,
    // real AF_UNIX listener/framing adapter, and production protocol before
    // the server derives the null correlation value.
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-cli-service-'));
    const directory = join(parent, 'control');
    const control = productionControl();
    const service = await createRuntimeControlSocketService({
      control,
      directory,
      socketPath: join(directory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
    });
    const expected = {
      exitCode: 2,
      stdout: nullInvalidRequest(),
      stderr: Buffer.from('INVALID_REQUEST\n', 'utf8'),
    };
    const noncanonicalId = Buffer.from(`${JSON.stringify({
      v: 'c1', requestControlId: 'not-a-canonical-uuid', command: 'STATUS', epoch, run: processRun,
    })}\n`, 'utf8');
    // `\\u0049` is one JSON escape in the actual frame.  The two textual
    // member names decode to the same `requestControlId` key, so JSON.parse
    // alone would be insufficient to establish a safe correlation value.
    const duplicateEscapedId = Buffer.from(
      `{"v":"c1","requestControlId":"${requestId}","requestControl\\u0049d":"${requestId}","command":"STATUS","epoch":"${epoch}","run":"${processRun}"}\n`,
      'utf8',
    );
    try {
      await expect(run(service.socketPath, noncanonicalId)).resolves.toEqual(expected);
      expect(control.snapshot().revision).toBe('0');
      await expect(run(service.socketPath, duplicateEscapedId)).resolves.toEqual(expected);
      // Neither malformed request must reach a control transition.
      expect(control.snapshot().revision).toBe('0');
    } finally {
      await service.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('rejects valid-looking responses whose requestControlId is not the request correlation ID', async () => {
    const anotherId = '44444444-4444-4444-8444-444444444444';
    const wrongSuccess = Buffer.from(success().toString('utf8').replace(requestId, anotherId), 'utf8');
    const wrongError = Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: anotherId, ok: false, code: 'STALE_EPOCH' })}\n`, 'utf8');
    const nullError = Buffer.from(`${JSON.stringify({ v: 'c1', requestControlId: null, ok: false, code: 'STALE_EPOCH' })}\n`, 'utf8');
    for (const payload of [wrongSuccess, wrongError, nullError]) {
      const fixture = await listener((socket) => {
        socket.resume();
        socket.once('end', () => socket.end(payload));
      });
      try {
        await expect(run(fixture.path, request())).resolves.toEqual({
          exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_PROTOCOL_ERROR\n', 'utf8'),
        });
      } finally { await close(fixture); }
    }
  });

  test('gives malformed complete responses protocol precedence, and incomplete responses partial disposition', async () => {
    const malformed = await listener((socket) => { socket.resume(); socket.once('end', () => socket.end(Buffer.from('{not-json}\n'))); });
    try {
      await expect(run(malformed.path, request())).resolves.toEqual({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_PROTOCOL_ERROR\n') });
    } finally { await close(malformed); }

    const partial = await listener((socket) => { socket.resume(); socket.once('end', () => socket.end(Buffer.from('{"v":"c1"'))); });
    try {
      await expect(run(partial.path, request())).resolves.toEqual({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_RESPONSE_PARTIAL\n') });
    } finally { await close(partial); }

    const trailing = await listener((socket) => {
      socket.resume();
      socket.once('end', () => socket.end(Buffer.concat([success(), Buffer.from('\n', 'utf8')])));
    });
    try {
      // A second LF comes after a complete candidate, so framing/protocol
      // precedence wins over the generic non-empty partial classification.
      await expect(run(trailing.path, request())).resolves.toEqual({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_PROTOCOL_ERROR\n') });
    } finally { await close(trailing); }

  });

  test('rejects a LOGS_READ envelope that violates its required null control fields', async () => {
    const payload = Buffer.from(`${JSON.stringify({
      v: 'c1', requestControlId: requestId, ok: true, command: 'LOGS_READ', outcome: 'LOGS_READ', revision: '0',
      controlId: requestId, snapshot: null, records: [], truncated: false,
    })}\n`, 'utf8');
    const fixture = await listener((socket) => { socket.resume(); socket.once('end', () => socket.end(payload)); });
    try {
      await expect(run(fixture.path, Buffer.from(`${JSON.stringify({
        v: 'c1', requestControlId: requestId, command: 'LOGS_READ', operationUUID: '77777777-7777-4777-8777-777777777777',
      })}\n`, 'utf8'))).resolves.toEqual({ exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_PROTOCOL_ERROR\n') });
    } finally { await close(fixture); }
  });

  test('does not leak local invalid request bytes and uses closed protocol failure', async () => {
    const fixture = await listener((socket) => { socket.destroy(); });
    try {
      await expect(run(fixture.path, Buffer.from('{"v":"c1"}\nsecond\n'))).resolves.toEqual({
        exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_PROTOCOL_ERROR\n'),
      });
    } finally { await close(fixture); }
  });

  test('rejects a non-private or unavailable socket before making a connection', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-cli-missing-'));
    try {
      await expect(run(join(parent, `${randomUUID()}.sock`), request())).resolves.toEqual({
        exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_CONNECT_FAILED\n'),
      });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  test('uses the normal 8-second deadline before receipt of any response bytes', async () => {
    let peer: Socket | undefined;
    const fixture = await listener((socket) => { peer = socket; socket.resume(); });
    const startedAt = Date.now();
    try {
      await expect(run(fixture.path, request())).resolves.toEqual({
        exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_REQUEST_TIMEOUT\n'),
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(7_500);
      expect(Date.now() - startedAt).toBeLessThan(9_500);
    } finally { peer?.destroy(); await close(fixture); }
  }, 12_000);

  test('uses DRAIN timeoutMs plus seven seconds before receipt of any response bytes', async () => {
    let peer: Socket | undefined;
    const fixture = await listener((socket) => { peer = socket; socket.resume(); });
    const startedAt = Date.now();
    try {
      await expect(run(fixture.path, drainRequest(1))).resolves.toEqual({
        exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_REQUEST_TIMEOUT\n'),
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(6_500);
      expect(Date.now() - startedAt).toBeLessThan(8_500);
    } finally { peer?.destroy(); await close(fixture); }
  }, 12_000);

  test('gives an exact DRAIN line its finite total deadline before EOF, without making stdin unbounded', async () => {
    let connections = 0;
    const fixture = await listener((socket) => { connections += 1; socket.destroy(); });
    const startedAt = Date.now();
    const client = start(fixture.path);
    // EOF is still the acquisition delimiter, so no connection may occur.
    // But an already complete exact DRAIN line earns its D184 total budget
    // from CLI start.  Leaving stdin open can therefore wait at most 37s,
    // never indefinitely.
    client.child.stdin!.write(drainRequest(30_000));
    try {
      await expect(client.result).resolves.toEqual({
        exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_REQUEST_TIMEOUT\n'),
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(36_500);
      expect(Date.now() - startedAt).toBeLessThan(39_500);
      expect(connections).toBe(0);
    } finally { client.child.stdin?.destroy(); await close(fixture); }
  }, 45_000);

  test('counts slow stdin acquisition against a DRAIN total deadline', async () => {
    let connections = 0;
    const fixture = await listener((socket) => { connections += 1; socket.destroy(); });
    const startedAt = Date.now();
    const client = start(fixture.path);
    try {
      // Once this exact request finally reaches EOF, its total DRAIN budget
      // (1 + 7000ms) has already elapsed.  The CLI must not restart that
      // budget at EOF or attempt a socket exchange.
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 7_400));
      client.child.stdin!.end(drainRequest(1));
      await expect(client.result).resolves.toEqual({
        exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('CONTROL_REQUEST_TIMEOUT\n'),
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(7_000);
      expect(Date.now() - startedAt).toBeLessThan(9_500);
      expect(connections).toBe(0);
    } finally { client.child.stdin?.destroy(); await close(fixture); }
  }, 12_000);
});
