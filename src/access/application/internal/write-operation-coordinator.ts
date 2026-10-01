import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { registerTrustedWriteOperationContext } from './operation-budget-binding.js';

export type WriteOperationKind =
  | 'MANAGEMENT_CREATE'
  | 'MANAGEMENT_UPDATE'
  | 'MANAGEMENT_REVOKE'
  | 'RECOGNITION';

export interface TrustedWriteClock {
  nowMs(): number;
}

export interface TrustedWriteMonotonicClock {
  nowMs(): number;
}

export interface WriteOperationRegistrationReceipt {
  readonly operationId: string;
  readonly receivedAtMs: number;
  readonly registeredAtMonotonicMs: number;
  readonly sequence: bigint;
}

export type WriteOperationLifecycleDisposition =
  | 'PRESTART_REJECTED'
  | 'BUSINESS_RESULT_PERSISTED'
  | 'KNOWN_NO_EFFECT'
  | 'UNKNOWN_EFFECT';

export interface WriteOperationLifecycleEvent {
  readonly receipt: WriteOperationRegistrationReceipt;
  readonly disposition: WriteOperationLifecycleDisposition;
}

export interface WriteOperationLifecycleObserver {
  registered?(receipt: WriteOperationRegistrationReceipt): void;
  queued?(receipt: WriteOperationRegistrationReceipt): void;
  started?(receipt: WriteOperationRegistrationReceipt): void;
  blocked?(receipt: WriteOperationRegistrationReceipt): void;
  settled(event: WriteOperationLifecycleEvent): void;
}

export interface WriteOperationOwner {
  assertCurrent(): void;
}

export interface WriteOperationContext {
  readonly operationId: string;
  readonly receivedAtMs: number;
  readonly sequence: bigint;
  readonly owner: WriteOperationOwner;
  assertCurrent(): void;
}

export interface WriteOperationSettlement<TResult> {
  prestartRejected(error: unknown): void;
  businessResultPersisted(result: TResult): void;
  knownNoEffect(error: unknown): void;
  unknownEffect(error: unknown): void;
  /**
   * Records one eligible post-commit transport unknown and returns an opaque
   * lease.  It deliberately does not settle the caller or advance FIFO work:
   * a separate recovery owner must first adopt the lease and make the one
   * terminal decision.
   */
  pausePostCommitUnknown(error: unknown): PostCommitUnknownRecoveryLease;
}

declare const postCommitUnknownRecoveryLeaseBrand: unique symbol;

/**
 * Opaque handoff from the current writer to the internal G10c recovery
 * coordinator.  The lease has no public controls; it is usable only through
 * an owner created for the same coordinator bundle.
 */
export interface PostCommitUnknownRecoveryLease {
  readonly [postCommitUnknownRecoveryLeaseBrand]: never;
}

declare const postCommitUnknownRecoveryOwnerBrand: unique symbol;

/** Internal nominal authority which can adopt one recovery lease. */
export interface PostCommitUnknownRecoveryOwner {
  readonly [postCommitUnknownRecoveryOwnerBrand]: never;
  adopt(lease: PostCommitUnknownRecoveryLease): PostCommitUnknownRecoveryHandle;
}

declare const postCommitUnknownRecoveryHandleBrand: unique symbol;

/**
 * One adopted, still-current operation.  The recovery owner must choose one
 * terminal path: publish the already-persisted result, or fail closed.
 */
export interface PostCommitUnknownRecoveryHandle {
  readonly [postCommitUnknownRecoveryHandleBrand]: never;
  assertCurrent(): void;
  businessResultPersisted(result: unknown): void;
  failClosed(error: unknown): void;
}

export type TrustedWriteExecutor<TInput, TResult> = (
  input: TInput,
  context: WriteOperationContext,
  settlement: WriteOperationSettlement<TResult>,
) => void | PromiseLike<void>;

export interface WriteOperationExecutorChannels<
  TManagementCreateInput = unknown,
  TManagementCreateResult = unknown,
  TManagementUpdateInput = unknown,
  TManagementUpdateResult = unknown,
  TManagementRevokeInput = unknown,
  TManagementRevokeResult = unknown,
  TRecognitionInput = unknown,
  TRecognitionResult = unknown,
> {
  readonly managementCreate: TrustedWriteExecutor<TManagementCreateInput, TManagementCreateResult>;
  readonly managementUpdate: TrustedWriteExecutor<TManagementUpdateInput, TManagementUpdateResult>;
  readonly managementRevoke: TrustedWriteExecutor<TManagementRevokeInput, TManagementRevokeResult>;
  readonly recognition: TrustedWriteExecutor<TRecognitionInput, TRecognitionResult>;
}

