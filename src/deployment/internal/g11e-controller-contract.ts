export const G11E_TIMER_CONTRACT = Object.freeze({
  calendar: '*-*-* 03:00:00 Asia/Taipei',
  accuracySec: '1s',
  randomizedDelaySec: '0',
  persistent: false,
});

export class G11eControllerError extends Error {
  constructor(readonly code: 'INVALID_TIMER_CONTRACT' | 'INVALID_IDENTITY' | 'RUNTIME_DIRECTORY' | 'TICKET_EXISTS') {
    super(code);
    this.name = 'G11eControllerError';
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function assertG11eTimerContract(contract: Readonly<Record<string, unknown>>): void {
  if (contract.calendar !== G11E_TIMER_CONTRACT.calendar || contract.accuracySec !== G11E_TIMER_CONTRACT.accuracySec
    || contract.randomizedDelaySec !== G11E_TIMER_CONTRACT.randomizedDelaySec || contract.persistent !== false) {
    throw new G11eControllerError('INVALID_TIMER_CONTRACT');
  }
}

export function assertG11eIdentity(value: string): void {
  if (!UUID_V4.test(value)) throw new G11eControllerError('INVALID_IDENTITY');
}
