import type { ClientSession, Collection, Db, Document, IndexDescription } from 'mongodb';

import {
  ensureG04aFaceSlotsCollection,
  G04A_FACE_SLOTS_COLLECTION,
  G04A_FACE_SLOTS_INDEXES,
  G04A_FACE_SLOTS_VALIDATOR,
  type G04aFaceSlotDocument,
} from './g04a-face-index-schema.js';

export const G04B_QUALIFICATIONS_COLLECTION = 'qualifications';
export const G04B_FACE_SLOTS_COLLECTION = 'faceSlots';
export const G04B_EVENTS_COLLECTION = 'events';
export const G04B_USERS_COLLECTION = 'users';
export const G04B_SOURCES_COLLECTION = 'sources';
export const G04B_METADATA_COLLECTION = 'metadata';
export const G04B_REASON_CODES = Object.freeze([
  'SOURCE_INACTIVE', 'INVALID_QR_CREDENTIAL', 'FACE_UNKNOWN', 'FACE_SUBJECT_NOT_MAPPED',
  'QUALIFICATION_REVOKED', 'ALREADY_INSIDE', 'QUALIFICATION_ALREADY_USED',
  'QUALIFICATION_NOT_YET_VALID', 'QUALIFICATION_EXPIRED', 'ENTRY_GRANTED',
  'NOT_INSIDE', 'ALREADY_EXITED', 'EXIT_RECORDED',
] as const);

export const G04B_QUALIFICATION_QR_INDEX = 'g04b_qualification_qr_unique_v1';
export const G04B_EVENT_EXTERNAL_INDEX = 'g04b_event_source_external_unique_v1';
export const G04B_EVENT_COMPARISON_INDEX = 'g04b_event_comparison_integrity_v1';
export const G04B_USER_USERNAME_INDEX = 'g04b_user_username_unique_v1';
export const G04B_SOURCE_ALIAS_INDEX = 'g04b_source_alias_unique_v1';
export const G04B_QUALIFICATION_CREATED_INDEX = 'g04b_qualification_created_v1';
export const G04B_QUALIFICATION_INSIDE_INDEX = 'g04b_qualification_inside_v1';
export const G04B_EVENT_RECEIVED_INDEX = 'g04b_event_received_v1';
export const G04B_EVENT_QUALIFICATION_INDEX = 'g04b_event_qualification_received_v1';

