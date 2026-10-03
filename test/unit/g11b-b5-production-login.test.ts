import { createG11bProductionLoginDelegate } from '../../src/deployment/internal/g11b-production-login.js';
import { createHttpResponsePlanBundle } from '../../src/composition/internal/http-response-plan.js';
import { createAdmissionWorkHandoffBundle } from '../../src/composition/internal/admission-work-handoff.js';
import type { AdmissionValidationInput } from '../../src/composition/internal/g07b-admission-handler.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const input: AdmissionValidationInput = {
  routeId: 'AUTH_LOGIN', retryMode: 'NORMAL', parameters: {},
  accepted: { method: 'POST', body: { username: 'operator', password: 'fixture-only' }, query: [], headers: {} },
};

test('production validation awaits authentication; opaque work only releases its prepared response once', async () => {
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  let complete!: (result: { accessToken: string }) => void;
  const authenticate = jest.fn(() => new Promise<{ accessToken: string }>((resolve) => { complete = resolve; }));
  const login = createG11bProductionLoginDelegate({ login: authenticate }, plans, handoff);
  let validated = false;
  const pending = login.validate(input).then((result) => { validated = true; return result; });
  await Promise.resolve();
  expect(validated).toBe(false);
  expect(authenticate).toHaveBeenCalledTimes(1);
  complete({ accessToken: 'opaque-fixture' });
  const result = await pending;
  if (result.kind !== 'LOGIN') throw new Error('expected login handoff');
  expect(Reflect.ownKeys(result.workInput)).toEqual([]);
  expect(plans.renderer.render(await login.login(result.workInput)).status).toBe(200);
  expect(plans.renderer.render(await login.login(result.workInput)).status).toBe(400);
  expect(authenticate).toHaveBeenCalledTimes(1);
});

test('invalid payload never authenticates and a foreign response token cannot be read', async () => {
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  const authenticate = jest.fn(async () => ({ accessToken: 'unused' }));
  const login = createG11bProductionLoginDelegate({ login: authenticate }, plans, handoff);
  const result = await login.validate({ ...input, accepted: { ...input.accepted, body: { username: 'operator' } } });
  expect(result.kind).toBe('REJECTED');
  expect(authenticate).not.toHaveBeenCalled();
  expect(plans.renderer.render(await login.login(handoff.issuer.issue('AUTH_LOGIN'))).status).toBe(400);
});
