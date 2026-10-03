import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Db, MongoClient } from 'mongodb';
import ts from 'typescript';

import {
  VerifiedDataset,
  VerifiedDatasetVerifier,
} from '../../src/deployment/internal/g11b-dataset-verification.js';
import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import { G04B_STARTUP_VECTORS, type G04bCollections } from '../../src/infrastructure/mongo/g04b-schema.js';
import {
  activateG11bExistingSchema,
  readG11bExistingSchemaDatabase,
  ExistingSchemaActivationError,
} from '../../src/infrastructure/mongo/internal/g11b-existing-schema-activation.js';
import { createVerifiedDatasetVerifierForTest } from '../support/g11b-dataset-verification-test-support.js';
import { registerG11bExistingSchemaAdapterForTest } from '../support/g11b-existing-schema-activation-test-support.js';

const NAMES = ['qualifications', 'faceSlots', 'events', 'users', 'sources', 'metadata', 'managementReceipts'];
const EPOCH = '11111111-1111-4111-8111-111111111111';
function metadata() {
  return {
    _id: 'system', kind: 'system', datasetEpoch: EPOCH,
    comparisonReferenceId: '33333333-3333-4333-8333-333333333333',
    frameVersion: 'v2', startupVectors: G04B_STARTUP_VECTORS.map((value) => ({ ...value })),
    qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 2, writeRunClaim: null,
  };
}

function fixture() {
  const collection = jest.fn((name: string) => Object.freeze({ collectionName: name }));
  const database = { databaseName: 'same-name', collection } as unknown as Db;
  const adapter = {} as G04bMongoPersistenceAdapter;
  const attach = jest.fn<void, [G04bCollections]>();
  registerG11bExistingSchemaAdapterForTest(adapter, database, attach);
  const inspect = jest.fn(() => metadata());
  const verifier = createVerifiedDatasetVerifierForTest(database, inspect);
  return { adapter, database, collection, attach, inspect, verifier };
}

describe('G11b b5 existing-schema attachment', () => {
  test('attaches precisely the seven fixed handles after exact verifier/target validation, without rereading', async () => {
    const f = fixture();
    const token = await f.verifier.verify();
    expect(readG11bExistingSchemaDatabase(f.adapter)).toBe(f.database);
    activateG11bExistingSchema(f.adapter, f.verifier, token);
    expect(f.inspect).toHaveBeenCalledTimes(1);
    expect(f.collection.mock.calls.map(([name]) => name)).toEqual(NAMES);
    expect(f.attach).toHaveBeenCalledTimes(1);
    const handles = f.attach.mock.calls[0]?.[0];
    expect(Object.isFrozen(handles)).toBe(true);
    expect(Object.keys(handles ?? {})).toEqual(NAMES);
  });

  test.each(['foreign target', 'foreign verifier same target', 'foreign token same target', 'forged token', 'forged verifier'])(
    'rejects %s before obtaining any handles or invoking attachment', async (kind) => {
      const f = fixture();
      let verifier = f.verifier;
      let token = await verifier.verify();
      if (kind === 'foreign target') {
        verifier = createVerifiedDatasetVerifierForTest({ databaseName: 'same-name' }, () => metadata());
        token = await verifier.verify();
      } else if (kind === 'foreign verifier same target') {
        verifier = createVerifiedDatasetVerifierForTest(f.database, () => metadata());
      } else if (kind === 'foreign token same target') {
        const foreign = createVerifiedDatasetVerifierForTest(f.database, () => metadata());
        token = await foreign.verify();
      } else if (kind === 'forged token') {
        token = Object.create(VerifiedDataset.prototype) as VerifiedDataset;
      } else {
        verifier = Object.create(VerifiedDatasetVerifier.prototype) as VerifiedDatasetVerifier;
      }
      expect(() => activateG11bExistingSchema(f.adapter, verifier, token)).toThrow(ExistingSchemaActivationError);
      expect(f.collection).not.toHaveBeenCalled();
      expect(f.attach).not.toHaveBeenCalled();
      // Invalid input does not consume a valid adapter's activation.
      activateG11bExistingSchema(f.adapter, f.verifier, await f.verifier.verify());
      expect(f.attach).toHaveBeenCalledTimes(1);
    },
  );

  test('rejects structural and prototype-forged adapters without touching their properties', async () => {
    const f = fixture();
    const token = await f.verifier.verify();
    const getter = jest.fn(() => f.database);
    const forged = Object.defineProperty({}, 'database', { get: getter });
    for (const adapter of [forged, Object.create(f.adapter), Object.create(G04bMongoPersistenceAdapter.prototype)]) {
      expect(() => readG11bExistingSchemaDatabase(adapter)).toThrow(ExistingSchemaActivationError);
      expect(() => activateG11bExistingSchema(adapter, f.verifier, token)).toThrow(ExistingSchemaActivationError);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(f.collection).not.toHaveBeenCalled();
  });

  test('attachment is single-use even with a new valid token', async () => {
    const f = fixture();
    activateG11bExistingSchema(f.adapter, f.verifier, await f.verifier.verify());
    expect(() => activateG11bExistingSchema(f.adapter, f.verifier, {} as VerifiedDataset)).toThrow(ExistingSchemaActivationError);
    const second = await f.verifier.verify();
    expect(() => activateG11bExistingSchema(f.adapter, f.verifier, second)).toThrow(ExistingSchemaActivationError);
    expect(f.collection).toHaveBeenCalledTimes(7);
    expect(f.attach).toHaveBeenCalledTimes(1);
  });

  test.each(['handle failure', 'attachment failure'])('sanitizes %s and forbids retry after attachment begins', async (kind) => {
    const f = fixture();
    const token = await f.verifier.verify();
    if (kind === 'handle failure') f.collection.mockImplementation(() => { throw new Error('raw Mongo secret'); });
    else f.attach.mockImplementation(() => { throw new Error('raw Mongo secret'); });
    try {
      activateG11bExistingSchema(f.adapter, f.verifier, token);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ExistingSchemaActivationError);
      expect(error).toMatchObject({ message: 'EXISTING_SCHEMA_ACTIVATION_FAILED' });
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain('raw Mongo secret');
    }
    const calls = f.collection.mock.calls.length;
    expect(() => activateG11bExistingSchema(f.adapter, f.verifier, token)).toThrow(ExistingSchemaActivationError);
    expect(f.collection).toHaveBeenCalledTimes(calls);
  });

  test('rejects duplicate registration without replacing original Db or callback', () => {
    const f = fixture();
    expect(() => registerG11bExistingSchemaAdapterForTest(f.adapter, {} as Db, jest.fn())).toThrow(ExistingSchemaActivationError);
    expect(readG11bExistingSchemaDatabase(f.adapter)).toBe(f.database);
  });

  test('actual adapter retains the exact constructor Db and supports reads after private attachment', async () => {
    const client = new MongoClient('mongodb://127.0.0.1:1');
    const database = new Db(client, 'same-name');
    const dbSpy = jest.spyOn(client, 'db').mockReturnValue(database);
    const cursor = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) };
    const collectionSpy = jest.spyOn(database, 'collection').mockReturnValue({ find: jest.fn(() => cursor) } as never);
    const adapter = new G04bMongoPersistenceAdapter(client, 'same-name');
    expect(readG11bExistingSchemaDatabase(adapter)).toBe(database);
    await expect(adapter.qualifications({ limit: 1 })).rejects.toThrow();
    const verifier = createVerifiedDatasetVerifierForTest(database, () => metadata());
    activateG11bExistingSchema(adapter, verifier, await verifier.verify());
    expect(collectionSpy.mock.calls.map(([name]) => name)).toEqual(NAMES);
    await expect(adapter.qualifications({ limit: 1 })).resolves.toEqual([]);
    dbSpy.mockRestore();
    collectionSpy.mockRestore();
    await client.close();
  });
});

