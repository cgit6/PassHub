import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';

import {
  assertAdmissionWorkHandoffBundle,
  type AdmissionWorkHandoffBundle,
  type AdmissionWorkToken,
} from './admission-work-handoff.js';
import {
  assertUnknownRecognitionOfferPort,
  type UnknownRecognitionOfferPort,
} from './unknown-recognition-coordinator.js';
import { issueUnknownRecognitionRecoveryToken } from './unknown-recognition-recovery.js';
import {
  createWriteOperationCoordinatorBundle,
  type WriteOperationContext,
  type WriteOperationLifecycleEvent,
  type WriteOperationProvisional,
  type WriteOperationSettlement,
} from '../../access/application/internal/write-operation-coordinator.js';
import {
  OperationRegistryError,
  type OperationComparisonArtifact,
  type OperationConfirmationLease,
  type OperationExecutionLease,
  type OperationObservationReference,
  type OperationRegistry,
  type OperationRegistryCapabilityIssuer,
  type OperationRegistryKey,
  type OperationRegistryKeyFacts,
  type OperationRegistryReservation,
  type OperationResultReference,
} from '../../access/application/internal/operation-registry.js';
import {
  classifyBusinessRoute,
  type AcceptedIngress,
  type AcceptedIngressHandler,
  type BusinessRouteId,
  type BusinessRouteRetryMode,
} from '../../shared/internal/http/index.js';
import {
  createAdmissionResourceLedger,
  type AdmissionResourceBundle,
  type AdmissionResourceLedger,
  type AncillaryAdmissionLease,
  type OriginAdmissionLease,
  type ValidationAdmissionLease,
} from './admission-resource-ledger.js';
import {
  createFixedMinuteRateLedger,
  type FixedMinuteRateLedger,
} from './fixed-minute-rate-ledger.js';
import {
  createWriterQuiescence,
  isWriterQuiescencePort,
  type WriterQuiescencePort,
} from './writer-quiescence.js';
import {
  createHttpResponseOwner,
  type HttpResponseOwner,
  type HttpResponseOwnerOptions,
  type NarrowHttpResponse,
} from './http-response-owner.js';
import {
  assertHttpResponsePlanComposition,
  type HttpResponsePlan,
  type HttpResponsePlanBundle,
} from './http-response-plan.js';
import { getQueryAdmissionIdentity } from './query-admission-binding.js';
import {
  assertG10aWriterPermissionBinding,
  type G10aWriterPermissionBinding,
} from './g10a-writer-permission-binding.js';
import {
  captureConstructionMethod,
  captureOptionalConstructionProperty,
  captureConstructionProperty,
} from '../../shared/internal/construction-capture.js';

export interface G07bWallClock {
  nowMs(): number;
}

export interface G07bMonotonicClock {
  nowMs(): number;
}

export interface AdmissionValidationInput {
  readonly routeId: BusinessRouteId;
  readonly retryMode: BusinessRouteRetryMode;
  readonly parameters: Readonly<{ readonly id?: string }>;
  readonly accepted: AcceptedIngress;
}

export type AdmissionValidationResult =
  | Readonly<{
      readonly kind: 'REJECTED';
      readonly response: HttpResponsePlan;
    }>
  | Readonly<{
      readonly kind: 'LOGIN';
      readonly workInput: AdmissionWorkToken;
    }>
  | Readonly<{
      readonly kind: 'QUERY';
      readonly accountId: string;
      readonly workInput: AdmissionWorkToken;
    }>
  | Readonly<{
      readonly kind: 'MANAGEMENT';
      readonly accountId: string;
      readonly workInput: AdmissionWorkToken;
    }>
  | Readonly<{
      readonly kind: 'RECOGNITION';
      readonly registryKey: OperationRegistryKey;
      readonly comparisonArtifact: OperationComparisonArtifact;
      readonly workInput: AdmissionWorkToken;
    }>;

type CanonicalAdmissionValidationResult =
  | Exclude<AdmissionValidationResult, Readonly<{ readonly kind: 'RECOGNITION' }>>
  | Readonly<{
      readonly kind: 'RECOGNITION';
      readonly keyFacts: OperationRegistryKeyFacts;
      readonly registryKey: OperationRegistryKey;
      readonly comparisonArtifact: OperationComparisonArtifact;
      readonly workInput: AdmissionWorkToken;
    }>;

export interface AdmissionValidatorPort {
  validate(input: AdmissionValidationInput): Promise<AdmissionValidationResult>;
}

export type AdmissionWriterDisposition =
  | 'BUSINESS_RESULT_PERSISTED'
  | 'KNOWN_NO_EFFECT'
  | 'UNKNOWN_EFFECT';

export interface AdmissionManagementWriterOutcome {
  readonly disposition: AdmissionWriterDisposition;
  readonly response: HttpResponsePlan;
}

export interface AdmissionRecognitionPersistedOutcome {
  readonly disposition: 'BUSINESS_RESULT_PERSISTED';
  readonly originalResponse: HttpResponsePlan;
  readonly replayResponse: HttpResponsePlan;
}

export interface AdmissionRecognitionTerminalOutcome {
  readonly disposition: 'KNOWN_NO_EFFECT' | 'UNKNOWN_EFFECT';
  readonly response: HttpResponsePlan;
}

export type AdmissionRecognitionWriterOutcome =
  | AdmissionRecognitionPersistedOutcome
  | AdmissionRecognitionTerminalOutcome;

/** Management keeps its legacy single-response contract; recognition is typed separately. */
export type AdmissionWriterOutcome =
  | AdmissionManagementWriterOutcome
  | AdmissionRecognitionWriterOutcome;

export interface AdmissionWorkContext {
  readonly operationId: string;
  readonly receivedAtMs: number;
  readonly sequence: bigint;
}

export interface AdmissionWorkPort {
  login(input: AdmissionWorkToken): Promise<HttpResponsePlan>;
  query(input: AdmissionWorkToken): Promise<HttpResponsePlan>;
  management(input: AdmissionWorkToken, context: AdmissionWorkContext): Promise<AdmissionManagementWriterOutcome>;
  recognition(input: AdmissionWorkToken, context: AdmissionWorkContext): Promise<AdmissionRecognitionWriterOutcome>;
}

export interface G07bAdmissionHandlerOptions {
  readonly currentDatasetEpoch: string;
  readonly registry: OperationRegistry;
  readonly registryCapabilities: OperationRegistryCapabilityIssuer;
  readonly responsePlans: HttpResponsePlanBundle;
  readonly workHandoff: AdmissionWorkHandoffBundle;
  readonly validator: AdmissionValidatorPort;
  readonly work: AdmissionWorkPort;
  readonly unknownRecognition: UnknownRecognitionOfferPort;
  readonly wallClock?: G07bWallClock;
  readonly monotonicClock?: G07bMonotonicClock;
  readonly resources?: AdmissionResourceLedger;
  readonly rates?: FixedMinuteRateLedger;
  /** Shared with the G09a query composition when supplied. */
  readonly writerQuiescence?: WriterQuiescencePort;
  /** Internal G10a bridge; absent preserves the pre-A3 admission harness. */
  readonly writerPermission?: unknown;
}

interface WriterInput {
  readonly routeId: BusinessRouteId;
  readonly accountId: string | null;
  readonly keyFacts: OperationRegistryKeyFacts | null;
  readonly workInput: AdmissionWorkToken;
  readonly owner: HttpResponseOwner;
  readonly reservation: OperationRegistryReservation | null;
  readonly registryKey: OperationRegistryKey | null;
  readonly comparisonArtifact: OperationComparisonArtifact | null;
  readonly observationReference: OperationObservationReference | null;
  readonly runningPlan: HttpResponsePlan | null;
  readonly pausedUnknownPlan: HttpResponsePlan | null;
  readonly deadlineObservation: DeadlineObservationController;
}

interface ObservationState {
  readonly original: Readonly<{
    readonly operationId: string;
    readonly receivedAtMs: number;
    readonly sequence: bigint;
  }>;
  progressPlan: HttpResponsePlan;
}

interface RecognitionResponsePlans {
  readonly original: HttpResponsePlan;
  readonly replay: HttpResponsePlan;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXTERNAL_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NativePromise = Promise;
const nativePromiseThen = Promise.prototype.then;

interface DeadlineObservationController {
  read(): HttpResponsePlan;
  useProgress(plan: HttpResponsePlan): void;
  markCanonicalReplay(): void;
}

class AdmissionTechnicalError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'AdmissionTechnicalError';
  }
}

/**
 * Builds the internal G07b ingress hand-off.  It deliberately stops before
 * formal controllers, DTOs, authentication implementation, and business I/O.
 */
