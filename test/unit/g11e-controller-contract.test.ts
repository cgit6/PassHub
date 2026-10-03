import { assertG11eIdentity, assertG11eTimerContract, G11E_TIMER_CONTRACT, G11eControllerError } from '../../src/deployment/internal/g11e-controller-contract.js';

describe('G11e controller contract', () => {
  test('locks the Taipei timer contract', () => {
    expect(() => assertG11eTimerContract(G11E_TIMER_CONTRACT)).not.toThrow();
    expect(() => assertG11eTimerContract({ ...G11E_TIMER_CONTRACT, persistent: true })).toThrow(G11eControllerError);
  });

  test('accepts only canonical UUIDv4 identities', () => {
    expect(() => assertG11eIdentity('11111111-1111-4111-8111-111111111111')).not.toThrow();
    expect(() => assertG11eIdentity('not-an-id')).toThrow(G11eControllerError);
  });
});
