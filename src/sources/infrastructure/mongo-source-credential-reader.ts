import type { Collection } from 'mongodb';

import type { G04bSourceDocument } from '../../infrastructure/mongo/g04b-schema.js';
import type { SourceCredentialRecordReaderPort } from '../ports/index.js';

const CREDENTIAL_PROJECTION = Object.freeze({
  _id: 1,
  credentialAlias: 1,
  credentialDigest: 1,
});

export class MongoSourceCredentialReader implements SourceCredentialRecordReaderPort {
  readonly #sources: Collection<G04bSourceDocument>;

  public constructor(sources: Collection<G04bSourceDocument>) {
    this.#sources = sources;
  }

  public async findByAlias(alias: 'entry' | 'exit'): Promise<unknown | null> {
    const row = await this.#sources.findOne({ credentialAlias: alias }, {
      projection: CREDENTIAL_PROJECTION,
      readConcern: { level: 'majority' },
      readPreference: 'primary',
    });
    if (row === null) return null;
    return {
      sourceId: row._id,
      credentialAlias: row.credentialAlias,
      credentialDigest: row.credentialDigest,
    };
  }
}
