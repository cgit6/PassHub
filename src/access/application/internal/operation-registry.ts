/**
 * Process-local operation registry for recognition idempotency.
 *
 * This primitive deliberately knows nothing about HTTP, MongoDB, admission
 * pools, or driver retries.  Trusted composition code supplies opaque
 * capabilities and references; the registry only owns identity, capacity,
 * lifecycle, and late-callback fences.
 */

export type OperationRegistryState =
  | 'IN_FLIGHT'
  | 'UNKNOWN'
  | 'CANONICAL'
  | 'SAFE_TECHNICAL_TERMINAL';

export type WriteRunClaimDisposition = 'WRITABLE' | 'READ_ONLY' | 'STALE';

export type OperationRegistryErrorCode =
  | 'REGISTRY_FROZEN'
  | 'REENTRANT'
  | 'TRUSTED_DEPENDENCY_FAILURE'
  | 'WRITE_NOT_ALLOWED'
  | 'DATASET_EPOCH_MISMATCH'
  | 'REGISTRY_CAPACITY_EXHAUSTED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CAPABILITY'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_NOT_MUTABLE'
  | 'INVALID_LEASE'
  | 'STALE_LEASE'
  | 'LEASE_ALREADY_USED'
  | 'INVALID_PERMIT'
  | 'STALE_PERMIT'
  | 'PERMIT_ALREADY_USED'
  | 'CONTINUATION_ALREADY_AUTHORIZED';

export class OperationRegistryError extends Error {
  readonly code: OperationRegistryErrorCode;
  readonly registryId: string;

  constructor(
    code: OperationRegistryErrorCode,
    registryId: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OperationRegistryError';
    this.code = code;
    this.registryId = registryId;
  }
}

declare const capabilityIssuerBrand: unique symbol;
declare const registryKeyBrand: unique symbol;
declare const comparisonArtifactBrand: unique symbol;
declare const resultReferenceBrand: unique symbol;
declare const writeRunClaimBrand: unique symbol;

export interface OperationRegistryKey {
  readonly [registryKeyBrand]: never;
}

export interface OperationComparisonArtifact {
  readonly [comparisonArtifactBrand]: never;
}

export interface OperationResultReference {
  readonly [resultReferenceBrand]: never;
}

export interface OperationWriteRunClaim {
  readonly [writeRunClaimBrand]: never;
}

export interface OperationRegistryCapabilityIssuerOptions {
  readonly registryId: string;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerId: string;
  readonly sameArtifact: (existing: unknown, candidate: unknown) => boolean;
}

/**
 * Composition-only issuer.  Every returned value is a frozen empty token;
 * payload and provenance live solely in module-private WeakMaps.
 */
export interface OperationRegistryCapabilityIssuer {
  readonly [capabilityIssuerBrand]: never;
  issueKey(sourceId: string, externalEventId: string): OperationRegistryKey;
  issueComparisonArtifact(identity: object): OperationComparisonArtifact;
  issueResultReference(): OperationResultReference;
  issueWriteRunClaim(disposition: WriteRunClaimDisposition): OperationWriteRunClaim;
}

/** Trusted callbacks must be synchronous and return exactly the documented value. */
export interface OperationRegistryOptions {
  readonly capabilities: OperationRegistryCapabilityIssuer;
  readonly writeRunClaim: OperationWriteRunClaim;
  readonly assertOwnerCurrent: () => unknown;
  readonly assertContinuationEvidence: (evidence: unknown) => unknown;
  readonly capacity?: number;
}

declare const executionLeaseBrand: unique symbol;
declare const confirmationLeaseBrand: unique symbol;
declare const continuationPermitBrand: unique symbol;

export interface OperationExecutionLease {
  readonly [executionLeaseBrand]: never;
  readonly generation: number;
}

export interface OperationConfirmationLease {
  readonly [confirmationLeaseBrand]: never;
  readonly generation: number;
}

export interface OperationContinuationPermit {
  readonly [continuationPermitBrand]: never;
  readonly generation: number;
}

export interface OperationRegistryEntryView {
  readonly datasetEpoch: string;
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly state: OperationRegistryState;
  readonly generation: number;
  readonly processRunId: string;
  readonly ownerId: string;
}

