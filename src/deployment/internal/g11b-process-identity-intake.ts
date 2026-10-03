import { G11B_RUN_TICKET_DIRECTORY } from './g11b-run-ticket-intake.js';
import { readProcessIdentityWithEngine } from './g11b-process-identity-engine.js';

export {
  ProcessIdentityIntakeError,
  type ProcessIdentityIntakeFailure,
} from './g11b-process-identity-engine.js';

export const G11B_PROCESS_IDENTITY_PATH = `${G11B_RUN_TICKET_DIRECTORY}/process-run-id`;

/** Sole production intake. Neither its directory nor its file name is configurable. */
export async function readCanonicalProcessRunId(): Promise<string> {
  return readProcessIdentityWithEngine(G11B_RUN_TICKET_DIRECTORY);
}
