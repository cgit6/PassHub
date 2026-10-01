import {
  OperationBudgetBindingError,
  assertOperationBudgetBindingCurrent,
  assertOperationBudgetBindingOwnership,
  assertOperationBudgetBindingProvenance,
  createOperationBudgetBindingFactory,
  type OperationBudgetBinding,
  type TrustedOperationBudgetBindingFactoryOptions,
} from '../../access/application/internal/operation-budget-binding.js';
import type { AdmissionWorkContext } from './g07b-admission-handler.js';
import type { WriteOperationContext } from '../../access/application/internal/write-operation-coordinator.js';
import {
  isAccessScopeContextRetired,
  readAccessScopeContextClaims,
  type AccessScopeContext,
} from '../../shared/access-scope-context.js';

/**
 * Private G10b composition provenance only.  This deliberately does not
 * alter G07/G08 work or the G04b adapter: a later composition seam may bind
 * the first persistence scope it opens, while all authority remains opaque.
 */
export type G10bOperationBridgeErrorCode =
  | 'INVALID_ADMISSION_CONTEXT'
  | 'ADMISSION_CONTEXT_ALREADY_REGISTERED'
  | 'INVALID_OPERATION_BINDING'
  | 'OPERATION_BINDING_MISOWNED'
  | 'OPERATION_BINDING_STALE'
  | 'ADMISSION_ALREADY_BOUND'
  | 'OPERATION_BINDING_ALREADY_BOUND'
  | 'ADMISSION_NOT_BOUND'
  | 'INVALID_ACCESS_SCOPE_CONTEXT'
  | 'ACCESS_SCOPE_ALREADY_BOUND'
  | 'ADMISSION_SCOPE_ALREADY_BOUND'
  | 'ACCESS_SCOPE_NOT_BOUND'
  | 'ACCESS_SCOPE_MISOWNED'
  | 'ACCESS_SCOPE_STALE';

export class G10bOperationBridgeError extends Error {
  readonly code: G10bOperationBridgeErrorCode;

  constructor(code: G10bOperationBridgeErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'G10bOperationBridgeError';
    this.code = code;
  }
}

interface TrustedAdmissionContextState {
  readonly context: AdmissionWorkContext;
  readonly writeContext: WriteOperationContext;
}

interface AdmissionBindingState extends TrustedAdmissionContextState {
  readonly binding: OperationBudgetBinding;
}

const trustedAdmissionContexts = new WeakMap<object, TrustedAdmissionContextState>();
const admissionBindings = new WeakMap<object, AdmissionBindingState>();
const scopeBindings = new WeakMap<object, AdmissionBindingState>();
const admissionScopes = new WeakMap<object, object>();
const bindingAdmissions = new WeakMap<object, AdmissionBindingState>();

/**
 * Internal composition-only binding factory.  G07 supplies both contexts so
 * its one freshly-created AdmissionWorkContext is the exact object associated
 * with the binding it is about to hand to G08.
 */
export interface G10bOperationBudgetBindingFactory {
  bind(context: WriteOperationContext, admissionContext: AdmissionWorkContext): OperationBudgetBinding;
}

/**
 * Private callback installed on a G08 scope.  It is intentionally narrower
 * than the budget capability: the scope may present only itself, exactly once.
 */
export interface G10bFirstScopedPersistenceBinder {
  bind(scope: AccessScopeContext): void;
}

/**
 * Creates the one composition-owned G10b binding factory.  It is kept in the
 * composition layer (and out of all public barrels) so G07 can receive only
 * the already-configured internal dependency, never a clock or budget policy.
 */
export function createG10bOperationBudgetBindingFactory(
  options: TrustedOperationBudgetBindingFactoryOptions,
): G10bOperationBudgetBindingFactory {
  const bindingFactory = createOperationBudgetBindingFactory(options);
  return Object.freeze({
    bind(context: WriteOperationContext, _admissionContext: AdmissionWorkContext): OperationBudgetBinding {
      return bindingFactory.bind(context);
    },
  });
}

/**
 * Called at the one existing G07 construction point.  A frozen copy has the
 * same visible facts but not this private provenance, so it cannot be bound.
 * This module is intentionally absent from composition and package barrels.
 */
export function registerG10bAdmissionWorkContext(
  context: AdmissionWorkContext,
  writeContext: WriteOperationContext,
): void {
  assertAdmissionContextShape(context);
  assertMatchingAdmissionFacts(context, writeContext);
  if (trustedAdmissionContexts.has(context as object)) {
    fail('ADMISSION_CONTEXT_ALREADY_REGISTERED', 'admission work context is already registered');
  }
  trustedAdmissionContexts.set(context as object, Object.freeze({ context, writeContext }));
}

/** Bind one real G07 work context to its one real G10b budget capability. */
export function bindG10bOperationBudget(
  context: AdmissionWorkContext,
  binding: OperationBudgetBinding,
): void {
  const admissionContext = requireTrustedAdmissionContext(context);
  assertBindingOwnership(binding, admissionContext.writeContext);
  // Fail stale bindings before writing any admission relationship.
  assertBindingCurrent(binding);
  if (admissionBindings.has(context as object)) {
    fail('ADMISSION_ALREADY_BOUND', 'admission work context already has an operation budget binding');
  }
  if (bindingAdmissions.has(binding as object)) {
    fail('OPERATION_BINDING_ALREADY_BOUND', 'operation budget binding already belongs to an admission work context');
  }
  const admission = Object.freeze({ ...admissionContext, binding });
  admissionBindings.set(context as object, admission);
  bindingAdmissions.set(binding as object, admission);
}

/**
 * The first scoped persistence use establishes this exact context-to-scope
 * relationship.  It is deliberately one-shot; later persistence calls must
 * use the lookup below rather than silently rebinding a scope.
 */
