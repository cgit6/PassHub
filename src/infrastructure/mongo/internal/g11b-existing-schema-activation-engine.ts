import type { Db } from 'mongodb';

import {
  readVerifiedDatasetForRuntime,
  type VerifiedDataset,
  type VerifiedDatasetVerifier,
} from '../../../deployment/internal/g11b-dataset-verification.js';
import { G04A_FACE_SLOTS_COLLECTION, type G04aFaceSlotDocument } from '../g04a-face-index-schema.js';
import {
  G04B_QUALIFICATIONS_COLLECTION,
  G04B_EVENTS_COLLECTION,
  G04B_USERS_COLLECTION,
  G04B_SOURCES_COLLECTION,
  G04B_METADATA_COLLECTION,
  G04B_MANAGEMENT_RECEIPTS_COLLECTION,
  type G04bCollections,
  type G04bQualificationDocument,
  type G04bEventDocument,
  type G04bUserDocument,
  type G04bSourceDocument,
  type G04bMetadataDocument,
  type G04bManagementReceiptDocument,
} from '../g04b-schema.js';

export class ExistingSchemaActivationError extends Error {
  constructor() {
    super('EXISTING_SCHEMA_ACTIVATION_FAILED');
    this.name = 'ExistingSchemaActivationError';
  }
}

interface AdapterBinding {
  readonly database: Db;
  readonly attach: (collections: G04bCollections) => void;
  consumed: boolean;
}

const bindings = new WeakMap<object, AdapterBinding>();

/** Constructor-only registration. Importers are restricted to adapter and test support. */
export function registerG11bExistingSchemaAdapter(
  adapter: object,
  database: Db,
  attach: (collections: G04bCollections) => void,
): void {
  if (bindings.has(adapter)) throw new ExistingSchemaActivationError();
  bindings.set(adapter, { database, attach, consumed: false });
}

/** Private composition reader: returns the exact constructor-owned Db, never collection handles. */
export function readG11bExistingSchemaDatabaseWithEngine(adapter: object): Db {
  const binding = bindings.get(adapter);
  if (binding === undefined) throw new ExistingSchemaActivationError();
  return binding.database;
}

/** Synchronous, one-use attachment. Db.collection obtains handles without server I/O. */
export function activateG11bExistingSchemaWithEngine(
  adapter: object,
  verifier: VerifiedDatasetVerifier,
  verified: VerifiedDataset,
): void {
  const binding = bindings.get(adapter);
  if (binding === undefined || binding.consumed) throw new ExistingSchemaActivationError();
  try {
    // Validate owner and exact target before obtaining any handle or invoking the adapter.
    readVerifiedDatasetForRuntime(verifier, verified, binding.database);
    binding.consumed = true;
    const database = binding.database;
    const collections: G04bCollections = Object.freeze({
      qualifications: database.collection<G04bQualificationDocument>(G04B_QUALIFICATIONS_COLLECTION),
      faceSlots: database.collection<G04aFaceSlotDocument>(G04A_FACE_SLOTS_COLLECTION),
      events: database.collection<G04bEventDocument>(G04B_EVENTS_COLLECTION),
      users: database.collection<G04bUserDocument>(G04B_USERS_COLLECTION),
      sources: database.collection<G04bSourceDocument>(G04B_SOURCES_COLLECTION),
      metadata: database.collection<G04bMetadataDocument>(G04B_METADATA_COLLECTION),
      managementReceipts: database.collection<G04bManagementReceiptDocument>(G04B_MANAGEMENT_RECEIPTS_COLLECTION),
    });
    binding.attach(collections);
  } catch {
    throw new ExistingSchemaActivationError();
  }
}