export interface WriteOperationCoordinatorOptions<
  TManagementCreateInput = unknown,
  TManagementCreateResult = unknown,
  TManagementUpdateInput = unknown,
  TManagementUpdateResult = unknown,
  TManagementRevokeInput = unknown,
  TManagementRevokeResult = unknown,
  TRecognitionInput = unknown,
  TRecognitionResult = unknown,
> {
  readonly clock: TrustedWriteClock;
  readonly monotonicClock?: TrustedWriteMonotonicClock;
  readonly lifecycleObserver?: WriteOperationLifecycleObserver;
  readonly startGate?: () => boolean;
  readonly executors: WriteOperationExecutorChannels<
    TManagementCreateInput,
    TManagementCreateResult,
    TManagementUpdateInput,
    TManagementUpdateResult,
    TManagementRevokeInput,
    TManagementRevokeResult,
    TRecognitionInput,
    TRecognitionResult
  >;
}

export interface WriteOperationEnqueuePort<TInput, TResult> {
  enqueue(input: TInput): Promise<TResult>;
  registerProvisional(): WriteOperationProvisional<TInput, TResult>;
}

export interface WriteOperationProvisional<TInput, TResult> {
  readonly receipt: WriteOperationRegistrationReceipt;
  readonly completion: Promise<TResult>;
  activate(validatedInput: TInput): void;
  rejectBeforeStart(error: unknown): void;
  /**
   * Returns a one-shot maintenance marker set only while this operation was
   * awaiting validation.  It deliberately does not cancel validation itself.
   */
  consumeMaintenanceValidationCancellation(): boolean;
  /** Finalize a marked, successfully validated operation without writer work. */
  settleMaintenanceKnownNoEffect(error: unknown): void;
}

export interface WriteOperationCoordinatorBundle<
  TManagementCreateInput = unknown,
  TManagementCreateResult = unknown,
  TManagementUpdateInput = unknown,
  TManagementUpdateResult = unknown,
  TManagementRevokeInput = unknown,
  TManagementRevokeResult = unknown,
  TRecognitionInput = unknown,
  TRecognitionResult = unknown,
> {
  readonly managementCreate: WriteOperationEnqueuePort<TManagementCreateInput, TManagementCreateResult>;
  readonly managementUpdate: WriteOperationEnqueuePort<TManagementUpdateInput, TManagementUpdateResult>;
  readonly managementRevoke: WriteOperationEnqueuePort<TManagementRevokeInput, TManagementRevokeResult>;
  readonly recognition: WriteOperationEnqueuePort<TRecognitionInput, TRecognitionResult>;
  /** Wake a drain deferred by the optional start gate. */
  wake(): void;
  /**
   * Internal maintenance-only command.  It settles only already validated,
   * still-queued work; it never touches validation-in-flight or running work.
   */
  settleReadyKnownNoEffect(error: unknown, beforeFinalize?: (input: unknown) => void): void;
  /** Mark only operations that were already awaiting validation. */
  markWaitingValidationMaintenanceCanceled(): void;
}

type Candidate =
  | { readonly kind: 'PRESTART_REJECTED'; readonly error: unknown }
  | { readonly kind: 'BUSINESS_RESULT_PERSISTED'; readonly result: unknown }
  | { readonly kind: 'KNOWN_NO_EFFECT'; readonly error: unknown }
  | { readonly kind: 'UNKNOWN_EFFECT'; readonly error: unknown };

interface Operation {
  readonly kind: WriteOperationKind;
  readonly operationId: string;
  readonly sequence: bigint;
  readonly receivedAtMs: number;
  readonly receipt: WriteOperationRegistrationReceipt;
  readonly executor: TrustedWriteExecutor<unknown, unknown>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  candidate: Candidate | null;
  settlementCount: number;
  invalidSettlement: boolean;
  active: boolean;
  finalized: boolean;
  validationState: 'WAITING_VALIDATION' | 'READY' | 'REJECTED';
  input: unknown;
  prestartError: unknown;
  maintenanceValidationCanceled: boolean;
  recoveryLease: PostCommitUnknownRecoveryLease | null;
  recoveryPhase: 'NONE' | 'REQUESTED' | 'PAUSED' | 'TERMINAL';
}

interface RecoveryLeaseState {
  readonly operation: Operation;
  readonly access: CoordinatorRecoveryAccess;
  adoptedBy: PostCommitUnknownRecoveryOwner | null;
  handle: PostCommitUnknownRecoveryHandle | null;
}