export type OperationRegistration =
  | {
      readonly kind: 'REGISTERED';
      readonly entry: OperationRegistryEntryView;
      readonly lease: OperationExecutionLease;
    }
  | {
      readonly kind: 'JOINED';
      readonly entry: OperationRegistryEntryView;
    }
  | {
      readonly kind: 'REPLAY_CANONICAL';
      readonly entry: OperationRegistryEntryView;
      readonly resultReference: OperationResultReference;
    }
  | {
      readonly kind: 'REPLAY_SAFE_TECHNICAL_TERMINAL';
      readonly entry: OperationRegistryEntryView;
      readonly resultReference: OperationResultReference;
    };

export type ExistingOperationLookup =
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'NOT_PROVEN' }
  | Exclude<OperationRegistration, { readonly kind: 'REGISTERED' }>;

type ExistingOperationHit = Exclude<
  OperationRegistration,
  { readonly kind: 'REGISTERED' }
>;

export interface OperationRegistrySnapshot {
  readonly registryId: string;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerId: string;
  readonly claimDisposition: WriteRunClaimDisposition;
  readonly capacity: number;
  readonly size: number;
  readonly frozen: boolean;
}

export interface OperationRegistry {
  register(key: OperationRegistryKey, artifact: OperationComparisonArtifact): OperationRegistration;
  lookupExisting(key: OperationRegistryKey, artifact: OperationComparisonArtifact): ExistingOperationLookup;
  markUnknown(lease: OperationExecutionLease): OperationConfirmationLease;
  completeCanonical(
    lease: OperationExecutionLease | OperationConfirmationLease,
    resultReference: OperationResultReference,
  ): void;
  completeSafeTechnicalTerminal(
    lease: OperationExecutionLease | OperationConfirmationLease,
    resultReference: OperationResultReference,
  ): void;
  authorizeContinuation(
    lease: OperationConfirmationLease,
    evidence: object,
  ): OperationContinuationPermit;
  resumeUnknown(
    lease: OperationConfirmationLease,
    permit: OperationContinuationPermit,
  ): OperationExecutionLease;
  snapshot(): OperationRegistrySnapshot;
}

const DEFAULT_CAPACITY = 4_096;

interface Entry {
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly artifact: OperationComparisonArtifact;
  state: OperationRegistryState;
  generation: number;
  resultReference: OperationResultReference | null;
  continuationAuthorized: boolean;
}

interface LeaseState {
  readonly registry: object;
  readonly entry: Entry;
  readonly generation: number;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerId: string;
  readonly kind: 'EXECUTION' | 'CONFIRMATION';
  active: boolean;
}

interface PermitState {
  readonly registry: object;
  readonly entry: Entry;
  readonly generation: number;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerId: string;
  active: boolean;
}

interface CapabilityIssuerState {
  readonly issuer: object;
  readonly registryId: string;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerId: string;
  readonly sameArtifact: (existing: unknown, candidate: unknown) => boolean;
}

interface RegistryKeyState {
  readonly issuer: CapabilityIssuerState;
  readonly sourceId: string;
  readonly externalEventId: string;
}

interface ComparisonArtifactState {
  readonly issuer: CapabilityIssuerState;
  readonly identity: object;
}

interface ResultReferenceState {
  readonly issuer: CapabilityIssuerState;
}

interface WriteRunClaimState {
  readonly issuer: CapabilityIssuerState;
  readonly disposition: WriteRunClaimDisposition;
}

const capabilityIssuers = new WeakMap<object, CapabilityIssuerState>();
const registryKeys = new WeakMap<object, RegistryKeyState>();
const comparisonArtifacts = new WeakMap<object, ComparisonArtifactState>();
const resultReferences = new WeakMap<object, ResultReferenceState>();
const writeRunClaims = new WeakMap<object, WriteRunClaimState>();

