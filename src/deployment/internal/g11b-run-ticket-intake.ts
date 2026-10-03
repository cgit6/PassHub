import {
  consumeRunTicketWithEngine,
  type ConsumedRunTicket,
} from './g11b-run-ticket-engine.js';

export {
  ConsumedRunTicket,
  readConsumedRunTicketForRuntime,
  RunTicketIntakeError,
  type ConsumedRunTicketFacts,
  type RunTicketIntakeFailure,
} from './g11b-run-ticket-engine.js';

export const G11B_RUN_TICKET_DIRECTORY = '/run/passhub/api';
export const G11B_RUN_TICKET_PATH = '/run/passhub/api/bootstrap-ticket.json';

/** Sole production intake: callers can provide identity, never transport or faults. */
export async function consumeCanonicalRunTicket(processRunId: string): Promise<ConsumedRunTicket> {
  return consumeRunTicketWithEngine(G11B_RUN_TICKET_DIRECTORY, processRunId);
}
