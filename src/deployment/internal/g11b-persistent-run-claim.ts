import type { Db } from 'mongodb';

import type { G04bMetadataDocument } from '../../infrastructure/mongo/g04b-schema.js';
import {
  createPersistentRunClaimerWithIo,
  type PersistentRunClaimer,
} from './g11b-persistent-run-claim-engine.js';
import type { VerifiedDatasetVerifier } from './g11b-dataset-verification.js';

const CLAIM_OPERATION_TIMEOUT_MS = 2_000;

/** Production-private Mongo facade. Its collection, concerns, and deadline are fixed here. */
export function createPersistentRunClaimer(
  database: Db,
  verifier: VerifiedDatasetVerifier,
): PersistentRunClaimer {
  const metadata = database.collection<G04bMetadataDocument>('metadata');
  return createPersistentRunClaimerWithIo(database, verifier, {
    compareAndSet: async ({ datasetEpoch, processRunId }) => metadata.findOneAndUpdate(
      { _id: 'system', kind: 'system', datasetEpoch, writeRunClaim: null },
      [{
        $set: {
          writeRunClaim: {
            runId: { $literal: processRunId },
            claimedAt: '$$NOW',
          },
        },
      }],
      {
        upsert: false,
        returnDocument: 'after',
        includeResultMetadata: false,
        readPreference: 'primary',
        writeConcern: { w: 'majority', j: true },
        timeoutMS: CLAIM_OPERATION_TIMEOUT_MS,
      },
    ),
    classifyAfterNoMatch: async () => metadata.findOne(
      { _id: 'system' },
      {
        readPreference: 'primary',
        readConcern: { level: 'majority' },
        timeoutMS: CLAIM_OPERATION_TIMEOUT_MS,
      },
    ),
  });
}