export function createG07bAdmissionHandler(
  options: G07bAdmissionHandlerOptions,
): AcceptedIngressHandler {
  options = captureOptions(options);
  const validator = options.validator;
  const work = options.work;
  const validatorValidate = captureConstructionMethod(validator, 'validate', 'G07b validator') as AdmissionValidatorPort['validate'];
  const loginWorkMethod = captureConstructionMethod(work, 'login', 'G07b work') as AdmissionWorkPort['login'];
  const queryWorkMethod = captureConstructionMethod(work, 'query', 'G07b work') as AdmissionWorkPort['query'];
  const managementWorkMethod = captureConstructionMethod(work, 'management', 'G07b work') as AdmissionWorkPort['management'];
  const recognitionWorkMethod = captureConstructionMethod(work, 'recognition', 'G07b work') as AdmissionWorkPort['recognition'];
  const registryAssertComposition = captureConstructionMethod(options.registry, 'assertComposition', 'G07b registry');
  const reserveCandidateMethod = captureConstructionMethod(options.registry, 'reserveCandidate', 'G07b registry');
  const releaseReservationMethod = captureConstructionMethod(options.registry, 'releaseReservation', 'G07b registry');
  const registerReservedMethod = captureConstructionMethod(options.registry, 'registerReserved', 'G07b registry');
  const lookupExistingMethod = captureConstructionMethod(options.registry, 'lookupExisting', 'G07b registry');
  const completeCanonicalMethod = captureConstructionMethod(options.registry, 'completeCanonical', 'G07b registry');
  const completeSafeTerminalMethod = captureConstructionMethod(options.registry, 'completeSafeTechnicalTerminal', 'G07b registry');
  const markUnknownMethod = captureConstructionMethod(options.registry, 'markUnknown', 'G07b registry');
  const assertRegistryKeyMethod = captureConstructionMethod(options.registryCapabilities, 'assertKey', 'G07b registry capabilities') as OperationRegistryCapabilityIssuer['assertKey'];
  const issueObservationReferenceMethod = captureConstructionMethod(options.registryCapabilities, 'issueObservationReference', 'G07b registry capabilities') as OperationRegistryCapabilityIssuer['issueObservationReference'];
  const issueResultReferenceMethod = captureConstructionMethod(options.registryCapabilities, 'issueResultReference', 'G07b registry capabilities') as OperationRegistryCapabilityIssuer['issueResultReference'];
  const claimer = captureConstructionProperty(options.workHandoff, 'claimer', 'G07b handoff');
  const claimWorkTokenMethod = captureConstructionMethod(claimer, 'claim', 'G07b handoff claimer');
  const offerUnknownRecognitionMethod = captureConstructionMethod(options.unknownRecognition, 'offer', 'G07b unknown recognition');
  const acceptUnknownRecognitionMethod = captureConstructionMethod(options.unknownRecognition, 'accept', 'G07b unknown recognition');
  const renderer = captureConstructionProperty(options.responsePlans, 'renderer', 'G07b response plans');
  const responseTechnical = captureConstructionProperty(options.responsePlans, 'technical', 'G07b response plans');
  const responseBusiness = captureConstructionProperty(options.responsePlans, 'business', 'G07b response plans');
  const renderResponsePlanMethod = captureConstructionMethod(renderer, 'render', 'G07b response renderer');
  const issueTechnicalPlan = captureConstructionMethod(responseTechnical, 'issue', 'G07b technical plans');
  const issueBusinessPlan = captureConstructionMethod(responseBusiness, 'issue', 'G07b business plans');
  const responsePlanRenderer = renderer as HttpResponseOwnerOptions['responsePlanRenderer'];
  const wallClockNow = options.wallClock === undefined ? undefined : captureConstructionMethod(options.wallClock, 'nowMs', 'G07b wall clock');
  const monotonicClockNow = options.monotonicClock === undefined ? undefined : captureConstructionMethod(options.monotonicClock, 'nowMs', 'G07b monotonic clock');
  const writerPermission = options.writerPermission;
  if (writerPermission !== undefined) assertG10aWriterPermissionBinding(writerPermission);
  const writerPermissionAcquire = writerPermission === undefined
    ? undefined
    : captureConstructionMethod(writerPermission, 'acquireIssuedPersistence', 'G10a writer permission').bind(writerPermission) as G10aWriterPermissionBinding['acquireIssuedPersistence'];
  const writerPermissionCanStart = writerPermission === undefined
    ? undefined
    : captureConstructionMethod(writerPermission, 'canStartWriter', 'G10a writer permission').bind(writerPermission) as G10aWriterPermissionBinding['canStartWriter'];
  const writerPermissionMaintenanceVeto = writerPermission === undefined
    ? undefined
    : captureConstructionMethod(writerPermission, 'isMaintenanceWriterVeto', 'G10a writer permission').bind(writerPermission) as G10aWriterPermissionBinding['isMaintenanceWriterVeto'];
  const writerPermissionBindWake = writerPermission === undefined
    ? undefined
    : captureConstructionMethod(writerPermission, 'bindWriterWake', 'G10a writer permission').bind(writerPermission) as G10aWriterPermissionBinding['bindWriterWake'];
  const writerPermissionBindMaintenanceReadySettlement = writerPermission === undefined
    ? undefined
    : captureConstructionMethod(writerPermission, 'bindMaintenanceReadySettlement', 'G10a writer permission').bind(writerPermission) as G10aWriterPermissionBinding['bindMaintenanceReadySettlement'];
  const writerPermissionBindMaintenanceValidationCancellation = writerPermission === undefined
    ? undefined
    : captureConstructionMethod(writerPermission, 'bindMaintenanceValidationCancellation', 'G10a writer permission').bind(writerPermission) as G10aWriterPermissionBinding['bindMaintenanceValidationCancellation'];
  assertOptions(options, validator, work, validatorValidate, loginWorkMethod, queryWorkMethod, managementWorkMethod, recognitionWorkMethod);
  const validatorIdentity = getQueryAdmissionIdentity(validatorValidate);
  const workIdentity = getQueryAdmissionIdentity(queryWorkMethod);
  if (validatorIdentity === undefined || workIdentity === undefined || validatorIdentity !== workIdentity) {
    throw new TypeError('G09a query delegate provenance is incomplete or mismatched');
  }
  if (validatorIdentity.kind === 'QUIESCED'
    && options.writerQuiescence !== undefined
    && options.writerQuiescence !== validatorIdentity.writerQuiescence) {
    throw new TypeError('G09a query quiescence does not match G07b writer quiescence');
  }
  assertAdmissionWorkHandoffBundle(options.workHandoff);
  assertUnknownRecognitionOfferPort(options.unknownRecognition);
  const currentDatasetEpoch = options.currentDatasetEpoch;
  assertHttpResponsePlanComposition(options.responsePlans, currentDatasetEpoch);
  const issueTechnical = issueTechnicalPlan.bind(responseTechnical);
  const renderResponsePlan = renderResponsePlanMethod.bind(renderer);
  const issueBusiness = issueBusinessPlan.bind(responseBusiness);
  const technical = Object.freeze({
    invalidRetry: issueTechnical('INVALID_RETRY_MODE'),
    invalidEpoch: issueTechnical('INVALID_DATASET_EPOCH'),
    epochMismatch: issueTechnical('DATASET_EPOCH_MISMATCH'),
    unavailable: issueTechnical('REQUEST_ADMISSION_UNAVAILABLE'),
    unconfirmed: issueTechnical('REQUEST_STATUS_UNCONFIRMED'),
    inProgress: issueTechnical('REQUEST_IN_PROGRESS'),
    canonicalUnconfirmed: issueTechnical('CANONICAL_RESULT_UNCONFIRMED'),
    conflict: issueTechnical('IDEMPOTENCY_CONFLICT'),
    rateLimited: issueTechnical('RATE_LIMITED'),
    busy: issueTechnical('TECHNICAL_BUSY'),
  });
  // Identity, rather than an error code string, prevents an ordinary
  // KNOWN_NO_EFFECT outcome from being rewritten as a maintenance response.
  const maintenanceReadySettlement = new AdmissionTechnicalError('MAINTENANCE_READY_SETTLED');
  const maintenanceValidationSettlement = new AdmissionTechnicalError('MAINTENANCE_VALIDATION_SETTLED');
  const sendImmediatePlan = (response: NarrowHttpResponse, plan: HttpResponsePlan): void => {
    writeImmediateResponse(response, plan, renderResponsePlan);
  };
  const createDeadlineObservation = (): DeadlineObservationController => {
    let progress: HttpResponsePlan | null = null;
    let canonicalReplay = false;
    return Object.freeze({
      read: (): HttpResponsePlan => {
        if (progress !== null) return progress;
        if (canonicalReplay) return technical.canonicalUnconfirmed;
        return technical.unconfirmed;
      },
      useProgress(plan: HttpResponsePlan): void {
        progress = plan;
      },
      markCanonicalReplay(): void {
        if (progress === null) canonicalReplay = true;
      },
    });
  };
  let writeClaimDisposition: 'WRITABLE' | 'READ_ONLY' | 'STALE';
  try {
    const composition = registryAssertComposition.call(options.registry, options.registryCapabilities);
    if (composition.datasetEpoch !== currentDatasetEpoch) {
      throw new TypeError('registry dataset epoch does not match handler epoch');
    }
    writeClaimDisposition = composition.claimDisposition;
  } catch {
    throw new TypeError('registry composition does not match G07b handler configuration');
  }
  const resources = options.resources ?? createAdmissionResourceLedger();
  const suppliedWallClock = options.wallClock ?? Object.freeze({ nowMs: Date.now });
  const suppliedMonotonicClock = options.monotonicClock
    ?? Object.freeze({ nowMs: performance.now.bind(performance) });
  const capturedWallNow = wallClockNow === undefined ? suppliedWallClock.nowMs.bind(suppliedWallClock) : wallClockNow.bind(options.wallClock);
  const capturedMonotonicNow = monotonicClockNow === undefined
    ? suppliedMonotonicClock.nowMs.bind(suppliedMonotonicClock)
    : monotonicClockNow.bind(options.monotonicClock);
  const wallClock = Object.freeze({ nowMs: () => capturedWallNow() });
  const monotonicClock = Object.freeze({ nowMs: () => capturedMonotonicNow() });
  const rates = options.rates ?? createFixedMinuteRateLedger({
    clock: wallClock,
  });
  const writerQuiescence = options.writerQuiescence
    ?? (validatorIdentity.kind === 'QUIESCED' ? validatorIdentity.writerQuiescence : undefined)
    ?? createWriterQuiescence({ clock: wallClock });

  const acquireBundle = resources.tryAcquire.bind(resources);
  const releaseHttp = resources.releaseHttp.bind(resources);
  const releaseValidation = resources.releaseValidation.bind(resources);
  const releaseOrigin = resources.releaseOrigin.bind(resources);
  const acquireScrypt = ratesafeAncillary(resources.ancillary.scrypt.tryAcquire.bind(resources.ancillary.scrypt));
  const releaseScrypt = resources.ancillary.scrypt.release.bind(resources.ancillary.scrypt);
  const acquireQueryDb = ratesafeAncillary(resources.ancillary.queryDb.tryAcquire.bind(resources.ancillary.queryDb));
  const releaseQueryDb = resources.ancillary.queryDb.release.bind(resources.ancillary.queryDb);
  const acquireCanonical = ratesafeAncillary(
    resources.ancillary.canonicalReplay.tryAcquire.bind(resources.ancillary.canonicalReplay),
  );
  const releaseCanonical = resources.ancillary.canonicalReplay.release.bind(resources.ancillary.canonicalReplay);

  const allowLogin = rates.login.allow.bind(rates.login);
  const allowQuery = rates.query.allow.bind(rates.query);
  const allowRecognition = rates.recognition.allow.bind(rates.recognition);
  const allowManagement = rates.management.allow.bind(rates.management);
  const validate = validatorValidate.bind(validator);
  const loginWork = loginWorkMethod.bind(work);
  const queryWork = queryWorkMethod.bind(work);
  const managementWork = managementWorkMethod.bind(work);
  const recognitionWork = recognitionWorkMethod.bind(work);
  const claimWorkToken = claimWorkTokenMethod.bind(claimer);
  const offerUnknownRecognition = offerUnknownRecognitionMethod.bind(options.unknownRecognition);
  const acceptUnknownRecognition = acceptUnknownRecognitionMethod.bind(options.unknownRecognition);
  const reserveCandidate = reserveCandidateMethod.bind(options.registry);
  const releaseReservation = releaseReservationMethod.bind(options.registry);
  const registerReserved = registerReservedMethod.bind(options.registry);
  const lookupExisting = lookupExistingMethod.bind(options.registry);
  const completeCanonical = completeCanonicalMethod.bind(options.registry);
  const completeSafeTerminal = completeSafeTerminalMethod.bind(options.registry);
  const markUnknown = markUnknownMethod.bind(options.registry);
  const issueObservationReference = issueObservationReferenceMethod.bind(options.registryCapabilities);
  const assertRegistryKey = assertRegistryKeyMethod.bind(options.registryCapabilities);
  const issueResultReference = issueResultReferenceMethod.bind(options.registryCapabilities);

  const originByOperation = new Map<string, OriginAdmissionLease>();
  const observations = new WeakMap<object, ObservationState>();
  const resultPlans = new WeakMap<object, RecognitionResponsePlans>();
  let invokingAsyncDependency = false;
  let asyncDependenciesFrozen = false;

  const invokeNativePromise = <T>(operation: () => Promise<T>): Promise<T> => {
    if (asyncDependenciesFrozen || invokingAsyncDependency) {
      asyncDependenciesFrozen = true;
      throw new AdmissionTechnicalError('ASYNC_DEPENDENCY_REENTRANT');
    }
    invokingAsyncDependency = true;
    try {
      const promise = operation();
      if (asyncDependenciesFrozen) {
        throw new AdmissionTechnicalError('ASYNC_DEPENDENCY_REENTRANT');
      }
      if (utilTypes.isProxy(promise)
        || !utilTypes.isPromise(promise)
        || Object.getPrototypeOf(promise) !== NativePromise.prototype
        || Object.hasOwn(promise, 'then')) {
        asyncDependenciesFrozen = true;
        throw new AdmissionTechnicalError('ASYNC_DEPENDENCY_MUST_RETURN_NATIVE_PROMISE');
      }
      return new NativePromise<T>((resolve, reject) => {
        nativePromiseThen.call(promise, resolve, reject);
      });
    } catch {
      asyncDependenciesFrozen = true;
      throw new AdmissionTechnicalError('ASYNC_DEPENDENCY_FAILED_SYNCHRONOUSLY');
    } finally {
      invokingAsyncDependency = false;
    }
  };

  const invokeG08WriterWork = <T>(operation: () => Promise<T>): Promise<T> => {
    if (writerPermissionAcquire === undefined) return invokeNativePromise(operation);
    const lease = writerPermissionAcquire();
    try {
      return invokeNativePromise(operation).finally(() => lease.release());
    } catch (error) {
      try { lease.release(); } catch { /* preserve the original synchronous boundary */ }
      throw error;
    }
  };

  let wakeCoordinator = (): void => undefined;
  const lifecycleObserver = Object.freeze({
    registered: writerQuiescence.lifecycle.registered.bind(writerQuiescence.lifecycle),
    queued: writerQuiescence.lifecycle.queued.bind(writerQuiescence.lifecycle),
    started: writerQuiescence.lifecycle.started.bind(writerQuiescence.lifecycle),
    blocked: writerQuiescence.lifecycle.blocked.bind(writerQuiescence.lifecycle),
    settled(event: WriteOperationLifecycleEvent): void {
      if (event.disposition === 'UNKNOWN_EFFECT') {
        writerQuiescence.lifecycle.settled(event.receipt, event.disposition);
        return;
      }
      const lease = originByOperation.get(event.receipt.operationId);
      if (lease !== undefined) {
        try {
          releaseOrigin(lease);
        } catch (error: unknown) {
          writerQuiescence.lifecycle.blocked(event.receipt);
          throw error;
        }
        originByOperation.delete(event.receipt.operationId);
      }
      // State is removed only after every external cleanup step succeeds.
      writerQuiescence.lifecycle.settled(event.receipt, event.disposition);
    },
  });

  const coordinator = createWriteOperationCoordinatorBundle<
    WriterInput,
    AdmissionWriterOutcome,
    WriterInput,
    AdmissionWriterOutcome,
    WriterInput,
    AdmissionWriterOutcome,
    WriterInput,
    AdmissionWriterOutcome
  >({
    clock: wallClock,
    monotonicClock,
    lifecycleObserver,
    startGate: (): boolean => writerQuiescence.canStartWriter() && (writerPermissionCanStart?.() ?? true),
    executors: Object.freeze({
      managementCreate: executeManagement,
      managementUpdate: executeManagement,
      managementRevoke: executeManagement,
      recognition: executeRecognition,
    }),
  });
  writerQuiescence.bindCoordinatorWake(() => wakeCoordinator());
  writerPermissionBindWake?.(() => wakeCoordinator());
  writerPermissionBindMaintenanceReadySettlement?.(() => {
    coordinator.settleReadyKnownNoEffect(maintenanceReadySettlement, (value: unknown) => {
      const input = value as WriterInput;
      // This is unlike ordinary best-effort cleanup: maintenance cannot claim
      // DRAINED while its READY reservations remain unreleased.  Let the
      // failure escape the synchronous callback so RuntimeControl records the
      // terminal INTERNAL_UNAVAILABLE outcome.
      if (input.reservation !== null) releaseReservationForMaintenance(input.reservation);
    });
  });
  writerPermissionBindMaintenanceValidationCancellation?.(() => {
    coordinator.markWaitingValidationMaintenanceCanceled();
  });
  wakeCoordinator = coordinator.wake;

  async function executeManagement(
    input: WriterInput,
    context: WriteOperationContext,
    settlement: WriteOperationSettlement<AdmissionWriterOutcome>,
  ): Promise<void> {
    if (input.accountId === null) {
      settleUnknown(input.owner, settlement, 'INVALID_MANAGEMENT_IDENTITY');
      return;
    }
    let rateDecision: ReturnType<typeof allowManagement>;
    try {
      rateDecision = allowManagement(input.accountId);
    } catch {
      respond(input.owner, technical.unavailable);
      settlement.knownNoEffect(new AdmissionTechnicalError('RATE_LIMITER_UNAVAILABLE'));
      return;
    }
    if (rateDecision.kind === 'RATE_LIMITED') {
      respond(input.owner, technical.rateLimited);
      settlement.knownNoEffect(new AdmissionTechnicalError('RATE_LIMITED'));
      return;
    }
    try {
      const outcome = await invokeG08WriterWork(
        () => managementWork(input.workInput, workContext(context)),
      );
      settleWriterOutcome(input.owner, settlement, outcome);
    } catch {
      settleUnknown(input.owner, settlement, 'MANAGEMENT_WORK_UNCONFIRMED');
    }
  }

  async function executeRecognition(
    input: WriterInput,
    context: WriteOperationContext,
    settlement: WriteOperationSettlement<AdmissionWriterOutcome>,
  ): Promise<void> {
    if (input.keyFacts === null
      || input.reservation === null
      || input.registryKey === null
      || input.comparisonArtifact === null
      || input.observationReference === null) {
      settleUnknown(input.owner, settlement, 'INVALID_RECOGNITION_INPUT');
      return;
    }
    let rateDecision: ReturnType<typeof allowRecognition>;
    try {
      rateDecision = allowRecognition(input.keyFacts.sourceId);
    } catch {
      try {
        releaseReservation(input.reservation);
      } catch {
        settleUnknown(input.owner, settlement, 'RESERVATION_RELEASE_UNCONFIRMED');
        return;
      }
      respond(input.owner, technical.unavailable);
      settlement.knownNoEffect(new AdmissionTechnicalError('RATE_LIMITER_UNAVAILABLE'));
      return;
    }
    if (rateDecision.kind === 'RATE_LIMITED') {
      try {
        releaseReservation(input.reservation);
      } catch {
        settleUnknown(input.owner, settlement, 'RESERVATION_RELEASE_UNCONFIRMED');
        return;
      }
      respond(input.owner, technical.rateLimited);
      settlement.knownNoEffect(new AdmissionTechnicalError('RATE_LIMITED'));
      return;
    }
    try {

      const registration = registerReserved(
        input.reservation,
        input.registryKey,
        input.comparisonArtifact,
        input.observationReference,
      );
      if (registration.kind === 'JOINED') {
        const original = observations.get(registration.observationReference);
        if (original !== undefined) input.deadlineObservation.useProgress(original.progressPlan);
        respond(input.owner, original === undefined ? technical.unconfirmed : original.progressPlan);
        settlement.knownNoEffect(new AdmissionTechnicalError('JOINED_EXISTING_OPERATION'));
        return;
      }
      if (registration.kind === 'REPLAY_CANONICAL'
        || registration.kind === 'REPLAY_SAFE_TECHNICAL_TERMINAL') {
        if (observations.has(registration.observationReference)) {
          input.deadlineObservation.markCanonicalReplay();
        }
        handleReplay(input.owner, registration.resultReference);
        settlement.knownNoEffect(new AdmissionTechnicalError('REPLAYED_EXISTING_OPERATION'));
        return;
      }

      if (input.runningPlan === null) throw new AdmissionTechnicalError('RUNNING_PLAN_REQUIRED');
      observations.set(registration.observationReference, {
        original: workContext(context),
        progressPlan: input.runningPlan,
      });
      input.deadlineObservation.useProgress(input.runningPlan);
      await runOriginalRecognition(
        input,
        context,
        settlement,
        registration.lease,
        registration.observationReference,
      );
    } catch (error: unknown) {
      if (error instanceof OperationRegistryError && error.code === 'IDEMPOTENCY_CONFLICT') {
        respond(input.owner, technical.conflict);
        settlement.knownNoEffect(new AdmissionTechnicalError('IDEMPOTENCY_CONFLICT'));
        return;
      }
      settleUnknown(input.owner, settlement, 'RECOGNITION_REGISTRY_UNCONFIRMED');
    }
  }

  async function runOriginalRecognition(
    input: WriterInput,
    context: WriteOperationContext,
    settlement: WriteOperationSettlement<AdmissionWriterOutcome>,
    lease: OperationExecutionLease,
    observationReference: OperationObservationReference,
  ): Promise<void> {
    let outcome: AdmissionRecognitionWriterOutcome;
    try {
      outcome = sanitizeRecognitionWriterOutcome(
        await invokeG08WriterWork(() => recognitionWork(input.workInput, workContext(context))),
        renderResponsePlan,
      );
    } catch {
      transitionUnknown(input, lease, context, observationReference);
      settleUnknown(input.owner, settlement, 'RECOGNITION_WORK_UNCONFIRMED');
      return;
    }

    if (outcome.disposition === 'UNKNOWN_EFFECT') {
      transitionUnknown(input, lease, context, observationReference);
      respond(input.owner, technical.unconfirmed);
      settlement.unknownEffect(new AdmissionTechnicalError('RECOGNITION_UNKNOWN_EFFECT'));
      return;
    }
    if (outcome.disposition === 'KNOWN_NO_EFFECT') {
      let result: OperationResultReference | null = null;
      try {
        renderResponsePlan(outcome.response);
        result = issueResultReference();
        resultPlans.set(result, Object.freeze({
          original: outcome.response,
          replay: outcome.response,
        }));
        completeSafeTerminal(lease, result);
      } catch {
        if (result !== null) resultPlans.delete(result);
        transitionUnknown(input, lease, context, observationReference);
        settleUnknown(input.owner, settlement, 'RECOGNITION_TERMINAL_UNCONFIRMED');
        return;
      }
      respond(input.owner, outcome.response);
      settlement.knownNoEffect(new AdmissionTechnicalError('KNOWN_NO_EFFECT'));
      return;
    }
    if (outcome.disposition !== 'BUSINESS_RESULT_PERSISTED') {
      throw new AdmissionTechnicalError('INVALID_RECOGNITION_WRITER_OUTCOME');
    }
    let result: OperationResultReference | null = null;
    try {
      renderResponsePlan(outcome.originalResponse);
      renderResponsePlan(outcome.replayResponse);
      result = issueResultReference();
      resultPlans.set(result, Object.freeze({
        original: outcome.originalResponse,
        replay: outcome.replayResponse,
      }));
      completeCanonical(lease, result);
    } catch {
      if (result !== null) resultPlans.delete(result);
      transitionUnknown(input, lease, context, observationReference);
      settleUnknown(input.owner, settlement, 'RECOGNITION_TERMINAL_UNCONFIRMED');
      return;
    }
    const plans = resultPlans.get(result);
    if (plans === undefined) {
      transitionUnknown(input, lease, context, observationReference);
      settleUnknown(input.owner, settlement, 'RECOGNITION_RESULT_PLAN_UNCONFIRMED');
      return;
    }
    respond(input.owner, plans.original);
    settlement.businessResultPersisted(outcome);
  }

  function transitionUnknown(
    input: WriterInput,
    lease: OperationExecutionLease,
    context: WriteOperationContext,
    observationReference: OperationObservationReference,
  ): void {
    let confirmation: OperationConfirmationLease;
    try {
      confirmation = markUnknown(lease);
    } catch {
      // The surrounding writer remains UNKNOWN and retains its origin slot.
      return;
    }
    const observation = observations.get(observationReference);
    if (observation !== undefined && input.pausedUnknownPlan !== null) {
      observation.progressPlan = input.pausedUnknownPlan;
      input.deadlineObservation.useProgress(input.pausedUnknownPlan);
    }
    try {
      if (input.keyFacts === null || input.comparisonArtifact === null) {
        throw new AdmissionTechnicalError('RECOGNITION_RECOVERY_PROVENANCE_MISSING');
      }
      const recovery = issueUnknownRecognitionRecoveryToken({
        sourceId: input.keyFacts.sourceId,
        externalEventId: input.keyFacts.externalEventId,
        comparisonArtifact: input.comparisonArtifact,
      });
      const receipt = offerUnknownRecognition(Object.freeze({
        confirmationLease: confirmation,
        operation: workContext(context),
        observationReference,
        recovery,
      }));
      acceptUnknownRecognition(receipt);
    } catch {
      // The factory-owned coordinator retains any offered item. Its drain port
      // is intentionally reserved for the future G10 owner; originalConfirm
      // admission capacity remains unused in this gate.
    }
  }

  function handleReplay(
    owner: HttpResponseOwner,
    resultReference: OperationResultReference,
  ): void {
    const capacity = acquireCanonical();
    if (capacity === null) {
      respond(owner, technical.canonicalUnconfirmed);
      return;
    }
    try {
      const plans = resultPlans.get(resultReference);
      if (plans === undefined) {
        respond(owner, technical.canonicalUnconfirmed);
        return;
      }
      respond(owner, plans.replay);
    } catch {
      respond(owner, technical.canonicalUnconfirmed);
    } finally {
      safeReleaseAncillary(releaseCanonical, capacity);
    }
  }

  const handler: AcceptedIngressHandler = (accepted, request, response, next): void => {
    const requestTarget = typeof request.originalUrl === 'string' && request.originalUrl.length > 0
      ? request.originalUrl
      : request.url;
    const classification = classifyBusinessRoute({
      method: accepted.method,
      requestTarget,
      ...(accepted.headers.retryMode === undefined ? {} : { retryMode: accepted.headers.retryMode }),
    });
    if (invokingAsyncDependency || asyncDependenciesFrozen) {
      if (invokingAsyncDependency) asyncDependenciesFrozen = true;
      sendImmediatePlan(
        response,
        classification.kind !== 'NO_MATCH' && classification.routeId === 'RECOGNITION_ATTEMPT'
          ? technical.unconfirmed
          : technical.unavailable,
      );
      return;
    }
    if (classification.kind === 'NO_MATCH') {
      next();
      return;
    }
    if (classification.kind === 'INVALID_RETRY_MODE') {
      sendImmediatePlan(response, technical.invalidRetry);
      return;
    }

    // This is intentionally before epoch, resource, rate, validation and
    // registry work.  Maintenance only vetoes NEW writers; exact existing-only
    // recognition, login and query retain their normal read/replay paths.
    if (isNewWriteRoute(classification.routeId, classification.retryMode)) {
      let maintenanceVeto: boolean;
      try {
        maintenanceVeto = writerPermissionMaintenanceVeto?.() ?? false;
      } catch {
        maintenanceVeto = true;
      }
      if (maintenanceVeto) {
        sendImmediatePlan(response, technical.busy);
        return;
      }
    }

    const epochRejection = checkEpoch(
      classification.routeId,
      accepted.headers.datasetEpoch,
      currentDatasetEpoch,
    );
    if (epochRejection !== null) {
      sendImmediatePlan(response, issueTechnical(epochRejection));
      return;
    }

    const admissionClass = routeAdmissionClass(classification.routeId, classification.retryMode);
    if (writeClaimDisposition !== 'WRITABLE'
      && isNewWriteRoute(classification.routeId, classification.retryMode)) {
      sendImmediatePlan(response, technical.unavailable);
      return;
    }
    let bundle: AdmissionResourceBundle | null;
    try {
      bundle = acquireBundle(admissionClass);
    } catch {
      bundle = null;
    }
    if (bundle === null) {
      sendImmediatePlan(
        response,
        classification.routeId === 'RECOGNITION_ATTEMPT'
          ? technical.unconfirmed
          : technical.unavailable,
      );
      return;
    }

    if (isWriterRoute(classification.routeId) && classification.retryMode === 'NORMAL') {
      startWriter(accepted, classification, response, bundle);
      return;
    }
    startNonWriter(
      accepted,
      classification,
      request.socket.remoteAddress,
      response,
      bundle,
    );
  };

  function startWriter(
    accepted: AcceptedIngress,
    classification: Extract<ReturnType<typeof classifyBusinessRoute>, { kind: 'MATCHED' }>,
    response: NarrowHttpResponse,
    bundle: AdmissionResourceBundle,
  ): void {
    let reservation: OperationRegistryReservation | null = null;
    let provisional: WriteOperationProvisional<WriterInput, AdmissionWriterOutcome> | null = null;
    let owner: HttpResponseOwner | null = null;
    const deadlineObservation = createDeadlineObservation();
    try {
      if (classification.routeId === 'RECOGNITION_ATTEMPT') reservation = reserveCandidate();
      provisional = provisionalFor(classification.routeId);
      if (bundle.origin === null) throw new AdmissionTechnicalError('ORIGIN_LEASE_REQUIRED');
      originByOperation.set(provisional.receipt.operationId, bundle.origin);
      owner = createHttpResponseOwner({
        response,
        receipt: provisional.receipt,
        releaseHttp: () => releaseHttp(bundle.http),
        responsePlanRenderer,
        fallbackPlan: technical.unconfirmed,
        deadlineResponse: deadlineObservation.read,
        clock: monotonicClock,
      });
      // A7 may settle this exact READY operation before G08 begins.  The
      // coordinator owns queue removal and lifecycle cleanup; this observer
      // owns the one HTTP response and deliberately ignores every other
      // established completion error.
      void provisional.completion.catch((error: unknown) => {
        if (error === maintenanceReadySettlement || error === maintenanceValidationSettlement) {
          respond(owner as HttpResponseOwner, technical.busy);
        }
      });
      void validateWriter(
        accepted,
        classification,
        provisional,
        owner,
        bundle.validation,
        reservation,
        deadlineObservation,
      ).catch(() => undefined);
    } catch {
      if (reservation !== null) safeReleaseReservation(reservation);
      safeReleaseValidation(bundle.validation);
      if (owner === null) safeReleaseHttp(bundle);
      if (provisional !== null) {
        safeRejectProvisional(provisional, 'WRITER_SETUP_FAILED');
        void provisional.completion.catch(() => undefined);
      } else if (bundle.origin !== null) {
        safeReleaseOrigin(bundle.origin);
      }
      if (owner === null) {
        sendImmediatePlan(
          response,
          classification.routeId === 'RECOGNITION_ATTEMPT'
            ? technical.unconfirmed
            : technical.unavailable,
        );
      }
    }
  }

  async function validateWriter(
    accepted: AcceptedIngress,
    classification: Extract<ReturnType<typeof classifyBusinessRoute>, { kind: 'MATCHED' }>,
    provisional: WriteOperationProvisional<WriterInput, AdmissionWriterOutcome>,
    owner: HttpResponseOwner,
    validationLease: ValidationAdmissionLease,
    reservation: OperationRegistryReservation | null,
    deadlineObservation: DeadlineObservationController,
  ): Promise<void> {
    let validation: CanonicalAdmissionValidationResult;
    try {
      validation = sanitizeValidationResult(
        classification.routeId,
        await invokeNativePromise(() => validate(validationInput(accepted, classification))),
        assertRegistryKey,
        claimWorkToken,
        renderResponsePlan,
      );
    } catch {
      if (reservation !== null) safeReleaseReservation(reservation);
      safeReleaseValidation(validationLease);
      respond(owner, technical.unconfirmed);
      safeRejectProvisional(provisional, 'VALIDATION_FAILED');
      void provisional.completion.catch(() => undefined);
      return;
    }
    safeReleaseValidation(validationLease);
    if (validation.kind === 'REJECTED') {
      if (reservation !== null) safeReleaseReservation(reservation);
      respond(owner, validation.response);
      safeRejectProvisional(provisional, 'VALIDATION_REJECTED');
      void provisional.completion.catch(() => undefined);
      return;
    }

    // A8 intentionally checks this only after a *valid* validator result.
    // A normal validator rejection retains its ordinary response.  The marker
    // is set synchronously by maintenance but it neither aborts validation nor
    // participates in drain observation.  It is consumed exactly once before
    // constructing WriterInput, registry/rate work, or G08 issuance.
    if (provisional.consumeMaintenanceValidationCancellation()) {
      try {
        if (reservation !== null) releaseReservationForMaintenance(reservation);
        provisional.settleMaintenanceKnownNoEffect(maintenanceValidationSettlement);
        void provisional.completion.catch(() => undefined);
      } catch {
        // The drain result may already be DRAINED and must remain immutable.
        // This request, however, cannot claim maintenance success when its
        // mandatory reservation cleanup failed, so fail closed as internal.
        if (reservation !== null) safeReleaseReservation(reservation);
        respond(owner, technical.unavailable);
        safeRejectProvisional(provisional, 'MAINTENANCE_VALIDATION_CLEANUP_FAILED');
        void provisional.completion.catch(() => undefined);
      }
      return;
    }

    try {
      let writerInput: WriterInput;
      if (validation.kind === 'MANAGEMENT') {
        writerInput = Object.freeze({
          routeId: classification.routeId,
          accountId: validation.accountId,
          keyFacts: null,
          workInput: validation.workInput,
          owner,
          reservation: null,
          registryKey: null,
          comparisonArtifact: null,
          observationReference: null,
          runningPlan: null,
          pausedUnknownPlan: null,
          deadlineObservation,
        });
      } else if (validation.kind === 'RECOGNITION' && reservation !== null) {
        const runningPlan = recognitionProgressPlan(
          validation.keyFacts.externalEventId,
          provisional.receipt.receivedAtMs,
          'RUNNING',
          issueBusiness,
        );
        const pausedUnknownPlan = recognitionProgressPlan(
          validation.keyFacts.externalEventId,
          provisional.receipt.receivedAtMs,
          'PAUSED_UNKNOWN',
          issueBusiness,
        );
        writerInput = Object.freeze({
          routeId: classification.routeId,
          accountId: null,
          keyFacts: validation.keyFacts,
          workInput: validation.workInput,
          owner,
          reservation,
          registryKey: validation.registryKey,
          comparisonArtifact: validation.comparisonArtifact,
          observationReference: issueObservationReference(),
          runningPlan,
          pausedUnknownPlan,
          deadlineObservation,
        });
      } else {
        throw new AdmissionTechnicalError('VALIDATION_KIND_MISMATCH');
      }
      provisional.activate(writerInput);
      void provisional.completion.catch(() => undefined);
    } catch {
      if (reservation !== null) safeReleaseReservation(reservation);
      respond(owner, technical.unconfirmed);
      safeRejectProvisional(provisional, 'VALIDATION_KIND_MISMATCH');
      void provisional.completion.catch(() => undefined);
    }
  }

  function startNonWriter(
    accepted: AcceptedIngress,
    classification: Extract<ReturnType<typeof classifyBusinessRoute>, { kind: 'MATCHED' }>,
    peerIp: string | undefined,
    response: NarrowHttpResponse,
    bundle: AdmissionResourceBundle,
  ): void {
    let admittedAt: number;
    try {
      admittedAt = monotonicClock.nowMs();
      if (!Number.isFinite(admittedAt) || admittedAt < 0) throw new TypeError('invalid monotonic admission time');
    } catch {
      releaseBundleBeforeOwner(bundle);
      sendImmediatePlan(response, technical.unavailable);
      return;
    }
    const deadlineObservation = createDeadlineObservation();
    let owner: HttpResponseOwner;
    try {
      owner = createHttpResponseOwner({
        response,
        receipt: Object.freeze({ registeredAtMonotonicMs: admittedAt }),
        releaseHttp: () => releaseHttp(bundle.http),
        responsePlanRenderer,
        fallbackPlan: technical.unconfirmed,
        deadlineResponse: deadlineObservation.read,
        clock: monotonicClock,
      });
    } catch {
      releaseBundleBeforeOwner(bundle);
      sendImmediatePlan(response, technical.unavailable);
      return;
    }
    void runNonWriter(
      accepted,
      classification,
      peerIp,
      owner,
      bundle.validation,
      deadlineObservation,
    ).catch(() => undefined);
  }

  async function runNonWriter(
    accepted: AcceptedIngress,
    classification: Extract<ReturnType<typeof classifyBusinessRoute>, { kind: 'MATCHED' }>,
    peerIp: string | undefined,
    owner: HttpResponseOwner,
    validationLease: ValidationAdmissionLease,
    deadlineObservation: DeadlineObservationController,
  ): Promise<void> {
    if (classification.routeId === 'AUTH_LOGIN') {
      await runLogin(accepted, classification, peerIp, owner, validationLease);
      return;
    }
    if (classification.routeId === 'RECOGNITION_ATTEMPT') {
      await runExistingOnly(accepted, classification, owner, validationLease, deadlineObservation);
      return;
    }
    await runQuery(accepted, classification, owner, validationLease);
  }

  async function runLogin(
    accepted: AcceptedIngress,
    classification: Extract<ReturnType<typeof classifyBusinessRoute>, { kind: 'MATCHED' }>,
    peerIp: string | undefined,
    owner: HttpResponseOwner,
    validationLease: ValidationAdmissionLease,
  ): Promise<void> {
    if (typeof peerIp !== 'string' || peerIp.length === 0) {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unavailable);
      return;
    }
    try {
      if (allowLogin(peerIp).kind === 'RATE_LIMITED') {
        safeReleaseValidation(validationLease);
        respond(owner, technical.rateLimited);
        return;
      }
    } catch {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unavailable);
      return;
    }
    const scrypt = acquireScrypt();
    if (scrypt === null) {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unavailable);
      return;
    }
    let validation: CanonicalAdmissionValidationResult;
    try {
      validation = sanitizeValidationResult(
        classification.routeId,
        await invokeNativePromise(() => validate(validationInput(accepted, classification))),
        assertRegistryKey,
        claimWorkToken,
        renderResponsePlan,
      );
    } catch {
      safeReleaseAncillary(releaseScrypt, scrypt);
      safeReleaseValidation(validationLease);
      respond(owner, technical.unconfirmed);
      return;
    }
    safeReleaseAncillary(releaseScrypt, scrypt);
    safeReleaseValidation(validationLease);
    if (validation.kind === 'REJECTED') {
      respond(owner, validation.response);
      return;
    }
    if (validation.kind !== 'LOGIN') {
      respond(owner, technical.unconfirmed);
      return;
    }
    try {
      respond(owner, await invokeNativePromise(() => loginWork(validation.workInput)));
    } catch {
      respond(owner, technical.unconfirmed);
    }
  }

  async function runQuery(
    accepted: AcceptedIngress,
    classification: Extract<ReturnType<typeof classifyBusinessRoute>, { kind: 'MATCHED' }>,
    owner: HttpResponseOwner,
    validationLease: ValidationAdmissionLease,
  ): Promise<void> {
    let validation: CanonicalAdmissionValidationResult;
    try {
      validation = sanitizeValidationResult(
        classification.routeId,
        await invokeNativePromise(() => validate(validationInput(accepted, classification))),
        assertRegistryKey,
        claimWorkToken,
        renderResponsePlan,
      );
    } catch {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unconfirmed);
      return;
    }
    if (validation.kind === 'REJECTED') {
      safeReleaseValidation(validationLease);
      respond(owner, validation.response);
      return;
    }
    if (validation.kind !== 'QUERY') {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unconfirmed);
      return;
    }
    try {
      if (allowQuery(validation.accountId).kind === 'RATE_LIMITED') {
        safeReleaseValidation(validationLease);
        respond(owner, technical.rateLimited);
        return;
      }
    } catch {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unavailable);
      return;
    }
    const queryDb = acquireQueryDb();
    if (queryDb === null) {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unavailable);
      return;
    }
    try {
      respond(owner, await invokeNativePromise(() => queryWork(validation.workInput)));
    } catch {
      respond(owner, technical.unconfirmed);
    } finally {
      safeReleaseAncillary(releaseQueryDb, queryDb);
      safeReleaseValidation(validationLease);
    }
  }

  async function runExistingOnly(
    accepted: AcceptedIngress,
    classification: Extract<ReturnType<typeof classifyBusinessRoute>, { kind: 'MATCHED' }>,
    owner: HttpResponseOwner,
    validationLease: ValidationAdmissionLease,
    deadlineObservation: DeadlineObservationController,
  ): Promise<void> {
    let validation: CanonicalAdmissionValidationResult;
    try {
      validation = sanitizeValidationResult(
        classification.routeId,
        await invokeNativePromise(() => validate(validationInput(accepted, classification))),
        assertRegistryKey,
        claimWorkToken,
        renderResponsePlan,
      );
    } catch {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unconfirmed);
      return;
    }
    if (validation.kind === 'REJECTED') {
      safeReleaseValidation(validationLease);
      respond(owner, validation.response);
      return;
    }
    if (validation.kind !== 'RECOGNITION') {
      safeReleaseValidation(validationLease);
      respond(owner, technical.unconfirmed);
      return;
    }
    try {
      if (allowRecognition(validation.keyFacts.sourceId).kind === 'RATE_LIMITED') {
        respond(owner, technical.rateLimited);
        return;
      }
      const lookup = lookupExisting(
        validation.registryKey,
        validation.comparisonArtifact,
      );
      if (lookup.kind === 'ABSENT' || lookup.kind === 'NOT_PROVEN') {
        respond(owner, technical.unconfirmed);
      } else if (lookup.kind === 'JOINED') {
        const observation = observations.get(lookup.observationReference);
        if (observation !== undefined) {
          deadlineObservation.useProgress(observation.progressPlan);
          respond(owner, observation.progressPlan);
        } else {
          respond(owner, technical.unconfirmed);
        }
      } else {
        if (observations.has(lookup.observationReference)) {
          deadlineObservation.markCanonicalReplay();
        }
        handleReplay(owner, lookup.resultReference);
      }
    } catch (error: unknown) {
      respond(owner, error instanceof OperationRegistryError && error.code === 'IDEMPOTENCY_CONFLICT'
        ? technical.conflict
        : technical.unconfirmed);
    } finally {
      safeReleaseValidation(validationLease);
    }
  }

  function provisionalFor(
    routeId: BusinessRouteId,
  ): WriteOperationProvisional<WriterInput, AdmissionWriterOutcome> {
    switch (routeId) {
      case 'QUALIFICATION_CREATE': return coordinator.managementCreate.registerProvisional();
      case 'QUALIFICATION_UPDATE': return coordinator.managementUpdate.registerProvisional();
      case 'QUALIFICATION_REVOKE': return coordinator.managementRevoke.registerProvisional();
      case 'RECOGNITION_ATTEMPT': return coordinator.recognition.registerProvisional();
      default: throw new AdmissionTechnicalError('NOT_A_WRITER_ROUTE');
    }
  }

  function respond(owner: HttpResponseOwner, plan: HttpResponsePlan): void {
    try {
      owner.tryRespond(plan);
    } catch {
      // The owner has already claimed or closed the response; no second writer
      // is introduced for a failed transport.
    }
  }

  function settleWriterOutcome(
    owner: HttpResponseOwner,
    settlement: WriteOperationSettlement<AdmissionWriterOutcome>,
    outcome: AdmissionManagementWriterOutcome,
  ): void {
    try {
      outcome = sanitizeWriterOutcome(outcome);
      renderResponsePlan(outcome.response);
    } catch {
      settleUnknown(owner, settlement, 'INVALID_WRITER_OUTCOME');
      return;
    }
    respond(owner, outcome.disposition === 'UNKNOWN_EFFECT'
      ? technical.unconfirmed
      : outcome.response);
    switch (outcome.disposition) {
      case 'BUSINESS_RESULT_PERSISTED':
        settlement.businessResultPersisted(outcome);
        return;
      case 'KNOWN_NO_EFFECT':
        settlement.knownNoEffect(new AdmissionTechnicalError('KNOWN_NO_EFFECT'));
        return;
      case 'UNKNOWN_EFFECT':
        settlement.unknownEffect(new AdmissionTechnicalError('UNKNOWN_EFFECT'));
    }
  }

  function settleUnknown(
    owner: HttpResponseOwner,
    settlement: WriteOperationSettlement<AdmissionWriterOutcome>,
    code: string,
  ): void {
    respond(owner, technical.unconfirmed);
    settlement.unknownEffect(new AdmissionTechnicalError(code));
  }

  function safeReleaseReservation(reservation: OperationRegistryReservation): void {
    try { releaseReservation(reservation); } catch { /* fail closed at caller */ }
  }
  function releaseReservationForMaintenance(reservation: OperationRegistryReservation): void {
    releaseReservation(reservation);
  }
  function safeReleaseValidation(lease: ValidationAdmissionLease): void {
    try { releaseValidation(lease); } catch { /* the fixed ledger remains bounded */ }
  }
  function safeReleaseOrigin(lease: OriginAdmissionLease): void {
    try { releaseOrigin(lease); } catch { /* the fixed ledger remains bounded */ }
  }
  function safeReleaseHttp(bundle: AdmissionResourceBundle): void {
    try { releaseHttp(bundle.http); } catch { /* the fixed ledger remains bounded */ }
  }
  function releaseBundleBeforeOwner(bundle: AdmissionResourceBundle): void {
    safeReleaseHttp(bundle);
    safeReleaseValidation(bundle.validation);
    if (bundle.origin !== null) safeReleaseOrigin(bundle.origin);
  }
  function safeRejectProvisional(
    provisional: WriteOperationProvisional<WriterInput, AdmissionWriterOutcome>,
    code: string,
  ): void {
    try { provisional.rejectBeforeStart(new AdmissionTechnicalError(code)); } catch { /* already decided */ }
  }
  function safeReleaseAncillary(
    release: (lease: AncillaryAdmissionLease) => void,
    lease: AncillaryAdmissionLease,
  ): void {
    try { release(lease); } catch { /* the fixed ledger remains bounded */ }
  }

  return handler;
}

