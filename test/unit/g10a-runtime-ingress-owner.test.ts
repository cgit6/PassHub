import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createG10aIngressIdentityHandler,
  getG10aIngressIdentity,
  readG10aIngressIdentity,
} from '../../src/composition/internal/g10a-ingress-identity.js';
import { createG10aRuntimeHttpApplication } from '../../src/composition/internal/g10a-runtime-http-application.js';
import { createG10aOperationIdentityBinding } from '../../src/composition/internal/g10a-operation-identity-binding.js';
import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { validateRuntimeLogRecord } from '../../src/runtime/internal/runtime-log-schema.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';

async function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    client.once('error', reject);
    client.end();
  });
}

describe('G10a runtime-owned strict ingress logging', () => {
  const parents: string[] = [];
  afterEach(async () => {
    await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
  });

  test('starts the real private owner before HTTP, emits only exact REQUEST_ACCEPTED records, and closes HTTP before the owner', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-runtime-ingress-'));
    parents.push(parent);
    const logDirectory = join(parent, 'logs');
    const controlDirectory = join(parent, 'control');
    const owner = createG10aRuntimeOwner({
      epoch,
      run,
      logDirectory,
      controlDirectory,
      controlSocketPath: join(controlDirectory, RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: Object.freeze({ nowMs: () => performance.now() }),
      awaitObservation: () => undefined,
    });

    const composed = await createG10aRuntimeHttpApplication({
      runtimeOwner: owner,
      createAcceptedHandler: (runtime) => createG10aIngressIdentityHandler({
        runtime,
        handler: (_accepted, _request, response) => {
          response.statusCode = 204;
          response.end();
        },
      }),
    });
    await composed.application.nestApplication.listen(0, '127.0.0.1');
    const address = composed.application.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP listener');

    expect(await get(address.port, '/qualifications')).toBe(204);
    // A strict but non-business request reaches the handler yet has no legal
    // route value for REQUEST_ACCEPTED, so it must not fabricate a record.
    expect(await get(address.port, '/not-a-business-route')).toBe(204);
    expect(await get(address.port, '/events')).toBe(204);

    const runtime = await owner.start();
    await runtime.runtimeLogSink.flush();
    const records = (await readFile(join(logDirectory, 'runtime.log'), 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.code)).toEqual(['REQUEST_ACCEPTED', 'REQUEST_ACCEPTED']);
    expect(records.map((record) => record.route)).toEqual(['QUERY', 'QUERY']);
    expect(records[0]).toMatchObject({
      schemaVersion: 'g10a.log.v1', kind: 'RUNTIME', phase: 'INGRESS',
      operationUUID: null, ownerRef: null, datasetEpoch: epoch, processRunId: run,
      round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
      commandName: null, driverRequestId: null, requestControlId: null, controlId: null, revision: null,
    });
    expect(records[0]?.requestUUID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(records[1]?.requestUUID).not.toBe(records[0]?.requestUUID);

    await composed.close();
    expect(runtime.runtimeLogSink.snapshot().closed).toBe(true);
    // Closing the lifecycle root stops transport intake before it closes the
    // owner.  A previously valid port must not keep accepting traffic, and
    // neither the owner nor its closed sink may be reused afterwards.
    await expect(get(address.port, '/qualifications')).rejects.toBeDefined();
    await expect(owner.start()).rejects.toThrow('runtime owner is closed');
    expect(runtime.runtimeLogSink.append(records[0]!)).toBe(false);
    await expect(composed.close()).resolves.toBeUndefined();
  });

  test('accepts only the indivisible, owner-issued runtime capability bundle', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-runtime-capability-'));
    parents.push(parent);
    const ownerA = createG10aRuntimeOwner({
      epoch,
      run,
      logDirectory: join(parent, 'logs-a'),
      controlDirectory: join(parent, 'control-a'),
      controlSocketPath: join(parent, 'control-a', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: Object.freeze({ nowMs: () => performance.now() }),
      awaitObservation: () => undefined,
    });
    const ownerB = createG10aRuntimeOwner({
      epoch,
      run,
      logDirectory: join(parent, 'logs-b'),
      controlDirectory: join(parent, 'control-b'),
      controlSocketPath: join(parent, 'control-b', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: Object.freeze({ nowMs: () => performance.now() }),
      awaitObservation: () => undefined,
    });
    const [runtimeA, runtimeB] = await Promise.all([ownerA.start(), ownerB.start()]);
    const handler = (_accepted: unknown, _request: unknown, _response: unknown): void => undefined;

    // A structural clone has all visible fields but not the private owner
    // capability membership.  JavaScript callers cannot forge it.
    expect(() => createG10aIngressIdentityHandler({
      handler: handler as never,
      runtime: { ...runtimeA },
    } as unknown as Parameters<typeof createG10aIngressIdentityHandler>[0])).toThrow(
      'G10a ingress identity options are invalid',
    );
    // Nor may a caller splice A's issuer together with B's sink: only the
    // exact owner-issued bundle is accepted at the ingress boundary.
    expect(() => createG10aIngressIdentityHandler({
      handler: handler as never,
      runtime: { ...runtimeA, runtimeLogSink: runtimeB.runtimeLogSink },
    } as unknown as Parameters<typeof createG10aIngressIdentityHandler>[0])).toThrow(
      'G10a ingress identity options are invalid',
    );
    expect(() => createG10aIngressIdentityHandler({
      handler: handler as never,
      runtime: runtimeA,
    })).not.toThrow();

    await Promise.all([ownerA.close(), ownerB.close()]);
  });

  test('issues each read request through its owner issuer and leaves writers pending their real operation token', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-runtime-ingress-identity-'));
    parents.push(parent);
    const owner = createG10aRuntimeOwner({
      epoch,
      run,
      logDirectory: join(parent, 'logs'),
      controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: Object.freeze({ nowMs: () => performance.now() }),
      awaitObservation: () => undefined,
    });
    const runtime = await owner.start();
    const accepted: unknown[] = [];
    const handler = createG10aIngressIdentityHandler({
      runtime,
      handler: (value) => { accepted.push(value); },
    });
    const headers = Object.freeze({});
    handler(Object.freeze({ method: 'GET', body: null, query: Object.freeze([]), headers }),
      { originalUrl: '/events' } as never, {} as never, (() => undefined) as never);
    handler(Object.freeze({ method: 'GET', body: null, query: Object.freeze([]), headers }),
      { originalUrl: '/qualifications' } as never, {} as never, (() => undefined) as never);
    handler(Object.freeze({ method: 'POST', body: null, query: Object.freeze([]), headers }),
      { originalUrl: '/qualifications' } as never, {} as never, (() => undefined) as never);
    handler(Object.freeze({ method: 'POST', body: null, query: Object.freeze([]), headers }),
      { originalUrl: '/auth/login' } as never, {} as never, (() => undefined) as never);
    handler(Object.freeze({ method: 'POST', body: null, query: Object.freeze([]), headers }),
      { originalUrl: '/recognition/attempts' } as never, {} as never, (() => undefined) as never);

    const [firstAccepted, secondAccepted, writerAccepted, loginAccepted, recognitionAccepted] = accepted;
    const first = readG10aIngressIdentity(getG10aIngressIdentity(firstAccepted as never)!);
    const second = readG10aIngressIdentity(getG10aIngressIdentity(secondAccepted as never)!);
    const writer = readG10aIngressIdentity(getG10aIngressIdentity(writerAccepted as never)!);
    const login = readG10aIngressIdentity(getG10aIngressIdentity(loginAccepted as never)!);
    const recognition = readG10aIngressIdentity(getG10aIngressIdentity(recognitionAccepted as never)!);

    expect(first.runtimeIdentity).not.toBeNull();
    expect(second.runtimeIdentity).not.toBeNull();
    expect(first.runtimeIdentity).not.toBe(second.runtimeIdentity);
    expect(first.requestUUID).not.toBe(second.requestUUID);
    expect(runtime.identityIssuer.read(first.runtimeIdentity!)).toMatchObject({
      requestUUID: first.requestUUID, route: 'QUERY', datasetEpoch: epoch, processRunId: run,
      operationUUID: null, ownerRef: null,
    });
    expect(runtime.identityIssuer.read(second.runtimeIdentity!)).toMatchObject({
      requestUUID: second.requestUUID, route: 'QUERY', datasetEpoch: epoch, processRunId: run,
      operationUUID: null, ownerRef: null,
    });
    expect(login.runtimeIdentity).not.toBeNull();
    expect(runtime.identityIssuer.read(login.runtimeIdentity!)).toMatchObject({
      requestUUID: login.requestUUID, route: 'LOGIN', datasetEpoch: epoch, processRunId: run,
      operationUUID: null, ownerRef: null,
    });
    expect(writer).toMatchObject({ route: 'MANAGEMENT_CREATE', runtimeIdentity: null, pendingOperationBinding: true });
    expect(recognition).toMatchObject({ route: 'RECOGNITION', runtimeIdentity: null, pendingOperationBinding: true });
    expect(new Set([first.requestUUID, second.requestUUID, writer.requestUUID, login.requestUUID, recognition.requestUUID]).size)
      .toBe(5);
    expect(() => runtime.identityIssuer.read({} as never)).toThrow('runtime identity is not issued by this issuer');

    // The pending writer identity is not merely an in-memory convention: its
    // accepted record must keep the operation fields null until a later
    // coordinator binding exists.  This reads the real owner sink, rather
    // than observing a mocked logger.
    await runtime.runtimeLogSink.flush();
    const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.route)).toEqual([
      'QUERY', 'QUERY', 'MANAGEMENT_CREATE', 'LOGIN', 'RECOGNITION',
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        code: 'REQUEST_ACCEPTED', kind: 'RUNTIME', phase: 'INGRESS',
        operationUUID: null, ownerRef: null, datasetEpoch: epoch, processRunId: run,
      });
    }

    await owner.close();
  });

  test('binds one pending writer ingress to its coordinator operation and records OPERATION_REGISTERED', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-runtime-operation-'));
    parents.push(parent);
    const owner = createG10aRuntimeOwner({
      epoch,
      run,
      logDirectory: join(parent, 'logs'),
      controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: Object.freeze({ nowMs: () => performance.now() }),
      awaitObservation: () => undefined,
    });
    const runtime = await owner.start();
    const accepted: unknown[] = [];
    const ingress = createG10aIngressIdentityHandler({
      runtime,
      handler: (value) => { accepted.push(value); },
    });
    ingress(
      Object.freeze({ method: 'POST', body: null, query: Object.freeze([]), headers: Object.freeze({}) }),
      { originalUrl: '/qualifications' } as never, {} as never, (() => undefined) as never,
    );
    const receipt = Object.freeze({
      operationId: '33333333-3333-4333-8333-333333333333', receivedAtMs: 0, registeredAtMonotonicMs: 0, sequence: 0n,
    });
    const binding = createG10aOperationIdentityBinding(runtime);
    const identity = binding.bind(accepted[0] as never, receipt);
    expect(runtime.identityIssuer.read(identity)).toMatchObject({
      requestUUID: readG10aIngressIdentity(getG10aIngressIdentity(accepted[0] as never)!).requestUUID,
      operationUUID: receipt.operationId, route: 'MANAGEMENT_CREATE', datasetEpoch: epoch, processRunId: run,
    });
    expect(() => binding.bind(accepted[0] as never, receipt)).toThrow('G10a writer ingress identity is already bound');

    await runtime.runtimeLogSink.flush();
    const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
      .split('\n').filter((line) => line.length > 0)
      .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown));
    expect(records.map((record) => record.code)).toEqual(['REQUEST_ACCEPTED', 'OPERATION_REGISTERED']);
    expect(records[1]).toMatchObject({
      requestUUID: records[0]?.requestUUID, operationUUID: receipt.operationId,
      route: 'MANAGEMENT_CREATE', phase: 'ADMISSION', ownerRef: expect.any(String),
    });
    await owner.close();
  });
});
