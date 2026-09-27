import type { BusinessRouteId } from '../../shared/internal/http/index.js';
import type {
  AdmissionValidationInput,
  AdmissionValidationResult,
  AdmissionValidatorPort,
  AdmissionWorkContext,
  AdmissionWorkPort,
  AdmissionManagementWriterOutcome,
  AdmissionRecognitionWriterOutcome,
} from './g07b-admission-handler.js';
import type { AdmissionWorkToken } from './admission-work-handoff.js';

export interface G07bRouteCompositionOptions {
  readonly login: AdmissionValidatorPort & Pick<AdmissionWorkPort, 'login'>;
  readonly query: AdmissionValidatorPort & Pick<AdmissionWorkPort, 'query'>;
  readonly management: AdmissionValidatorPort & Pick<AdmissionWorkPort, 'management'>;
  readonly recognition: AdmissionValidatorPort & Pick<AdmissionWorkPort, 'recognition'>;
}

export interface G07bRouteComposition {
  readonly validator: AdmissionValidatorPort;
  readonly work: Pick<AdmissionWorkPort, 'login' | 'query' | 'management' | 'recognition'>;
}

export function createG07bRouteComposition(
  options: G07bRouteCompositionOptions,
): G07bRouteComposition {
  assertOptions(options);
  const validators = Object.freeze({
    login: options.login.validate.bind(options.login),
    query: options.query.validate.bind(options.query),
    management: options.management.validate.bind(options.management),
    recognition: options.recognition.validate.bind(options.recognition),
  });
  const login = options.login.login.bind(options.login);
  const query = options.query.query.bind(options.query);
  const management = options.management.management.bind(options.management);
  const recognition = options.recognition.recognition.bind(options.recognition);

  const validator: AdmissionValidatorPort = Object.freeze({
    validate(input: AdmissionValidationInput): Promise<AdmissionValidationResult> {
      return selectValidator(input.routeId)(input);
    },
  });
  const work = Object.freeze({
    login(input: AdmissionWorkToken): ReturnType<AdmissionWorkPort['login']> {
      return login(input);
    },
    query(input: AdmissionWorkToken): ReturnType<AdmissionWorkPort['query']> {
      return query(input);
    },
    management(
      input: AdmissionWorkToken,
      context: AdmissionWorkContext,
    ): Promise<AdmissionManagementWriterOutcome> {
      return management(input, context);
    },
    recognition(
      input: AdmissionWorkToken,
      context: AdmissionWorkContext,
    ): Promise<AdmissionRecognitionWriterOutcome> {
      return recognition(input, context);
    },
  });

  function selectValidator(routeId: BusinessRouteId):
    (input: AdmissionValidationInput) => Promise<AdmissionValidationResult> {
    if (routeId === 'AUTH_LOGIN') return validators.login;
    if (routeId === 'RECOGNITION_ATTEMPT') return validators.recognition;
    if (routeId === 'QUALIFICATION_CREATE'
      || routeId === 'QUALIFICATION_UPDATE'
      || routeId === 'QUALIFICATION_REVOKE') return validators.management;
    if (routeId === 'QUALIFICATION_LIST'
      || routeId === 'QUALIFICATION_INSIDE_LIST'
      || routeId === 'QUALIFICATION_DETAIL'
      || routeId === 'EVENT_LIST'
      || routeId === 'EVENT_DETAIL') return validators.query;
    throw new TypeError('unsupported G07b route');
  }

  return Object.freeze({ validator, work });
}

function assertOptions(options: G07bRouteCompositionOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('G07b route composition options are required');
  }
  for (const [name, delegate] of Object.entries(options)) {
    if (typeof delegate !== 'object' || delegate === null
      || typeof (delegate as { readonly validate?: unknown }).validate !== 'function') {
      throw new TypeError(`${name} validator delegate is required`);
    }
  }
  if (typeof options.login.login !== 'function'
    || typeof options.query.query !== 'function'
    || typeof options.management.management !== 'function'
    || typeof options.recognition.recognition !== 'function') {
    throw new TypeError('G07b route work delegates are required');
  }
}
