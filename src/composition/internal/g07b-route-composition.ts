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
import {
  bindQueryAdmissionComposition,
  bindQueryAdmissionDelegate,
  getQueryAdmissionIdentity,
  type QueryAdmissionCapability,
} from './query-admission-binding.js';
import { captureConstructionMethod, captureConstructionProperty } from '../../shared/internal/construction-capture.js';

export interface G07bRouteCompositionOptions {
  readonly login: AdmissionValidatorPort & Pick<AdmissionWorkPort, 'login'>;
  readonly query: QueryAdmissionCapability;
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
  const captured = captureOptions(options);
  const queryIdentity = getQueryAdmissionIdentity(captured.query);
  if (queryIdentity === undefined) throw new TypeError('invalid query admission capability');
  const delegates = captureDelegates(captured);
  assertOptions(captured, delegates);
  const validators = Object.freeze({
    login: delegates.login.validate.bind(captured.login),
    query: delegates.query.validate.bind(captured.query),
    management: delegates.management.validate.bind(captured.management),
    recognition: delegates.recognition.validate.bind(captured.recognition),
  });
  const login = delegates.login.login.bind(captured.login);
  const query = delegates.query.query.bind(captured.query);
  const management = delegates.management.management.bind(captured.management);
  const recognition = delegates.recognition.recognition.bind(captured.recognition);

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

  const composition = Object.freeze({ validator, work });
  bindQueryAdmissionDelegate(validator.validate, queryIdentity);
  bindQueryAdmissionDelegate(work.query, queryIdentity);
  bindQueryAdmissionComposition(composition, queryIdentity);
  return composition;
}

function captureOptions(options: G07bRouteCompositionOptions): G07bRouteCompositionOptions {
  const captured = {
    login: captureConstructionProperty(options, 'login', 'G07b route options') as G07bRouteCompositionOptions['login'],
    query: captureConstructionProperty(options, 'query', 'G07b route options') as G07bRouteCompositionOptions['query'],
    management: captureConstructionProperty(options, 'management', 'G07b route options') as G07bRouteCompositionOptions['management'],
    recognition: captureConstructionProperty(options, 'recognition', 'G07b route options') as G07bRouteCompositionOptions['recognition'],
  };
  return Object.freeze(captured);
}

type CapturedRouteDelegate = Readonly<{
  readonly validate: AdmissionValidatorPort['validate'];
  readonly login?: AdmissionWorkPort['login'];
  readonly query?: AdmissionWorkPort['query'];
  readonly management?: AdmissionWorkPort['management'];
  readonly recognition?: AdmissionWorkPort['recognition'];
}>;

function captureDelegates(options: G07bRouteCompositionOptions): Readonly<{
  readonly login: CapturedRouteDelegate & { readonly login: AdmissionWorkPort['login'] };
  readonly query: CapturedRouteDelegate & { readonly query: AdmissionWorkPort['query'] };
  readonly management: CapturedRouteDelegate & { readonly management: AdmissionWorkPort['management'] };
  readonly recognition: CapturedRouteDelegate & { readonly recognition: AdmissionWorkPort['recognition'] };
}> {
  return Object.freeze({
    login: captureDelegate(options.login, 'login'),
    query: captureQueryCapabilityDelegate(options.query),
    management: captureDelegate(options.management, 'management'),
    recognition: captureDelegate(options.recognition, 'recognition'),
  });
}

function captureQueryCapabilityDelegate(
  value: QueryAdmissionCapability,
): CapturedRouteDelegate & { readonly query: AdmissionWorkPort['query'] } {
  const validator = captureConstructionProperty(value, 'validator', 'query admission capability');
  const work = captureConstructionProperty(value, 'work', 'query admission capability');
  const validate = captureConstructionMethod(validator, 'validate', 'query admission capability validator') as AdmissionValidatorPort['validate'];
  const query = captureConstructionMethod(work, 'query', 'query admission capability work') as AdmissionWorkPort['query'];
  return Object.freeze({ validate, query });
}

function captureDelegate<T extends 'login' | 'query' | 'management' | 'recognition'>(
  value: unknown,
  workKey: T,
): CapturedRouteDelegate & Record<T, AdmissionWorkPort[T]> {
  const validate = captureConstructionMethod(value, 'validate', 'G07b route delegate') as AdmissionValidatorPort['validate'];
  const work = captureConstructionMethod(value, workKey, 'G07b route delegate') as AdmissionWorkPort[T];
  return Object.freeze({ validate, [workKey]: work }) as unknown as CapturedRouteDelegate & Record<T, AdmissionWorkPort[T]>;
}

function assertOptions(
  options: G07bRouteCompositionOptions,
  delegates: Readonly<Record<string, CapturedRouteDelegate>>,
): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('G07b route composition options are required');
  }
  for (const [name, delegate] of Object.entries(options)) {
    if (typeof delegate !== 'object' || delegate === null || delegates[name] === undefined) {
      throw new TypeError(`${name} validator delegate is required`);
    }
  }
}