export function createOperationRegistryCapabilityIssuer(
  options: OperationRegistryCapabilityIssuerOptions,
): OperationRegistryCapabilityIssuer {
  assertCapabilityIssuerOptions(options);
  const issuer = Object.freeze({
    issueKey(sourceId: string, externalEventId: string): OperationRegistryKey {
      assertNonemptyString(sourceId, 'source ID');
      assertNonemptyString(externalEventId, 'external event ID');
      const token = Object.freeze({}) as OperationRegistryKey;
      registryKeys.set(token, { issuer: state, sourceId, externalEventId });
      return token;
    },

    issueComparisonArtifact(identity: object): OperationComparisonArtifact {
      assertOpaqueObject(identity, 'comparison artifact identity');
      if (!Object.isFrozen(identity)) {
        throw new TypeError('comparison artifact identity must be frozen');
      }
      const token = Object.freeze({}) as OperationComparisonArtifact;
      comparisonArtifacts.set(token, { issuer: state, identity });
      return token;
    },

    issueResultReference(): OperationResultReference {
      const token = Object.freeze({}) as OperationResultReference;
      resultReferences.set(token, { issuer: state });
      return token;
    },

    issueWriteRunClaim(disposition: WriteRunClaimDisposition): OperationWriteRunClaim {
      if (!isClaimDisposition(disposition)) {
        throw new TypeError('write-run claim disposition is invalid');
      }
      const token = Object.freeze({}) as OperationWriteRunClaim;
      writeRunClaims.set(token, { issuer: state, disposition });
      return token;
    },
  }) as OperationRegistryCapabilityIssuer;
  const state: CapabilityIssuerState = Object.freeze({
    issuer,
    registryId: options.registryId,
    datasetEpoch: options.datasetEpoch,
    processRunId: options.processRunId,
    ownerId: options.ownerId,
    sameArtifact: options.sameArtifact,
  });
  capabilityIssuers.set(issuer, state);
  return issuer;
}

