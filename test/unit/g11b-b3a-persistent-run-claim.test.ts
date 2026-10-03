import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';

import { G04B_STARTUP_VECTORS } from '../../src/infrastructure/mongo/g04b-schema.js';
import type { ConsumedRunTicket } from '../../src/deployment/internal/g11b-run-ticket-intake.js';
import type { VerifiedDataset } from '../../src/deployment/internal/g11b-dataset-verification.js';
import { createG11bRunTicketIntakeForFsTest } from '../support/g11b-run-ticket-test-support.js';
import { createVerifiedDatasetVerifierForTest } from '../support/g11b-dataset-verification-test-support.js';
import {
  ClaimedPersistentRun,
  PersistentRunClaimer,
  PersistentRunClaimError,
  createPersistentRunClaimerForTest,
  readClaimedPersistentRunForBridge,
  type PersistentRunClaimIo,
} from '../support/g11b-persistent-run-claim-test-support.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  for (const directory of tempDirectories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'passhub-b3a-'))) throw new Error('unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

function metadata(
  epoch: string,
  claim: null | { readonly runId: string; readonly claimedAt: Date } = null,
): Record<string, unknown> {
  return {
    _id: 'system', kind: 'system', datasetEpoch: epoch,
    comparisonReferenceId: '33333333-3333-4333-8333-333333333333', frameVersion: 'v2',
    startupVectors: G04B_STARTUP_VECTORS.map((vector) => ({ ...vector })),
    qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 0, writeRunClaim: claim,
  };
}

async function genuineTicket(epoch: string, runId: string): Promise<{
  readonly ticket: ConsumedRunTicket;
  readonly ticketId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'passhub-b3a-'));
  tempDirectories.push(directory);
  await chmod(directory, 0o700);
  const ticketId = randomUUID();
  const wire = `${JSON.stringify({
    v: 'g11b.run-ticket.v1', ticketId, datasetEpoch: epoch, processRunId: runId,
  })}\n`;
  const path = join(directory, 'bootstrap-ticket.json');
  await writeFile(path, wire, { mode: 0o400 });
  await chmod(path, 0o400);
  return Object.freeze({
    ticket: await createG11bRunTicketIntakeForFsTest(directory)(runId),
    ticketId,
  });
}

async function context(options: {
  readonly verifiedEpoch?: string;
  readonly ticketEpoch?: string;
  readonly runId?: string;
  readonly cas?: (request: unknown) => Promise<unknown | null>;
  readonly classify?: () => Promise<unknown | null>;
} = {}) {
  const verifiedEpoch = options.verifiedEpoch ?? randomUUID();
  const ticketEpoch = options.ticketEpoch ?? verifiedEpoch;
  const runId = options.runId ?? randomUUID();
  const target = Object.freeze({ id: randomUUID() });
  const verifier = createVerifiedDatasetVerifierForTest(target, () => metadata(verifiedEpoch));
  const verified = await verifier.verify();
  const { ticket, ticketId } = await genuineTicket(ticketEpoch, runId);
  const compareAndSet = jest.fn(options.cas ?? (async () => metadata(ticketEpoch, { runId, claimedAt: new Date(1234) })));
  const classifyAfterNoMatch = jest.fn(options.classify ?? (async () => metadata(ticketEpoch, null)));
  const io: PersistentRunClaimIo = { compareAndSet, classifyAfterNoMatch };
  const claimer = createPersistentRunClaimerForTest(target, verifier, io);
  return { target, verifier, verified, ticket, ticketId, runId, verifiedEpoch, ticketEpoch, claimer, compareAndSet, classifyAfterNoMatch };
}

async function expectClaimError(action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action;
    throw new Error('expected claim error');
  } catch (error) {
    expect(error).toBeInstanceOf(PersistentRunClaimError);
    expect(error).toMatchObject({ code, message: code });
    expect(error).not.toHaveProperty('cause');
  }
}