export interface G04bQualificationDocument {
  readonly _id: string;
  readonly incarnation: string;
  readonly version: number;
  readonly displayName: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly createdBy: string;
  readonly qrLookupDigest: string;
  readonly presence: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  readonly enteredAt: Date | null;
  readonly exitedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly expiredTerminalAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface G04bEventDocument {
  readonly _id: string;
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly kind: 'QR_SCANNED' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
  readonly direction: 'ENTRY' | 'EXIT';
  readonly outcome: 'ACCEPTED' | 'REJECTED';
  readonly reasonCode: string;
  readonly receivedAt: Date;
  readonly recordedAt: Date;
  readonly qualificationId: string | null;
  readonly presenceTransition: {
    readonly from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
    readonly to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  } | null;
  readonly inputHmac: string;
  readonly comparisonReferenceId: string;
}

export interface G04bUserDocument {
  readonly _id: string;
  readonly username: string;
  readonly role: 'OPERATOR' | 'VIEWER';
  readonly enabled: boolean;
  readonly passwordSalt: string;
  readonly passwordHash: string;
  readonly scryptParams: {
    readonly N: number;
    readonly r: number;
    readonly p: number;
    readonly keyLength: number;
  };
}

export interface G04bSourceDocument {
  readonly _id: string;
  readonly credentialAlias: 'entry' | 'exit';
  readonly direction: 'ENTRY' | 'EXIT';
  readonly active: boolean;
  readonly credentialDigest: string;
  readonly incarnation: string;
  readonly version: number;
}

export interface G04bStartupVectorDocument {
  readonly name: string;
  readonly expectedFrameHex: string;
  readonly expectedHmacHex: string;
}

export interface G04bMetadataDocument {
  readonly _id: 'system';
  readonly kind: 'system';
  readonly datasetEpoch: string;
  readonly comparisonReferenceId: string;
  readonly frameVersion: 'v2';
  readonly startupVectors: readonly G04bStartupVectorDocument[];
  readonly qrGuardVersion: number;
  readonly faceGuardVersion: number;
  readonly slotCount: number;
  readonly writeRunClaim: {
    readonly runId: string;
    readonly claimedAt: Date;
  } | null;
}

export const G04B_STARTUP_VECTORS: readonly G04bStartupVectorDocument[] = Object.freeze([
  {
    name: 'QR_SCANNED:A',
    expectedFrameHex: '5b22506173734875622f6964656d2f7632222c2251525f5343414e4e4544222c5b312c2241225d5d',
    expectedHmacHex: '1035cbfb48da122da36a14350fdd5e43942923570c45dcfb50007a4d1dba93ae',
  },
  {
    name: 'FACE_MATCHED:DemoFace:中😀',
    expectedFrameHex: '5b22506173734875622f6964656d2f7632222c22464143455f4d415443484544222c5b382c2244656d6f46616365225d2c5b372c22e4b8adf09f9880225d5d',
    expectedHmacHex: 'b414e2e7b0a1ea756132cd1038e6648dd065b05beb771d14caf72a8b3d560873',
  },
  {
    name: 'FACE_UNKNOWN',
    expectedFrameHex: '5b22506173734875622f6964656d2f7632222c22464143455f554e4b4e4f574e225d',
    expectedHmacHex: '4c2c59f9a184f54901874d198ce64e0b225d3603cc53525437451048af08bb65',
  },
]);

const UUID = { bsonType: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' } as const;
const NULLABLE_DATE = { bsonType: ['null', 'date'] } as const;
const NULLABLE_STRING = { bsonType: ['null', 'string'] } as const;
const NULLABLE_UUID = { oneOf: [{ bsonType: 'null' }, UUID] } as const;
const HEX64 = { bsonType: 'string', pattern: '^[0-9a-f]{64}$' } as const;

export const G04B_QUALIFICATIONS_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    oneOf: [
      {
        properties: {
          presence: { enum: ['NOT_ENTERED'] }, enteredAt: { bsonType: 'null' }, exitedAt: { bsonType: 'null' },
          revokedAt: { bsonType: 'null' }, revocationReason: { bsonType: 'null' }, expiredTerminalAt: { bsonType: 'null' },
        },
      },
      {
        properties: {
          presence: { enum: ['NOT_ENTERED'] }, enteredAt: { bsonType: 'null' }, exitedAt: { bsonType: 'null' },
          revokedAt: { bsonType: 'date' }, revocationReason: { bsonType: 'string', minLength: 1 }, expiredTerminalAt: { bsonType: 'null' },
        },
      },
      {
        properties: {
          presence: { enum: ['NOT_ENTERED'] }, enteredAt: { bsonType: 'null' }, exitedAt: { bsonType: 'null' },
          revokedAt: { bsonType: 'null' }, revocationReason: { bsonType: 'null' }, expiredTerminalAt: { bsonType: 'date' },
        },
      },
      {
        properties: {
          presence: { enum: ['INSIDE'] }, enteredAt: { bsonType: 'date' }, exitedAt: { bsonType: 'null' },
          revokedAt: { bsonType: 'null' }, revocationReason: { bsonType: 'null' }, expiredTerminalAt: { bsonType: 'null' },
        },
      },
      {
        properties: {
          presence: { enum: ['EXITED'] }, enteredAt: { bsonType: 'date' }, exitedAt: { bsonType: 'date' },
          revokedAt: { bsonType: 'null' }, revocationReason: { bsonType: 'null' }, expiredTerminalAt: { bsonType: 'null' },
        },
      },
    ],
    required: [
      '_id', 'incarnation', 'version', 'displayName', 'validFrom', 'validUntil',
      'createdBy', 'qrLookupDigest', 'presence', 'enteredAt', 'exitedAt',
      'revokedAt', 'revocationReason', 'expiredTerminalAt', 'createdAt', 'updatedAt',
    ],
    properties: {
      _id: UUID, incarnation: UUID, version: { bsonType: 'int', minimum: 0 },
      displayName: { bsonType: 'string', minLength: 1 },
      validFrom: { bsonType: 'date' }, validUntil: { bsonType: 'date' }, createdBy: UUID,
      qrLookupDigest: HEX64,
      presence: { enum: ['NOT_ENTERED', 'INSIDE', 'EXITED'] },
      enteredAt: NULLABLE_DATE, exitedAt: NULLABLE_DATE, revokedAt: NULLABLE_DATE,
      revocationReason: NULLABLE_STRING, expiredTerminalAt: NULLABLE_DATE,
      createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' },
    },
  },
});