function validationInput(
  accepted: AcceptedIngress,
  classification: Extract<ReturnType<typeof classifyBusinessRoute>, { kind: 'MATCHED' }>,
): AdmissionValidationInput {
  return Object.freeze({
    routeId: classification.routeId,
    retryMode: classification.retryMode,
    parameters: classification.parameters,
    accepted,
  });
}

function sanitizeValidationResult(
  routeId: BusinessRouteId,
  result: unknown,
  assertRegistryKey: (key: OperationRegistryKey) => OperationRegistryKeyFacts,
  claimWorkToken: (
    token: AdmissionWorkToken,
    expectedRouteId: BusinessRouteId,
  ) => AdmissionWorkToken,
  renderResponsePlan: (plan: HttpResponsePlan) => unknown,
): CanonicalAdmissionValidationResult {
  const kindRecord = exactDataRecord(result, ['kind'], true);
  const kind = recordString(kindRecord, 'kind');
  if (kind === 'REJECTED') {
    const record = exactDataRecord(result, ['kind', 'response']);
    const response = record.response;
    if (!isObject(response)) throw new TypeError('invalid rejection');
    renderResponsePlan(response as HttpResponsePlan);
    return Object.freeze({ kind, response: response as HttpResponsePlan });
  }
  if (routeId === 'AUTH_LOGIN' && kind === 'LOGIN') {
    const record = exactDataRecord(result, ['kind', 'workInput']);
    return Object.freeze({
      kind,
      workInput: claimWorkToken(record.workInput as AdmissionWorkToken, routeId),
    });
  }
  if (isQueryRoute(routeId) && kind === 'QUERY') {
    const record = exactDataRecord(result, ['kind', 'accountId', 'workInput']);
    const accountId = recordString(record, 'accountId');
    assertNonempty(accountId);
    return Object.freeze({
      kind,
      accountId,
      workInput: claimWorkToken(record.workInput as AdmissionWorkToken, routeId),
    });
  }
  if (isManagementRoute(routeId) && kind === 'MANAGEMENT') {
    const record = exactDataRecord(result, ['kind', 'accountId', 'workInput']);
    const accountId = recordString(record, 'accountId');
    assertNonempty(accountId);
    return Object.freeze({
      kind,
      accountId,
      workInput: claimWorkToken(record.workInput as AdmissionWorkToken, routeId),
    });
  }
  if (routeId === 'RECOGNITION_ATTEMPT' && kind === 'RECOGNITION') {
    const record = exactDataRecord(
      result,
      ['kind', 'registryKey', 'comparisonArtifact', 'workInput'],
    );
    const registryKey = record.registryKey;
    const comparisonArtifact = record.comparisonArtifact;
    if (!isObject(registryKey) || !isObject(comparisonArtifact)) {
      throw new TypeError('invalid recognition capabilities');
    }
    assertCanonicalOpaque(registryKey, 'registry key');
    const assertedFacts = assertRegistryKey(registryKey as OperationRegistryKey);
    const keyFacts = canonicalKeyFacts(assertedFacts);
    assertCanonicalOpaque(comparisonArtifact, 'comparison artifact');
    return Object.freeze({
      kind,
      keyFacts,
      registryKey: registryKey as OperationRegistryKey,
      comparisonArtifact: comparisonArtifact as OperationComparisonArtifact,
      workInput: claimWorkToken(record.workInput as AdmissionWorkToken, routeId),
    });
  }
  throw new TypeError('validation result does not match route');
}

