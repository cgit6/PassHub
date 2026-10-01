import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MongoClient } from 'mongodb';

import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import { createG10aDriverLogBinding } from '../../src/composition/internal/g10a-driver-log-binding.js';
import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { validateRuntimeLogRecord } from '../../src/runtime/internal/runtime-log-schema.js';

const URI = process.env.G10A_MONGO_URI ?? 'mongodb://127.0.0.1:27029/?replicaSet=rs0';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

/**
 * This is intentionally an independent true-driver integration seam, not a
 * G10a evidence run.  It proves that official Mongo command-monitoring events
 * (rather than a hand-emitted EventEmitter fixture) can be attributed by the
 * private runtime binding.  The future G10a integration runner owns Docker,
 * evidence manifest, and broader G07/G08 flow coverage.
 */
describe('G10a true MongoDB driver command monitoring', () => {
  let parent: string;
  let client: MongoClient;
  let owner: ReturnType<typeof createG10aRuntimeOwner>;
  let databaseName: string;

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-driver-log-'));
    databaseName = `passhub_g10a_driver_${process.pid}`.slice(0, 63);
    client = new MongoClient(URI, { monitorCommands: true, retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 });
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    expect(hello).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
    owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    await owner.start();
    // Construction binds the real client's official command events exactly once.
    new G04bMongoPersistenceAdapter(client, databaseName);
  });

  afterAll(async () => {
    await client.db(databaseName).dropDatabase().catch(() => undefined);
    await client.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });

  test('attributes real insert/find command lifecycle to writer and read identities without command payloads', async () => {
    const runtime = await owner.start();
    const binding = createG10aDriverLogBinding(runtime);
    const writerToken = runtime.identityIssuer.issueBusinessToken({ operationUUID: randomUUID(), ownerRef: randomUUID() });
    const writer = runtime.identityIssuer.issue({ requestUUID: randomUUID(), operationToken: writerToken, route: 'MANAGEMENT_CREATE' });
    const reader = runtime.identityIssuer.issue({ requestUUID: randomUUID(), operationToken: null, operationUUID: null, ownerRef: null, route: 'QUERY' });
    const collection = client.db(databaseName).collection<{ readonly _id: string }>('g10a_driver_probe');

    await binding.run(writer, async () => {
      await collection.insertOne({ _id: 'writer-probe' });
      await collection.findOne({ _id: 'writer-probe' });
      // A malformed raw `find` reaches the server, so the real driver emits
      // commandFailed (unlike duplicate-key writeErrors in a succeeded insert reply).
      await expect(client.db(databaseName).command({ find: 'g10a_driver_probe', filter: 'not-a-document' })).rejects.toBeDefined();
      // `ping` is a genuine driver command but intentionally outside D184's allowlist.
      await client.db(databaseName).command({ ping: 1 });
    });
    await binding.run(reader, async () => { await collection.findOne({ _id: 'reader-probe' }); });
    await binding.run(reader, async () => {
      await Promise.all(Array.from({ length: 12 }, (_, index) => collection.findOne({ _id: `parallel-${index}` })));
    });
    await runtime.runtimeLogSink.flush();

    const records = (await readFile(join(parent, 'logs', 'runtime.log'), 'utf8'))
      .split('\n').filter((line) => line.length > 0)
      .map((line) => validateRuntimeLogRecord(JSON.parse(line) as unknown))
      .filter((record) => record.kind === 'DRIVER');
    expect(records.length).toBeGreaterThanOrEqual(8);
    expect(records.every((record) => ['find', 'aggregate', 'insert', 'update', 'delete', 'findAndModify', 'commitTransaction', 'abortTransaction', 'endSessions'].includes(record.commandName!))).toBe(true);
    expect(records.filter((record) => record.route === 'MANAGEMENT_CREATE').every((record) =>
      record.requestUUID === runtime.identityIssuer.read(writer).requestUUID
      && record.operationUUID === runtime.identityIssuer.read(writer).operationUUID
      && record.ownerRef === runtime.identityIssuer.read(writer).ownerRef
      && record.phase === 'DRIVER' && record.driverRequestId !== null,
    )).toBe(true);
    expect(records.filter((record) => record.route === 'QUERY').every((record) =>
      record.requestUUID === runtime.identityIssuer.read(reader).requestUUID
      && record.operationUUID === null && record.ownerRef === null,
    )).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_STARTED' && record.commandName === 'insert')).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_SUCCEEDED' && record.commandName === 'insert')).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_FAILED' && record.commandName === 'find')).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_STARTED' && record.commandName === 'find')).toBe(true);
    expect(records.some((record) => record.code === 'DRIVER_SUCCEEDED' && record.commandName === 'find')).toBe(true);
    const starts = records.filter((record) => record.code === 'DRIVER_STARTED');
    const terminals = records.filter((record) => record.code === 'DRIVER_SUCCEEDED' || record.code === 'DRIVER_FAILED');
    expect(starts).toHaveLength(terminals.length);
    // connectionId is intentionally absent from the on-disk contract, so the
    // displayed requestId is diagnostic only and cannot prove the bridge's
    // private composite key. Concurrent real finds instead prove that each
    // emitted read record retains the read identity and lifecycle balances.
    expect(records.filter((record) => record.route === 'QUERY' && record.commandName === 'find' && record.code === 'DRIVER_STARTED').length).toBeGreaterThanOrEqual(13);
  });
});