export const G04B_EVENTS_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    oneOf: [
      {
        properties: {
          outcome: { enum: ['ACCEPTED'] }, reasonCode: { enum: ['ENTRY_GRANTED'] },
          qualificationId: UUID,
          presenceTransition: {
            bsonType: 'object', additionalProperties: false, required: ['from', 'to'],
            properties: { from: { enum: ['NOT_ENTERED'] }, to: { enum: ['INSIDE'] } },
          },
        },
      },
      {
        properties: {
          outcome: { enum: ['ACCEPTED'] }, reasonCode: { enum: ['EXIT_RECORDED'] },
          qualificationId: UUID,
          presenceTransition: {
            bsonType: 'object', additionalProperties: false, required: ['from', 'to'],
            properties: { from: { enum: ['INSIDE'] }, to: { enum: ['EXITED'] } },
          },
        },
      },
      {
        properties: {
          outcome: { enum: ['REJECTED'] },
          reasonCode: { enum: ['SOURCE_INACTIVE', 'INVALID_QR_CREDENTIAL', 'FACE_UNKNOWN', 'FACE_SUBJECT_NOT_MAPPED'] },
          qualificationId: { bsonType: 'null' }, presenceTransition: { bsonType: 'null' },
        },
      },
      {
        properties: {
          outcome: { enum: ['REJECTED'] },
          reasonCode: {
            enum: [
              'QUALIFICATION_REVOKED', 'ALREADY_INSIDE', 'QUALIFICATION_ALREADY_USED',
              'QUALIFICATION_NOT_YET_VALID', 'QUALIFICATION_EXPIRED', 'NOT_INSIDE', 'ALREADY_EXITED',
            ],
          },
          qualificationId: UUID, presenceTransition: { bsonType: 'null' },
        },
      },
    ],
    required: [
      '_id', 'sourceId', 'externalEventId', 'kind', 'direction', 'outcome',
      'reasonCode', 'receivedAt', 'recordedAt', 'qualificationId',
      'presenceTransition', 'inputHmac', 'comparisonReferenceId',
    ],
    properties: {
      _id: UUID, sourceId: UUID,
      externalEventId: { bsonType: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
      kind: { enum: ['QR_SCANNED', 'FACE_MATCHED', 'FACE_UNKNOWN'] },
      direction: { enum: ['ENTRY', 'EXIT'] }, outcome: { enum: ['ACCEPTED', 'REJECTED'] },
      reasonCode: { enum: [...G04B_REASON_CODES] },
      receivedAt: { bsonType: 'date' }, recordedAt: { bsonType: 'date' },
      qualificationId: NULLABLE_UUID, inputHmac: HEX64, comparisonReferenceId: UUID,
      presenceTransition: {
        bsonType: ['null', 'object'],
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: { enum: ['NOT_ENTERED', 'INSIDE', 'EXITED'] },
          to: { enum: ['NOT_ENTERED', 'INSIDE', 'EXITED'] },
        },
      },
    },
  },
});