describe('private activation boundary', () => {
  test('engine/facade contain no schema creation, repair, seed, persistence, ambient configuration or public exports', async () => {
    const engine = await readFile(join(process.cwd(), 'src/infrastructure/mongo/internal/g11b-existing-schema-activation-engine.ts'), 'utf8');
    const facade = await readFile(join(process.cwd(), 'src/infrastructure/mongo/internal/g11b-existing-schema-activation.ts'), 'utf8');
    expect(`${engine}\n${facade}`).not.toMatch(/ensureSchema|ensureG04bSchema|createCollection|createIndex|collMod|drop\w*|insert(?:One|Many)|update(?:One|Many)|delete(?:One|Many)|replaceOne|findOneAnd\w*|bulkWrite|(?:run)?[Cc]ommand|clearAndSeed|process\.(?:env|argv)/u);
    // A closed call allowlist catches mutation aliases and future driver methods,
    // including computed method calls that a keyword denylist could miss.
    const permittedCalls = new Set([
      'super',
      'bindings.has', 'bindings.set', 'bindings.get',
      'readVerifiedDatasetForRuntime', 'Object.freeze', 'database.collection', 'binding.attach',
      'readG11bExistingSchemaDatabaseWithEngine', 'activateG11bExistingSchemaWithEngine',
    ]);
    const calls: string[] = [];
    for (const [filename, source] of [['engine.ts', engine], ['facade.ts', facade]] as const) {
      const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const expression = node.expression.getText(tree);
          calls.push(expression);
          expect(permittedCalls.has(expression)).toBe(true);
          expect(ts.isElementAccessExpression(node.expression)).toBe(false);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(calls.filter((expression) => expression === 'database.collection')).toHaveLength(7);
    expect(new Set(calls)).toEqual(permittedCalls);
    for (const path of ['src/index.ts', 'src/infrastructure/mongo/index.ts', 'src/composition/index.ts']) {
      expect(await readFile(join(process.cwd(), path), 'utf8')).not.toMatch(/g11b-existing-schema|activateG11bExistingSchema|readG11bExistingSchemaDatabase/u);
    }
  });

  test('only the fixed facade, concrete adapter and test registration support import the engine', async () => {
    const guarded = ['g11b', 'existing', 'schema', 'activation', 'engine'].join('-');
    const importers: string[] = [];
    for (const root of ['src', 'test']) {
      for (const name of (await readdir(join(process.cwd(), root), { recursive: true })).filter((value) => value.endsWith('.ts'))) {
        if ((await readFile(join(process.cwd(), root, name), 'utf8')).includes(guarded)) importers.push(`${root}/${name}`);
      }
    }
    expect(importers.sort()).toEqual([
      'src/infrastructure/mongo/g04b-persistence-adapter.ts',
      'src/infrastructure/mongo/internal/g11b-existing-schema-activation.ts',
      'test/support/g11b-existing-schema-activation-test-support.ts',
      'test/unit/g11b-b5-existing-schema-activation.test.ts',
    ]);
  });
});