function sanitizeWriterOutcome(value: unknown): AdmissionManagementWriterOutcome {
  const record = exactDataRecord(value, ['disposition', 'response']);
  const disposition = recordString(record, 'disposition');
  if (disposition !== 'BUSINESS_RESULT_PERSISTED'
    && disposition !== 'KNOWN_NO_EFFECT'
    && disposition !== 'UNKNOWN_EFFECT') {
    throw new TypeError('invalid writer disposition');
  }
  const response = record.response;
  if (!isObject(response)) throw new TypeError('invalid writer response');
  return Object.freeze({ disposition, response: response as HttpResponsePlan });
}

function sanitizeRecognitionWriterOutcome(
  value: unknown,
  renderResponsePlan: (plan: HttpResponsePlan) => unknown,
): AdmissionRecognitionWriterOutcome {
  const header = exactDataRecord(value, ['disposition'], true);
  const disposition = recordString(header, 'disposition');
  if (disposition === 'BUSINESS_RESULT_PERSISTED') {
    const record = exactDataRecord(value, ['disposition', 'originalResponse', 'replayResponse']);
    const originalResponse = record.originalResponse;
    const replayResponse = record.replayResponse;
    if (!isObject(originalResponse) || !isObject(replayResponse)) {
      throw new TypeError('invalid recognition response plans');
    }
    renderResponsePlan(originalResponse as HttpResponsePlan);
    renderResponsePlan(replayResponse as HttpResponsePlan);
    return Object.freeze({
      disposition,
      originalResponse: originalResponse as HttpResponsePlan,
      replayResponse: replayResponse as HttpResponsePlan,
    });
  }
  if (disposition === 'KNOWN_NO_EFFECT' || disposition === 'UNKNOWN_EFFECT') {
    const record = exactDataRecord(value, ['disposition', 'response']);
    const response = record.response;
    if (!isObject(response)) throw new TypeError('invalid recognition response plan');
    renderResponsePlan(response as HttpResponsePlan);
    return Object.freeze({ disposition, response: response as HttpResponsePlan });
  }
  throw new TypeError('invalid recognition writer disposition');
}