describe('G11b-b3a persistent claim outcomes', () => {
  test('valid CAS postimage mints one opaque claimed capability and exact private facts', async () => {
    const ctx = await context();
    const result = await ctx.claimer.claimOnce(ctx.verified, ctx.ticket);
    expect(result.status).toBe('CLAIMED');
    if (result.status !== 'CLAIMED') throw new Error('expected claimed');
    expect(result.claim).toBeInstanceOf(ClaimedPersistentRun);
    expect(Reflect.ownKeys(result.claim)).toEqual([]);
    expect(Object.isFrozen(result.claim)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(ctx.compareAndSet).toHaveBeenCalledTimes(1);
    expect(ctx.classifyAfterNoMatch).not.toHaveBeenCalled();
    const request = ctx.compareAndSet.mock.calls[0]![0];
    expect(request).toEqual({ datasetEpoch: ctx.ticketEpoch, processRunId: ctx.runId });
    expect(Reflect.ownKeys(request as object)).toEqual(['datasetEpoch', 'processRunId']);
    expect(request).not.toHaveProperty('ticketId');
    expect(Object.isFrozen(request)).toBe(true);
    const facts = readClaimedPersistentRunForBridge(
      ctx.claimer, result.claim, ctx.target, ctx.verifier, ctx.verified, ctx.ticket,
    );
    expect(facts).toEqual({
      datasetEpoch: ctx.ticketEpoch, processRunId: ctx.runId, ticketId: ctx.ticketId, claimedAtMillis: 1234,
    });
    expect(Object.isFrozen(facts)).toBe(true);
  });

  test('verified/ticket epoch mismatch returns EPOCH_MISMATCH with zero IO and consumes ticket', async () => {
    const ctx = await context({ verifiedEpoch: randomUUID(), ticketEpoch: randomUUID() });
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status: 'EPOCH_MISMATCH' });
    expect(ctx.compareAndSet).not.toHaveBeenCalled();
    expect(ctx.classifyAfterNoMatch).not.toHaveBeenCalled();
    await expectClaimError(ctx.claimer.claimOnce(ctx.verified, ctx.ticket), 'RUN_TICKET_ALREADY_USED');
  });

  test.each([
    ['CAS throw', async () => { throw new Error('raw secret'); }],
    ['undefined postimage', async () => undefined],
    ['scalar postimage', async () => 4],
    ['proxy postimage', async () => new Proxy({}, {})],
    ['null-claim postimage', async () => metadata(randomUUID(), null)],
    ['extra-key postimage', async () => ({ ...metadata(randomUUID(), null), extra: true })],
  ])('%s is CLAIM_UNKNOWN and never classifies', async (_label, cas) => {
    const ctx = await context({ cas });
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status: 'CLAIM_UNKNOWN' });
    expect(ctx.compareAndSet).toHaveBeenCalledTimes(1);
    expect(ctx.classifyAfterNoMatch).not.toHaveBeenCalled();
  });

  test.each([
    ['wrong run', (epoch: string) => metadata(epoch, { runId: randomUUID(), claimedAt: new Date() })],
    ['invalid date', (epoch: string, runId: string) => metadata(epoch, { runId, claimedAt: new Date(Number.NaN) })],
    ['proxied date', (epoch: string, runId: string) => metadata(epoch, { runId, claimedAt: new Proxy(new Date(), {}) })],
    ['wrong epoch', (_epoch: string, runId: string) => metadata(randomUUID(), { runId, claimedAt: new Date() })],
    ['bad vector', (epoch: string, runId: string) => ({
      ...metadata(epoch, { runId, claimedAt: new Date() }),
      startupVectors: G04B_STARTUP_VECTORS.map((vector, index) => ({
        ...vector, ...(index === 0 ? { expectedHmacHex: '0'.repeat(64) } : {}),
      })),
    })],
  ])('CAS postimage %s is unknown without classification', async (_label, makePostimage) => {
    const ctx = await context();
    ctx.compareAndSet.mockImplementationOnce(async () => makePostimage(ctx.ticketEpoch, ctx.runId));
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status: 'CLAIM_UNKNOWN' });
    expect(ctx.compareAndSet).toHaveBeenCalledTimes(1);
    expect(ctx.classifyAfterNoMatch).not.toHaveBeenCalled();
  });

  test('malformed CAS accessor is rejected without invoking it', async () => {
    let invoked = 0;
    const ctx = await context();
    ctx.compareAndSet.mockImplementationOnce(async () => {
      const value = metadata(ctx.ticketEpoch, { runId: ctx.runId, claimedAt: new Date() });
      Object.defineProperty(value, 'writeRunClaim', { enumerable: true, get: () => { invoked += 1; return null; } });
      return value;
    });
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status: 'CLAIM_UNKNOWN' });
    expect(invoked).toBe(0);
  });

  test.each([
    ['read throw', async (): Promise<unknown | null> => { throw new Error('raw secret'); }, 'CLAIM_UNKNOWN'],
    ['missing metadata', async (): Promise<unknown | null> => null, 'METADATA_MISSING_OR_INVALID'],
    ['malformed metadata', async (): Promise<unknown | null> => ({}), 'METADATA_MISSING_OR_INVALID'],
  ] as const)('CAS null then %s classifies exactly once as %s', async (_label, classify, expected) => {
    const ctx = await context({ cas: async () => null, classify });
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status: expected });
    expect(ctx.compareAndSet).toHaveBeenCalledTimes(1);
    expect(ctx.classifyAfterNoMatch).toHaveBeenCalledTimes(1);
    expect(ctx.classifyAfterNoMatch).toHaveBeenCalledWith();
  });

  test('classification maps different epoch, held same-run, held other-run, and same-epoch null', async () => {
    const cases = [
      [metadata(randomUUID(), null), 'EPOCH_MISMATCH'],
      [undefined, 'CLAIM_HELD'],
      [undefined, 'CLAIM_HELD'],
      [undefined, 'CLAIM_UNKNOWN'],
    ] as const;
    for (const [index, [placeholder, expected]] of cases.entries()) {
      const ctx = await context({ cas: async () => null });
      const observed = index === 0 ? placeholder
        : index === 1 ? metadata(ctx.ticketEpoch, { runId: ctx.runId, claimedAt: new Date() })
          : index === 2 ? metadata(ctx.ticketEpoch, { runId: randomUUID(), claimedAt: new Date() })
            : metadata(ctx.ticketEpoch, null);
      ctx.classifyAfterNoMatch.mockImplementationOnce(async () => observed);
      await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status: expected });
      expect(ctx.compareAndSet).toHaveBeenCalledTimes(1);
      expect(ctx.classifyAfterNoMatch).toHaveBeenCalledTimes(1);
      const request = ctx.compareAndSet.mock.calls[0]![0];
      expect(request).toEqual({ datasetEpoch: ctx.ticketEpoch, processRunId: ctx.runId });
      expect(Reflect.ownKeys(request as object)).toEqual(['datasetEpoch', 'processRunId']);
      expect(Object.isFrozen(request)).toBe(true);
      expect(ctx.classifyAfterNoMatch).toHaveBeenCalledWith();
    }
  });

  test('wrong epoch plus malformed metadata classifies invalid before epoch mismatch', async () => {
    const ctx = await context({ cas: async () => null });
    ctx.classifyAfterNoMatch.mockImplementationOnce(async () => ({
      ...metadata(randomUUID(), null),
      extra: true,
    }));
    await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({
      status: 'METADATA_MISSING_OR_INVALID',
    });
    expect(ctx.compareAndSet).toHaveBeenCalledTimes(1);
    expect(ctx.classifyAfterNoMatch).toHaveBeenCalledTimes(1);
    expect(ctx.classifyAfterNoMatch).toHaveBeenCalledWith();
  });

  test.each(['CAS_THROW', 'CLASSIFY_THROW', 'CLAIM_HELD'] as const)(
    '%s consumes the ticket and retry adds no IO',
    async (mode) => {
      const ctx = await context({
        cas: mode === 'CAS_THROW'
          ? async () => { throw new Error('raw secret'); }
          : async () => null,
      });
      if (mode === 'CLASSIFY_THROW') {
        ctx.classifyAfterNoMatch.mockImplementationOnce(async () => { throw new Error('raw secret'); });
      } else if (mode === 'CLAIM_HELD') {
        ctx.classifyAfterNoMatch.mockImplementationOnce(async () => metadata(
          ctx.ticketEpoch,
          { runId: randomUUID(), claimedAt: new Date() },
        ));
      }
      const expected = mode === 'CLAIM_HELD' ? 'CLAIM_HELD' : 'CLAIM_UNKNOWN';
      await expect(ctx.claimer.claimOnce(ctx.verified, ctx.ticket)).resolves.toEqual({ status: expected });
      const casCount = ctx.compareAndSet.mock.calls.length;
      const classifyCount = ctx.classifyAfterNoMatch.mock.calls.length;
      await expectClaimError(ctx.claimer.claimOnce(ctx.verified, ctx.ticket), 'RUN_TICKET_ALREADY_USED');
      expect(ctx.compareAndSet).toHaveBeenCalledTimes(casCount);
      expect(ctx.classifyAfterNoMatch).toHaveBeenCalledTimes(classifyCount);
      if (classifyCount === 1) expect(ctx.classifyAfterNoMatch).toHaveBeenCalledWith();
    },
  );
});

