import type { RecognitionComparisonInput } from '../../access/application/comparison/comparison-port.js';
import type { RedactedAccessEventProjection } from '../../access/ports/index.js';
import { assertPersistedEventInvariant } from '../../access/application/internal/persisted-event-invariants.js';

/**
 * Facts which must still be true when a persisted Event is rendered.  These
 * are deliberately supplied by the already-authenticated request/work
 * envelope; they are not reconstructed from the Event itself.
 */
export interface RecognitionEventExpectations {
  readonly sourceId: string;
  readonly input: RecognitionComparisonInput;
  readonly receivedAtMs: number;
}

/**
 * Fail closed if a persistence adapter returns an Event which does not match
 * the request envelope or the domain's fixed reason/transition matrix.
 *
 * This is intentionally an internal assertion: a mismatch means the writer
 * cannot safely produce a canonical 200 response and must classify the write
 * as UNKNOWN_EFFECT.
 */
export function assertRecognitionEventInvariant(
  event: RedactedAccessEventProjection,
  expected: RecognitionEventExpectations,
): void {
  assertPersistedEventInvariant(event);
  if (event.sourceId !== expected.sourceId) {
    throw new TypeError('persisted event source does not match request source');
  }
  if (event.kind !== kindForInput(expected.input)) {
    throw new TypeError('persisted event kind does not match request input');
  }
  if (event.receivedAtMs !== expected.receivedAtMs) {
    throw new TypeError('persisted event receivedAt does not match request');
  }

  const reason = event.reasonCode;
  if (event.outcome === 'ACCEPTED') {
    if (reason === 'ENTRY_GRANTED') {
      assertAcceptedTransition(event, 'ENTRY', 'NOT_ENTERED', 'INSIDE');
      requireQualification(event, reason);
      return;
    }
    if (reason === 'EXIT_RECORDED') {
      assertAcceptedTransition(event, 'EXIT', 'INSIDE', 'EXITED');
      requireQualification(event, reason);
      return;
    }
    throw new TypeError('accepted event has a rejection reason');
  }

  if (event.presenceTransition !== null) {
    throw new TypeError('rejected event has a presence transition');
  }
  if (reason === 'SOURCE_INACTIVE'
    || reason === 'INVALID_QR_CREDENTIAL'
    || reason === 'FACE_UNKNOWN'
    || reason === 'FACE_SUBJECT_NOT_MAPPED') {
    if (event.qualificationId !== null) {
      throw new TypeError(`${reason} must not carry a qualification`);
    }
    return;
  }

  if (reason === 'QUALIFICATION_REVOKED'
    || reason === 'ALREADY_INSIDE'
    || reason === 'QUALIFICATION_ALREADY_USED'
    || reason === 'QUALIFICATION_NOT_YET_VALID'
    || reason === 'QUALIFICATION_EXPIRED') {
    requireQualification(event, reason);
    if (event.direction !== 'ENTRY') {
      throw new TypeError(`${reason} is ENTRY-only`);
    }
    return;
  }

  if (reason === 'NOT_INSIDE' || reason === 'ALREADY_EXITED') {
    requireQualification(event, reason);
    if (event.direction !== 'EXIT') {
      throw new TypeError(`${reason} is EXIT-only`);
    }
    return;
  }

  throw new TypeError('rejected event has an accepted reason');
}

function kindForInput(input: RecognitionComparisonInput): RedactedAccessEventProjection['kind'] {
  switch (input.kind) {
    case 'QR_SCANNED':
      return 'QR_SCANNED';
    case 'FACE_MATCHED':
      return 'FACE_MATCHED';
    case 'FACE_UNKNOWN':
      return 'FACE_UNKNOWN';
  }
}

function requireQualification(
  event: RedactedAccessEventProjection,
  reason: string,
): void {
  if (event.qualificationId === null) {
    throw new TypeError(`${reason} must carry a qualification`);
  }
}

function assertAcceptedTransition(
  event: RedactedAccessEventProjection,
  direction: 'ENTRY' | 'EXIT',
  from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED',
  to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED',
): void {
  if (event.direction !== direction
    || event.presenceTransition === null
    || event.presenceTransition.from !== from
    || event.presenceTransition.to !== to) {
    throw new TypeError('accepted event has an invalid direction or transition');
  }
}
