import type { Db } from 'mongodb';

import { inspectExistingG04bSchemaReadOnly } from '../../infrastructure/mongo/g04b-schema.js';
import {
  createVerifiedDatasetVerifierWithInspector,
  type VerifiedDatasetVerifier,
} from './g11b-dataset-verification-engine.js';

export {
  DatasetVerificationError,
  VerifiedDataset,
  VerifiedDatasetVerifier,
  readVerifiedDatasetForRuntime,
  type DatasetVerificationFailure,
  type VerifiedDatasetFacts,
} from './g11b-dataset-verification-engine.js';

/** Production-private facade: the supplied Db is always inspected by b2a. */
export function createVerifiedDatasetVerifier(database: Db): VerifiedDatasetVerifier {
  return createVerifiedDatasetVerifierWithInspector(
    database,
    async () => inspectExistingG04bSchemaReadOnly(database),
  );
}
