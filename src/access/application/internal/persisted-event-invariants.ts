export interface PersistedEventInvariantInput {
  readonly direction: 'ENTRY' | 'EXIT';
  readonly outcome: 'ACCEPTED' | 'REJECTED';
  readonly reasonCode: string;
  readonly qualificationId: string | null;
  readonly presenceTransition: Readonly<{ readonly from: string; readonly to: string }> | null;
}

const UNQUALIFIED_REASONS = new Set([
  'SOURCE_INACTIVE', 'INVALID_QR_CREDENTIAL', 'FACE_UNKNOWN', 'FACE_SUBJECT_NOT_MAPPED',
]);
const ENTRY_REASONS = new Set([
  'QUALIFICATION_REVOKED', 'ALREADY_INSIDE', 'QUALIFICATION_ALREADY_USED',
  'QUALIFICATION_NOT_YET_VALID', 'QUALIFICATION_EXPIRED',
]);
const EXIT_REASONS = new Set(['NOT_INSIDE', 'ALREADY_EXITED']);

/** Shared persisted Event semantic guard used by query and recognition response paths. */
export function assertPersistedEventInvariant(event: PersistedEventInvariantInput): void {
  if (event.outcome === 'ACCEPTED') {
    if (event.qualificationId === null || event.presenceTransition === null) throw new TypeError('accepted event qualification/transition is invalid');
    if (event.reasonCode === 'ENTRY_GRANTED') {
      if (event.direction !== 'ENTRY' || event.presenceTransition.from !== 'NOT_ENTERED' || event.presenceTransition.to !== 'INSIDE') throw new TypeError('entry event invariant is invalid');
      return;
    }
    if (event.reasonCode === 'EXIT_RECORDED') {
      if (event.direction !== 'EXIT' || event.presenceTransition.from !== 'INSIDE' || event.presenceTransition.to !== 'EXITED') throw new TypeError('exit event invariant is invalid');
      return;
    }
    throw new TypeError('accepted event reason is invalid');
  }
  if (event.presenceTransition !== null) throw new TypeError('rejected event transition must be null');
  if (UNQUALIFIED_REASONS.has(event.reasonCode)) {
    if (event.qualificationId !== null) throw new TypeError('unqualified rejection carries qualification');
    return;
  }
  if (ENTRY_REASONS.has(event.reasonCode)) {
    if (event.qualificationId === null || event.direction !== 'ENTRY') throw new TypeError('entry rejection invariant is invalid');
    return;
  }
  if (EXIT_REASONS.has(event.reasonCode)) {
    if (event.qualificationId === null || event.direction !== 'EXIT') throw new TypeError('exit rejection invariant is invalid');
    return;
  }
  throw new TypeError('rejected event reason is invalid');
}
