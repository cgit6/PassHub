import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';
import type { Db } from 'mongodb';

import { createPersistentRunClaimer } from '../../src/deployment/internal/g11b-persistent-run-claim.js';
import { G04B_STARTUP_VECTORS } from '../../src/infrastructure/mongo/g04b-schema.js';
import { createVerifiedDatasetVerifierForTest } from '../support/g11b-dataset-verification-test-support.js';
import { createG11bRunTicketIntakeForFsTest } from '../support/g11b-run-ticket-test-support.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'passhub-b3b-unit-'))) throw new Error('unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

function metadata(epoch: string, claim: null | { runId: string; claimedAt: Date } = null) {
  return {
    _id: 'system', kind: 'system', datasetEpoch: epoch,
    comparisonReferenceId: '33333333-3333-4333-8333-333333333333', frameVersion: 'v2',
    startupVectors: G04B_STARTUP_VECTORS.map((vector) => ({ ...vector })),
    qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 0, writeRunClaim: claim,
  };
}

async function genuineTicket(epoch: string, runId: string) {
  const directory = await mkdtemp(join(tmpdir(), 'passhub-b3b-unit-'));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  const path = join(directory, 'bootstrap-ticket.json');
  await writeFile(path, `${JSON.stringify({
    v: 'g11b.run-ticket.v1', ticketId: randomUUID(), datasetEpoch: epoch, processRunId: runId,
  })}\n`, { mode: 0o400 });
  await chmod(path, 0o400);
  return createG11bRunTicketIntakeForFsTest(directory)(runId);
}

async function setup(options: {
  cas?: (filter: unknown, update: unknown, options: unknown) => Promise<unknown>;
  find?: (filter: unknown, options: unknown) => Promise<unknown>;
} = {}) {
  const epoch = randomUUID();
  const runId = randomUUID();
  const cas = jest.fn(options.cas ?? (async () => metadata(epoch, { runId, claimedAt: new Date(1234) })));
  const find = jest.fn(options.find ?? (async () => metadata(epoch, null)));
  const collection = jest.fn(() => ({ findOneAndUpdate: cas, findOne: find }));
  const database = { collection } as unknown as Db;
  const verifier = createVerifiedDatasetVerifierForTest(database, () => metadata(epoch));
  const verified = await verifier.verify();
  const ticket = await genuineTicket(epoch, runId);
  const claimer = createPersistentRunClaimer(database, verifier);
  return { epoch, runId, cas, find, collection, database, verifier, verified, ticket, claimer };
}

function expectExactCas(ctx: Awaited<ReturnType<typeof setup>>): void {
  expect(ctx.cas).toHaveBeenCalledTimes(1);
  expect(ctx.cas).toHaveBeenCalledWith(
    { _id: 'system', kind: 'system', datasetEpoch: ctx.epoch, writeRunClaim: null },
    [{ $set: { writeRunClaim: { runId: { $literal: ctx.runId }, claimedAt: '$$NOW' } } }],
    {
      upsert: false, returnDocument: 'after', includeResultMetadata: false,
      readPreference: 'primary', writeConcern: { w: 'majority', j: true }, timeoutMS: 2000,
    },
  );
}

function expectExactClassification(ctx: Awaited<ReturnType<typeof setup>>): void {
  expect(ctx.find).toHaveBeenCalledTimes(1);
  expect(ctx.find).toHaveBeenCalledWith(
    { _id: 'system' },
    { readPreference: 'primary', readConcern: { level: 'majority' }, timeoutMS: 2000 },
  );
}

describe('G11b-b3b fixed Mongo command contract', () => {
  test('successful CAS uses the exact fixed collection, filter, pipeline, and options', async () => {
    const ctx = await setup();
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toMatchObject({ status: 'CLAIMED' });
    expect(ctx.collection).toHaveBeenCalledTimes(1);
    expect(ctx.collection).toHaveBeenCalledWith('metadata');
    expectExactCas(ctx);
    expect(ctx.find).not.toHaveBeenCalled();
  });

  test.each([
    ['held', (epoch: string) => metadata(epoch, { runId: randomUUID(), claimedAt: new Date(1) }), 'CLAIM_HELD'],
    ['epoch mismatch', () => metadata(randomUUID()), 'EPOCH_MISMATCH'],
    ['missing', () => null, 'METADATA_MISSING_OR_INVALID'],
    ['malformed', (epoch: string) => ({ ...metadata(epoch), extra: true }), 'METADATA_MISSING_OR_INVALID'],
    ['same epoch remains unclaimed', (epoch: string) => metadata(epoch), 'CLAIM_UNKNOWN'],
  ])('null CAS then exact one majority classification: %s', async (_label, observed, status) => {
    const ctx = await setup({ cas: async () => null, find: async () => observed(ctx.epoch) });
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status });
    expectExactCas(ctx);
    expectExactClassification(ctx);
  });

  test.each([
    ['throw', async () => { throw new Error('secret'); }],
    ['malformed', async () => ({ nope: true })],
  ])('CAS %s is UNKNOWN and performs no classification read', async (_label, cas) => {
    const ctx = await setup({ cas });
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status: 'CLAIM_UNKNOWN' });
    expectExactCas(ctx);
    expect(ctx.find).not.toHaveBeenCalled();
  });
});

describe('G11b-b3b private production boundary', () => {
  test('facade is private, fixed, and contains no destructive/bootstrap API', async () => {
    const facadeName = ['g11b', 'persistent', 'run', 'claim'].join('-');
    const source = await readFile(join(process.cwd(), `src/deployment/internal/${facadeName}.ts`), 'utf8');
    for (const required of ['2_000', "collection<G04bMetadataDocument>('metadata')", "claimedAt: '$$NOW'", 'includeResultMetadata: false']) {
      expect(source).toContain(required);
    }
    for (const forbidden of ['clear', 'delete', 'ensure', 'seed', 'reset', 'session', 'transaction', 'projection', 'comment', 'bypass']) {
      expect(source.toLowerCase()).not.toContain(forbidden);
    }
    for (const barrel of ['src/index.ts', 'src/composition/index.ts', 'src/infrastructure/mongo/index.ts']) {
      expect((await readFile(join(process.cwd(), barrel), 'utf8')).toLowerCase()).not.toContain(facadeName);
    }
    const productionMain = await readFile(join(process.cwd(), 'src/deployment/production-main.ts'), 'utf8');
    expect(productionMain).toContain('maxAdaptiveRetries: 0');
    expect(productionMain).not.toContain('createPersistentRunClaimer');
  });

  test('claim engine importer graph is locked to facade and test support', async () => {
    const guarded = ['g11b', 'persistent', 'run', 'claim', 'engine'].join('-');
    const importers: string[] = [];
    for (const rootName of ['src', 'test']) {
      const root = join(process.cwd(), rootName);
      for (const name of (await readdir(root, { recursive: true })).filter((entry) => entry.endsWith('.ts'))) {
        if ((await readFile(join(root, name), 'utf8')).includes(guarded)) importers.push(`${rootName}/${name}`);
      }
    }
    expect(importers.sort()).toEqual([
      'src/deployment/internal/g11b-persistent-run-claim.ts',
      'test/support/g11b-persistent-run-claim-test-support.ts',
    ]);
  });
});