function canonicalKeyFacts(value: unknown): OperationRegistryKeyFacts {
  const record = exactDataRecord(value, ['sourceId', 'externalEventId']);
  const sourceId = recordString(record, 'sourceId');
  assertNonempty(sourceId);
  const externalEventId = recordString(record, 'externalEventId');
  if (!EXTERNAL_EVENT_ID.test(externalEventId)) {
    throw new TypeError('external event ID does not satisfy D119');
  }
  return Object.freeze({ sourceId, externalEventId });
}

function checkEpoch(
  routeId: BusinessRouteId,
  supplied: string | undefined,
  current: string,
): 'INVALID_DATASET_EPOCH' | 'DATASET_EPOCH_MISMATCH' | null {
  if (!isRelatedWrite(routeId)) return null;
  if (supplied === undefined || !UUID_V4.test(supplied)) return 'INVALID_DATASET_EPOCH';
  if (supplied !== current) return 'DATASET_EPOCH_MISMATCH';
  return null;
}

function routeAdmissionClass(
  routeId: BusinessRouteId,
  retryMode: BusinessRouteRetryMode,
): 'MANAGEMENT' | 'NORMAL_RECOGNITION' | 'LOGIN' | 'QUERY' | 'EXISTING_ONLY' {
  if (routeId === 'AUTH_LOGIN') return 'LOGIN';
  if (routeId === 'RECOGNITION_ATTEMPT') {
    return retryMode === 'EXISTING_ONLY' ? 'EXISTING_ONLY' : 'NORMAL_RECOGNITION';
  }
  if (isManagementRoute(routeId)) return 'MANAGEMENT';
  return 'QUERY';
}

