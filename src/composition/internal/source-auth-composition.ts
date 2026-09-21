import type { Collection } from 'mongodb';

import {
  createSourceAuth,
  type SourceAuthCapability,
} from '../../auth/internal/index.js';
import type { G04bSourceDocument } from '../../infrastructure/mongo/g04b-schema.js';
import {
  createSourceCredentialVerifier,
  MongoSourceCredentialReader,
} from '../../sources/internal/index.js';

export interface SourceAuthComposition {
  readonly sourceAuth: SourceAuthCapability;
}

/** Internal-only narrow wiring. It is deliberately absent from package exports. */
export function createSourceAuthComposition(
  sources: Collection<G04bSourceDocument>,
): SourceAuthComposition {
  const reader = new MongoSourceCredentialReader(sources);
  const credentialVerifier = createSourceCredentialVerifier({ reader });
  const sourceAuth = createSourceAuth({ credentialVerifier });
  return Object.freeze({ sourceAuth });
}
