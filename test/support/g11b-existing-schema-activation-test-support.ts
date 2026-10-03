import type { Db } from 'mongodb';

import type { G04bCollections } from '../../src/infrastructure/mongo/g04b-schema.js';
import { registerG11bExistingSchemaAdapter } from '../../src/infrastructure/mongo/internal/g11b-existing-schema-activation-engine.js';

export function registerG11bExistingSchemaAdapterForTest(
  adapter: object,
  database: Db,
  attach: (collections: G04bCollections) => void,
): void {
  registerG11bExistingSchemaAdapter(adapter, database, attach);
}