describe('G11b-b3a one-use and provenance', () => {
  test('sequential and cross-claimer reuse are rejected without additional IO', async () => {
    const ctx = await context();
    await ctx.claimer.claimOnce(ctx.verified, ctx.ticket);
    const second = createPersistentRunClaimerForTest(ctx.target, ctx.verifier, {
      compareAndSet: jest.fn(async () => null), classifyAfterNoMatch: jest.fn(async () => null),
    });
    await expectClaimError(ctx.claimer.claimOnce(ctx.verified, ctx.ticket), 'RUN_TICKET_ALREADY_USED');
    await expectClaimError(second.claimOnce(ctx.verified, ctx.ticket), 'RUN_TICKET_ALREADY_USED');
    expect(ctx.compareAndSet).toHaveBeenCalledTimes(1);
  });

  test('concurrent reuse globally reserves before IO and admits exactly one CAS', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const ctx = await context({ cas: async () => pending });
    const first = ctx.claimer.claimOnce(ctx.verified, ctx.ticket);
    const second = ctx.claimer.claimOnce(ctx.verified, ctx.ticket);
    await expectClaimError(second, 'RUN_TICKET_ALREADY_USED');
    expect(ctx.compareAndSet).toHaveBeenCalledTimes(1);
    release(metadata(ctx.ticketEpoch, { runId: ctx.runId, claimedAt: new Date() }));
    await expect(first).resolves.toMatchObject({ status: 'CLAIMED' });
  });

  test('forged ticket is rejected before IO; genuine ticket plus forged verified is consumed', async () => {
    const forgedTicket = await context();
    await expectClaimError(
      forgedTicket.claimer.claimOnce(forgedTicket.verified, {} as ConsumedRunTicket),
      'PERSISTENT_RUN_CLAIM_INVALID',
    );
    expect(forgedTicket.compareAndSet).not.toHaveBeenCalled();

    const forgedVerified = await context();
    await expectClaimError(
      forgedVerified.claimer.claimOnce({} as VerifiedDataset, forgedVerified.ticket),
      'PERSISTENT_RUN_CLAIM_INVALID',
    );
    expect(forgedVerified.compareAndSet).not.toHaveBeenCalled();
    await expectClaimError(
      forgedVerified.claimer.claimOnce(forgedVerified.verified, forgedVerified.ticket),
      'RUN_TICKET_ALREADY_USED',
    );
  });

  test('foreign target/verifier/verified combinations fail closed after consuming genuine ticket', async () => {
    const owner = await context();
    const foreignTarget = Object.freeze({ id: randomUUID() });
    const foreignVerifier = createVerifiedDatasetVerifierForTest(foreignTarget, () => metadata(owner.ticketEpoch));
    const foreignVerified = await foreignVerifier.verify();
    const claimer = createPersistentRunClaimerForTest(foreignTarget, foreignVerifier, {
      compareAndSet: jest.fn(async () => null), classifyAfterNoMatch: jest.fn(async () => null),
    });
    await expectClaimError(claimer.claimOnce(owner.verified, owner.ticket), 'PERSISTENT_RUN_CLAIM_INVALID');
    await expectClaimError(owner.claimer.claimOnce(owner.verified, owner.ticket), 'RUN_TICKET_ALREADY_USED');
    void foreignVerified;
  });

  test('claimed bridge rejects every foreign identity and capability forgery', async () => {
    const ctx = await context();
    const result = await ctx.claimer.claimOnce(ctx.verified, ctx.ticket);
    if (result.status !== 'CLAIMED') throw new Error('expected claim');
    expect(() => new ClaimedPersistentRun(Symbol('foreign'))).toThrow(
      expect.objectContaining({ code: 'PERSISTENT_RUN_CLAIM_INVALID' }),
    );
    expect(() => new PersistentRunClaimer(Symbol('foreign'))).toThrow(
      expect.objectContaining({ code: 'PERSISTENT_RUN_CLAIM_INVALID' }),
    );
    const argumentsTable = [
      [Object.create(PersistentRunClaimer.prototype), result.claim, ctx.target, ctx.verifier, ctx.verified, ctx.ticket],
      [ctx.claimer, Object.create(ClaimedPersistentRun.prototype), ctx.target, ctx.verifier, ctx.verified, ctx.ticket],
      [ctx.claimer, result.claim, {}, ctx.verifier, ctx.verified, ctx.ticket],
      [ctx.claimer, result.claim, ctx.target, {} as never, ctx.verified, ctx.ticket],
      [ctx.claimer, result.claim, ctx.target, ctx.verifier, {} as never, ctx.ticket],
      [ctx.claimer, result.claim, ctx.target, ctx.verifier, ctx.verified, {} as never],
    ] as const;
    for (const args of argumentsTable) {
      expect(() => readClaimedPersistentRunForBridge(
        args[0] as PersistentRunClaimer,
        args[1] as ClaimedPersistentRun,
        args[2],
        args[3],
        args[4],
        args[5],
      )).toThrow(
        expect.objectContaining({ code: 'PERSISTENT_RUN_CLAIM_INVALID' }),
      );
    }
    const first = readClaimedPersistentRunForBridge(
      ctx.claimer, result.claim, ctx.target, ctx.verifier, ctx.verified, ctx.ticket,
    );
    expect(() => { (first as { ticketId: string }).ticketId = 'changed'; }).toThrow();
    const second = readClaimedPersistentRunForBridge(
      ctx.claimer, result.claim, ctx.target, ctx.verifier, ctx.verified, ctx.ticket,
    );
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe('G11b-b3a private boundaries', () => {
  test('engine has no Mongo, timeout, G05c, ready, ticket IDs in errors, or public-barrel export', async () => {
    const engineName = ['g11b', 'persistent', 'run', 'claim', 'engine'].join('-');
    const engine = await import('node:fs/promises').then(({ readFile }) => readFile(
      join(process.cwd(), `src/deployment/internal/${engineName}.ts`), 'utf8',
    ));
    for (const forbidden of [
      'MongoClient', 'findOneAndUpdate', 'timeoutMS', '2000', 'WRITABLE', 'G05c',
      'authorizeReady', 'service-ready', 'process.env', 'process.argv',
    ]) expect(engine).not.toContain(forbidden);
    for (const barrel of ['src/index.ts', 'src/composition/index.ts', 'src/infrastructure/mongo/index.ts']) {
      const source = await import('node:fs/promises').then(({ readFile }) => readFile(join(process.cwd(), barrel), 'utf8'));
      expect(source).not.toContain('PersistentRunClaim');
    }
  });

  test('claim engine has exactly the production facade and test-support importers', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
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

  test('shared metadata capture has only the b2 and b3 engine importers and no public export', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const guarded = ['g11b', 'closed', 'metadata', 'capture'].join('-');
    const importers: string[] = [];
    for (const rootName of ['src', 'test']) {
      const root = join(process.cwd(), rootName);
      for (const name of (await readdir(root, { recursive: true })).filter((entry) => entry.endsWith('.ts'))) {
        if ((await readFile(join(root, name), 'utf8')).includes(guarded)) importers.push(`${rootName}/${name}`);
      }
    }
    expect(importers.sort()).toEqual([
      `src/deployment/internal/${['g11b', 'dataset', 'verification', 'engine'].join('-')}.ts`,
      `src/deployment/internal/${['g11b', 'persistent', 'run', 'claim', 'engine'].join('-')}.ts`,
    ]);
    for (const barrel of ['src/index.ts', 'src/composition/index.ts', 'src/infrastructure/mongo/index.ts']) {
      const source = await readFile(join(process.cwd(), barrel), 'utf8');
      expect(source).not.toContain('ClosedMetadata');
      expect(source).not.toContain(guarded);
    }
  });
});
