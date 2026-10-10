import type { MongoClient } from 'mongodb';

import { createG11bProductionApplication } from '../../src/deployment/internal/g11b-production-application.js';
import * as processIdentity from '../../src/deployment/internal/g11b-process-identity-intake.js';
import * as ticketIntake from '../../src/deployment/internal/g11b-run-ticket-intake.js';
import * as verification from '../../src/deployment/internal/g11b-dataset-verification.js';
import * as claim from '../../src/deployment/internal/g11b-persistent-run-claim.js';
import { DatasetDescriptorIntakeError } from '../../src/deployment/internal/g12g1-dataset-descriptor-intake.js';
import type { ProductionDatasetTarget } from '../../src/deployment/internal/g12g1-deployment-profile.js';
import { G04B_STARTUP_VECTORS } from '../../src/infrastructure/mongo/g04b-schema.js';
import { createVerifiedDatasetVerifierForTest } from '../support/g11b-dataset-verification-test-support.js';

const RUN = '22222222-2222-4222-8222-222222222222';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const OTHER_EPOCH = '33333333-3333-4333-8333-333333333333';
const KEY = Buffer.from('j'.repeat(32));
const COMPARISON = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

afterEach(() => jest.restoreAllMocks());

function context(databaseName: ProductionDatasetTarget['databaseName']) {
  const calls: string[] = [];
  const database = Object.freeze({});
  const mongo = {
    on: jest.fn().mockReturnThis(),
    db: jest.fn((name: string) => {
      calls.push(`db:${name}`);
      expect(name).toBe(databaseName);
      return database;
    }),
  } as unknown as MongoClient;
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
  const consume = jest.spyOn(ticketIntake, 'consumeCanonicalRunTicket').mockImplementation(async () => {
    calls.push('ticket');
    throw new ticketIntake.RunTicketIntakeError('TICKET_NOT_PROVEN');
  });
  const createClaim = jest.spyOn(claim, 'createPersistentRunClaimer');
  return { calls, mongo, consume, createClaim };
}

describe('G12g-1 production dataset target injection', () => {
  test.each([
    ['passhub_demo_blue', 'BLUE'],
    ['passhub_demo_green', 'GREEN'],
  ] as const)('injects Atlas %s into the existing production composition (%s)', async (databaseName, _slot) => {
    const fixture = context(databaseName);
    const target: ProductionDatasetTarget = Object.freeze({
      databaseName,
      expectedDatasetEpoch: EPOCH,
    });
    const result = await createG11bProductionApplication(fixture.mongo, target, KEY, COMPARISON);
    expect(fixture.calls).toEqual(['identity', `db:${databaseName}`, 'verify', 'ticket']);
    expect(fixture.createClaim).not.toHaveBeenCalled();
    expect(result.application).toBeNull();
    expect(result.serviceGate.isOpen()).toBe(false);
    await result.close();
  });

  test('descriptor epoch mismatch fails before ticket consumption and durable claim', async () => {
    const fixture = context('passhub_demo_blue');
    const target: ProductionDatasetTarget = Object.freeze({
      databaseName: 'passhub_demo_blue',
      expectedDatasetEpoch: OTHER_EPOCH,
    });
    await expect(createG11bProductionApplication(fixture.mongo, target, KEY, COMPARISON))
      .rejects.toEqual(expect.objectContaining<Partial<DatasetDescriptorIntakeError>>({
        code: 'DATASET_DESCRIPTOR_EPOCH_MISMATCH',
        message: 'DATASET_DESCRIPTOR_EPOCH_MISMATCH',
      }));
    expect(fixture.calls).toEqual(['identity', 'db:passhub_demo_blue', 'verify']);
    expect(fixture.consume).not.toHaveBeenCalled();
    expect(fixture.createClaim).not.toHaveBeenCalled();
  });
});
