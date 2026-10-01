import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createG10aBusinessStepLogBinding } from '../../src/composition/internal/g10a-business-step-log-binding.js';
import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { createRuntimeIdentityIssuer } from '../../src/runtime/internal/runtime-control.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';

describe('G10a business-step log binding provenance', () => {
  test('rejects foreign and read-only identities without writing a record', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'passhub-g10a-step-provenance-'));
    const owner = createG10aRuntimeOwner({
      epoch: EPOCH, run: RUN,
      logDirectory: join(parent, 'logs'), controlDirectory: join(parent, 'control'),
      controlSocketPath: join(parent, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
      monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
    });
    try {
      const runtime = await owner.start();
      const binding = createG10aBusinessStepLogBinding(runtime);
      const foreignIssuer = createRuntimeIdentityIssuer({ datasetEpoch: EPOCH, processRunId: RUN });
      const foreignToken = foreignIssuer.issueBusinessToken({
        operationUUID: '44444444-4444-4444-8444-444444444444', ownerRef: '55555555-5555-4555-8555-555555555555',
      });
      const foreign = foreignIssuer.issue({ requestUUID: request, operationToken: foreignToken, route: 'MANAGEMENT_CREATE' });
      const reader = runtime.identityIssuer.issue({
        requestUUID: request, operationToken: null, operationUUID: null, ownerRef: null, route: 'QUERY',
      });
      expect(() => binding.begin(foreign)).toThrow(TypeError);
      expect(() => binding.begin(reader)).toThrow(TypeError);
      await runtime.runtimeLogSink.flush();
      expect(await readFile(join(parent, 'logs', 'runtime.log'), 'utf8')).toBe('');
    } finally {
      await owner.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });
});