export function bindG10bOperationBudgetOnFirstScopedPersistenceUse(
  context: AdmissionWorkContext,
  scope: AccessScopeContext,
): OperationBudgetBinding {
  const admission = requireAdmissionBinding(context);
  assertBindingCurrent(admission.binding);
  requireLiveAccessScope(scope);
  if (scopeBindings.has(scope as object)) {
    fail('ACCESS_SCOPE_ALREADY_BOUND', 'access scope already has an operation budget binding');
  }
  if (admissionScopes.has(admission as object)) {
    fail('ADMISSION_SCOPE_ALREADY_BOUND', 'admission work context already has an access scope');
  }
  scopeBindings.set(scope as object, admission);
  admissionScopes.set(admission as object, scope as object);
  return admission.binding;
}

/**
 * Creates the private G08 scope hook for one admitted ORIGINAL.  Old G08
 * harnesses have no G10b budget binding, so they deliberately receive no
 * hook; a live-but-invalid binding remains fail-closed.
 */
export function createG10bFirstScopedPersistenceBinder(
  context: AdmissionWorkContext,
): G10bFirstScopedPersistenceBinder | null {
  let admission: AdmissionBindingState;
  try {
    admission = requireAdmissionBinding(context);
  } catch (error: unknown) {
    if (error instanceof G10bOperationBridgeError
      && (error.code === 'INVALID_ADMISSION_CONTEXT' || error.code === 'ADMISSION_NOT_BOUND')) {
      return null;
    }
    throw error;
  }
  assertBindingCurrent(admission.binding);
  return Object.freeze({
    bind(scope: AccessScopeContext): void {
      bindG10bOperationBudgetOnFirstScopedPersistenceUse(context, scope);
    },
  });
}

/** Read only the binding owned by this exact live admission/scope pair. */
export function readG10bOperationBudgetForScopedPersistence(
  context: AdmissionWorkContext,
  scope: AccessScopeContext,
): OperationBudgetBinding {
  const admission = requireAdmissionBinding(context);
  assertBindingCurrent(admission.binding);
  requireLiveAccessScope(scope);
  const scoped = scopeBindings.get(scope as object);
  if (scoped === undefined) {
    fail('ACCESS_SCOPE_NOT_BOUND', 'access scope has no operation budget binding');
  }
  if (scoped !== admission) {
    fail('ACCESS_SCOPE_MISOWNED', 'access scope belongs to a different admission work context');
  }
  return admission.binding;
}

function requireAdmissionBinding(context: AdmissionWorkContext): AdmissionBindingState {
  requireTrustedAdmissionContext(context);
  const admission = admissionBindings.get(context as object);
  if (admission === undefined || admission.context !== context) {
    fail('ADMISSION_NOT_BOUND', 'admission work context has no operation budget binding');
  }
  return admission as AdmissionBindingState;
}

function requireTrustedAdmissionContext(context: AdmissionWorkContext): TrustedAdmissionContextState {
  assertAdmissionContextShape(context);
  const trusted = trustedAdmissionContexts.get(context as object);
  if (trusted === undefined || trusted.context !== context) {
    fail('INVALID_ADMISSION_CONTEXT', 'admission work context provenance is invalid');
  }
  return trusted as TrustedAdmissionContextState;
}

function assertAdmissionContextShape(context: AdmissionWorkContext): void {
  if (!isObject(context) || !Object.isFrozen(context)
    || typeof context.operationId !== 'string' || context.operationId.length === 0
    || !Number.isSafeInteger(context.receivedAtMs)
    || typeof context.sequence !== 'bigint') {
    fail('INVALID_ADMISSION_CONTEXT', 'admission work context must be a frozen G07 context');
  }
}

function assertMatchingAdmissionFacts(context: AdmissionWorkContext, writeContext: WriteOperationContext): void {
  if (!isObject(writeContext)
    || context.operationId !== writeContext.operationId
    || context.receivedAtMs !== writeContext.receivedAtMs
    || context.sequence !== writeContext.sequence) {
    fail('INVALID_ADMISSION_CONTEXT', 'admission work context must match its write operation context');
  }
}

function requireLiveAccessScope(scope: AccessScopeContext): void {
  if (!isObject(scope) || !Object.isFrozen(scope)
    || readAccessScopeContextClaims(scope) === null) {
    fail('INVALID_ACCESS_SCOPE_CONTEXT', 'access scope context provenance is invalid');
  }
  if (isAccessScopeContextRetired(scope)) {
    fail('ACCESS_SCOPE_STALE', 'access scope context is retired');
  }
}

function assertBindingOwnership(binding: OperationBudgetBinding, context: WriteOperationContext): void {
  try {
    assertOperationBudgetBindingProvenance(binding);
    assertOperationBudgetBindingOwnership(binding, context);
  } catch (error: unknown) {
    if (error instanceof OperationBudgetBindingError) {
      const code = error.code === 'BINDING_CONTEXT_MISMATCH'
        ? 'OPERATION_BINDING_MISOWNED'
        : 'INVALID_OPERATION_BINDING';
      fail(code, 'operation budget binding does not belong to this admission work context', error);
    }
    throw error;
  }
}

function assertBindingCurrent(binding: OperationBudgetBinding): void {
  try {
    assertOperationBudgetBindingCurrent(binding);
  } catch (error: unknown) {
    if (error instanceof OperationBudgetBindingError) {
      fail('OPERATION_BINDING_STALE', 'operation budget binding is no longer current', error);
    }
    throw error;
  }
}

function fail(
  code: G10bOperationBridgeErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new G10bOperationBridgeError(code, message, cause === undefined ? undefined : { cause });
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
