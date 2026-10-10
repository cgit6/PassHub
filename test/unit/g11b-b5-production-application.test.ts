import type { MongoClient } from 'mongodb';
import { createG11bProductionApplication, createG11bProductionMonotonicClock } from '../../src/deployment/internal/g11b-production-application.js';
import * as processIdentity from '../../src/deployment/internal/g11b-process-identity-intake.js';
import * as ticketIntake from '../../src/deployment/internal/g11b-run-ticket-intake.js';
import * as verification from '../../src/deployment/internal/g11b-dataset-verification.js';
import { LOCAL_PRODUCTION_DATASET_TARGET } from '../../src/deployment/internal/g12g1-deployment-profile.js';
import * as claim from '../../src/deployment/internal/g11b-persistent-run-claim.js';
import { createVerifiedDatasetVerifierForTest } from '../support/g11b-dataset-verification-test-support.js';
import { G04B_STARTUP_VECTORS } from '../../src/infrastructure/mongo/g04b-schema.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createG11bRunTicketIntakeForFsTest } from '../support/g11b-run-ticket-test-support.js';
import { createPersistentRunClaimerForTest } from '../support/g11b-persistent-run-claim-test-support.js';
import * as schemaActivation from '../../src/infrastructure/mongo/internal/g11b-existing-schema-activation.js';

const RUN = '22222222-2222-4222-8222-222222222222';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const KEY = Buffer.from('j'.repeat(32));
const COMPARISON = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

afterEach(() => jest.restoreAllMocks());

function ordinaryContext() {
  const calls: string[] = [];
  const database = Object.freeze({});
  const mongo = { on: jest.fn().mockReturnThis(), db: jest.fn((name: string) => {
    expect(name).toBe('passhub_demo');
    return database;
  }) } as unknown as MongoClient;
  jest.spyOn(processIdentity, 'readCanonicalProcessRunId').mockImplementation(async () => {
    calls.push('identity');
    return RUN;
  });
  const metadata = {
      _id: 'system', kind: 'system', datasetEpoch: EPOCH,
      comparisonReferenceId: EPOCH, frameVersion: 'v2', startupVectors: G04B_STARTUP_VECTORS,
      qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 0, writeRunClaim: null,
    };
  const verifier = createVerifiedDatasetVerifierForTest(database, () => {
    calls.push('verify');
    return metadata;
  });
  jest.spyOn(verification, 'createVerifiedDatasetVerifier').mockImplementation((target) => {
    expect(target).toBe(database);
    return verifier;
  });
  const consume = jest.spyOn(ticketIntake, 'consumeCanonicalRunTicket').mockImplementation(async (run) => {
    calls.push('ticket');
    expect(run).toBe(RUN);
    throw new ticketIntake.RunTicketIntakeError('TICKET_NOT_PROVEN');
  });
  const createClaim = jest.spyOn(claim, 'createPersistentRunClaimer');
  return { calls, mongo, consume, createClaim, database, verifier, metadata };
}

describe('G11b b5 production ordinary boot boundary', () => {
  test('fractional monotonic measurements are normalized for the integer-only budget ledger', () => {
    const measurement = jest.spyOn(performance, 'now').mockReturnValue(12.75);
    const clock = createG11bProductionMonotonicClock();
    expect(clock.nowMs()).toBe(12);
    measurement.mockReturnValue(12.99);
    expect(clock.nowMs()).toBe(12);
    measurement.mockReturnValue(13.01);
    expect(clock.nowMs()).toBe(13);
  });
  test('post-claim composition failure preserves the claim and returns a closed diagnostic application', async () => {
    const context = ordinaryContext();
    const directory = await mkdtemp(join(tmpdir(), 'passhub-b5-postclaim-'));
    try {
      await chmod(directory, 0o700);
      const path = join(directory, 'bootstrap-ticket.json');
      await writeFile(path, `${JSON.stringify({
        v: 'g11b.run-ticket.v1', ticketId: randomUUID(), datasetEpoch: EPOCH, processRunId: RUN,
      })}\n`, { mode: 0o400 });
      const ticket = await createG11bRunTicketIntakeForFsTest(directory)(RUN);
      context.consume.mockResolvedValue(ticket);
      let durableClaim: { runId: string; claimedAt: Date } | null = null;
      const cas = jest.fn(async () => {
        durableClaim = { runId: RUN, claimedAt: new Date(1234) };
        return { ...context.metadata, writeRunClaim: durableClaim };
      });
      const classification = jest.fn(async () => null);
      context.createClaim.mockImplementation((target, verifier) =>
        createPersistentRunClaimerForTest(target, verifier, { compareAndSet: cas, classifyAfterNoMatch: classification }));
      jest.spyOn(schemaActivation, 'activateG11bExistingSchema').mockImplementation(() => { throw new Error('injected composition failure'); });
      const application = await createG11bProductionApplication(context.mongo, LOCAL_PRODUCTION_DATASET_TARGET, KEY, COMPARISON);
      expect(application.application).toBeNull();
      expect(application.serviceGate.isOpen()).toBe(false);
      expect(application.serviceGate.getState()).toBe('SHUTDOWN');
      expect(cas).toHaveBeenCalledTimes(1);
      expect(classification).not.toHaveBeenCalled();
      expect(durableClaim).toEqual({ runId: RUN, claimedAt: new Date(1234) });
      await application.close();
      expect(durableClaim).toEqual({ runId: RUN, claimedAt: new Date(1234) });
    } finally {
      if (!directory.startsWith(join(tmpdir(), 'passhub-b5-postclaim-'))) throw new Error('unsafe cleanup');
      await rm(directory, { recursive: true, force: true });
    }
  });
  test('missing canonical ticket produces closed diagnostic gate after exact read-only verification, without claim', async () => {
    const context = ordinaryContext();
    const application = await createG11bProductionApplication(context.mongo, LOCAL_PRODUCTION_DATASET_TARGET, KEY, COMPARISON);
    expect(context.calls).toEqual(['identity', 'verify', 'ticket']);
    expect(context.createClaim).not.toHaveBeenCalled();
    expect(application.application).toBeNull();
    expect(application.serviceGate.getState()).toBe('FAILED');
    expect(application.serviceGate.isOpen()).toBe(false);
    await application.close();
    expect(application.serviceGate.isOpen()).toBe(false);
  });

  test('unsafe or already consumed ticket never takes the ordinary absence branch or calls claim', async () => {
    const context = ordinaryContext();
    context.consume.mockRejectedValue(new ticketIntake.RunTicketIntakeError('TICKET_ALREADY_USED'));
    await expect(createG11bProductionApplication(context.mongo, LOCAL_PRODUCTION_DATASET_TARGET, KEY, COMPARISON)).rejects.toMatchObject({ code: 'TICKET_ALREADY_USED' });
    expect(context.createClaim).not.toHaveBeenCalled();
  });

  test('schema verification failure precedes ticket consumption and claim', async () => {
    const context = ordinaryContext();
    jest.spyOn(verification, 'createVerifiedDatasetVerifier').mockImplementation(() => {
      throw new verification.DatasetVerificationError('DATASET_VERIFICATION_FAILED');
    });
    await expect(createG11bProductionApplication(context.mongo, LOCAL_PRODUCTION_DATASET_TARGET, KEY, COMPARISON)).rejects.toMatchObject({ code: 'DATASET_VERIFICATION_FAILED' });
    expect(context.consume).not.toHaveBeenCalled();
    expect(context.createClaim).not.toHaveBeenCalled();
  });
});
