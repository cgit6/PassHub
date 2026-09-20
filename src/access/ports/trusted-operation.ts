import type { Direction } from '../domain/index.js';
import {
  isComparisonArtifact,
  type ComparisonArtifact,
} from './comparison-artifact.js';

export interface ManagementPersistenceEnvelope {
  readonly receivedAtMs: number;
  readonly actorId: string;
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
  managementEnvelopes.set(plan, Object.freeze({ ...envelope }));
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