interface CoordinatorRecoveryAccess {
  createOwner(): PostCommitUnknownRecoveryOwner;
}

const coordinatorRecoveryAccesses = new WeakMap<object, CoordinatorRecoveryAccess>();

const allowedKinds = new Set<WriteOperationKind>([
  'MANAGEMENT_CREATE',
  'MANAGEMENT_UPDATE',
  'MANAGEMENT_REVOKE',
  'RECOGNITION',
]);

export function createWriteOperationCoordinatorBundle<
  TManagementCreateInput = unknown,
  TManagementCreateResult = unknown,
  TManagementUpdateInput = unknown,
  TManagementUpdateResult = unknown,
  TManagementRevokeInput = unknown,
  TManagementRevokeResult = unknown,
  TRecognitionInput = unknown,
  TRecognitionResult = unknown,
>(
  options: WriteOperationCoordinatorOptions<
    TManagementCreateInput,
    TManagementCreateResult,
    TManagementUpdateInput,
    TManagementUpdateResult,
    TManagementRevokeInput,
    TManagementRevokeResult,
    TRecognitionInput,
    TRecognitionResult
  >,
): WriteOperationCoordinatorBundle<
  TManagementCreateInput,
  TManagementCreateResult,
  TManagementUpdateInput,
  TManagementUpdateResult,
  TManagementRevokeInput,
  TManagementRevokeResult,
  TRecognitionInput,
  TRecognitionResult
