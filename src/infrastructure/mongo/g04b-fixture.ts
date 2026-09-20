import { randomUUID } from 'node:crypto';

import type { G04aFaceSlotDocument } from './g04a-face-index-schema.js';
import type {
  G04bEventDocument,
  G04bMetadataDocument,
  G04bQualificationDocument,
  G04bSourceDocument,
  G04bUserDocument,
} from './g04b-schema.js';
export interface G04bFixture {
  readonly datasetEpoch: string;
  readonly comparisonReferenceId: string;
  readonly qualificationId: string;
  readonly qualificationIncarnation: string;
  readonly faceSlotId: string;
  readonly sourceEntryId: string;
  readonly sourceExitId: string;
  readonly qualifications: readonly G04bQualificationDocument[];
  readonly faceSlots: readonly G04aFaceSlotDocument[];
  readonly events: readonly G04bEventDocument[];
  readonly users: readonly G04bUserDocument[];
  readonly sources: readonly G04bSourceDocument[];
  readonly metadata: G04bMetadataDocument;
}

import { G04B_STARTUP_VECTORS } from './g04b-schema.js';

export function createG04bFixture(nowMs = Date.now()): G04bFixture {
  if (!Number.isSafeInteger(nowMs)) throw new TypeError('fixture time must be a safe integer');
  const now = new Date(nowMs);
  const datasetEpoch = randomUUID();
  const comparisonReferenceId = '11111111-1111-4111-8111-111111111111';
  const qualificationId = randomUUID();
  const qualificationIncarnation = randomUUID();
  const faceSlotId = randomUUID();
  const emptyFaceSlotId = randomUUID();
  const sourceEntryId = randomUUID();
  const sourceExitId = randomUUID();
  const faceSlot: G04aFaceSlotDocument = {
    _id: faceSlotId,
    provider: 'DemoFace',
    subject: 'subject-1',
    qualificationId,
    qualificationIncarnation,
    slotIncarnation: randomUUID(),
    version: 0,
  };
  const emptyFaceSlot: G04aFaceSlotDocument = {
    _id: emptyFaceSlotId,
    provider: 'DemoFace.empty',
    subject: 'empty-1',
    qualificationId: null,
    qualificationIncarnation: null,
    slotIncarnation: randomUUID(),
    version: 0,
  };
  const qualification: G04bQualificationDocument = {
    _id: qualificationId,
    incarnation: qualificationIncarnation,
    version: 0,
    displayName: 'G04b fixture',
    validFrom: new Date(nowMs - 60_000),
    validUntil: new Date(nowMs + 60 * 60_000),
    createdBy: randomUUID(),
    qrLookupDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    presence: 'NOT_ENTERED',
    enteredAt: null,
    exitedAt: null,
    revokedAt: null,
    revocationReason: null,
    expiredTerminalAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const source = (id: string, alias: 'entry' | 'exit', direction: 'ENTRY' | 'EXIT'): G04bSourceDocument => ({
    _id: id,
    credentialAlias: alias,
    direction,
    active: true,
    credentialDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    incarnation: randomUUID(),
    version: 0,
  });
  const metadata: G04bMetadataDocument = {
    _id: 'system',
    kind: 'system',
    datasetEpoch,
    comparisonReferenceId,
    frameVersion: 'v2',
    startupVectors: G04B_STARTUP_VECTORS,
    qrGuardVersion: 0,
    faceGuardVersion: 0,
    slotCount: 2,
    writeRunClaim: null,
  };
  return Object.freeze({
    datasetEpoch,
    comparisonReferenceId,
    qualificationId,
    qualificationIncarnation,
    faceSlotId,
    sourceEntryId,
    sourceExitId,
    qualifications: Object.freeze([qualification]),
    faceSlots: Object.freeze([faceSlot, emptyFaceSlot]),
    events: Object.freeze([]),
    users: Object.freeze([{
      _id: randomUUID(), username: 'operator', role: 'OPERATOR', enabled: true,
      passwordSalt: 'c'.repeat(32), passwordHash: 'd'.repeat(128),
      scryptParams: { N: 131072, r: 8, p: 1, keyLength: 64 },
    } satisfies G04bUserDocument]),
    sources: Object.freeze([source(sourceEntryId, 'entry', 'ENTRY'), source(sourceExitId, 'exit', 'EXIT')]),
    metadata,
  });
}