export function createOperationRegistry(options: OperationRegistryOptions): OperationRegistry {
  assertOptions(options);

  const issuerState = capabilityIssuers.get(options.capabilities);
  if (issuerState === undefined) {
    throw new TypeError('trusted operation registry capability issuer is required');
  }
  const registryId = issuerState.registryId;
  const datasetEpoch = issuerState.datasetEpoch;
  const processRunId = issuerState.processRunId;
  const ownerId = issuerState.ownerId;
  const claimState = writeRunClaims.get(options.writeRunClaim);
  if (claimState === undefined || claimState.issuer !== issuerState) {
    throw new TypeError('write-run claim was not issued for this registry');
  }
  const assertOwnerCurrent = options.assertOwnerCurrent;
  const sameArtifact = issuerState.sameArtifact;
  const assertContinuationEvidence = options.assertContinuationEvidence;
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const identity = Object.freeze({});

  const entriesBySource = new Map<string, Map<string, Entry>>();
  const executionLeases = new WeakMap<object, LeaseState>();
  const confirmationLeases = new WeakMap<object, LeaseState>();
  const continuationPermits = new WeakMap<object, PermitState>();
  const consumedEvidence = new WeakSet<object>();

  let size = 0;
  let transitioning = false;
  let frozen = false;

  const freeze = (code: 'REENTRANT' | 'TRUSTED_DEPENDENCY_FAILURE', message: string, cause?: unknown): never => {
    frozen = true;
    throw new OperationRegistryError(
      code,
      registryId,
      message,
      cause === undefined ? undefined : { cause },
    );
  };

  const rejectAsyncTrustResult = (result: unknown, label: string): void => {
    if ((typeof result !== 'object' && typeof result !== 'function') || result === null) return;
    let then: unknown;
    try {
      then = (result as { readonly then?: unknown }).then;
    } catch (error: unknown) {
      freeze('TRUSTED_DEPENDENCY_FAILURE', `${label} returned an invalid thenable`, error);
    }
    if (typeof then !== 'function') return;
    try {
      void Promise.resolve(result).catch(() => undefined);
    } catch (error: unknown) {
      freeze('TRUSTED_DEPENDENCY_FAILURE', `${label} returned an invalid thenable`, error);
    }
    freeze('TRUSTED_DEPENDENCY_FAILURE', `${label} must be synchronous`);
  };

  const callTrusted = <T>(label: string, callback: () => T): T => {
    let result!: T;
    try {
      result = callback();
    } catch (error: unknown) {
      // A genuine nested transition freezes before throwing.  Every other
      // callback throw, including a forged exported error with this registry
      // ID, is a trusted-dependency failure and must freeze here.
      if (frozen) throw error;
      freeze('TRUSTED_DEPENDENCY_FAILURE', `${label} failed`, error);
    }
    if (frozen) {
      throw new OperationRegistryError(
        'REGISTRY_FROZEN',
        registryId,
        'operation registry was frozen by a reentrant trusted dependency',
      );
    }
    rejectAsyncTrustResult(result, label);
    return result;
  };

  const claimDisposition = claimState.disposition;

  const assertOwner = (): void => {
    const result = callTrusted('owner fence', assertOwnerCurrent);
    if (result !== undefined) {
      freeze('TRUSTED_DEPENDENCY_FAILURE', 'owner fence must return undefined');
    }
  };

  const transition = <T>(work: () => T): T => {
    if (transitioning) freeze('REENTRANT', 'operation registry transition is reentrant');
    if (frozen) {
      throw new OperationRegistryError(
        'REGISTRY_FROZEN',
        registryId,
        'operation registry is permanently frozen',
      );
    }
    transitioning = true;
    try {
      return work();
    } finally {
      transitioning = false;
    }
  };

  const requireKey = (key: OperationRegistryKey): RegistryKeyState => {
    if (!isObject(key)) throw localError('INVALID_CAPABILITY', 'operation registry key is invalid');
    const state = registryKeys.get(key);
    if (state === undefined) {
      throw localError('INVALID_CAPABILITY', 'operation registry key has no trusted provenance');
    }
    if (state.issuer !== issuerState) {
      throw localError('DATASET_EPOCH_MISMATCH', 'operation key was issued for another registry epoch');
    }
    return state;
  };

  const requireArtifact = (artifact: OperationComparisonArtifact): ComparisonArtifactState => {
    if (!isObject(artifact)) throw localError('INVALID_CAPABILITY', 'comparison artifact is invalid');
    const state = comparisonArtifacts.get(artifact);
    if (state === undefined || state.issuer !== issuerState) {
      throw localError('INVALID_CAPABILITY', 'comparison artifact has no provenance for this registry');
    }
    return state;
  };

  const requireResultReference = (reference: OperationResultReference): void => {
    if (!isObject(reference)) throw localError('INVALID_CAPABILITY', 'result reference is invalid');
    const state = resultReferences.get(reference);
    if (state === undefined || state.issuer !== issuerState) {
      throw localError('INVALID_CAPABILITY', 'result reference has no provenance for this registry');
    }
  };

  const findEntry = (key: RegistryKeyState): Entry | undefined =>
    entriesBySource.get(key.sourceId)?.get(key.externalEventId);

  const compareArtifact = (entry: Entry, candidate: OperationComparisonArtifact): void => {
    const existingState = comparisonArtifacts.get(entry.artifact);
    const candidateState = requireArtifact(candidate);
    if (existingState === undefined || existingState.issuer !== issuerState) {
      freeze('TRUSTED_DEPENDENCY_FAILURE', 'stored comparison artifact lost its provenance');
    }
    const trustedExistingState = existingState as ComparisonArtifactState;
    const result = callTrusted('artifact equality verifier', () =>
      sameArtifact(trustedExistingState.identity, candidateState.identity),
    );
    if (typeof result !== 'boolean') {
      freeze('TRUSTED_DEPENDENCY_FAILURE', 'artifact equality verifier must return a boolean');
    }
    if (!result) {
      throw localError('IDEMPOTENCY_CONFLICT', 'idempotency key was reused with different content');
    }
  };

  const entryView = (entry: Entry): OperationRegistryEntryView => Object.freeze({
    datasetEpoch,
    sourceId: entry.sourceId,
    externalEventId: entry.externalEventId,
    state: entry.state,
    generation: entry.generation,
    processRunId,
    ownerId,
  });

  const existingResult = (entry: Entry): ExistingOperationHit => {
    const view = entryView(entry);
    if (entry.state === 'CANONICAL') {
      if (entry.resultReference === null) {
        freeze('TRUSTED_DEPENDENCY_FAILURE', 'canonical entry has no result reference');
      }
      const resultReference = entry.resultReference as OperationResultReference;
      return Object.freeze({
        kind: 'REPLAY_CANONICAL',
        entry: view,
        resultReference,
      });
    }
    if (entry.state === 'SAFE_TECHNICAL_TERMINAL') {
      if (entry.resultReference === null) {
        freeze('TRUSTED_DEPENDENCY_FAILURE', 'technical terminal entry has no result reference');
      }
      const resultReference = entry.resultReference as OperationResultReference;
      return Object.freeze({
        kind: 'REPLAY_SAFE_TECHNICAL_TERMINAL',
        entry: view,
        resultReference,
      });
    }
    return Object.freeze({ kind: 'JOINED', entry: view });
  };

  const mintExecutionLease = (entry: Entry): OperationExecutionLease => {
    const lease = Object.freeze({ generation: entry.generation }) as OperationExecutionLease;
    executionLeases.set(lease, {
      registry: identity,
      entry,
      generation: entry.generation,
      datasetEpoch,
      processRunId,
      ownerId,
      kind: 'EXECUTION',
      active: true,
    });
    return lease;
  };

  const mintConfirmationLease = (entry: Entry): OperationConfirmationLease => {
    const lease = Object.freeze({ generation: entry.generation }) as OperationConfirmationLease;
    confirmationLeases.set(lease, {
      registry: identity,
      entry,
      generation: entry.generation,
      datasetEpoch,
      processRunId,
      ownerId,
      kind: 'CONFIRMATION',
      active: true,
    });
    return lease;
  };

  const requireLease = (
    lease: OperationExecutionLease | OperationConfirmationLease,
  ): LeaseState => {
    if (!isObject(lease)) throw localError('INVALID_LEASE', 'operation lease is invalid');
    const state = executionLeases.get(lease) ?? confirmationLeases.get(lease);
    if (state === undefined || state.registry !== identity) {
      throw localError('INVALID_LEASE', 'operation lease belongs to another registry');
    }
    if (!state.active) throw localError('LEASE_ALREADY_USED', 'operation lease is no longer active');
    if (
      state.datasetEpoch !== datasetEpoch ||
      state.processRunId !== processRunId ||
      state.ownerId !== ownerId ||
      state.generation !== state.entry.generation
    ) {
      state.active = false;
      throw localError('STALE_LEASE', 'operation lease is stale');
    }
    return state;
  };

  const requireExecutionLease = (lease: OperationExecutionLease): LeaseState => {
    const state = requireLease(lease);
    if (state.kind !== 'EXECUTION') throw localError('INVALID_LEASE', 'execution lease is required');
    return state;
  };

  const requireConfirmationLease = (lease: OperationConfirmationLease): LeaseState => {
    const state = requireLease(lease);
    if (state.kind !== 'CONFIRMATION') {
      throw localError('INVALID_LEASE', 'confirmation lease is required');
    }
    return state;
  };

  const finishTerminal = (
    lease: OperationExecutionLease | OperationConfirmationLease,
    state: 'CANONICAL' | 'SAFE_TECHNICAL_TERMINAL',
    resultReference: OperationResultReference,
  ): void => {
    requireResultReference(resultReference);
    const leaseState = requireLease(lease);
    assertOwner();
    if (
      (leaseState.kind === 'EXECUTION' && leaseState.entry.state !== 'IN_FLIGHT') ||
      (leaseState.kind === 'CONFIRMATION' && leaseState.entry.state !== 'UNKNOWN')
    ) {
      throw localError('ENTRY_NOT_MUTABLE', 'entry state does not accept this callback');
    }
    leaseState.active = false;
    leaseState.entry.continuationAuthorized = false;
    leaseState.entry.resultReference = resultReference;
    leaseState.entry.state = state;
  };

  const localError = (code: OperationRegistryErrorCode, message: string): OperationRegistryError =>
    new OperationRegistryError(code, registryId, message);

  const makeSnapshot = (): OperationRegistrySnapshot => Object.freeze({
    registryId,
    datasetEpoch,
    processRunId,
    ownerId,
    claimDisposition,
    capacity,
    size,
    frozen,
  });

  const registry: OperationRegistry = Object.freeze({
    register(
      key: OperationRegistryKey,
      artifact: OperationComparisonArtifact,
    ): OperationRegistration {
      return transition(() => {
        const keyState = requireKey(key);
        requireArtifact(artifact);
        const existing = findEntry(keyState);
        if (existing !== undefined) {
          compareArtifact(existing, artifact);
          return existingResult(existing);
        }
        if (claimDisposition !== 'WRITABLE') {
          throw localError('WRITE_NOT_ALLOWED', 'write-run claim does not allow new operations');
        }
        assertOwner();
        if (size >= capacity) {
          throw localError('REGISTRY_CAPACITY_EXHAUSTED', 'operation registry capacity is exhausted');
        }
        const entry: Entry = {
          sourceId: keyState.sourceId,
          externalEventId: keyState.externalEventId,
          artifact,
          state: 'IN_FLIGHT',
          generation: 1,
          resultReference: null,
          continuationAuthorized: false,
        };
        let sourceEntries = entriesBySource.get(keyState.sourceId);
        if (sourceEntries === undefined) {
          sourceEntries = new Map<string, Entry>();
          entriesBySource.set(keyState.sourceId, sourceEntries);
        }
        sourceEntries.set(keyState.externalEventId, entry);
        size += 1;
        const lease = mintExecutionLease(entry);
        return Object.freeze({ kind: 'REGISTERED', entry: entryView(entry), lease });
      });
    },

    lookupExisting(
      key: OperationRegistryKey,
      artifact: OperationComparisonArtifact,
    ): ExistingOperationLookup {
      return transition(() => {
        const keyState = requireKey(key);
        requireArtifact(artifact);
        const existing = findEntry(keyState);
        if (existing === undefined) {
          return Object.freeze({ kind: claimDisposition === 'WRITABLE' ? 'ABSENT' : 'NOT_PROVEN' });
        }
        compareArtifact(existing, artifact);
        return existingResult(existing);
      });
    },

    markUnknown(lease: OperationExecutionLease): OperationConfirmationLease {
      return transition(() => {
        const leaseState = requireExecutionLease(lease);
        assertOwner();
        if (leaseState.entry.state !== 'IN_FLIGHT') {
          throw localError('ENTRY_NOT_MUTABLE', 'only an in-flight entry can become unknown');
        }
        leaseState.active = false;
        leaseState.entry.state = 'UNKNOWN';
        leaseState.entry.continuationAuthorized = false;
        return mintConfirmationLease(leaseState.entry);
      });
    },

    completeCanonical(
      lease: OperationExecutionLease | OperationConfirmationLease,
      resultReference: OperationResultReference,
    ): void {
      transition(() => finishTerminal(lease, 'CANONICAL', resultReference));
    },

    completeSafeTechnicalTerminal(
      lease: OperationExecutionLease | OperationConfirmationLease,
      resultReference: OperationResultReference,
    ): void {
      transition(() => finishTerminal(lease, 'SAFE_TECHNICAL_TERMINAL', resultReference));
    },

    authorizeContinuation(
      lease: OperationConfirmationLease,
      evidence: object,
    ): OperationContinuationPermit {
      assertOpaqueObject(evidence, 'continuation evidence');
      return transition(() => {
        const leaseState = requireConfirmationLease(lease);
        assertOwner();
        if (leaseState.entry.state !== 'UNKNOWN') {
          throw localError('ENTRY_NOT_MUTABLE', 'only an unknown entry can authorize continuation');
        }
        if (leaseState.entry.continuationAuthorized) {
          throw localError(
            'CONTINUATION_ALREADY_AUTHORIZED',
            'continuation was already authorized for this generation',
          );
        }
        if (consumedEvidence.has(evidence)) {
          throw localError('PERMIT_ALREADY_USED', 'continuation evidence was already consumed');
        }
        const verified = callTrusted('continuation evidence verifier', () =>
          assertContinuationEvidence(evidence),
        );
        if (verified !== undefined) {
          freeze('TRUSTED_DEPENDENCY_FAILURE', 'continuation evidence verifier must return undefined');
        }
        consumedEvidence.add(evidence);
        leaseState.entry.continuationAuthorized = true;
        const permit = Object.freeze({ generation: leaseState.generation }) as OperationContinuationPermit;
        continuationPermits.set(permit, {
          registry: identity,
          entry: leaseState.entry,
          generation: leaseState.generation,
          datasetEpoch,
          processRunId,
          ownerId,
          active: true,
        });
        return permit;
      });
    },

    resumeUnknown(
      lease: OperationConfirmationLease,
      permit: OperationContinuationPermit,
    ): OperationExecutionLease {
      return transition(() => {
        const leaseState = requireConfirmationLease(lease);
        if (!isObject(permit)) throw localError('INVALID_PERMIT', 'continuation permit is invalid');
        const permitState = continuationPermits.get(permit);
        if (permitState === undefined || permitState.registry !== identity) {
          throw localError('INVALID_PERMIT', 'continuation permit belongs to another registry');
        }
        if (!permitState.active) {
          throw localError('PERMIT_ALREADY_USED', 'continuation permit is no longer active');
        }
        if (
          permitState.entry !== leaseState.entry ||
          permitState.generation !== leaseState.generation ||
          permitState.datasetEpoch !== datasetEpoch ||
          permitState.processRunId !== processRunId ||
          permitState.ownerId !== ownerId
        ) {
          permitState.active = false;
          throw localError('STALE_PERMIT', 'continuation permit is stale');
        }
        assertOwner();
        if (leaseState.entry.state !== 'UNKNOWN' || !leaseState.entry.continuationAuthorized) {
          throw localError('ENTRY_NOT_MUTABLE', 'unknown entry is not authorized to resume');
        }
        leaseState.active = false;
        permitState.active = false;
        leaseState.entry.continuationAuthorized = false;
        leaseState.entry.generation += 1;
        leaseState.entry.state = 'IN_FLIGHT';
        return mintExecutionLease(leaseState.entry);
      });
    },

    snapshot(): OperationRegistrySnapshot {
      // A healthy registry treats diagnostic reads like every other state
      // transition so a trusted callback cannot use snapshot() as a reentry
      // escape hatch.  Once frozen, a read-only snapshot remains available for
      // diagnosis and cannot change state.
      return frozen ? makeSnapshot() : transition(makeSnapshot);
    },
  });

  return registry;
}