export const G04B_USERS_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: ['_id', 'username', 'role', 'enabled', 'passwordSalt', 'passwordHash', 'scryptParams'],
    properties: {
      _id: UUID, username: { bsonType: 'string', minLength: 1 },
      role: { enum: ['OPERATOR', 'VIEWER'] }, enabled: { bsonType: 'bool' },
      passwordSalt: { bsonType: 'string', pattern: '^[0-9a-f]{32,}$' },
      passwordHash: { bsonType: 'string', pattern: '^[0-9a-f]{128}$' },
      scryptParams: {
        bsonType: 'object', required: ['N', 'r', 'p', 'keyLength'],
        additionalProperties: false,
        properties: {
          N: { bsonType: 'int', enum: [131072] }, r: { bsonType: 'int', enum: [8] },
          p: { bsonType: 'int', enum: [1] }, keyLength: { bsonType: 'int', enum: [64] },
        },
      },
    },
  },
});

export const G04B_SOURCES_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    oneOf: [
      { properties: { credentialAlias: { enum: ['entry'] }, direction: { enum: ['ENTRY'] } } },
      { properties: { credentialAlias: { enum: ['exit'] }, direction: { enum: ['EXIT'] } } },
    ],
    required: ['_id', 'credentialAlias', 'direction', 'active', 'credentialDigest', 'incarnation', 'version'],
    properties: {
      _id: UUID, credentialAlias: { enum: ['entry', 'exit'] },
      direction: { enum: ['ENTRY', 'EXIT'] }, active: { bsonType: 'bool' },
      credentialDigest: HEX64, incarnation: UUID, version: { bsonType: 'int', minimum: 0 },
    },
  },
});

export const G04B_METADATA_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'kind', 'datasetEpoch', 'comparisonReferenceId', 'frameVersion',
      'startupVectors', 'qrGuardVersion', 'faceGuardVersion', 'slotCount', 'writeRunClaim',
    ],
    properties: {
      _id: { enum: ['system'] }, kind: { enum: ['system'] }, datasetEpoch: UUID,
      comparisonReferenceId: UUID, frameVersion: { enum: ['v2'] },
      startupVectors: {
        bsonType: 'array', minItems: 3, maxItems: 3, uniqueItems: true,
        items: [
          {
            bsonType: 'object', additionalProperties: false, required: ['name', 'expectedFrameHex', 'expectedHmacHex'],
            properties: {
              name: { enum: ['QR_SCANNED:A'] },
              expectedFrameHex: { bsonType: 'string', minLength: 2, pattern: '^(?:[0-9a-f]{2})+$' }, expectedHmacHex: HEX64,
            },
          },
          {
            bsonType: 'object', additionalProperties: false, required: ['name', 'expectedFrameHex', 'expectedHmacHex'],
            properties: {
              name: { enum: ['FACE_MATCHED:DemoFace:中😀'] },
              expectedFrameHex: { bsonType: 'string', minLength: 2, pattern: '^(?:[0-9a-f]{2})+$' }, expectedHmacHex: HEX64,
            },
          },
          {
            bsonType: 'object', additionalProperties: false, required: ['name', 'expectedFrameHex', 'expectedHmacHex'],
            properties: {
              name: { enum: ['FACE_UNKNOWN'] },
              expectedFrameHex: { bsonType: 'string', minLength: 2, pattern: '^(?:[0-9a-f]{2})+$' }, expectedHmacHex: HEX64,
            },
          },
        ],
      },
      qrGuardVersion: { bsonType: 'int', minimum: 0 }, faceGuardVersion: { bsonType: 'int', minimum: 0 },
      slotCount: { bsonType: 'int', minimum: 0, maximum: 4096 },
      writeRunClaim: {
        bsonType: ['null', 'object'], required: ['runId', 'claimedAt'],
        additionalProperties: false,
        properties: { runId: UUID, claimedAt: { bsonType: 'date' } },
      },
    },
  },
});

