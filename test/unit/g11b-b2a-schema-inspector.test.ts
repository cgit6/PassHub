import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  inspectExistingG04bSchemaReadOnly,
} from '../../src/infrastructure/mongo/g04b-schema.js';

describe('G11b-b2a existing-schema inspector structure', () => {
  test('is a production function and returns no schema collection bundle declaration', () => {
    expect(typeof inspectExistingG04bSchemaReadOnly).toBe('function');
    expect(inspectExistingG04bSchemaReadOnly.name).toBe('inspectExistingG04bSchemaReadOnly');
  });

  test('is not exported through the public Mongo infrastructure barrel', async () => {
    const barrel = await readFile(
      join(process.cwd(), 'src/infrastructure/mongo/index.ts'),
      'utf8',
    );
    expect(barrel).not.toContain('inspectExistingG04bSchemaReadOnly');
    expect(barrel).not.toContain('G04bExistingMetadataProjection');
  });

  test('inspector body has no mutating Mongo primitive and uses the existing checks', async () => {
    const source = await readFile(
      join(process.cwd(), 'src/infrastructure/mongo/g04b-schema.ts'),
      'utf8',
    );
    const start = source.indexOf('export async function inspectExistingG04bSchemaReadOnly');
    const end = source.indexOf('\nfunction freezeMetadataProjection', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    for (const forbidden of [
      '.createCollection(', '.createIndex(', '.createIndexes(', '.insert', '.update',
      '.delete', '.findOneAndUpdate(', '.bulkWrite(', '.drop(', '.rename(', 'collMod',
      'ensureG04bSchema(', 'ensureCollection(', 'ensureG04aFaceSlotsCollection(',
    ]) expect(body).not.toContain(forbidden);
    for (const required of [
      'assertExistingCollectionOptions(', 'assertExistingIndexContract(',
      'readConcern: { level: \'snapshot\' }', "readPreference: 'primary'",
      'assertG04bMetadataBootstrap(', 'assertExistingLegacyIntegrity(',
      'freezeMetadataProjection(',
    ]) expect(body).toContain(required);
  });

  test('requires all seven known collection constants and zero metadata/receipt indexes', async () => {
    const source = await readFile(
      join(process.cwd(), 'src/infrastructure/mongo/g04b-schema.ts'),
      'utf8',
    );
    const start = source.indexOf('export async function inspectExistingG04bSchemaReadOnly');
    const end = source.indexOf('\nfunction freezeMetadataProjection', start);
    const body = source.slice(start, end);
    for (const name of [
      'G04B_QUALIFICATIONS_COLLECTION', 'G04A_FACE_SLOTS_COLLECTION',
      'G04B_EVENTS_COLLECTION', 'G04B_USERS_COLLECTION', 'G04B_SOURCES_COLLECTION',
      'G04B_METADATA_COLLECTION', 'G04B_MANAGEMENT_RECEIPTS_COLLECTION',
    ]) expect(body).toContain(name);
    expect(body).toContain('assertExistingIndexContract(collections.metadata, [], G04B_METADATA_COLLECTION)');
    expect(body).toContain('assertExistingIndexContract(collections.managementReceipts, [], G04B_MANAGEMENT_RECEIPTS_COLLECTION)');
  });
});
