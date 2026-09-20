import type { Collection, Db, IndexDescription } from 'mongodb';

export const G04A_FACE_SLOTS_COLLECTION = 'faceSlots';
export const G04A_FACE_SUBJECT_INDEX = 'g04a_face_subject_unique_v1';
export const G04A_FACE_QUALIFICATION_INDEX =
  'g04a_face_qualification_unique_v1';
const UUID = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
} as const;

/**
 * The G04a experiment deliberately owns only the faceSlots collection. It
 * does not claim to be the v1 persistence adapter or to validate the other
 * five collections.
 */
export interface G04aFaceSlotDocument {
  readonly _id: string;
  readonly provider: string;
  readonly subject: string;
  readonly qualificationId: string | null;
  readonly qualificationIncarnation: string | null;
  readonly slotIncarnation: string;
  readonly version: number;
}

export const G04A_FACE_SLOTS_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    oneOf: [
      {
        properties: {
          qualificationId: { bsonType: 'null' },
          qualificationIncarnation: { bsonType: 'null' },
        },
      },
      {
        properties: {
          qualificationId: { bsonType: 'string' },
          qualificationIncarnation: { bsonType: 'string' },
        },
      },
    ],
    required: [
      '_id',
      'provider',
      'subject',
      'qualificationId',
      'qualificationIncarnation',
      'slotIncarnation',
      'version',
    ],
    properties: {
      _id: UUID,
      provider: { bsonType: 'string', minLength: 1 },
      subject: { bsonType: 'string', minLength: 1 },
      qualificationId: { bsonType: ['null', 'string'], oneOf: [{ bsonType: 'null' }, UUID] },
      qualificationIncarnation: { bsonType: ['null', 'string'], oneOf: [{ bsonType: 'null' }, UUID] },
      slotIncarnation: UUID,
      version: { bsonType: 'int', minimum: 0 },
    },
  },
});

export const G04A_FACE_SLOTS_INDEXES: readonly IndexDescription[] =
  Object.freeze([
    {
      key: { provider: 1, subject: 1 },
      name: G04A_FACE_SUBJECT_INDEX,
      unique: true,
      collation: { locale: 'simple' },
    },
    {
      key: { qualificationId: 1 },
      name: G04A_FACE_QUALIFICATION_INDEX,
      unique: true,
      partialFilterExpression: { qualificationId: { $type: 'string' } },
      collation: { locale: 'simple' },
    },
  ]);

export async function ensureG04aFaceSlotsCollection(
  database: Db,
  installIndexes = true,
): Promise<Collection<G04aFaceSlotDocument>> {
  try {
    await database.createCollection<G04aFaceSlotDocument>(
      G04A_FACE_SLOTS_COLLECTION,
      {
        validator: G04A_FACE_SLOTS_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    );
  } catch (error: unknown) {
    if (!isNamespaceExistsError(error)) {
      throw error;
    }
  }

  const collection = database.collection<G04aFaceSlotDocument>(
    G04A_FACE_SLOTS_COLLECTION,
  );
  if (installIndexes) await collection.createIndexes([...G04A_FACE_SLOTS_INDEXES]);
  return collection;
}

function isNamespaceExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'codeName' in error &&
    (error as { codeName?: unknown }).codeName === 'NamespaceExists'
  );
}