export const G04B_QUALIFICATION_INDEXES: readonly IndexDescription[] = Object.freeze([
  { key: { qrLookupDigest: 1 }, name: G04B_QUALIFICATION_QR_INDEX, unique: true },
  { key: { createdAt: -1, _id: -1 }, name: G04B_QUALIFICATION_CREATED_INDEX },
  { key: { presence: 1, enteredAt: -1, _id: -1 }, name: G04B_QUALIFICATION_INSIDE_INDEX },
]);
export const G04B_EVENT_INDEXES: readonly IndexDescription[] = Object.freeze([
  { key: { sourceId: 1, externalEventId: 1 }, name: G04B_EVENT_EXTERNAL_INDEX, unique: true },
  { key: { comparisonReferenceId: 1 }, name: G04B_EVENT_COMPARISON_INDEX },
  { key: { receivedAt: -1, _id: -1 }, name: G04B_EVENT_RECEIVED_INDEX },
  { key: { qualificationId: 1, receivedAt: -1, _id: -1 }, name: G04B_EVENT_QUALIFICATION_INDEX },
]);
export const G04B_USER_INDEXES: readonly IndexDescription[] = Object.freeze([
  { key: { username: 1 }, name: G04B_USER_USERNAME_INDEX, unique: true },
]);
export const G04B_SOURCE_INDEXES: readonly IndexDescription[] = Object.freeze([
  { key: { credentialAlias: 1 }, name: G04B_SOURCE_ALIAS_INDEX, unique: true },
]);

export interface G04bCollections {
  readonly qualifications: Collection<G04bQualificationDocument>;
  readonly faceSlots: Collection<G04aFaceSlotDocument>;
  readonly events: Collection<G04bEventDocument>;
  readonly users: Collection<G04bUserDocument>;
  readonly sources: Collection<G04bSourceDocument>;
  readonly metadata: Collection<G04bMetadataDocument>;
}

const STARTUP_VECTOR_NAMES = new Set(G04B_STARTUP_VECTORS.map((vector) => vector.name));
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVEN_LOWER_HEX = /^(?:[0-9a-f]{2})+$/u;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

export function assertG04bMetadataBootstrap(metadata: G04bMetadataDocument): void {
  if (!UUID_V4_PATTERN.test(metadata.datasetEpoch) || !UUID_V4_PATTERN.test(metadata.comparisonReferenceId)) {
    throw new TypeError('G04b metadata UUID fields are invalid');
  }
  if (metadata.startupVectors.length !== 3) throw new TypeError('G04b startup vectors must contain exactly three items');
  const names = new Set<string>();
  for (const [index, vector] of metadata.startupVectors.entries()) {
    if (!STARTUP_VECTOR_NAMES.has(vector.name) || names.has(vector.name)) throw new TypeError('G04b startup vector names must be unique and exact');
    if (!EVEN_LOWER_HEX.test(vector.expectedFrameHex) || !LOWER_HEX_64.test(vector.expectedHmacHex)) {
      throw new TypeError('G04b startup vector hex shape is invalid');
    }
    const expected = G04B_STARTUP_VECTORS[index];
    if (expected === undefined || vector.name !== expected.name || vector.expectedFrameHex !== expected.expectedFrameHex || vector.expectedHmacHex !== expected.expectedHmacHex) {
      throw new TypeError('G04b startup vector literal or HMAC is incompatible');
    }
    names.add(vector.name);
  }
  if (names.size !== STARTUP_VECTOR_NAMES.size) throw new TypeError('G04b startup vectors are incomplete');
}