function assertOptions(options: OperationRegistryOptions): void {
  if (!isObject(options)) throw new TypeError('operation registry options are required');
  assertOpaqueObject(options.capabilities, 'operation registry capability issuer');
  assertOpaqueObject(options.writeRunClaim, 'write-run claim');
  if (typeof options.assertOwnerCurrent !== 'function') {
    throw new TypeError('owner fence is required');
  }
  if (typeof options.assertContinuationEvidence !== 'function') {
    throw new TypeError('continuation evidence verifier is required');
  }
  if (
    options.capacity !== undefined &&
    (!Number.isSafeInteger(options.capacity) || options.capacity < 1 || options.capacity > DEFAULT_CAPACITY)
  ) {
    throw new TypeError(`operation registry capacity must be an integer from 1 to ${DEFAULT_CAPACITY}`);
  }
}

function assertCapabilityIssuerOptions(options: OperationRegistryCapabilityIssuerOptions): void {
  if (!isObject(options)) throw new TypeError('operation registry capability issuer options are required');
  assertNonemptyString(options.registryId, 'registry ID');
  assertNonemptyString(options.datasetEpoch, 'dataset epoch');
  assertNonemptyString(options.processRunId, 'process run ID');
  assertNonemptyString(options.ownerId, 'owner ID');
  if (typeof options.sameArtifact !== 'function') {
    throw new TypeError('artifact equality verifier is required');
  }
}

function assertOpaqueObject(value: unknown, label: string): asserts value is object {
  if (!isObject(value)) throw new TypeError(`${label} must be an opaque object`);
}

function assertNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isClaimDisposition(value: unknown): value is WriteRunClaimDisposition {
  return value === 'WRITABLE' || value === 'READ_ONLY' || value === 'STALE';
}
