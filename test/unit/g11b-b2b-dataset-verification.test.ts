import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DatasetVerificationError,
  VerifiedDataset,
  VerifiedDatasetVerifier,
  readVerifiedDatasetForRuntime,
} from '../../src/deployment/internal/g11b-dataset-verification.js';
import { createVerifiedDatasetVerifierForTest } from '../support/g11b-dataset-verification-test-support.js';
import { G04B_STARTUP_VECTORS } from '../../src/infrastructure/mongo/g04b-schema.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

function projection(claim: null | { readonly runId: string; readonly claimedAt: Date } = null): Record<string, unknown> {
  return {
    _id: 'system',
    kind: 'system',
    datasetEpoch: EPOCH,
    comparisonReferenceId: '33333333-3333-4333-8333-333333333333',
    frameVersion: 'v2',
    startupVectors: G04B_STARTUP_VECTORS.map((vector) => ({ ...vector })),
    qrGuardVersion: 0,
    faceGuardVersion: 0,
    slotCount: 2,
    writeRunClaim: claim,
  };
}

function verifierFor(inspect: () => unknown | Promise<unknown>, target: object = Object.freeze({})) {
  return Object.freeze({ target, verifier: createVerifiedDatasetVerifierForTest(target, inspect) });
}

async function expectVerificationFailure(action: Promise<unknown>): Promise<void> {
  try {
    await action;
    throw new Error('expected verification failure');
  } catch (error) {
    expect(error).toBeInstanceOf(DatasetVerificationError);
    expect(error).toMatchObject({
      code: 'DATASET_VERIFICATION_FAILED',
      message: 'DATASET_VERIFICATION_FAILED',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('raw inspector secret');
  }
}

describe('G11b-b2b verified dataset capability', () => {
  test.each([
    ['NULL', null],
    ['PRESENT', { runId: RUN_ID, claimedAt: new Date('2027-01-02T03:04:05.678Z') }],
  ] as const)('returns an empty frozen opaque token and closed %s facts', async (expected, claim) => {
    const { verifier, target } = verifierFor(() => projection(claim));
    const token = await verifier.verify();
    expect(token).toBeInstanceOf(VerifiedDataset);
    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(Object.isFrozen(token)).toBe(true);
    const facts = readVerifiedDatasetForRuntime(verifier, token, target);
    expect(facts).toEqual({ datasetEpoch: EPOCH, observedWriteRunClaim: expected });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(facts).not.toHaveProperty('runId');
    expect(facts).not.toHaveProperty('claimedAt');
  });

  test('captures immutable closed facts independently of mutable inspector input and reader copies', async () => {
    const input = projection({ runId: RUN_ID, claimedAt: new Date('2027-01-02T03:04:05.678Z') });
    const { verifier, target } = verifierFor(() => input);
    const token = await verifier.verify();
    input.datasetEpoch = '44444444-4444-4444-8444-444444444444';
    input.writeRunClaim = null;
    const first = readVerifiedDatasetForRuntime(verifier, token, target);
    expect(first).toEqual({ datasetEpoch: EPOCH, observedWriteRunClaim: 'PRESENT' });
    expect(() => { (first as { datasetEpoch: string }).datasetEpoch = RUN_ID; }).toThrow();
    const second = readVerifiedDatasetForRuntime(verifier, token, target);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  test('binds verifier and token to the exact target identity', async () => {
    const target = Object.freeze({ databaseName: 'passhub_demo', client: Object.freeze({ id: 1 }) });
    const sameLookingTarget = Object.freeze({ databaseName: 'passhub_demo', client: Object.freeze({ id: 1 }) });
    const differentClientTarget = Object.freeze({ databaseName: 'passhub_demo', client: Object.freeze({ id: 2 }) });
    const { verifier } = verifierFor(() => projection(), target);
    const token = await verifier.verify();
    expect(readVerifiedDatasetForRuntime(verifier, token, target)).toEqual({
      datasetEpoch: EPOCH,
      observedWriteRunClaim: 'NULL',
    });
    for (const wrongTarget of [sameLookingTarget, differentClientTarget, {}, Object.create(target)]) {
      expect(() => readVerifiedDatasetForRuntime(verifier, token, wrongTarget)).toThrow(
        expect.objectContaining({ code: 'VERIFIED_DATASET_INVALID' }),
      );
    }
  });

  test('rejects constructed, structural, prototype-forged, and foreign-verifier tokens', async () => {
    expect(() => new VerifiedDataset(Symbol('foreign'))).toThrow(
      expect.objectContaining({ code: 'VERIFIED_DATASET_INVALID' }),
    );
    expect(() => new VerifiedDatasetVerifier(Symbol('foreign'))).toThrow(
      expect.objectContaining({ code: 'VERIFIED_DATASET_INVALID' }),
    );
    const ownerTarget = Object.freeze({});
    const foreignTarget = Object.freeze({});
    const owner = createVerifiedDatasetVerifierForTest(ownerTarget, () => projection());
    const foreign = createVerifiedDatasetVerifierForTest(foreignTarget, () => projection());
    const foreignSameTarget = createVerifiedDatasetVerifierForTest(ownerTarget, () => projection());
    const token = await owner.verify();
    for (const forged of [
      {}, null, undefined, Symbol('forged'), Object.freeze({}),
      Object.create(VerifiedDataset.prototype), new Proxy({}, {}),
    ]) {
      expect(() => readVerifiedDatasetForRuntime(owner, forged as VerifiedDataset, ownerTarget)).toThrow(
        expect.objectContaining({ code: 'VERIFIED_DATASET_INVALID' }),
      );
    }
    expect(() => readVerifiedDatasetForRuntime(foreign, token, foreignTarget)).toThrow(
      expect.objectContaining({ code: 'VERIFIED_DATASET_INVALID' }),
    );
    expect(() => readVerifiedDatasetForRuntime(foreignSameTarget, token, ownerTarget)).toThrow(
      expect.objectContaining({ code: 'VERIFIED_DATASET_INVALID' }),
    );
    expect(() => readVerifiedDatasetForRuntime(
      Object.create(VerifiedDatasetVerifier.prototype) as VerifiedDatasetVerifier,
      token,
      ownerTarget,
    )).toThrow(expect.objectContaining({ code: 'VERIFIED_DATASET_INVALID' }));
  });

  test('invokes the inspector exactly once for every repeated and concurrent explicit call', async () => {
    let calls = 0;
    const { verifier } = verifierFor(async () => {
      calls += 1;
      await Promise.resolve();
      return projection();
    });
    await verifier.verify();
    await verifier.verify();
    expect(calls).toBe(2);
    const tokens = await Promise.all([verifier.verify(), verifier.verify(), verifier.verify()]);
    expect(calls).toBe(5);
    expect(new Set(tokens).size).toBe(3);
  });

  test.each([
    ['sync throw', () => { throw new Error('raw inspector secret'); }],
    ['async rejection', () => Promise.reject(new Error('raw inspector secret'))],
    ['null projection', () => null],
    ['extra projection key', () => ({ ...projection(), extra: true })],
    ['noncanonical epoch', () => ({ ...projection(), datasetEpoch: 'invalid' })],
    ['malformed null-like claim', () => ({ ...projection(), writeRunClaim: undefined })],
    ['malformed claim date', () => ({ ...projection(), writeRunClaim: { runId: RUN_ID, claimedAt: 'date' } })],
    ['uppercase held runId', () => ({ ...projection(), writeRunClaim: { runId: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF', claimedAt: new Date() } })],
    ['wrong-version held runId', () => ({ ...projection(), writeRunClaim: { runId: '22222222-2222-5222-8222-222222222222', claimedAt: new Date() } })],
    ['invalid held date', () => ({ ...projection(), writeRunClaim: { runId: RUN_ID, claimedAt: new Date(Number.NaN) } })],
    ['proxied held date', () => ({ ...projection(), writeRunClaim: { runId: RUN_ID, claimedAt: new Proxy(new Date(), {}) } })],
    ['date subclass claim', () => ({ ...projection(), writeRunClaim: { runId: RUN_ID, claimedAt: new (class extends Date {})() } })],
    ['claim with extra facts', () => ({ ...projection(), writeRunClaim: { runId: RUN_ID, claimedAt: new Date(), owner: true } })],
    ['malformed startup vector', () => ({ ...projection(), startupVectors: [{ name: 'wrong', expectedFrameHex: 'aa', expectedHmacHex: 'a'.repeat(64) }] })],
    ['wrong startup frame literal', () => ({ ...projection(), startupVectors: G04B_STARTUP_VECTORS.map((vector, index) => ({ ...vector, ...(index === 0 ? { expectedFrameHex: 'aa' } : {}) })) })],
    ['wrong startup HMAC literal', () => ({ ...projection(), startupVectors: G04B_STARTUP_VECTORS.map((vector, index) => ({ ...vector, ...(index === 1 ? { expectedHmacHex: '0'.repeat(64) } : {}) })) })],
    ['transparent proxy startup array', () => ({ ...projection(), startupVectors: new Proxy(G04B_STARTUP_VECTORS.map((vector) => ({ ...vector })), {}) })],
    ['startup array subclass', () => {
      class Vectors extends Array<unknown> {}
      return { ...projection(), startupVectors: new Vectors(...G04B_STARTUP_VECTORS.map((vector) => ({ ...vector }))) };
    }],
    ['startup array extra key', () => {
      const vectors = G04B_STARTUP_VECTORS.map((vector) => ({ ...vector })) as unknown[] & { extra?: boolean };
      vectors.extra = true;
      return { ...projection(), startupVectors: vectors };
    }],
  ])('maps %s to one sanitized failure and returns no token', async (_label, inspect) => {
    let calls = 0;
    const { verifier } = verifierFor(() => { calls += 1; return inspect(); });
    await expectVerificationFailure(verifier.verify());
    expect(calls).toBe(1);
  });

  test('rejects a startup-array accessor without invoking it and calls inspector once', async () => {
    let accessorCalls = 0;
    let inspectorCalls = 0;
    const vectors = G04B_STARTUP_VECTORS.map((vector) => ({ ...vector }));
    Object.defineProperty(vectors, '1', {
      enumerable: true,
      configurable: true,
      get: () => { accessorCalls += 1; return G04B_STARTUP_VECTORS[1]; },
    });
    const { verifier } = verifierFor(() => {
      inspectorCalls += 1;
      return { ...projection(), startupVectors: vectors };
    });
    await expectVerificationFailure(verifier.verify());
    expect(inspectorCalls).toBe(1);
    expect(accessorCalls).toBe(0);
  });

  test('does not cache a failure and succeeds on the next explicit call', async () => {
    let calls = 0;
    const { verifier, target } = verifierFor(() => {
      calls += 1;
      if (calls === 1) throw new Error('raw inspector secret');
      return projection();
    });
    await expectVerificationFailure(verifier.verify());
    const token = await verifier.verify();
    expect(calls).toBe(2);
    expect(readVerifiedDatasetForRuntime(verifier, token, target)).toEqual({
      datasetEpoch: EPOCH,
      observedWriteRunClaim: 'NULL',
    });
  });

  test('reader performs zero inspector I/O', async () => {
    let calls = 0;
    const { verifier, target } = verifierFor(() => { calls += 1; return projection(); });
    const token = await verifier.verify();
    expect(calls).toBe(1);
    for (let index = 0; index < 10; index += 1) readVerifiedDatasetForRuntime(verifier, token, target);
    expect(calls).toBe(1);
  });
});

describe('G11b-b2b private production boundary', () => {
  test('facade hard-binds b2a and exposes no injection, ambient input, or later-slice capability', async () => {
    const facade = await readFile(
      join(process.cwd(), 'src/deployment/internal/g11b-dataset-verification.ts'), 'utf8',
    );
    const engineBasename = ['g11b', 'dataset', 'verification', 'engine'].join('-');
    const engine = await readFile(
      join(process.cwd(), `src/deployment/internal/${engineBasename}.ts`), 'utf8',
    );
    expect(facade).toContain('inspectExistingG04bSchemaReadOnly(database)');
    expect(facade.match(/inspectExistingG04bSchemaReadOnly\(/gu)).toHaveLength(1);
    const source = `${facade}\n${engine}`;
    expect(source).not.toMatch(/process\.(?:env|argv)/u);
    expect(facade).not.toContain('ForTest');
    for (const forbidden of [
      'run-ticket', 'findOneAndUpdate', 'CLAIMED', 'CLAIM_HELD', 'WRITABLE', 'G05c',
      'authorizeReady', 'ensureG04bSchema', 'createCollection', 'createIndexes',
      'insertOne', 'updateOne', 'deleteOne', 'bulkWrite',
    ]) expect(source).not.toContain(forbidden);
  });

  test('is absent from public barrels', async () => {
    for (const path of ['src/index.ts', 'src/infrastructure/mongo/index.ts', 'src/composition/index.ts']) {
      const source = await readFile(join(process.cwd(), path), 'utf8');
      expect(source).not.toContain('g11b-dataset-verification');
      expect(source).not.toContain('VerifiedDataset');
    }
  });

  test('configurable engine has exactly the production facade and test-support importers', async () => {
    const guarded = ['g11b', 'dataset', 'verification', 'engine'].join('-');
    const importers: string[] = [];
    for (const rootName of ['src', 'test']) {
      const root = join(process.cwd(), rootName);
      for (const name of (await readdir(root, { recursive: true })).filter((entry) => entry.endsWith('.ts'))) {
        if ((await readFile(join(root, name), 'utf8')).includes(guarded)) importers.push(`${rootName}/${name}`);
      }
    }
    expect(importers.sort()).toEqual([
      'src/deployment/internal/g11b-dataset-verification.ts',
      'test/support/g11b-dataset-verification-test-support.ts',
    ]);
  });
});
