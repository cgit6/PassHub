import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRuntimeControlSocketService } from '../../src/runtime/internal/runtime-control-socket-service.js';
import { createRuntimeControl, createRuntimeIdentityIssuer } from '../../src/runtime/internal/runtime-control.js';
import { createG11cMaintenanceMarkerAdapter } from '../../src/deployment/internal/g11c-maintenance-marker.js';
import { createG11cMaintenanceComposition } from '../../src/deployment/internal/g11c-maintenance-composition.js';
import { createG11cPrivateDrainAdapter } from '../../src/deployment/internal/g11c-private-drain.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), 'passhub-g11c-drain-'));
  roots.push(root);
  // The host marker directory is traversable by the read-only NGINX edge;
  // the private AF_UNIX socket lives in its own 0700 runtime directory in
  // production.  This fixture models the marker side of that split.
  await chmod(root, 0o755);
  const controlDirectory = join(root, 'control');
  await mkdir(controlDirectory, { mode: 0o700 });
  const socketPath = join(controlDirectory, 'runtime-control.sock');
  const control = createRuntimeControl({
    epoch, run, identityIssuer: createRuntimeIdentityIssuer({ datasetEpoch: epoch, processRunId: run }),
    clock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    controlIdFactory: randomUUID,
  });
  const service = await createRuntimeControlSocketService({ control, directory: controlDirectory, socketPath });
  return { root, socketPath, control, service };
}

function processEffects(order: string[]) {
  return {
    requestApiStop: async () => { order.push('API_STOP'); },
    awaitApiProcessGone: async () => { order.push('API_GONE'); },
    requestMongoStop: async () => { order.push('MONGO_STOP'); },
    awaitMongoProcessGone: async () => { order.push('MONGO_GONE'); },
    awaitMongoPrimary: async () => { order.push('MONGO_PRIMARY'); },
    verifyNoLateWork: async () => { order.push('NO_LATE'); },
  };
}

describe('G11c production-private marker and G10a drain composition', () => {
  test('real marker plus AF_UNIX G10a DRAIN reaches process isolation ports', async () => {
    const runtimeFixture = await runtime();
    const order: string[] = [];
    const composition = createG11cMaintenanceComposition({
      marker: createG11cMaintenanceMarkerAdapter({ directory: runtimeFixture.root }),
      drain: createG11cPrivateDrainAdapter({ socketPath: runtimeFixture.socketPath, epoch, run }),
      process: processEffects(order),
    });
    await expect(composition.run(1_000)).resolves.toMatchObject({ phase: 'NO_LATE_WORK_VERIFIED', drain: 'DRAINED', failure: null });
    expect(order).toEqual(['API_STOP', 'API_GONE', 'MONGO_STOP', 'MONGO_GONE', 'MONGO_PRIMARY', 'NO_LATE']);
    expect(runtimeFixture.control.snapshot()).toMatchObject({ maintenance: { active: true, outcome: 'DRAINED' } });
    await runtimeFixture.service.close();
  });

  test('real AF_UNIX drain timeout is retained as unavailable while process isolation continues', async () => {
    const runtimeFixture = await runtime();
    const lease = runtimeFixture.control.acquireIssuedPersistence();
    const order: string[] = [];
    const composition = createG11cMaintenanceComposition({
      marker: createG11cMaintenanceMarkerAdapter({ directory: runtimeFixture.root }),
      drain: createG11cPrivateDrainAdapter({ socketPath: runtimeFixture.socketPath, epoch, run }),
      process: processEffects(order),
    });
    await expect(composition.run(1)).resolves.toMatchObject({ phase: 'NO_LATE_WORK_VERIFIED', drain: 'NOT_DRAINED', failure: 'DRAIN_UNAVAILABLE' });
    expect(order).toEqual(['API_STOP', 'API_GONE', 'MONGO_STOP', 'MONGO_GONE', 'MONGO_PRIMARY', 'NO_LATE']);
    lease.release();
    await runtimeFixture.service.close();
  });

  test('private drain maps an unavailable socket to INTERNAL_UNAVAILABLE without throwing', async () => {
    await expect(createG11cPrivateDrainAdapter({ socketPath: '/tmp/nonexistent-passhub-g11c.sock', epoch, run }).drain(1))
      .resolves.toBe('INTERNAL_UNAVAILABLE');
  });
});
