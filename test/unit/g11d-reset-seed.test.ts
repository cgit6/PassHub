import { createG11dStableSeed, G11D_RESET_COLLECTIONS, G11dResetSeedError, resetAndSeedG11d } from '../../src/deployment/internal/g11d-reset-seed.js';

const epoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('G11d exact reset and stable seed', () => {
  test('stable seed is deterministic and starts a new unclaimed epoch', () => {
    const first = createG11dStableSeed(epoch);
    const second = createG11dStableSeed(epoch);
    expect(first).toEqual(second);
    expect(first.metadata.datasetEpoch).toBe(epoch);
    expect(first.metadata.writeRunClaim).toBeNull();
    expect(first.managementReceipts).toEqual([]);
    expect(first.qualifications[0]?._id).toBe('11111111-1111-4111-8111-111111111111');
    expect(first.faceSlots[0]?.qualificationId).toBe(first.qualifications[0]?._id);
    expect(first.sources.map((source) => source.direction)).toEqual(['ENTRY', 'EXIT']);
    expect(first.metadata.comparisonReferenceId).toBe('11111111-1111-4111-8111-111111111111');
  });

  test('resets only the exact seven collections sequentially and preserves indexes/unknown collections', async () => {
    const calls: string[] = [];
    const indexes = [{ key: { _id: 1 }, name: '_id_' }];
    const documents = new Map<string, unknown[]>(G11D_RESET_COLLECTIONS.map((name) => [name, [{ _id: `${name}-old` }]]));
    documents.set('unrelated', [{ _id: 'untouched' }]);
    const collection = (name: string) => ({
      deleteMany: async () => { calls.push(`delete:${name}`); const old = documents.get(name) ?? []; documents.set(name, []); return { deletedCount: old.length }; },
      insertMany: async (values: readonly unknown[]) => { calls.push(`insert:${name}`); documents.set(name, [...values]); return { insertedCount: values.length }; },
      findOne: async () => documents.get(name)?.[0] ?? null,
      listIndexes: () => ({ toArray: async () => indexes }),
    });
    const database = {
      databaseName: 'passhub_demo',
      listCollections: () => ({ toArray: async () => [...documents.keys()].map((name) => ({ name })) }),
      collection,
    } as never;
    const oldMetadata = { _id: 'system', datasetEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', writeRunClaim: null };
    documents.set('metadata', [oldMetadata]);
    const result = await resetAndSeedG11d(database, epoch);
    expect(result.database).toBe('passhub_demo');
    expect(result.previousDatasetEpoch).toBe(oldMetadata.datasetEpoch);
    expect(result.indexesPreserved).toBe(true);
    expect(result.untouchedCollectionNames).toEqual(['unrelated']);
    expect(calls.slice(0, 7)).toEqual(G11D_RESET_COLLECTIONS.map((name) => `delete:${name}`));
    expect(documents.get('unrelated')).toEqual([{ _id: 'untouched' }]);
    expect(documents.get('metadata')).toEqual([expect.objectContaining({ datasetEpoch: epoch, writeRunClaim: null })]);
    expect(result.seedFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  test.each([
    ['wrong database', { databaseName: 'other' }, 'DATABASE_SCOPE'],
    ['same epoch', { databaseName: 'passhub_demo', sameEpoch: true }, 'EPOCH_NOT_NEW'],
  ])('%s fails closed', async (_label, mode, code) => {
    const documents = new Map<string, unknown[]>(G11D_RESET_COLLECTIONS.map((name) => [name, []]));
    documents.set('metadata', [{ _id: 'system', datasetEpoch: (mode as { readonly sameEpoch?: boolean }).sameEpoch ? epoch : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', writeRunClaim: null }]);
    const database = {
      databaseName: mode.databaseName,
      listCollections: () => ({ toArray: async () => [...documents.keys()].map((name) => ({ name })) }),
      collection: () => ({ findOne: async () => documents.get('metadata')?.[0] ?? null, listIndexes: () => ({ toArray: async () => [] }), deleteMany: async () => ({ deletedCount: 0 }), insertMany: async () => ({ insertedCount: 0 }) }),
    } as never;
    await expect(resetAndSeedG11d(database, epoch)).rejects.toMatchObject({ code });
    expect(code).toBe((new G11dResetSeedError(code as never)).code);
  });
});