async function ensureCollection<T extends Document>(
  database: Db,
  name: string,
  validator: object,
): Promise<Collection<T>> {
  try {
    await database.createCollection<T>(name, {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } catch (error: unknown) {
    if (!isNamespaceExistsError(error)) throw error;
    await assertExistingCollectionOptions(database, name, validator);
  }
  return database.collection<T>(name);
}

export async function ensureG04bSchema(database: Db): Promise<G04bCollections> {
  const existingNames = new Set<string>();
  for await (const entry of database.listCollections({}, { nameOnly: true })) existingNames.add(entry.name);
  const requiredCollections = [
    G04B_QUALIFICATIONS_COLLECTION, G04A_FACE_SLOTS_COLLECTION, G04B_EVENTS_COLLECTION,
    G04B_USERS_COLLECTION, G04B_SOURCES_COLLECTION, G04B_METADATA_COLLECTION,
  ] as const;
  const freshBootstrap = existingNames.size === 0;
  if (!freshBootstrap) {
    for (const [name, validator] of [
      [G04B_QUALIFICATIONS_COLLECTION, G04B_QUALIFICATIONS_VALIDATOR],
      [G04A_FACE_SLOTS_COLLECTION, G04A_FACE_SLOTS_VALIDATOR],
      [G04B_EVENTS_COLLECTION, G04B_EVENTS_VALIDATOR],
      [G04B_USERS_COLLECTION, G04B_USERS_VALIDATOR],
      [G04B_SOURCES_COLLECTION, G04B_SOURCES_VALIDATOR],
      [G04B_METADATA_COLLECTION, G04B_METADATA_VALIDATOR],
    ] as const) {
      if (existingNames.has(name)) await assertExistingCollectionOptions(database, name, validator);
    }
    const missingCollection = requiredCollections.find((name) => !existingNames.has(name));
    if (missingCollection !== undefined) throw new TypeError(`G04b existing schema is missing required collection ${missingCollection}`);
  }
  const qualifications = await ensureCollection<G04bQualificationDocument>(database, G04B_QUALIFICATIONS_COLLECTION, G04B_QUALIFICATIONS_VALIDATOR);
  const faceSlots = await ensureG04aFaceSlotsCollection(database, freshBootstrap);
  const events = await ensureCollection<G04bEventDocument>(database, G04B_EVENTS_COLLECTION, G04B_EVENTS_VALIDATOR);
  const users = await ensureCollection<G04bUserDocument>(database, G04B_USERS_COLLECTION, G04B_USERS_VALIDATOR);
  const sources = await ensureCollection<G04bSourceDocument>(database, G04B_SOURCES_COLLECTION, G04B_SOURCES_VALIDATOR);
  const metadata = await ensureCollection<G04bMetadataDocument>(database, G04B_METADATA_COLLECTION, G04B_METADATA_VALIDATOR);
  if (freshBootstrap) {
    await qualifications.createIndexes([...G04B_QUALIFICATION_INDEXES]);
    await events.createIndexes([...G04B_EVENT_INDEXES]);
    await users.createIndexes([...G04B_USER_INDEXES]);
    await sources.createIndexes([...G04B_SOURCE_INDEXES]);
  } else {
    await assertExistingIndexContract(qualifications, G04B_QUALIFICATION_INDEXES, G04B_QUALIFICATIONS_COLLECTION);
    await assertExistingIndexContract(faceSlots, G04A_FACE_SLOTS_INDEXES, G04A_FACE_SLOTS_COLLECTION);
    await assertExistingIndexContract(events, G04B_EVENT_INDEXES, G04B_EVENTS_COLLECTION);
    await assertExistingIndexContract(users, G04B_USER_INDEXES, G04B_USERS_COLLECTION);
    await assertExistingIndexContract(sources, G04B_SOURCE_INDEXES, G04B_SOURCES_COLLECTION);
    await assertExistingIndexContract(metadata, [], G04B_METADATA_COLLECTION);
  }
  const startupSession = database.client.startSession();
  try {
    startupSession.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
    const existingMetadata = await metadata.findOne({ _id: 'system' }, { session: startupSession });
    if (existingMetadata !== null) {
      assertG04bMetadataBootstrap(existingMetadata);
      await assertExistingLegacyIntegrity({ qualifications, faceSlots, events, users, sources, metadata }, existingMetadata, startupSession);
    } else if (!freshBootstrap) {
      throw new TypeError('G04b metadata/system document is required for an existing schema');
    }
    await startupSession.commitTransaction();
  } catch (error: unknown) {
    if (startupSession.inTransaction()) await startupSession.abortTransaction().catch(() => undefined);
    throw error;
  } finally {
    await startupSession.endSession();
  }
  return { qualifications, faceSlots, events, users, sources, metadata };
}

async function assertExistingIndexContract<T extends Document>(
  collection: Collection<T>,
  expectedIndexes: readonly IndexDescription[],
  collectionName: string,
): Promise<void> {
  const actualIndexes = await collection.listIndexes().toArray();
  const actualSecondary = actualIndexes.filter((index) => index.name !== '_id_');
  if (actualSecondary.length !== expectedIndexes.length) {
    throw new TypeError(`G04b ${collectionName} index contract is incomplete or has conflicting extras`);
  }
  for (const expected of expectedIndexes) {
    const actual = actualSecondary.find((index) => index.name === expected.name);
    if (actual === undefined || !sameIndexContract(actual, expected)) {
      throw new TypeError(`G04b ${collectionName} index ${expected.name} contract is incompatible`);
    }
  }
}

function sameIndexContract(actual: Document, expected: IndexDescription): boolean {
  if (actual.v !== 2 || actual.name !== expected.name || !sameIndexKey(actual.key, expected.key)) return false;
  const expectedOptionKeys = new Set(['name', 'key', 'unique', 'partialFilterExpression', 'collation']);
  for (const key of Object.keys(actual)) {
    if (key !== 'v' && !expectedOptionKeys.has(key)) return false;
  }
  for (const key of ['unique', 'partialFilterExpression', 'collation'] as const) {
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (key === 'collation' && actualValue === undefined && isSimpleCollation(expectedValue)) continue;
    if (expectedValue === undefined ? actualValue !== undefined : !sameBsonJson(actualValue, expectedValue)) return false;
  }
  return true;
}

function isSimpleCollation(value: unknown): boolean {
  return isPlainObject(value) && value.locale === 'simple' && Object.keys(value).length === 1;
}

function sameIndexKey(actual: unknown, expected: unknown): boolean {
  if (!isPlainObject(actual) || !isPlainObject(expected)) return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length && actualEntries.every(([key, value], index) => {
    const expectedEntry = expectedEntries[index];
    return expectedEntry !== undefined && key === expectedEntry[0] && Object.is(value, expectedEntry[1]);
  });
}

async function assertExistingLegacyIntegrity(
  collections: G04bCollections,
  metadataDocument: G04bMetadataDocument,
  session: ClientSession,
): Promise<void> {
  await assertNoInvalidDocuments(collections.qualifications, G04B_QUALIFICATIONS_VALIDATOR, G04B_QUALIFICATIONS_COLLECTION, session);
  await assertNoInvalidDocuments(collections.faceSlots, G04A_FACE_SLOTS_VALIDATOR, G04A_FACE_SLOTS_COLLECTION, session);
  await assertNoInvalidDocuments(collections.events, G04B_EVENTS_VALIDATOR, G04B_EVENTS_COLLECTION, session);
  await assertNoInvalidDocuments(collections.users, G04B_USERS_VALIDATOR, G04B_USERS_COLLECTION, session);
  await assertNoInvalidDocuments(collections.sources, G04B_SOURCES_VALIDATOR, G04B_SOURCES_COLLECTION, session);
  await assertNoInvalidDocuments(collections.metadata, G04B_METADATA_VALIDATOR, G04B_METADATA_COLLECTION, session);
  await assertExistingEventIntegrity(collections.events, metadataDocument, session);
  await assertExistingReferenceIntegrity(collections, session);
  const faceSlotCount = await collections.faceSlots.countDocuments({}, { session });
  if (faceSlotCount !== metadataDocument.slotCount) throw new TypeError('G04b existing metadata slotCount is inconsistent with faceSlots');
}

async function assertNoInvalidDocuments<T extends Document>(
  collection: Collection<T>,
  validator: object,
  collectionName: string,
  session: ClientSession,
): Promise<void> {
  const invalid = await collection.aggregate<{ readonly _id: unknown }>([
    { $match: { $nor: [validator] } },
    { $project: { _id: 1 } },
    { $limit: 1 },
  ], { session }).next();
  if (invalid !== null) throw new TypeError(`G04b existing ${collectionName} row violates its schema`);
}

async function assertExistingReferenceIntegrity(
  collections: G04bCollections,
  session: ClientSession,
): Promise<void> {
  const orphanMapping = await collections.faceSlots.aggregate<{ readonly _id: unknown }>([
    { $match: { qualificationId: { $type: 'string' } } },
    {
      $lookup: {
        from: G04B_QUALIFICATIONS_COLLECTION,
        let: { qualificationId: '$qualificationId', incarnation: '$qualificationIncarnation' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$_id', '$$qualificationId'] },
            { $eq: ['$incarnation', '$$incarnation'] },
          ] } } },
          { $project: { _id: 1 } },
          { $limit: 1 },
        ],
        as: 'qualificationMatch',
      },
    },
    { $match: { $expr: { $eq: [{ $size: '$qualificationMatch' }, 0] } } },
    { $project: { _id: 1 } },
    { $limit: 1 },
  ], { session }).next();
  if (orphanMapping !== null) throw new TypeError('G04b existing face mapping is orphaned or has a qualification incarnation mismatch');

  const orphanEventSource = await collections.events.aggregate<{ readonly _id: unknown }>([
    {
      $lookup: {
        from: G04B_SOURCES_COLLECTION,
        let: { sourceId: '$sourceId', direction: '$direction' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$_id', '$$sourceId'] },
            { $eq: ['$direction', '$$direction'] },
          ] } } },
          { $project: { _id: 1 } },
          { $limit: 1 },
        ],
        as: 'sourceMatch',
      },
    },
    { $match: { $expr: { $eq: [{ $size: '$sourceMatch' }, 0] } } },
    { $project: { _id: 1 } },
    { $limit: 1 },
  ], { session }).next();
  if (orphanEventSource !== null) throw new TypeError('G04b existing Event references a missing source');

  const orphanEventQualification = await collections.events.aggregate<{ readonly _id: unknown }>([
    { $match: { qualificationId: { $type: 'string' } } },
    {
      $lookup: {
        from: G04B_QUALIFICATIONS_COLLECTION,
        let: { qualificationId: '$qualificationId' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$qualificationId'] } } },
          { $project: { _id: 1 } },
          { $limit: 1 },
        ],
        as: 'qualificationMatch',
      },
    },
    { $match: { $expr: { $eq: [{ $size: '$qualificationMatch' }, 0] } } },
    { $project: { _id: 1 } },
    { $limit: 1 },
  ], { session }).next();
  if (orphanEventQualification !== null) throw new TypeError('G04b existing Event references a missing qualification');
}

