import type {
  AdmissionValidatorPort,
  AdmissionWorkPort,
} from './g07b-admission-handler.js';
import { captureConstructionMethod } from '../../shared/internal/construction-capture.js';
import type { WriterQuiescencePort } from './writer-quiescence.js';

declare const queryAdmissionCapabilityBrand: unique symbol;

export interface QueryAdmissionCapability {
  readonly [queryAdmissionCapabilityBrand]: never;
  readonly validator: Readonly<{ readonly validate: AdmissionValidatorPort['validate'] }>;
  readonly work: Readonly<{ readonly query: AdmissionWorkPort['query'] }>;
}

export type QueryAdmissionIdentity =
  | Readonly<{ readonly kind: 'QUIESCED'; readonly writerQuiescence: WriterQuiescencePort }>
  | Readonly<{ readonly kind: 'LEGACY' }>;

const capabilityBindings = new WeakMap<object, QueryAdmissionIdentity>();
const delegateBindings = new WeakMap<Function, QueryAdmissionIdentity>();

export function createQuiescedQueryAdmissionCapability(
  delegate: AdmissionValidatorPort & Pick<AdmissionWorkPort, 'query'>,
  writerQuiescence: WriterQuiescencePort,
): QueryAdmissionCapability {
  return createCapability(delegate, Object.freeze({ kind: 'QUIESCED', writerQuiescence }));
}

export function createLegacyQueryAdmissionCapability(
  delegate: AdmissionValidatorPort & Pick<AdmissionWorkPort, 'query'>,
): QueryAdmissionCapability {
  return createCapability(delegate, Object.freeze({ kind: 'LEGACY' }));
}

export function getQueryAdmissionIdentity(value: unknown): QueryAdmissionIdentity | undefined {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    const direct = capabilityBindings.get(value as object);
    if (direct !== undefined) return direct;
  }
  if (typeof value === 'function') return delegateBindings.get(value);
  return undefined;
}

export function bindQueryAdmissionComposition(value: object, identity: QueryAdmissionIdentity): void {
  capabilityBindings.set(value, identity);
}

export function bindQueryAdmissionDelegate(value: object, identity: QueryAdmissionIdentity): void {
  delegateBindings.set(value as unknown as Function, identity);
}

function createCapability(
  delegate: AdmissionValidatorPort & Pick<AdmissionWorkPort, 'query'>,
  identity: QueryAdmissionIdentity,
): QueryAdmissionCapability {
  const validate = captureConstructionMethod(delegate, 'validate', 'query admission delegate').bind(delegate) as AdmissionValidatorPort['validate'];
  const query = captureConstructionMethod(delegate, 'query', 'query admission delegate').bind(delegate) as AdmissionWorkPort['query'];
  const validator = Object.freeze({ validate });
  const work = Object.freeze({ query });
  const capability = Object.freeze({ validator, work }) as QueryAdmissionCapability;
  capabilityBindings.set(capability, identity);
  delegateBindings.set(validator.validate, identity);
  delegateBindings.set(work.query, identity);
  return capability;
}
