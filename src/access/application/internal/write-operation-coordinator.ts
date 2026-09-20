import { randomUUID } from 'node:crypto';

export type WriteOperationKind =
  | 'MANAGEMENT_CREATE'
  | 'MANAGEMENT_UPDATE'
  | 'MANAGEMENT_REVOKE'
  | 'RECOGNITION';

export interface TrustedWriteClock {
  nowMs(): number;
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
  readonly input: unknown;
  readonly executor: TrustedWriteExecutor<unknown, unknown>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  candidate: Candidate | null;
  settlementCount: number;
  invalidSettlement: boolean;
  active: boolean;
  finalized: boolean;
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

  const finalizeUnknown = (operation: Operation, error: unknown): void => {
    if (operation.finalized) return;
    operation.finalized = true;
    operation.active = false;
    blocked = true;
    current = null;
    operation.reject(error ?? new Error('write operation has unknown effect'));
  };

  const finalize = (operation: Operation, candidate: Candidate): void => {
    if (operation.finalized) return;
    operation.finalized = true;
    operation.active = false;
    current = null;
    switch (candidate.kind) {
      case 'BUSINESS_RESULT_PERSISTED':
        operation.resolve(candidate.result);
        return;
      case 'UNKNOWN_EFFECT':
        blocked = true;
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
        const operation = queue.shift();
        if (operation === undefined) return;
        await runOperation(operation);
      }
    } finally {
      running = false;
      if (!blocked && queue.length > 0) scheduleDrain();
    }
  }

  const enqueue = <TInput, TResult>(
    kind: WriteOperationKind,
    input: TInput,
    executor: TrustedWriteExecutor<TInput, TResult>,
  ): Promise<TResult> => {
    if (!allowedKinds.has(kind)) throw new TypeError('unsupported write operation kind');
    if (blocked) return Promise.reject(new Error('write operation coordinator is blocked by unknown effect'));
    const receivedAtMs = clockNowMs();
    if (!Number.isSafeInteger(receivedAtMs)) throw new TypeError('trusted write clock must return a safe integer');
    const operationId = createUniqueOperationId(issuedOperationIds);
    const sequence = nextSequence;
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
      input,
      executor: executor as TrustedWriteExecutor<unknown, unknown>,
      resolve: resolvePromise as (result: unknown) => void,
      reject: rejectPromise,
      candidate: null,
      settlementCount: 0,
      invalidSettlement: false,
      active: false,
      finalized: false,
    };
    queue.push(operation);
    issuedOperationIds.add(operationId);
    nextSequence += 1n;
    scheduleDrain();
    return promise;
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
    managementCreate: Object.freeze({
      enqueue: (input: TManagementCreateInput) => enqueue('MANAGEMENT_CREATE', input, capturedExecutors.managementCreate),
    }),
    managementUpdate: Object.freeze({
      enqueue: (input: TManagementUpdateInput) => enqueue('MANAGEMENT_UPDATE', input, capturedExecutors.managementUpdate),
    }),
    managementRevoke: Object.freeze({
      enqueue: (input: TManagementRevokeInput) => enqueue('MANAGEMENT_REVOKE', input, capturedExecutors.managementRevoke),
    }),
    recognition: Object.freeze({
      enqueue: (input: TRecognitionInput) => enqueue('RECOGNITION', input, capturedExecutors.recognition),
    }),
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
  if (typeof options.executors !== 'object' || options.executors === null) {
    throw new TypeError('trusted write executors are required');
  }
  for (const executor of Object.values(options.executors)) {
    if (typeof executor !== 'function') throw new TypeError('trusted write executor is required');
  }
}