> {
  assertOptions(options);
  // Capture trusted dependencies once. The bundle must not observe mutations to
  // the construction options (including replacement of methods) afterwards.
  const clockNowMs = options.clock.nowMs.bind(options.clock);
  const monotonicNowMs = options.monotonicClock === undefined
    ? performance.now.bind(performance)
    : options.monotonicClock.nowMs.bind(options.monotonicClock);
  const lifecycleSettled = options.lifecycleObserver?.settled.bind(options.lifecycleObserver);
  const lifecycleRegistered = options.lifecycleObserver?.registered?.bind(options.lifecycleObserver);
  const lifecycleQueued = options.lifecycleObserver?.queued?.bind(options.lifecycleObserver);
  const lifecycleStarted = options.lifecycleObserver?.started?.bind(options.lifecycleObserver);
  const lifecycleBlocked = options.lifecycleObserver?.blocked?.bind(options.lifecycleObserver);
  const startGate = options.startGate;
  const capturedExecutors = Object.freeze({
    managementCreate: options.executors.managementCreate,
    managementUpdate: options.executors.managementUpdate,
    managementRevoke: options.executors.managementRevoke,
    recognition: options.executors.recognition,
  });
  const queue: Operation[] = [];
  const issuedOperationIds = new Set<string>();
  let nextSequence = 0n;
  let running = false;
  let drainScheduled = false;
  let deferredByGate = false;
  let blocked = false;
  let current: Operation | null = null;
  const recoveryLeaseStates = new WeakMap<object, RecoveryLeaseState>();

  const assertCurrent = (operation: Operation): void => {
    if (current !== operation || !operation.active || operation.finalized) {
      throw new Error('write operation is not current');
    }
  };

  const requestPostCommitUnknownPause = (operation: Operation, error: unknown): PostCommitUnknownRecoveryLease => {
    assertCurrent(operation);
    if (error === undefined || error === null) {
      throw new TypeError('post-commit unknown pause requires an error');
    }
    if (operation.recoveryPhase !== 'NONE' || operation.settlementCount !== 0 || operation.candidate !== null) {
      throw new Error('post-commit unknown recovery pause was already decided');
    }
    const lease = Object.freeze({}) as PostCommitUnknownRecoveryLease;
    operation.settlementCount = 1;
    operation.candidate = { kind: 'UNKNOWN_EFFECT', error };
    operation.recoveryLease = lease;
    operation.recoveryPhase = 'REQUESTED';
    recoveryLeaseStates.set(lease as object, {
      operation,
      access: recoveryAccess,
      adoptedBy: null,
      handle: null,
    });
    return lease;
  };

  const scheduleDrain = (): void => {
    if (drainScheduled || running || blocked || deferredByGate) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      void drain();
    });
  };

  const recordCandidate = (operation: Operation, candidate: Candidate): void => {
    if (operation.finalized || !operation.active) return;
    operation.settlementCount += 1;
    if (!isLegalCandidate(candidate)) operation.invalidSettlement = true;
    if (operation.settlementCount !== 1) operation.invalidSettlement = true;
    if (operation.candidate === null) operation.candidate = candidate;
  };

  const invokeLifecycleHook = (
    hook: ((receipt: WriteOperationRegistrationReceipt) => void) | undefined,
    receipt: WriteOperationRegistrationReceipt,
  ): void => {
    if (hook === undefined) return;
    const result = hook(receipt);
    rejectAsyncLifecycleResult(result);
    if (result !== undefined) throw new TypeError('write operation lifecycle hook must return undefined');
  };

  const notifyBlocked = (operation: Operation): void => {
    try {
      invokeLifecycleHook(lifecycleBlocked, operation.receipt);
    } catch {
      // There is no safer observer to notify. The coordinator remains blocked.
    }
  };

  const rejectQueued = (error: unknown): void => {
    const queued = queue.splice(0, queue.length);
    for (const operation of queued) {
      if (operation.finalized) continue;
      operation.finalized = true;
      operation.active = false;
      notifyBlocked(operation);
      operation.reject(error);
    }
  };

  const failClosed = (operation: Operation | null, error: unknown): void => {
    blocked = true;
    if (operation !== null && !operation.finalized) {
      const position = queue.indexOf(operation);
      if (position >= 0) queue.splice(position, 1);
      operation.finalized = true;
      operation.active = false;
      operation.recoveryPhase = 'TERMINAL';
      if (current === operation) current = null;
      notifyBlocked(operation);
      operation.reject(error);
    }
    rejectQueued(error);
  };

  const runOperation = async (operation: Operation): Promise<void> => {
    current = operation;
    operation.active = true;
    try {
      invokeLifecycleHook(lifecycleStarted, operation.receipt);
    } catch (error: unknown) {
      failClosed(operation, error);
      return;
    }
    const owner: WriteOperationOwner = Object.freeze({
      assertCurrent: () => assertCurrent(operation),
    });
    const context: WriteOperationContext = Object.freeze({
      operationId: operation.operationId,
      receivedAtMs: operation.receivedAtMs,
      sequence: operation.sequence,
      owner,
      assertCurrent: owner.assertCurrent,
    });
    registerTrustedWriteOperationContext(context);
    const settlement: WriteOperationSettlement<unknown> = Object.freeze({
      prestartRejected: (error: unknown) => recordCandidate(operation, { kind: 'PRESTART_REJECTED', error }),
      businessResultPersisted: (result: unknown) => recordCandidate(operation, { kind: 'BUSINESS_RESULT_PERSISTED', result }),
      knownNoEffect: (error: unknown) => recordCandidate(operation, { kind: 'KNOWN_NO_EFFECT', error }),
      unknownEffect: (error: unknown) => recordCandidate(operation, { kind: 'UNKNOWN_EFFECT', error }),
      pausePostCommitUnknown: (error: unknown) => requestPostCommitUnknownPause(operation, error),
    });

    let executionFailed = false;
    let executionError: unknown;
    try {
      await operation.executor(operation.input, context, settlement);
    } catch (error: unknown) {
      executionFailed = true;
      executionError = error;
    }

    if (operation.recoveryPhase === 'REQUESTED') {
      if (executionFailed || operation.settlementCount !== 1 || operation.invalidSettlement
        || operation.candidate?.kind !== 'UNKNOWN_EFFECT' || operation.recoveryLease === null) {
        finalizeUnknown(operation, executionError ?? new Error('post-commit unknown recovery pause is invalid'));
        return;
      }
      operation.recoveryPhase = 'PAUSED';
      blocked = true;
      return;
    }

    if (executionFailed || operation.settlementCount !== 1 || operation.invalidSettlement || operation.candidate === null) {
      finalizeUnknown(operation, executionError ?? new Error('write operation completed without one legal settlement'));
      return;
    }
    finalize(operation, operation.candidate);
  };

  const notifyLifecycle = (
    operation: Operation,
    disposition: WriteOperationLifecycleDisposition,
  ): boolean => {
    if (lifecycleSettled === undefined) return true;
    try {
      const result = lifecycleSettled(Object.freeze({
        receipt: operation.receipt,
        disposition,
      }));
      rejectAsyncLifecycleResult(result);
      if (result !== undefined) throw new TypeError('write operation lifecycle observer must return undefined');
      return true;
    } catch {
      blocked = true;
      notifyBlocked(operation);
      operation.reject(new Error('write operation lifecycle observer failed'));
      rejectQueued(new Error('write operation lifecycle observer failed'));
      return false;
    }
  };

  const finalizeUnknown = (operation: Operation, error: unknown): void => {
    if (operation.finalized) return;
    operation.finalized = true;
    operation.active = false;
    operation.recoveryPhase = 'TERMINAL';
    blocked = true;
    if (current === operation) current = null;
    const rejection = error ?? new Error('write operation has unknown effect');
    if (!notifyLifecycle(operation, 'UNKNOWN_EFFECT')) {
      rejectQueued(rejection);
      return;
    }
    operation.reject(rejection);
    rejectQueued(rejection);
  };

  const finalize = (operation: Operation, candidate: Candidate): void => {
    if (operation.finalized) return;
    operation.finalized = true;
    operation.active = false;
    operation.recoveryPhase = 'TERMINAL';
    if (candidate.kind === 'UNKNOWN_EFFECT') blocked = true;
    if (current === operation) current = null;
    if (!notifyLifecycle(operation, candidate.kind)) {
      rejectQueued(candidateError(candidate) ?? new Error('write operation lifecycle observer failed'));
      return;
    }
    switch (candidate.kind) {
      case 'BUSINESS_RESULT_PERSISTED':
        operation.resolve(candidate.result);
        return;
      case 'UNKNOWN_EFFECT':
        operation.reject(candidate.error);
        rejectQueued(candidate.error);
        return;
      case 'PRESTART_REJECTED':
      case 'KNOWN_NO_EFFECT':
        operation.reject(candidate.error);
    }
  };

  // Maintenance uses a narrower terminal path than ordinary coordinator
  // failure handling.  A broken lifecycle observer must surface to the caller
  // (so RuntimeControl can become INTERNAL_UNAVAILABLE), but must not convert
  // unrelated READY / WAITING_VALIDATION operations into rejected or UNKNOWN
  // work by invoking the coordinator-wide fail-closed queue path.
  const finalizeMaintenanceKnownNoEffect = (operation: Operation, error: unknown): void => {
    if (operation.finalized) return;
    operation.finalized = true;
    operation.active = false;
    operation.recoveryPhase = 'TERMINAL';
    if (current === operation) current = null;
    try {
      if (lifecycleSettled !== undefined) {
        const result = lifecycleSettled(Object.freeze({
          receipt: operation.receipt,
          disposition: 'KNOWN_NO_EFFECT' as const,
        }));
        rejectAsyncLifecycleResult(result);
        if (result !== undefined) throw new TypeError('write operation lifecycle observer must return undefined');
      }
    } catch (lifecycleError: unknown) {
      operation.reject(lifecycleError);
      throw lifecycleError;
    }
    operation.reject(error);
  };

  const finalizeRecoveredBusinessResult = (operation: Operation, result: unknown): void => {
    if (result === undefined) throw new TypeError('post-commit unknown recovery result must be defined');
    if (operation.recoveryPhase !== 'PAUSED') {
      throw new Error('post-commit unknown recovery operation is not paused');
    }
    assertCurrent(operation);
    operation.finalized = true;
    operation.active = false;
    operation.recoveryPhase = 'TERMINAL';
    current = null;
    if (!notifyLifecycle(operation, 'BUSINESS_RESULT_PERSISTED')) return;
    operation.resolve(result);
  };

  const recoveryAccess: CoordinatorRecoveryAccess = Object.freeze({
    createOwner(): PostCommitUnknownRecoveryOwner {
      let owner!: PostCommitUnknownRecoveryOwner;
      owner = Object.freeze({
        adopt(this: unknown, lease: PostCommitUnknownRecoveryLease): PostCommitUnknownRecoveryHandle {
          if (this !== owner) throw new TypeError('post-commit unknown recovery owner is foreign');
          if ((typeof lease !== 'object' && typeof lease !== 'function') || lease === null) {
            throw new TypeError('post-commit unknown recovery lease is invalid');
          }
          const leaseState = recoveryLeaseStates.get(lease as object);
          if (leaseState === undefined || leaseState.access !== recoveryAccess) {
            throw new TypeError('post-commit unknown recovery lease is foreign or forged');
          }
          const operation = leaseState.operation;
          if (leaseState.adoptedBy !== null || leaseState.handle !== null) {
            throw new Error('post-commit unknown recovery lease was already adopted');
          }
          if (operation.recoveryPhase !== 'PAUSED' || operation.recoveryLease !== lease) {
            throw new Error('post-commit unknown recovery lease is not paused');
          }
          assertCurrent(operation);

          let handle!: PostCommitUnknownRecoveryHandle;
          const assertHandleCurrent = (): void => {
            if (leaseState.adoptedBy !== owner || leaseState.handle !== handle) {
              throw new Error('post-commit unknown recovery handle is stale');
            }
            if (operation.recoveryPhase !== 'PAUSED' || operation.recoveryLease !== lease) {
              throw new Error('post-commit unknown recovery operation is not paused');
            }
            assertCurrent(operation);
          };
          handle = Object.freeze({
            assertCurrent(this: unknown): void {
              if (this !== handle) throw new TypeError('post-commit unknown recovery handle is foreign');
              assertHandleCurrent();
            },
            businessResultPersisted(this: unknown, result: unknown): void {
              if (this !== handle) throw new TypeError('post-commit unknown recovery handle is foreign');
              assertHandleCurrent();
              finalizeRecoveredBusinessResult(operation, result);
            },
            failClosed(this: unknown, error: unknown): void {
              if (this !== handle) throw new TypeError('post-commit unknown recovery handle is foreign');
              if (error === undefined || error === null) {
                throw new TypeError('post-commit unknown recovery failure requires an error');
              }
              assertHandleCurrent();
              finalizeUnknown(operation, error);
            },
          }) as PostCommitUnknownRecoveryHandle;
          leaseState.adoptedBy = owner;
          leaseState.handle = handle;
          return handle;
        },
      }) as PostCommitUnknownRecoveryOwner;
      return owner;
    },
  });

  async function drain(): Promise<void> {
    if (running || blocked) return;
    running = true;
    try {
      while (!blocked) {
        const operation = queue[0];
        if (operation === undefined) return;
        if (operation.validationState === 'WAITING_VALIDATION') return;
        if (startGate !== undefined) {
          let allowed: boolean;
          try {
            const result = startGate();
            rejectAsyncLifecycleResult(result);
            if (typeof result !== 'boolean') throw new TypeError('write operation start gate must return boolean');
            allowed = result;
          } catch (error: unknown) {
            failClosed(operation, error);
            return;
          }
          if (!allowed) {
            deferredByGate = true;
            return;
          }
        }
        queue.shift();
        if (operation.validationState === 'REJECTED') {
          finalize(operation, { kind: 'PRESTART_REJECTED', error: operation.prestartError });
          continue;
        }
        await runOperation(operation);
      }
    } finally {
      running = false;
      const head = queue[0];
      if (!blocked && !deferredByGate && head?.validationState === 'READY') scheduleDrain();
    }
  }

  const registerProvisional = <TInput, TResult>(
    kind: WriteOperationKind,
    executor: TrustedWriteExecutor<TInput, TResult>,
  ): WriteOperationProvisional<TInput, TResult> => {
    if (!allowedKinds.has(kind)) throw new TypeError('unsupported write operation kind');
    if (blocked) throw new Error('write operation coordinator is blocked by unknown effect');
    const receivedAtMs = clockNowMs();
    if (!Number.isSafeInteger(receivedAtMs)) throw new TypeError('trusted write clock must return a safe integer');
    const registeredAtMonotonicMs = monotonicNowMs();
    if (!Number.isFinite(registeredAtMonotonicMs) || registeredAtMonotonicMs < 0) {
      throw new TypeError('trusted monotonic clock must return a finite non-negative number');
    }
    const operationId = createUniqueOperationId(issuedOperationIds);
    const sequence = nextSequence;
    const receipt: WriteOperationRegistrationReceipt = Object.freeze({
      operationId,
      receivedAtMs,
      registeredAtMonotonicMs,
      sequence,
    });
    let resolvePromise: (result: TResult) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<TResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // A lifecycle failure can reject this completion before a provisional
    // handle is returned; attach a sink so that fail-closed never creates an
    // unhandled rejection for an inaccessible handle.
    void promise.catch(() => undefined);
    const operation: Operation = {
      kind,
      operationId,
      sequence,
      receivedAtMs,
      receipt,
      input: undefined,
      executor: executor as TrustedWriteExecutor<unknown, unknown>,
      resolve: resolvePromise as (result: unknown) => void,
      reject: rejectPromise,
      candidate: null,
      settlementCount: 0,
      invalidSettlement: false,
      active: false,
      finalized: false,
      validationState: 'WAITING_VALIDATION',
      prestartError: undefined,
      maintenanceValidationCanceled: false,
      recoveryLease: null,
      recoveryPhase: 'NONE',
    };
    queue.push(operation);
    issuedOperationIds.add(operationId);
    try {
      invokeLifecycleHook(lifecycleRegistered, receipt);
    } catch (error: unknown) {
      failClosed(operation, error);
      throw new LifecycleHookFailure(error);
    }
    nextSequence += 1n;
    scheduleDrain();
    let decided = false;
    const provisional: WriteOperationProvisional<TInput, TResult> = Object.freeze({
      receipt,
      completion: promise,
      activate(validatedInput: TInput): void {
        if (decided) throw new Error('provisional write operation was already decided');
        decided = true;
        operation.input = validatedInput;
        operation.validationState = 'READY';
        try {
          invokeLifecycleHook(lifecycleQueued, operation.receipt);
        } catch (error: unknown) {
          failClosed(operation, error);
          throw error;
        }
        scheduleDrain();
      },
      rejectBeforeStart(error: unknown): void {
        if (decided) throw new Error('provisional write operation was already decided');
        if (error === undefined || error === null) {
          throw new TypeError('prestart rejection requires an error');
        }
        decided = true;
        operation.prestartError = error;
        operation.validationState = 'REJECTED';
        const position = queue.indexOf(operation);
        if (position < 0) {
          throw new Error('provisional write operation is no longer queued');
        }
        queue.splice(position, 1);
        finalize(operation, { kind: 'PRESTART_REJECTED', error });
        const head = queue[0];
        if (!blocked && head?.validationState === 'READY') scheduleDrain();
      },
      consumeMaintenanceValidationCancellation(): boolean {
        if (!operation.maintenanceValidationCanceled) return false;
        operation.maintenanceValidationCanceled = false;
        return true;
      },
      settleMaintenanceKnownNoEffect(error: unknown): void {
        if (decided) throw new Error('provisional write operation was already decided');
        if (error === undefined || error === null) throw new TypeError('maintenance settlement requires an error');
        decided = true;
        const position = queue.indexOf(operation);
        if (position < 0 || operation.finalized || operation.validationState !== 'WAITING_VALIDATION') {
          throw new Error('provisional write operation is no longer awaiting validation');
        }
        queue.splice(position, 1);
        finalizeMaintenanceKnownNoEffect(operation, error);
        const head = queue[0];
        if (!blocked && head?.validationState === 'READY') scheduleDrain();
      },
    });
    return provisional;
  };

  const enqueue = <TInput, TResult>(
    kind: WriteOperationKind,
    input: TInput,
    executor: TrustedWriteExecutor<TInput, TResult>,
  ): Promise<TResult> => {
    if (blocked) return Promise.reject(new Error('write operation coordinator is blocked by unknown effect'));
    let provisional: WriteOperationProvisional<TInput, TResult>;
    try {
      provisional = registerProvisional(kind, executor);
    } catch (error: unknown) {
      if (!(error instanceof LifecycleHookFailure)) throw error;
      return Promise.reject(error.cause);
    }
    try {
      provisional.activate(input);
    } catch {
      return provisional.completion;
    }
    return provisional.completion;
  };

  const createPort = <TInput, TResult>(
    kind: WriteOperationKind,
    executor: TrustedWriteExecutor<TInput, TResult>,
  ): WriteOperationEnqueuePort<TInput, TResult> => {
    const port = {
      enqueue: (input: TInput) => enqueue(kind, input, executor),
    } as WriteOperationEnqueuePort<TInput, TResult>;
    Object.defineProperty(port, 'registerProvisional', {
      value: () => registerProvisional(kind, executor),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return Object.freeze(port);
  };

  const bundleChannels = {
    managementCreate: createPort('MANAGEMENT_CREATE', capturedExecutors.managementCreate),
    managementUpdate: createPort('MANAGEMENT_UPDATE', capturedExecutors.managementUpdate),
    managementRevoke: createPort('MANAGEMENT_REVOKE', capturedExecutors.managementRevoke),
    recognition: createPort('RECOGNITION', capturedExecutors.recognition),
  };
  Object.defineProperty(bundleChannels, 'wake', {
    value: (): void => {
      deferredByGate = false;
      scheduleDrain();
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(bundleChannels, 'settleReadyKnownNoEffect', {
    value: (error: unknown, beforeFinalize?: (input: unknown) => void): void => {
      if (error === undefined || error === null) {
        throw new TypeError('ready settlement requires an error');
      }
      if (beforeFinalize !== undefined && typeof beforeFinalize !== 'function') {
        throw new TypeError('ready settlement cleanup must be a function');
      }
      // Snapshot first.  The cleanup hook can fail the enclosing maintenance
      // command, so keep its operation in the FIFO until that hook returns.
      // Removing it first would strand an unfinalized entry if cleanup throws.
      // Re-check after cleanup because it may synchronously re-enter here.
      const ready = queue.filter((operation) => !operation.finalized
        && operation.validationState === 'READY');
      for (const operation of ready) {
        if (queue.indexOf(operation) < 0 || operation.finalized || operation.validationState !== 'READY') continue;
        beforeFinalize?.(operation.input);
        const position = queue.indexOf(operation);
        if (position < 0 || operation.finalized || operation.validationState !== 'READY') continue;
        queue.splice(position, 1);
        finalizeMaintenanceKnownNoEffect(operation, error);
      }
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(bundleChannels, 'markWaitingValidationMaintenanceCanceled', {
    value: (): void => {
      for (const operation of queue) {
        if (!operation.finalized && operation.validationState === 'WAITING_VALIDATION') {
          operation.maintenanceValidationCanceled = true;
        }
      }
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  const bundle = bundleChannels as WriteOperationCoordinatorBundle<
    TManagementCreateInput,
    TManagementCreateResult,
    TManagementUpdateInput,
    TManagementUpdateResult,
    TManagementRevokeInput,
    TManagementRevokeResult,
    TRecognitionInput,
    TRecognitionResult
  >;
  const frozenBundle = Object.freeze(bundle);
  coordinatorRecoveryAccesses.set(frozenBundle as object, recoveryAccess);
  return frozenBundle;
}

/**
 * Creates an internal recovery owner for exactly one coordinator bundle.
 * Ordinary enqueue callers never receive this owner; it exists solely so the
 * future G10c confirmation coordinator can make a controlled final decision
 * about a post-commit transport unknown.
 */
export function createPostCommitUnknownRecoveryOwner(
  bundle: WriteOperationCoordinatorBundle,
): PostCommitUnknownRecoveryOwner {
  if ((typeof bundle !== 'object' && typeof bundle !== 'function') || bundle === null) {
    throw new TypeError('write operation coordinator bundle is invalid');
  }
  const access = coordinatorRecoveryAccesses.get(bundle as object);
  if (access === undefined) throw new TypeError('write operation coordinator bundle is foreign');
  return access.createOwner();
}

function createUniqueOperationId(issuedOperationIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const operationId = randomUUID();
    if (!issuedOperationIds.has(operationId)) return operationId;
  }
  throw new Error('unable to create a unique write operation id');
}

function isLegalCandidate(candidate: Candidate): boolean {
  switch (candidate.kind) {
    case 'BUSINESS_RESULT_PERSISTED':
      return candidate.result !== undefined;
    case 'PRESTART_REJECTED':
    case 'KNOWN_NO_EFFECT':
    case 'UNKNOWN_EFFECT':
      return candidate.error !== undefined && candidate.error !== null;
  }
}

function candidateError(candidate: Candidate): unknown {
  return candidate.kind === 'BUSINESS_RESULT_PERSISTED' ? undefined : candidate.error;
}

class LifecycleHookFailure extends Error {
  public constructor(public override readonly cause: unknown) {
    super('write operation lifecycle hook failed');
  }
}

function rejectAsyncLifecycleResult(result: unknown): void {
  if ((typeof result !== 'object' && typeof result !== 'function') || result === null) return;
  let then: unknown;
  try {
    then = Reflect.get(result, 'then');
  } catch {
    throw new TypeError('write operation lifecycle observer returned an invalid thenable');
  }
  if (typeof then !== 'function') return;
  try {
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    throw new TypeError('write operation lifecycle observer returned an invalid thenable');
  }
  throw new TypeError('write operation lifecycle observer must be synchronous');
}

function assertOptions<
  TManagementCreateInput,
  TManagementCreateResult,
  TManagementUpdateInput,
  TManagementUpdateResult,
  TManagementRevokeInput,
  TManagementRevokeResult,
  TRecognitionInput,
  TRecognitionResult,
>(
  options: WriteOperationCoordinatorOptions<
    TManagementCreateInput,
    TManagementCreateResult,
    TManagementUpdateInput,
    TManagementUpdateResult,
    TManagementRevokeInput,
    TManagementRevokeResult,
    TRecognitionInput,
    TRecognitionResult
  >,
): void {
  if (typeof options !== 'object' || options === null || typeof options.clock?.nowMs !== 'function') {
    throw new TypeError('trusted write clock is required');
  }
  if (options.monotonicClock !== undefined && typeof options.monotonicClock.nowMs !== 'function') {
    throw new TypeError('trusted monotonic clock is invalid');
  }
  if (options.lifecycleObserver !== undefined && typeof options.lifecycleObserver.settled !== 'function') {
    throw new TypeError('write operation lifecycle observer is invalid');
  }
  if (options.startGate !== undefined && typeof options.startGate !== 'function') {
    throw new TypeError('write operation start gate is invalid');
  }
  if (typeof options.executors !== 'object' || options.executors === null) {
    throw new TypeError('trusted write executors are required');
  }
  for (const executor of Object.values(options.executors)) {
    if (typeof executor !== 'function') throw new TypeError('trusted write executor is required');
  }
}