function isWriterRoute(routeId: BusinessRouteId): boolean {
  return isManagementRoute(routeId) || routeId === 'RECOGNITION_ATTEMPT';
}

function isNewWriteRoute(
  routeId: BusinessRouteId,
  retryMode: BusinessRouteRetryMode,
): boolean {
  return isManagementRoute(routeId)
    || (routeId === 'RECOGNITION_ATTEMPT' && retryMode === 'NORMAL');
}

function isManagementRoute(routeId: BusinessRouteId): boolean {
  return routeId === 'QUALIFICATION_CREATE'
    || routeId === 'QUALIFICATION_UPDATE'
    || routeId === 'QUALIFICATION_REVOKE';
}

function isQueryRoute(routeId: BusinessRouteId): boolean {
  return routeId === 'QUALIFICATION_LIST'
    || routeId === 'QUALIFICATION_INSIDE_LIST'
    || routeId === 'QUALIFICATION_DETAIL'
    || routeId === 'EVENT_LIST'
    || routeId === 'EVENT_DETAIL';
}

function isRelatedWrite(routeId: BusinessRouteId): boolean {
  return isManagementRoute(routeId) || routeId === 'RECOGNITION_ATTEMPT';
}

function workContext(context: WriteOperationContext): AdmissionWorkContext {
  return Object.freeze({
    operationId: context.operationId,
    receivedAtMs: context.receivedAtMs,
    sequence: context.sequence,
  });
}

