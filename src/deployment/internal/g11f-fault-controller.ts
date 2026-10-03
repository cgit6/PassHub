/**
 * Canonical G11f fail-closed policy. Adapters from G11a--G11e build this
 * observation from real runtime facts; this module itself performs no I/O.
 */
export type G11fOperation = 'RESET' | 'ORDINARY_RESTART';
export type G11fResetState = 'NONE' | 'COMMITTED' | 'PARTIAL' | 'UNKNOWN';

export interface G11fFaultObservation {
  readonly operation: G11fOperation;
  readonly marker: 'ACTIVE' | 'MISSING' | 'UNKNOWN';
  readonly api: 'STOPPED' | 'RUNNING' | 'UNKNOWN';
  readonly mongo: 'PRIMARY' | 'NOT_PRIMARY' | 'UNKNOWN';
  readonly writers: number | 'UNKNOWN';
  readonly lock: 'HELD' | 'ACQUIRED' | 'UNKNOWN';
  readonly ticket: 'VALID' | 'INVALID' | 'UNKNOWN';
  readonly currentEpoch: string | null | 'UNKNOWN';
  readonly targetEpoch: string | null | 'UNKNOWN';
  readonly writeRunClaim: 'NULL' | 'HELD' | 'UNKNOWN';
  readonly resetState: G11fResetState;
  readonly controlledRerun: boolean;
}

export type G11fDecision =
  | { readonly action: 'REQUIRE_RESET'; readonly reason: 'PRECONDITIONS_PROVEN' }
  | { readonly action: 'REPAIR_RERUN'; readonly reason: 'PARTIAL_RESET_RETRY' }
  | { readonly action: 'HANDOFF'; readonly reason: 'RESET_COMMITTED' }
  | { readonly action: 'CLOSED'; readonly code: G11fFaultCode };

export type G11fFaultCode =
  | 'INVALID_OBSERVATION' | 'MARKER_NOT_ACTIVE' | 'API_NOT_STOPPED' | 'MONGO_NOT_PRIMARY'
  | 'WRITERS_PRESENT' | 'WRITER_COUNT_UNKNOWN' | 'LOCK_NOT_OWNED' | 'TICKET_NOT_VALID'
  | 'EPOCH_UNCERTAIN' | 'EPOCH_NOT_NEW' | 'CLAIM_NOT_NULL' | 'RESET_STATE_UNKNOWN'
  | 'PARTIAL_RESET_REQUIRES_CONTROL' | 'ORDINARY_RESTART_WRITE_CLOSED';

export class G11fFaultControllerError extends Error {
  constructor(readonly code: G11fFaultCode) { super(code); this.name = 'G11fFaultControllerError'; }
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function decideG11fMaintenance(observation: G11fFaultObservation): G11fDecision {
  validateObservation(observation);
  if (observation.operation === 'ORDINARY_RESTART') throw new G11fFaultControllerError('ORDINARY_RESTART_WRITE_CLOSED');
  if (observation.marker !== 'ACTIVE') throw new G11fFaultControllerError('MARKER_NOT_ACTIVE');
  if (observation.api !== 'STOPPED') throw new G11fFaultControllerError('API_NOT_STOPPED');
  if (observation.mongo !== 'PRIMARY') throw new G11fFaultControllerError('MONGO_NOT_PRIMARY');
  if (observation.writers === 'UNKNOWN') throw new G11fFaultControllerError('WRITER_COUNT_UNKNOWN');
  if (observation.writers !== 0) throw new G11fFaultControllerError('WRITERS_PRESENT');
  if (observation.lock !== 'ACQUIRED') throw new G11fFaultControllerError('LOCK_NOT_OWNED');
  if (observation.ticket !== 'VALID') throw new G11fFaultControllerError('TICKET_NOT_VALID');
  if (observation.currentEpoch === 'UNKNOWN' || observation.targetEpoch === 'UNKNOWN'
    || observation.currentEpoch === null || observation.targetEpoch === null) throw new G11fFaultControllerError('EPOCH_UNCERTAIN');
  if (observation.currentEpoch === observation.targetEpoch) throw new G11fFaultControllerError('EPOCH_NOT_NEW');
  if (observation.writeRunClaim !== 'NULL') throw new G11fFaultControllerError('CLAIM_NOT_NULL');
  if (observation.resetState === 'UNKNOWN') throw new G11fFaultControllerError('RESET_STATE_UNKNOWN');
  if (observation.resetState === 'PARTIAL') {
    if (!observation.controlledRerun) throw new G11fFaultControllerError('PARTIAL_RESET_REQUIRES_CONTROL');
    return Object.freeze({ action: 'REPAIR_RERUN', reason: 'PARTIAL_RESET_RETRY' });
  }
  if (observation.resetState === 'COMMITTED') return Object.freeze({ action: 'HANDOFF', reason: 'RESET_COMMITTED' });
  return Object.freeze({ action: 'REQUIRE_RESET', reason: 'PRECONDITIONS_PROVEN' });
}

function validateObservation(value: G11fFaultObservation): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !['RESET', 'ORDINARY_RESTART'].includes(value.operation)
    || !['ACTIVE', 'MISSING', 'UNKNOWN'].includes(value.marker)
    || !['STOPPED', 'RUNNING', 'UNKNOWN'].includes(value.api)
    || !['PRIMARY', 'NOT_PRIMARY', 'UNKNOWN'].includes(value.mongo)
    || (typeof value.writers !== 'number' && value.writers !== 'UNKNOWN')
    || (typeof value.writers === 'number' && (!Number.isSafeInteger(value.writers) || value.writers < 0))
    || !['HELD', 'ACQUIRED', 'UNKNOWN'].includes(value.lock)
    || !['VALID', 'INVALID', 'UNKNOWN'].includes(value.ticket)
    || (typeof value.currentEpoch !== 'string' && value.currentEpoch !== null && value.currentEpoch !== 'UNKNOWN')
    || (typeof value.targetEpoch !== 'string' && value.targetEpoch !== null && value.targetEpoch !== 'UNKNOWN')
    || (typeof value.currentEpoch === 'string' && value.currentEpoch !== 'UNKNOWN' && !uuidV4.test(value.currentEpoch))
    || (typeof value.targetEpoch === 'string' && value.targetEpoch !== 'UNKNOWN' && !uuidV4.test(value.targetEpoch))
    || !['NULL', 'HELD', 'UNKNOWN'].includes(value.writeRunClaim)
    || !['NONE', 'COMMITTED', 'PARTIAL', 'UNKNOWN'].includes(value.resetState)
    || typeof value.controlledRerun !== 'boolean') throw new G11fFaultControllerError('INVALID_OBSERVATION');
}
