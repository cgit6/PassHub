import type { Direction } from '../domain/index.js';
import {
  isComparisonArtifact,
  type ComparisonArtifact,
} from './comparison-artifact.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ManagementPersistenceEnvelope {
  readonly receivedAtMs: number;
  readonly actorId: string;
  readonly expectedQualification?: Readonly<{
    readonly qualificationId: string;
    readonly incarnation: string;
    readonly version: number;
  }>;
}

export interface RecognitionPersistenceEnvelope {
  readonly externalEventId: string;
  readonly receivedAtMs: number;
  readonly sourceId: string;
  readonly direction: Direction;
  readonly comparisonArtifact: ComparisonArtifact;
}

const managementEnvelopes = new WeakMap<object, ManagementPersistenceEnvelope>();
const recognitionEnvelopes = new WeakMap<object, RecognitionPersistenceEnvelope>();

export function registerManagementPersistenceEnvelope(
  plan: object,
  envelope: ManagementPersistenceEnvelope,
): void {
  if (typeof envelope.actorId !== 'string' || !UUID_V4.test(envelope.actorId)) {
    throw new TypeError('management envelope actorId must be a canonical UUID v4');
  }
  if (!Number.isSafeInteger(envelope.receivedAtMs)) {
    throw new TypeError('management envelope receivedAtMs must be a safe integer');
  }
  let expectedQualification: ManagementPersistenceEnvelope['expectedQualification'];
  if (envelope.expectedQualification !== undefined) {
    const expected = envelope.expectedQualification;
    if (expected === null || typeof expected !== 'object') {
      throw new TypeError('management envelope expectedQualification must be an object');
    }
    if (typeof expected.qualificationId !== 'string' || !UUID_V4.test(expected.qualificationId)) {
      throw new TypeError('management envelope qualificationId must be a canonical UUID v4');
    }
    if (typeof expected.incarnation !== 'string' || !UUID_V4.test(expected.incarnation)) {
      throw new TypeError('management envelope incarnation must be a canonical UUID v4');
    }
    if (!Number.isSafeInteger(expected.version) || expected.version < 0) {
      throw new TypeError('management envelope version must be a non-negative safe integer');
    }
    // Copy the nested object before freezing the envelope. The caller may
    // retain and mutate its original plan/envelope after issuance.
    expectedQualification = Object.freeze({
      qualificationId: expected.qualificationId,
      incarnation: expected.incarnation,
      version: expected.version,
    });
  }
  const stored: ManagementPersistenceEnvelope = {
    receivedAtMs: envelope.receivedAtMs,
    actorId: envelope.actorId,
    ...(expectedQualification === undefined ? {} : { expectedQualification }),
  };
  managementEnvelopes.set(plan, Object.freeze(stored));
}

export function readManagementPersistenceEnvelope(
  plan: object,
): ManagementPersistenceEnvelope | null {
  return managementEnvelopes.get(plan) ?? null;
}

export function registerRecognitionPersistenceEnvelope(
  plan: object,
  envelope: RecognitionPersistenceEnvelope,
): void {
  if (!isComparisonArtifact(envelope.comparisonArtifact)) {
    throw new TypeError('recognition envelope requires a verified comparison artifact');
  }
  recognitionEnvelopes.set(plan, Object.freeze({ ...envelope }));
}

export function readRecognitionPersistenceEnvelope(
  plan: object,
): RecognitionPersistenceEnvelope | null {
  return recognitionEnvelopes.get(plan) ?? null;
}