function recognitionProgressPlan(
  externalEventId: string,
  receivedAtMs: number,
  stage: 'RUNNING' | 'PAUSED_UNKNOWN',
  issueBusiness: (status: 202, payload: Readonly<Record<string, unknown>>) => HttpResponsePlan,
): HttpResponsePlan {
  const receivedAt = new Date(receivedAtMs);
  if (Number.isNaN(receivedAt.getTime())) {
    throw new TypeError('recognition receivedAt is outside the UTC date range');
  }
  return issueBusiness(202, Object.freeze({
    externalEventId,
    receivedAt: receivedAt.toISOString(),
    stage,
    confirmationState: 'NOT_STARTED',
    control: 'NONE',
  }));
}

function ratesafeAncillary(
  acquire: () => AncillaryAdmissionLease | null,
): () => AncillaryAdmissionLease | null {
  return (): AncillaryAdmissionLease | null => {
    try { return acquire(); } catch { return null; }
  };
}

function writeImmediateResponse(
  response: NarrowHttpResponse,
  plan: HttpResponsePlan,
  render: (plan: HttpResponsePlan) => Readonly<{
    readonly status: number;
    readonly body: string;
    readonly byteLength: number;
    readonly headers: Readonly<{ readonly contentType: string; readonly cacheControl: string }>;
  }>,
): void {
  if (response.writableEnded === true || response.destroyed === true) return;
  try {
    const rendered = render(plan);
    response.statusCode = rendered.status;
    response.setHeader('Content-Type', rendered.headers.contentType);
    response.setHeader('Content-Length', rendered.byteLength);
    response.setHeader('Cache-Control', rendered.headers.cacheControl);
    response.end(rendered.body);
  } catch {
    // No owner or admitted work exists on these synchronous rejection paths.
  }
}

