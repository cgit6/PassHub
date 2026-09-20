import type { Collection } from 'mongodb';

import type { HumanAccountReaderPort } from '../ports/index.js';

const ACCOUNT_PROJECTION = Object.freeze({
  _id: 1,
  username: 1,
  role: 1,
  enabled: 1,
  passwordSalt: 1,
  passwordHash: 1,
  scryptParams: 1,
});

const STATUS_PROJECTION = Object.freeze({ _id: 1, role: 1, enabled: 1 });

interface MongoHumanAccountDocument {
  readonly _id: string;
  readonly username: string;
  readonly role: string;
  readonly enabled: boolean;
  readonly passwordSalt: string;
  readonly passwordHash: string;
  readonly scryptParams: unknown;
}

export class MongoHumanAccountReader implements HumanAccountReaderPort {
  readonly #users: Collection<MongoHumanAccountDocument>;

  public constructor(users: Collection<MongoHumanAccountDocument>) {
    this.#users = users;
  }

  public async findByUsername(username: string): Promise<unknown | null> {
    const row = await this.#users.findOne({ username }, {
      projection: ACCOUNT_PROJECTION,
      readConcern: { level: 'majority' },
      readPreference: 'primary',
    });
    if (row === null) return null;
    return {
      userId: row._id,
      username: row.username,
      role: row.role,
      enabled: row.enabled,
      passwordSalt: row.passwordSalt,
      passwordHash: row.passwordHash,
      scryptParams: row.scryptParams,
    };
  }

  public async findCurrentById(userId: string): Promise<unknown | null> {
    const row = await this.#users.findOne({ _id: userId }, {
      projection: STATUS_PROJECTION,
      readConcern: { level: 'majority' },
      readPreference: 'primary',
    });
    if (row === null) return null;
    return { userId: row._id, role: row.role, enabled: row.enabled };
  }
}
