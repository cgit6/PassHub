import {
  DIRECTIONS,
  REASON_CODES,
  type Direction,
  type ReasonCode,
} from '../domain/index.js';
import type { RedactedAccessEventProjection } from '../ports/index.js';

/**
 * The only mapper from a persisted Event record to a recognition result
 * projection. It accepts the saved document shape, never a domain decision,
 * and deliberately drops comparison digests and every other persistence-only
 * field.
 */
export interface PersistedRecognitionEventRecord {
  readonly _id: unknown;
  readonly sourceId: unknown;
  readonly kind: unknown;
  readonly direction: unknown;
  readonly outcome: unknown;
  readonly reasonCode: unknown;
  readonly receivedAt: unknown;
  readonly recordedAt: unknown;
  readonly qualificationId: unknown;
  readonly presenceTransition: unknown;
}

export function toRedactedAccessEventProjection(
  record: PersistedRecognitionEventRecord,
): RedactedAccessEventProjection {
  if (!isNonEmptyString(record._id) || !isNonEmptyString(record.sourceId) ||
      !isKind(record.kind) || !isDirection(record.direction) ||
      (record.outcome !== 'ACCEPTED' && record.outcome !== 'REJECTED') ||
      !isReasonCode(record.reasonCode) ||
      !(record.receivedAt instanceof Date) || Number.isNaN(record.receivedAt.getTime()) ||
      !(record.recordedAt instanceof Date) || Number.isNaN(record.recordedAt.getTime()) ||
      !(record.qualificationId === null || isNonEmptyString(record.qualificationId)) ||
      !isPresenceTransition(record.presenceTransition)) {
    throw new TypeError('persisted recognition event is malformed');
  }
  const presenceTransition = record.presenceTransition === null
    ? null
    : Object.freeze({
        from: (record.presenceTransition as { from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED'; to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED' }).from,
        to: (record.presenceTransition as { from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED'; to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED' }).to,
      });
  return Object.freeze({
    eventId: record._id,
    sourceId: record.sourceId,
    direction: record.direction,
    kind: record.kind,
    outcome: record.outcome,
    reasonCode: record.reasonCode,
    receivedAtMs: record.receivedAt.getTime(),
    recordedAtMs: record.recordedAt.getTime(),
    qualificationId: record.qualificationId,
    presenceTransition,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isKind(value: unknown): value is RedactedAccessEventProjection['kind'] {
  return value === 'QR_SCANNED' || value === 'FACE_MATCHED' || value === 'FACE_UNKNOWN';
}

function isDirection(value: unknown): value is Direction {
  return (DIRECTIONS as readonly unknown[]).includes(value);
}

function isReasonCode(value: unknown): value is ReasonCode {
  return (REASON_CODES as readonly unknown[]).includes(value);
}

function isPresenceTransition(
  value: unknown,
): value is RedactedAccessEventProjection['presenceTransition'] {
  if (value === null) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as { from?: unknown; to?: unknown };
  return (candidate.from === 'NOT_ENTERED' || candidate.from === 'INSIDE' || candidate.from === 'EXITED') &&
    (candidate.to === 'NOT_ENTERED' || candidate.to === 'INSIDE' || candidate.to === 'EXITED');
}