function assertOptions(
  options: G07bAdmissionHandlerOptions,
  validator: AdmissionValidatorPort,
  work: AdmissionWorkPort,
  validatorValidate: unknown,
  loginWork: unknown,
  queryWork: unknown,
  managementWork: unknown,
  recognitionWork: unknown,
): void {
  if (!isObject(options)
    || typeof options.currentDatasetEpoch !== 'string'
    || !UUID_V4.test(options.currentDatasetEpoch)
    || !isObject(options.registry)
    || !isObject(options.registryCapabilities)
    || !isObject(options.responsePlans)
    || !isObject(validator) || typeof validatorValidate !== 'function'
    || !isObject(work)
    || typeof loginWork !== 'function'
    || typeof queryWork !== 'function'
    || typeof managementWork !== 'function'
    || typeof recognitionWork !== 'function'
    || !isObject(options.unknownRecognition)
    || (options.wallClock !== undefined && !isObject(options.wallClock))
    || (options.monotonicClock !== undefined && !isObject(options.monotonicClock))
    || (options.writerQuiescence !== undefined && !isWriterQuiescencePort(options.writerQuiescence))) {
    throw new TypeError('invalid G07b admission handler options');
  }
}

function captureOptions(options: G07bAdmissionHandlerOptions): G07bAdmissionHandlerOptions {
  return Object.freeze({
    currentDatasetEpoch: captureConstructionProperty(options, 'currentDatasetEpoch', 'G07b options'),
    registry: captureConstructionProperty(options, 'registry', 'G07b options'),
    registryCapabilities: captureConstructionProperty(options, 'registryCapabilities', 'G07b options'),
    responsePlans: captureConstructionProperty(options, 'responsePlans', 'G07b options'),
    workHandoff: captureConstructionProperty(options, 'workHandoff', 'G07b options'),
    validator: captureConstructionProperty(options, 'validator', 'G07b options'),
    work: captureConstructionProperty(options, 'work', 'G07b options'),
    unknownRecognition: captureConstructionProperty(options, 'unknownRecognition', 'G07b options'),
    wallClock: captureOptionalConstructionProperty(options, 'wallClock', 'G07b options'),
    monotonicClock: captureOptionalConstructionProperty(options, 'monotonicClock', 'G07b options'),
    resources: captureOptionalConstructionProperty(options, 'resources', 'G07b options'),
    rates: captureOptionalConstructionProperty(options, 'rates', 'G07b options'),
    writerQuiescence: captureOptionalConstructionProperty(options, 'writerQuiescence', 'G07b options'),
    writerPermission: captureOptionalConstructionProperty(options, 'writerPermission', 'G07b options'),
  }) as G07bAdmissionHandlerOptions;
}

function recordString(value: Readonly<Record<string, unknown>>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string') throw new TypeError('invalid trusted result');
  return result;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  allowAdditionalKeys = false,
): Readonly<Record<string, unknown>> {
  if (!isObject(value) || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError('trusted result must be a non-proxy record');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('trusted result must be a plain record');
  }
  const keys = Reflect.ownKeys(value);
  if ((!allowAdditionalKeys && keys.length !== expectedKeys.length)
    || expectedKeys.some((key) => !keys.includes(key))
    || keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('trusted result has non-canonical keys');
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError('trusted result has a symbol key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('trusted result properties must be enumerable data properties');
    }
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function assertCanonicalOpaque(value: object, label: string): void {
  if (utilTypes.isProxy(value) || !Object.isFrozen(value) || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(`${label} must be an opaque frozen capability`);
  }
}

function assertNonempty(value: string): void {
  if (value.length === 0) throw new TypeError('trusted identity is empty');
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
