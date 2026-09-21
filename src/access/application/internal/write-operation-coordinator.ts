import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

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
}

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
  let blocked = false;
  let current: Operation | null = null;

  const assertCurrent = (operation: Operation): void => {
    if (current !== operation || !operation.active || operation.finalized) {
      throw new Error('write operation is not current');
    }
  };

  const scheduleDrain = (): void => {
    if (drainScheduled || running || blocked) return;
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

  const runOperation = async (operation: Operation): Promise<void> => {
    current = operation;
    operation.active = true;
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
    const settlement: WriteOperationSettlement<unknown> = Object.freeze({
      prestartRejected: (error: unknown) => recordCandidate(operation, { kind: 'PRESTART_REJECTED', error }),
      businessResultPersisted: (result: unknown) => recordCandidate(operation, { kind: 'BUSINESS_RESULT_PERSISTED', result }),
      knownNoEffect: (error: unknown) => recordCandidate(operation, { kind: 'KNOWN_NO_EFFECT', error }),
      unknownEffect: (error: unknown) => recordCandidate(operation, { kind: 'UNKNOWN_EFFECT', error }),
    });

    let executionFailed = false;
    let executionError: unknown;
    try {
      await operation.executor(operation.input, context, settlement);
    } catch (error: unknown) {
      executionFailed = true;
      executionError = error;
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
      operation.reject(new Error('write operation lifecycle observer failed'));
      return false;
    }
  };

  const finalizeUnknown = (operation: Operation, error: unknown): void => {
    if (operation.finalized) return;
    operation.finalized = true;
    operation.active = false;
    blocked = true;
    if (current === operation) current = null;
    if (!notifyLifecycle(operation, 'UNKNOWN_EFFECT')) return;
    operation.reject(error ?? new Error('write operation has unknown effect'));
  };

  const finalize = (operation: Operation, candidate: Candidate): void => {
    if (operation.finalized) return;
    operation.finalized = true;
    operation.active = false;
    if (candidate.kind === 'UNKNOWN_EFFECT') blocked = true;
    if (current === operation) current = null;
    if (!notifyLifecycle(operation, candidate.kind)) return;
    switch (candidate.kind) {
      case 'BUSINESS_RESULT_PERSISTED':
        operation.resolve(candidate.result);
        return;
      case 'UNKNOWN_EFFECT':
        operation.reject(candidate.error);
        return;
      case 'PRESTART_REJECTED':
      case 'KNOWN_NO_EFFECT':
        operation.reject(candidate.error);
    }
  };

  async function drain(): Promise<void> {
    if (running || blocked) return;
    running = true;
    try {
      while (!blocked) {
        const operation = queue[0];
        if (operation === undefined) return;
        if (operation.validationState === 'WAITING_VALIDATION') return;
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
      if (!blocked && head?.validationState === 'READY') scheduleDrain();
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
    };
    queue.push(operation);
    issuedOperationIds.add(operationId);
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
    });
    return provisional;
  };

  const enqueue = <TInput, TResult>(
    kind: WriteOperationKind,
    input: TInput,
    executor: TrustedWriteExecutor<TInput, TResult>,
  ): Promise<TResult> => {
    if (blocked) return Promise.reject(new Error('write operation coordinator is blocked by unknown effect'));
    const provisional = registerProvisional(kind, executor);
    provisional.activate(input);
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

  const bundle: WriteOperationCoordinatorBundle<
    TManagementCreateInput,
    TManagementCreateResult,
    TManagementUpdateInput,
    TManagementUpdateResult,
    TManagementRevokeInput,
    TManagementRevokeResult,
    TRecognitionInput,
    TRecognitionResult
  > = {
    managementCreate: createPort('MANAGEMENT_CREATE', capturedExecutors.managementCreate),
    managementUpdate: createPort('MANAGEMENT_UPDATE', capturedExecutors.managementUpdate),
    managementRevoke: createPort('MANAGEMENT_REVOKE', capturedExecutors.managementRevoke),
    recognition: createPort('RECOGNITION', capturedExecutors.recognition),
  };
  return Object.freeze(bundle);
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
  if (typeof options.executors !== 'object' || options.executors === null) {
    throw new TypeError('trusted write executors are required');
  }
  for (const executor of Object.values(options.executors)) {
    if (typeof executor !== 'function') throw new TypeError('trusted write executor is required');
  }
}