async function assertExistingEventIntegrity(
  events: Collection<G04bEventDocument>,
  metadata: G04bMetadataDocument,
  session: ClientSession,
): Promise<void> {
  const invalidShape = await events.aggregate<{ readonly _id: unknown }>([
    { $match: { $nor: [G04B_EVENTS_VALIDATOR] } },
    { $project: { _id: 1 } },
    { $limit: 1 },
  ], { session }).next();
  if (invalidShape !== null) throw new TypeError('G04b existing event schema/comparison fields are incompatible');

  const mixedReference = await events.find(
    { comparisonReferenceId: { $exists: true, $ne: metadata.comparisonReferenceId } },
    { session, projection: { _id: 1 }, hint: G04B_EVENT_COMPARISON_INDEX },
  ).limit(1).next();
  if (mixedReference !== null) throw new TypeError('G04b existing event comparison reference is incompatible with metadata');
}

async function assertExistingCollectionOptions(database: Db, name: string, expectedValidator: object): Promise<void> {
  const info = await database.listCollections({ name }, { nameOnly: false }).next();
  const options = info?.options as { validator?: unknown; validationLevel?: unknown; validationAction?: unknown } | undefined;
  if (options === undefined || options.validationLevel !== 'strict' || options.validationAction !== 'error' || !sameBsonJson(options.validator, expectedValidator)) {
    throw new TypeError(`G04b ${name} validator/schema bootstrap options are incompatible`);
  }
}

function sameBsonJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return false;
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameBsonJson(value, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameBsonJson(left[key], right[key]));
  }
  if (typeof left !== typeof right) return false;
  return Object.is(left, right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNamespaceExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'codeName' in error &&
    (error as { codeName?: unknown }).codeName === 'NamespaceExists';
}
