import { decideG11fMaintenance, G11fFaultControllerError, type G11fFaultObservation } from '../../src/deployment/internal/g11f-fault-controller.js';

const base: G11fFaultObservation = Object.freeze({
  operation: 'RESET', marker: 'ACTIVE', api: 'STOPPED', mongo: 'PRIMARY', writers: 0,
  lock: 'ACQUIRED', ticket: 'VALID', currentEpoch: '11111111-1111-4111-8111-111111111111',
  targetEpoch: '22222222-2222-4222-8222-222222222222', writeRunClaim: 'NULL', resetState: 'NONE', controlledRerun: false,
});

describe('G11f canonical fail-closed policy', () => {
  test('nominal and committed handoff are distinct', () => {
    expect(decideG11fMaintenance(base)).toEqual({ action: 'REQUIRE_RESET', reason: 'PRECONDITIONS_PROVEN' });
    expect(decideG11fMaintenance({ ...base, resetState: 'COMMITTED' })).toEqual({ action: 'HANDOFF', reason: 'RESET_COMMITTED' });
  });

  test('partial reset requires explicit controlled rerun', () => {
    expect(() => decideG11fMaintenance({ ...base, resetState: 'PARTIAL' })).toThrow(new G11fFaultControllerError('PARTIAL_RESET_REQUIRES_CONTROL'));
    expect(decideG11fMaintenance({ ...base, resetState: 'PARTIAL', controlledRerun: true })).toEqual({ action: 'REPAIR_RERUN', reason: 'PARTIAL_RESET_RETRY' });
  });

  test.each([
    ['marker off', { marker: 'MISSING' }, 'MARKER_NOT_ACTIVE'], ['API running', { api: 'RUNNING' }, 'API_NOT_STOPPED'],
    ['Mongo not primary', { mongo: 'NOT_PRIMARY' }, 'MONGO_NOT_PRIMARY'], ['extra writer', { writers: 1 }, 'WRITERS_PRESENT'],
    ['unknown writer count', { writers: 'UNKNOWN' }, 'WRITER_COUNT_UNKNOWN'], ['lock lost', { lock: 'HELD' }, 'LOCK_NOT_OWNED'],
    ['ticket invalid', { ticket: 'INVALID' }, 'TICKET_NOT_VALID'], ['epoch unknown', { currentEpoch: 'UNKNOWN' }, 'EPOCH_UNCERTAIN'],
    ['same epoch', { targetEpoch: base.currentEpoch }, 'EPOCH_NOT_NEW'], ['claim held', { writeRunClaim: 'HELD' }, 'CLAIM_NOT_NULL'],
    ['reset unknown', { resetState: 'UNKNOWN' }, 'RESET_STATE_UNKNOWN'],
  ] as const)('%s closes without reset', (_label, change, code) => {
    expect(() => decideG11fMaintenance({ ...base, ...change })).toThrow(new G11fFaultControllerError(code));
  });

  test('ordinary restart is write-closed and malformed observations fail closed', () => {
    expect(() => decideG11fMaintenance({ ...base, operation: 'ORDINARY_RESTART' })).toThrow(new G11fFaultControllerError('ORDINARY_RESTART_WRITE_CLOSED'));
    expect(() => decideG11fMaintenance({ ...base, targetEpoch: 'not-a-uuid' })).toThrow(new G11fFaultControllerError('INVALID_OBSERVATION'));
    expect(() => decideG11fMaintenance({ ...base, resetState: 'BOGUS' as never })).toThrow(new G11fFaultControllerError('INVALID_OBSERVATION'));
  });
});
