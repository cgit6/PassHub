import type { HumanAuthCapability } from '../../auth/application/index.js';
import { HumanAuthError } from '../../auth/domain/index.js';
import type { AdmissionValidationInput, AdmissionValidationResult, AdmissionValidatorPort, AdmissionWorkPort } from '../../composition/internal/g07b-admission-handler.js';
import type { AdmissionWorkHandoffBundle, AdmissionWorkToken } from '../../composition/internal/admission-work-handoff.js';
import type { HttpResponsePlan, HttpResponsePlanBundle } from '../../composition/internal/http-response-plan.js';

/** G07b holds its scrypt lease during validation, not response handoff. */
export function createG11bProductionLoginDelegate(
  auth: Pick<HumanAuthCapability, 'login'>,
  plans: HttpResponsePlanBundle,
  handoff: AdmissionWorkHandoffBundle,
): AdmissionValidatorPort & Pick<AdmissionWorkPort, 'login'> {
  const responses = new WeakMap<AdmissionWorkToken, HttpResponsePlan>();
  return Object.freeze({
    async validate(input: AdmissionValidationInput): Promise<AdmissionValidationResult> {
      const body = input.accepted.body;
      if (input.routeId !== 'AUTH_LOGIN' || input.accepted.query.length !== 0 || body === null
        || Object.keys(body).sort().join(',') !== 'password,username'
        || typeof body.username !== 'string' || typeof body.password !== 'string') {
        return { kind: 'REJECTED', response: plans.technical.issue('INVALID_REQUEST') };
      }
      let response: HttpResponsePlan;
      try { response = plans.business.issue(200, { ...await auth.login({ username: body.username, password: body.password }) }); }
      catch (error) {
        response = plans.technical.issue(error instanceof HumanAuthError && error.code === 'INVALID_CREDENTIALS'
          ? 'AUTHENTICATION_FAILED' : error instanceof HumanAuthError && error.code === 'INVALID_LOGIN_INPUT'
            ? 'INVALID_REQUEST' : 'AUTH_UNAVAILABLE');
      }
      const token = handoff.issuer.issue('AUTH_LOGIN');
      responses.set(token, response);
      return { kind: 'LOGIN', workInput: token };
    },
    async login(token: AdmissionWorkToken) {
      const response = responses.get(token);
      responses.delete(token);
      return response ?? plans.technical.issue('INVALID_REQUEST');
    },
  });
}
