/** @deprecated Compatibility import; G11f has one canonical policy module. */
export {
  decideG11fMaintenance as decideG11fRecovery,
  G11fFaultControllerError,
  type G11fFaultObservation as G11fFaultInput,
  type G11fDecision,
  type G11fResetState,
} from './g11f-fault-controller.js';

import type { G11fResetState } from './g11f-fault-controller.js';

export function assertG11fConverged(previous: G11fResetState, next: G11fResetState, newEpoch: boolean, claimNull: boolean): void {
  if (previous !== 'PARTIAL' || next !== 'COMMITTED' || !newEpoch || !claimNull) throw new Error('G11F_RERUN_NOT_CONVERGED');
}
