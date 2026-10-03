import type { Db } from 'mongodb';

import type { VerifiedDataset, VerifiedDatasetVerifier } from '../../../deployment/internal/g11b-dataset-verification.js';
import type { G04bMongoPersistenceAdapter } from '../g04b-persistence-adapter.js';
import {
  activateG11bExistingSchemaWithEngine,
  readG11bExistingSchemaDatabaseWithEngine,
} from './g11b-existing-schema-activation-engine.js';

export { ExistingSchemaActivationError } from './g11b-existing-schema-activation-engine.js';

export function readG11bExistingSchemaDatabase(adapter: G04bMongoPersistenceAdapter): Db {
  return readG11bExistingSchemaDatabaseWithEngine(adapter);
}

export function activateG11bExistingSchema(
  adapter: G04bMongoPersistenceAdapter,
  verifier: VerifiedDatasetVerifier,
  verified: VerifiedDataset,
): void {
  activateG11bExistingSchemaWithEngine(adapter, verifier, verified);
}
