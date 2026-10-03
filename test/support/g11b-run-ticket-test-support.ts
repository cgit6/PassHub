import {
  consumeRunTicketWithEngine,
  type ConsumedRunTicket,
  type RunTicketEngineFaults,
} from '../../src/deployment/internal/g11b-run-ticket-engine.js';

export type G11bRunTicketFsTestFaults = RunTicketEngineFaults;

export interface G11bRunTicketFsTestOptions {
  readonly faults?: G11bRunTicketFsTestFaults;
  readonly expectedDirectoryOwnerUid?: number;
  readonly expectedTicketOwnerUid?: number;
}

/** Test-only real-FS adapter. It is outside src and cannot enter production. */
export function createG11bRunTicketIntakeForFsTest(
  directory: string,
  options: G11bRunTicketFsTestOptions = {},
): (processRunId: string) => Promise<ConsumedRunTicket> {
  return async (processRunId: string): Promise<ConsumedRunTicket> => consumeRunTicketWithEngine(
    directory,
    processRunId,
    options,
  );
}
