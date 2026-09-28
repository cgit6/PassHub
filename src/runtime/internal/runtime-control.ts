import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

export type RuntimeControlPhase =
  | 'RUNNING'
  | 'MANUAL_HOLD'
  | 'MAINTENANCE_DRAINING'
  | 'MAINTENANCE_HELD'
  | 'MANUAL_AND_MAINTENANCE_DRAINING'
  | 'MANUAL_AND_MAINTENANCE_HELD';
export type RuntimeControlOutcome = 'HELD' | 'RELEASED' | 'DRAINED' | 'NOT_DRAINED' | 'INTERNAL_UNAVAILABLE';
export type RuntimeControlErrorCode =
  | 'INVALID_REQUEST' | 'STALE_EPOCH' | 'STALE_RUN' | 'STALE_REVISION' | 'REQUEST_CONTROL_CONFLICT'
  | 'CONTROL_BUSY' | 'MANUAL_HOLD_EXISTS' | 'NO_MANUAL_HOLD'
  | 'CONTROL_ID_MISMATCH' | 'MAINTENANCE_HOLD_EXISTS';

export type BusinessRoute = 'MANAGEMENT_CREATE' | 'MANAGEMENT_UPDATE' | 'MANAGEMENT_REVOKE' | 'RECOGNITION';
export type RuntimeRoute = BusinessRoute | 'QUERY' | 'LOGIN';

export interface RuntimeBusinessIdentityFacts {
  readonly requestUUID: string;
  readonly operationUUID: string;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerRef: string;
  readonly route: BusinessRoute;
}
export interface RuntimeReadIdentityFacts {
  readonly requestUUID: string;
  readonly operationUUID: null;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerRef: null;
  readonly route: 'QUERY' | 'LOGIN';
}
export type RuntimeIdentityFacts = RuntimeBusinessIdentityFacts | RuntimeReadIdentityFacts;

export type RuntimeIdentityInput =
  | { readonly requestUUID: string; readonly operationToken: unknown; readonly route: BusinessRoute }
  | { readonly requestUUID: string; readonly operationToken: null; readonly operationUUID: null; readonly ownerRef: null; readonly route: 'QUERY' | 'LOGIN' };

export interface RuntimeIdentity { readonly __runtimeIdentity: unique symbol; }
interface OperationToken { readonly __operationToken: unique symbol; }
export interface RuntimeIdentityIssuer {
  issue(input: RuntimeIdentityInput): RuntimeIdentity;
  /** Internal composition seam; the opaque return type is intentionally not exported. */
  issueBusinessToken(input: unknown): unknown;
  read(identity: RuntimeIdentity): RuntimeIdentityFacts;
}
export interface RuntimeIdentityIssuerOptions { readonly datasetEpoch: string; readonly processRunId: string; }

export interface WriterCounterSnapshot {
  readonly provisional: number;
  readonly queued: number;
  readonly running: number;
  readonly blocked: number;
  readonly unknown: number;
}
export interface LoggingSnapshot { readonly status: 'HEALTHY' | 'LOGGING_DEGRADED'; readonly droppedCount: number; }
export interface RuntimeControlSnapshot {
  readonly epoch: string;
  readonly run: string;
  readonly revision: string;
  readonly phase: RuntimeControlPhase;
  readonly manual: Readonly<{ readonly active: boolean; readonly controlId: string | null }>;
  readonly maintenance: Readonly<{
    readonly active: boolean;
    readonly controlId: string | null;
    readonly outcome: 'WAITING' | 'DRAINED' | 'NOT_DRAINED' | 'INTERNAL_UNAVAILABLE' | null;
  }>;
  readonly writers: WriterCounterSnapshot;
  readonly issuedPersistence: number;
  readonly activeQueryReads: number;
  readonly registryUnknown: number;
  readonly logging: LoggingSnapshot;
}

export interface RuntimeControlMutationBase {
  readonly requestControlId: string;
  readonly epoch: string;
  readonly run: string;
  readonly expectedRevision: string;
}
export type HoldRequest = RuntimeControlMutationBase;
export type ReleaseRequest = RuntimeControlMutationBase & { readonly controlId: string };
export interface DrainRequest extends RuntimeControlMutationBase {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}
export interface RuntimeControlResult {
  readonly outcome: RuntimeControlOutcome;
  readonly revision: string;
  readonly controlId: string | null;
  readonly snapshot: RuntimeControlSnapshot;
}
export interface IssuedPersistenceLease { release(): void; }
export interface ActiveQueryReadLease { release(): void; }
export interface RuntimeControlOptions {
  readonly epoch: string;
  readonly run: string;
  readonly identityIssuer: RuntimeIdentityIssuer;
  readonly clock: RuntimeClock;
  readonly awaitObservation: (remainingMs: number) => PromiseLike<void> | void;
  readonly controlIdFactory?: () => string;
}
export interface RuntimeClock { nowMs(): number; }
export interface RuntimeControl {
  readonly snapshot: () => RuntimeControlSnapshot;
  readonly acquireIssuedPersistence: () => IssuedPersistenceLease;
  readonly acquireActiveQueryRead: () => ActiveQueryReadLease;
  /** Internal writer-start gate.  A manual hold only affects work not yet started. */
  readonly canStartWriter: () => boolean;
  /** Internal ingress gate for new writers while maintenance is active. */
  readonly isMaintenanceWriterVeto: () => boolean;
  /** Internal, one-time coordinator wake binding. */
  readonly bindWriterWake: (wake: () => void) => void;
  /** Internal, one-time settlement binding for READY writers at drain start. */
  readonly bindMaintenanceReadySettlement: (settle: () => void) => void;
  readonly hold: (request: HoldRequest) => RuntimeControlResult;
  readonly release: (request: ReleaseRequest) => RuntimeControlResult;
  readonly drain: (request: DrainRequest) => Promise<RuntimeControlResult>;
}

export class RuntimeControlError extends Error {
  readonly code: RuntimeControlErrorCode;
  constructor(code: RuntimeControlErrorCode) {
    super(code);
    this.name = 'RuntimeControlError';
    this.code = code;
  }
}

interface IssuerState { readonly epoch: string; readonly run: string; }
interface IdentityState { readonly issuer: IssuerState; readonly facts: RuntimeIdentityFacts; }
interface OperationTokenState {
  readonly issuer: IssuerState;
  readonly operationUUID: string;
  readonly ownerRef: string;
  consumed: boolean;
}
interface ControlState { readonly epoch: string; readonly run: string; readonly issuer: IssuerState; }
interface CapturedMutation {
  readonly requestControlId: string;
  readonly epoch: string;
  readonly run: string;
  readonly expectedRevision: string;
  readonly controlId?: string;
}
interface CapturedDrain {
  readonly request: CapturedMutation;
  readonly timeoutMs: number;
  readonly signal?: CapturedAbortSignal;
}
interface CapturedAbortSignal {
  readonly initiallyAborted: boolean;
  readonly addEventListener: (listener: () => void) => void;
  readonly removeEventListener: (listener: () => void) => void;
}
interface MutationRecord {
  readonly command: 'HOLD' | 'RELEASE' | 'DRAIN';
  readonly requestControlId: string;
  readonly fingerprint: string;
  readonly result?: RuntimeControlResult;
  readonly promise?: Promise<RuntimeControlResult>;
}
interface SnapshotProjection {
  readonly revision: bigint;
  readonly manualControlId: string | null;
  readonly maintenanceControlId: string | null;
  readonly maintenanceOutcome: RuntimeControlSnapshot['maintenance']['outcome'];
}
interface PendingResultCell {
  state: 'PENDING' | 'COMMITTED' | 'FAILED';
  outcome?: RuntimeControlOutcome;
  revision?: string;
  controlId?: string | null;
  snapshot?: RuntimeControlSnapshot;
  error?: unknown;
}
interface LeaseState { readonly control: ControlState; readonly kind: 'PERSISTENCE' | 'QUERY'; active: boolean; }

const identityIssuers = new WeakMap<object, IssuerState>();
const identities = new WeakMap<object, IdentityState>();
const operationTokens = new WeakMap<object, OperationTokenState>();
const controls = new WeakMap<object, ControlState>();
const leases = new WeakMap<object, LeaseState>();
const issuedControlIds = new Set<string>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revisionPattern = /^(?:0|[1-9][0-9]*)$/;
const businessRoutes = new Set<BusinessRoute>(['MANAGEMENT_CREATE', 'MANAGEMENT_UPDATE', 'MANAGEMENT_REVOKE', 'RECOGNITION']);
const readRoutes = new Set<'QUERY' | 'LOGIN'>(['QUERY', 'LOGIN']);

export function createRuntimeIdentityIssuer(options: RuntimeIdentityIssuerOptions): RuntimeIdentityIssuer {
  const raw = captureRecord(options, ['datasetEpoch', 'processRunId'], [], 'identity issuer options');
  const captured = Object.freeze({ datasetEpoch: raw.datasetEpoch, processRunId: raw.processRunId });
  assertUuid(captured.datasetEpoch, 'datasetEpoch');
  assertUuid(captured.processRunId, 'processRunId');
  const state: IssuerState = Object.freeze({ epoch: captured.datasetEpoch, run: captured.processRunId });
  let issuer!: RuntimeIdentityIssuer;
  issuer = Object.freeze({
    issue(input: RuntimeIdentityInput): RuntimeIdentity {
      if (identityIssuers.get(issuer as object) !== state) throw new TypeError('runtime identity issuer is not trusted');
      const capturedInput = captureIdentityInput(input);
      const tokenState = capturedInput.route === 'QUERY' || capturedInput.route === 'LOGIN'
        ? null
        : consumeOperationToken(capturedInput.operationToken, state);
      const facts: RuntimeIdentityFacts = Object.freeze({
        requestUUID: capturedInput.requestUUID,
        operationUUID: tokenState === null ? null : tokenState.operationUUID,
        datasetEpoch: state.epoch,
        processRunId: state.run,
        ownerRef: tokenState === null ? null : tokenState.ownerRef,
        route: capturedInput.route,
      }) as RuntimeIdentityFacts;
      const identity = Object.freeze({}) as RuntimeIdentity;
      identities.set(identity as object, { issuer: state, facts });
      return identity;
    },
    issueBusinessToken(input: unknown): unknown {
      if (identityIssuers.get(issuer as object) !== state) throw new TypeError('runtime identity issuer is not trusted');
      const captured = captureRecord(input, ['operationUUID', 'ownerRef'], [], 'business operation token input');
      assertUuid(captured.operationUUID, 'operationUUID');
      assertUuid(captured.ownerRef, 'ownerRef');
      const token = Object.freeze({}) as OperationToken;
      operationTokens.set(token as object, {
        issuer: state,
        operationUUID: captured.operationUUID,
        ownerRef: captured.ownerRef,
        consumed: false,
      });
      return token;
    },
    read(identity: RuntimeIdentity): RuntimeIdentityFacts {
      const identityState = identities.get(asObject(identity));
      if (identityState === undefined || identityState.issuer !== state) throw new TypeError('runtime identity is not issued by this issuer');
      return identityState.facts;
    },
  });
  identityIssuers.set(issuer as object, state);
  return issuer;
}

export function assertRuntimeIdentityIssuer(value: unknown): asserts value is RuntimeIdentityIssuer {
  if (nodeTypes.isProxy(value) || typeof value !== 'object' || value === null || !identityIssuers.has(value)) {
    throw new TypeError('runtime identity issuer is not trusted');
  }
}

export function createRuntimeControl(options: RuntimeControlOptions): RuntimeControl {
  const rawOptions = captureRecord(options, ['epoch', 'run', 'identityIssuer', 'clock', 'awaitObservation'], ['controlIdFactory'], 'runtime control options');
  const capturedOptions = Object.freeze({
    epoch: rawOptions.epoch,
    run: rawOptions.run,
    identityIssuer: rawOptions.identityIssuer,
    clock: rawOptions.clock,
    awaitObservation: rawOptions.awaitObservation,
    controlIdFactory: rawOptions.controlIdFactory,
  });
  assertUuid(capturedOptions.epoch, 'epoch');
  assertUuid(capturedOptions.run, 'run');
  assertRuntimeIdentityIssuer(capturedOptions.identityIssuer);
  const issuerState = identityIssuers.get(capturedOptions.identityIssuer as object);
  if (issuerState === undefined || issuerState.epoch !== capturedOptions.epoch || issuerState.run !== capturedOptions.run) {
    throw new TypeError('runtime identity issuer does not match control epoch/run');
  }
  const factory = capturedOptions.controlIdFactory === undefined ? randomUUID : capturedOptions.controlIdFactory;
  if (nodeTypes.isProxy(factory) || typeof factory !== 'function') throw new TypeError('control id factory is invalid');
  if (nodeTypes.isProxy(capturedOptions.clock) || typeof capturedOptions.clock !== 'object' || capturedOptions.clock === null) throw new TypeError('runtime clock is invalid');
  if (nodeTypes.isProxy(capturedOptions.awaitObservation) || typeof capturedOptions.awaitObservation !== 'function') throw new TypeError('runtime observation awaiter is invalid');
  const clockNowMs = captureDataMethod(capturedOptions.clock, 'nowMs', 'runtime clock');
  const awaitObservation = capturedOptions.awaitObservation;
  const state: ControlState = Object.freeze({ epoch: capturedOptions.epoch, run: capturedOptions.run, issuer: issuerState });
  let nextControlId = reserveControlId(factory);
  let factoryFailure: TypeError | null = null;
  let revision = 0n;
  let manualControlId: string | null = null;
  let maintenanceControlId: string | null = null;
  let maintenanceOutcome: RuntimeControlSnapshot['maintenance']['outcome'] = null;
  let issuedPersistence = 0;
  let activeQueryReads = 0;
  let writerWake: (() => void) | undefined;
  let writerWakeBound = false;
  let maintenanceReadySettlement: (() => void) | undefined;
  let maintenanceReadySettlementBound = false;
  let current: MutationRecord | null = null;
  let last: MutationRecord | null = null;
  interface CounterWaiter { readonly wake: () => void; active: boolean; }
  const counterWaiters = new Set<CounterWaiter>();

  const makeSnapshot = (projection: SnapshotProjection): RuntimeControlSnapshot => {
    const manual = Object.freeze({ active: projection.manualControlId !== null, controlId: projection.manualControlId });
    const maintenance = Object.freeze({ active: projection.maintenanceControlId !== null, controlId: projection.maintenanceControlId, outcome: projection.maintenanceOutcome });
    const writers = Object.freeze({ provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 0 });
    const logging = Object.freeze({ status: 'HEALTHY' as const, droppedCount: 0 });
    return Object.freeze({
      epoch: state.epoch,
      run: state.run,
      revision: projection.revision.toString(10),
      phase: derivePhase(projection.manualControlId !== null, projection.maintenanceControlId !== null, projection.maintenanceOutcome === 'WAITING'),
      manual,
      maintenance,
      writers,
      issuedPersistence,
      activeQueryReads,
      registryUnknown: 0,
      logging,
    });
  };
  const snapshot = (): RuntimeControlSnapshot => makeSnapshot({ revision, manualControlId, maintenanceControlId, maintenanceOutcome });

  const canStartWriter = (): boolean => manualControlId === null;
  // Deliberately distinct from canStartWriter: A6 only rejects a *new*
  // writer synchronously at ingress.  Previously admitted work is governed by
  // its existing coordinator lifecycle and is not retroactively cancelled.
  const isMaintenanceWriterVeto = (): boolean => maintenanceControlId !== null;
  const bindWriterWake = (wake: () => void): void => {
    if (typeof wake !== 'function' || writerWakeBound) throw new TypeError('writer wake is invalid or already bound');
    writerWakeBound = true;
    writerWake = wake;
  };
  const bindMaintenanceReadySettlement = (settle: () => void): void => {
    if (typeof settle !== 'function' || maintenanceReadySettlementBound) {
      throw new TypeError('maintenance ready settlement is invalid or already bound');
    }
    maintenanceReadySettlementBound = true;
    maintenanceReadySettlement = settle;
  };
  const notifyCounterWaiters = (): void => {
    const waiters = [...counterWaiters];
    counterWaiters.clear();
    waiters.forEach((waiter) => { waiter.active = false; waiter.wake(); });
  };
  const waitForCounterChange = (): { readonly promise: Promise<void>; readonly cancel: () => void } => {
    let resolveWaiter!: () => void;
    const waiter: CounterWaiter = { wake: () => resolveWaiter(), active: true };
    const promise = new Promise<void>((resolve) => { resolveWaiter = resolve; });
    counterWaiters.add(waiter);
    return Object.freeze({
      promise,
      cancel: (): void => {
        if (!waiter.active) return;
        waiter.active = false;
        counterWaiters.delete(waiter);
      },
    });
  };

  const validateMutation = (command: MutationRecord['command'], request: CapturedMutation, extra: string): RuntimeControlResult | undefined => {
    const fingerprint = fingerprintFor(command, request, extra);
    if (request.epoch !== state.epoch) throw new RuntimeControlError('STALE_EPOCH');
    if (request.run !== state.run) throw new RuntimeControlError('STALE_RUN');
    if (current !== null) {
      if (current.requestControlId === request.requestControlId && current.fingerprint !== fingerprint) throw new RuntimeControlError('REQUEST_CONTROL_CONFLICT');
      if (current.result !== undefined && current.fingerprint === fingerprint) return current.result;
      throw new RuntimeControlError('CONTROL_BUSY');
    }
    if (last !== null && last.requestControlId === request.requestControlId) {
      if (last.fingerprint !== fingerprint) throw new RuntimeControlError('REQUEST_CONTROL_CONFLICT');
      if (last.result === undefined) throw new RuntimeControlError('CONTROL_BUSY');
      return last.result;
    }
    if (!revisionMatches(request.expectedRevision, revision)) throw new RuntimeControlError('STALE_REVISION');
    return undefined;
  };
  const validateDrainMutation = (request: CapturedMutation, timeoutMs: number): Promise<RuntimeControlResult> | undefined => {
    const fingerprint = fingerprintFor('DRAIN', request, String(timeoutMs));
    if (request.epoch !== state.epoch) throw new RuntimeControlError('STALE_EPOCH');
    if (request.run !== state.run) throw new RuntimeControlError('STALE_RUN');
    if (current !== null) {
      if (current.requestControlId === request.requestControlId && current.fingerprint !== fingerprint) throw new RuntimeControlError('REQUEST_CONTROL_CONFLICT');
      if (current.promise !== undefined && current.fingerprint === fingerprint) return current.promise;
      throw new RuntimeControlError('CONTROL_BUSY');
    }
    if (last !== null && last.requestControlId === request.requestControlId) {
      if (last.fingerprint !== fingerprint) throw new RuntimeControlError('REQUEST_CONTROL_CONFLICT');
      if (last.result === undefined) throw new RuntimeControlError('CONTROL_BUSY');
      return Promise.resolve(last.result);
    }
    if (!revisionMatches(request.expectedRevision, revision)) throw new RuntimeControlError('STALE_REVISION');
    return undefined;
  };

  const takeControlId = (): string => {
    if (factoryFailure !== null) throw factoryFailure;
    return nextControlId;
  };
  const reserveFollowingControlId = (): string => {
    if (factoryFailure !== null) throw factoryFailure;
    try { return reserveControlId(factory); } catch {
      factoryFailure = new TypeError('control id factory failed or returned a duplicate');
      throw factoryFailure;
    }
  };

  const acquireIssuedPersistence = (): IssuedPersistenceLease => {
    if (manualControlId !== null || maintenanceControlId !== null) throw new RuntimeControlError('CONTROL_BUSY');
    issuedPersistence += 1;
    const lease = Object.freeze({ release(this: unknown): void {
      const receiver = (typeof this === 'object' && this !== null) || typeof this === 'function' ? this : undefined;
      const leaseState = receiver === undefined ? undefined : leases.get(receiver);
      if (leaseState === undefined || leaseState.control !== state || leaseState.kind !== 'PERSISTENCE' || !leaseState.active) throw new TypeError('issued persistence lease is invalid or already released');
      leaseState.active = false;
      issuedPersistence -= 1;
      notifyCounterWaiters();
    } });
    leases.set(lease, { control: state, kind: 'PERSISTENCE', active: true });
    return lease;
  };

  const acquireActiveQueryRead = (): ActiveQueryReadLease => {
    if (maintenanceControlId !== null) throw new RuntimeControlError('CONTROL_BUSY');
    activeQueryReads += 1;
    const lease = Object.freeze({ release(this: unknown): void {
      const receiver = (typeof this === 'object' && this !== null) || typeof this === 'function' ? this : undefined;
      const leaseState = receiver === undefined ? undefined : leases.get(receiver);
      if (leaseState === undefined || leaseState.control !== state || leaseState.kind !== 'QUERY' || !leaseState.active) throw new TypeError('active query read lease is invalid or already released');
      leaseState.active = false;
      activeQueryReads -= 1;
      notifyCounterWaiters();
    } });
    leases.set(lease, { control: state, kind: 'QUERY', active: true });
    return lease;
  };

  const hold = (input: HoldRequest): RuntimeControlResult => {
    const request = captureBase(input);
    const replay = validateMutation('HOLD', request, '');
    if (replay !== undefined) return replay;
    if (manualControlId !== null) throw new RuntimeControlError('MANUAL_HOLD_EXISTS');
    const fingerprint = fingerprintFor('HOLD', request, '');
    const controlId = takeControlId();
    const terminalCell: PendingResultCell = { state: 'PENDING' };
    const terminal = createPendingResult(terminalCell);
    current = { command: 'HOLD', requestControlId: request.requestControlId, fingerprint, result: terminal };
    try {
      const followingControlId = reserveFollowingControlId();
      revision += 1n;
      manualControlId = controlId;
      nextControlId = followingControlId;
      commitPendingResult(terminalCell, 'HELD', controlId, snapshot());
      last = { command: 'HOLD', requestControlId: request.requestControlId, fingerprint, result: terminal };
      current = null;
      return terminal;
    } catch (error) {
      terminalCell.state = 'FAILED';
      terminalCell.error = error;
      current = null;
      throw error;
    }
  };

  const release = (input: ReleaseRequest): RuntimeControlResult => {
    const request = captureRelease(input);
    const replay = validateMutation('RELEASE', request, request.controlId as string);
    if (replay !== undefined) return replay;
    if (manualControlId === null) throw new RuntimeControlError('NO_MANUAL_HOLD');
    if (manualControlId !== request.controlId) throw new RuntimeControlError('CONTROL_ID_MISMATCH');
    const fingerprint = fingerprintFor('RELEASE', request, request.controlId as string);
    current = { command: 'RELEASE', requestControlId: request.requestControlId, fingerprint };
    try {
      revision += 1n;
      manualControlId = null;
      const result = makeResult('RELEASED', request.controlId as string);
      current = { command: 'RELEASE', requestControlId: request.requestControlId, fingerprint, result };
      last = { command: 'RELEASE', requestControlId: request.requestControlId, fingerprint, result };
      current = null;
      // The terminal transition is fully visible before the coordinator can
      // synchronously start a writer.  A wake failure must not undo release.
      try { writerWake?.(); } catch { /* a future write remains fail-closed until another wake */ }
      return result;
    } catch (error) { current = null; throw error; }
  };

  const drain = (input: DrainRequest): Promise<RuntimeControlResult> => {
    const captured = captureDrain(input);
    const replay = validateDrainMutation(captured.request, captured.timeoutMs);
    if (replay !== undefined) return replay;
    if (maintenanceControlId !== null) throw new RuntimeControlError('MAINTENANCE_HOLD_EXISTS');
    const fingerprint = fingerprintFor('DRAIN', captured.request, String(captured.timeoutMs));
    let resolveResult!: (result: RuntimeControlResult) => void;
    let rejectResult!: (error: unknown) => void;
    const promise = new Promise<RuntimeControlResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    current = { command: 'DRAIN', requestControlId: captured.request.requestControlId, fingerprint, promise };
    let controlId: string;
    try {
      controlId = takeControlId();
      const followingControlId = reserveFollowingControlId();
      revision += 1n;
      maintenanceControlId = controlId;
      maintenanceOutcome = 'WAITING';
      nextControlId = followingControlId;
    } catch (error) {
      current = null;
      rejectResult(error);
      return promise;
    }

    let settled = false;
    let removeAbortListener: (() => void) | undefined;
    let cancelWaiter: (() => void) | undefined;
    const finish = (outcome: 'DRAINED' | 'NOT_DRAINED' | 'INTERNAL_UNAVAILABLE'): void => {
      if (settled) return;
      settled = true;
      const cleanupAbort = removeAbortListener;
      removeAbortListener = undefined;
      cancelWaiter?.();
      cancelWaiter = undefined;
      maintenanceOutcome = outcome;
      const result = makeResult(outcome, controlId);
      last = { command: 'DRAIN', requestControlId: captured.request.requestControlId, fingerprint, result };
      current = null;
      resolveResult(result);
      try { cleanupAbort?.(); } catch { /* cleanup cannot change the terminal */ }
    };
    // The maintenance state is visible before the coordinator receives this
    // synchronous command.  It may only settle READY queue entries; issued
    // work and validation-in-flight are deliberately outside this A7 seam.
    try {
      const settlementResult: unknown = maintenanceReadySettlement?.();
      if (settlementResult !== undefined) throw new TypeError('maintenance ready settlement must return undefined');
    } catch {
      finish('INTERNAL_UNAVAILABLE');
      return promise;
    }
    const observe = async (): Promise<void> => {
      try {
        const started = readClock(clockNowMs);
        if (started > Number.MAX_SAFE_INTEGER - captured.timeoutMs) throw new TypeError('runtime drain deadline overflow');
        const deadline = started + captured.timeoutMs;
        let previousClock = started;
        const readMonotonicClock = (): number => {
          const now = readClock(clockNowMs);
          if (now < previousClock) throw new TypeError('runtime clock moved backwards');
          previousClock = now;
          return now;
        };
        let abortPromise: Promise<void> | undefined;
        let aborted = captured.signal?.initiallyAborted ?? false;
        if (captured.signal !== undefined) {
          let abortResolve!: () => void;
          abortPromise = new Promise<void>((resolve) => { abortResolve = resolve; });
          const onAbort = (): void => { aborted = true; abortResolve(); };
          if (aborted) abortResolve();
          else {
            captured.signal.addEventListener(onAbort);
            removeAbortListener = (): void => captured.signal?.removeEventListener(onAbort);
          }
        }
        while (true) {
          if (aborted) { finish('NOT_DRAINED'); return; }
          if (issuedPersistence === 0 && activeQueryReads === 0) { finish('DRAINED'); return; }
          const now = readMonotonicClock();
          if (now >= deadline) { finish('NOT_DRAINED'); return; }
          const waiter = waitForCounterChange();
          cancelWaiter = waiter.cancel;
          const observation = Promise.resolve().then(() => awaitObservation(deadline - now));
          try {
            await Promise.race([waiter.promise, observation, ...(abortPromise === undefined ? [] : [abortPromise])]);
          } finally {
            cancelWaiter?.();
            cancelWaiter = undefined;
          }
        }
      } catch {
        finish('INTERNAL_UNAVAILABLE');
      }
    };
    if (issuedPersistence === 0 && activeQueryReads === 0 && !(captured.signal?.initiallyAborted ?? false)) finish('DRAINED');
    else void observe();
    return promise;
  };

  const control: RuntimeControl = Object.freeze({ snapshot, acquireIssuedPersistence, acquireActiveQueryRead, canStartWriter, isMaintenanceWriterVeto, bindWriterWake, bindMaintenanceReadySettlement, hold, release, drain });
  controls.set(control as object, state);
  return control;

  function makeResult(outcome: RuntimeControlOutcome, controlId: string | null, projection?: SnapshotProjection): RuntimeControlResult {
    return Object.freeze({
      outcome,
      revision: (projection?.revision ?? revision).toString(10),
      controlId,
      snapshot: makeSnapshot(projection ?? { revision, manualControlId, maintenanceControlId, maintenanceOutcome }),
    });
  }
  function fingerprintFor(command: MutationRecord['command'], request: CapturedMutation, extra: string): string {
    return `${command}|${request.requestControlId}|${request.epoch}|${request.run}|${request.expectedRevision}|${extra}`;
  }
}

export function assertRuntimeControl(value: unknown): asserts value is RuntimeControl {
  if (nodeTypes.isProxy(value) || typeof value !== 'object' || value === null || !controls.has(value)) throw new TypeError('runtime control is not trusted');
}

function createPendingResult(cell: PendingResultCell): RuntimeControlResult {
  return Object.freeze({
    get outcome(): RuntimeControlOutcome { return requireCommitted(cell).outcome as RuntimeControlOutcome; },
    get revision(): string { return requireCommitted(cell).revision as string; },
    get controlId(): string | null { return requireCommitted(cell).controlId ?? null; },
    get snapshot(): RuntimeControlSnapshot { return requireCommitted(cell).snapshot as RuntimeControlSnapshot; },
  });
}

function commitPendingResult(cell: PendingResultCell, outcome: RuntimeControlOutcome, controlId: string, snapshot: RuntimeControlSnapshot): void {
  if (cell.state !== 'PENDING') throw new TypeError('pending runtime result is not committable');
  cell.outcome = outcome;
  cell.revision = snapshot.revision;
  cell.controlId = controlId;
  cell.snapshot = snapshot;
  cell.state = 'COMMITTED';
}

function requireCommitted(cell: PendingResultCell): PendingResultCell {
  if (cell.state === 'PENDING') throw new RuntimeControlError('CONTROL_BUSY');
  if (cell.state === 'FAILED') {
    if (cell.error instanceof Error) throw cell.error;
    throw new TypeError('runtime mutation failed');
  }
  return cell;
}

function captureIdentityInput(input: RuntimeIdentityInput): RuntimeIdentityInput {
  const record = captureRecord(
    input,
    ['requestUUID', 'route'],
    ['operationToken', 'operationUUID', 'ownerRef'],
    'runtime identity input',
    [
      ['requestUUID', 'route', 'operationToken'],
      ['requestUUID', 'route', 'operationToken', 'operationUUID', 'ownerRef'],
    ],
  );
  if (typeof record.route !== 'string') throw new TypeError('runtime identity input is invalid');
  if (businessRoutes.has(record.route as BusinessRoute)) {
    assertCapturedKeySet(record, ['requestUUID', 'route', 'operationToken']);
    assertUuid(record.requestUUID, 'requestUUID');
    return Object.freeze({ requestUUID: record.requestUUID, operationToken: record.operationToken, route: record.route as BusinessRoute });
  }
  if (readRoutes.has(record.route as 'QUERY' | 'LOGIN') && record.operationToken === null && record.operationUUID === null && record.ownerRef === null) {
    assertCapturedKeySet(record, ['requestUUID', 'route', 'operationToken', 'operationUUID', 'ownerRef']);
    assertUuid(record.requestUUID, 'requestUUID');
    return Object.freeze({ requestUUID: record.requestUUID, operationToken: null, operationUUID: null, ownerRef: null, route: record.route as 'QUERY' | 'LOGIN' });
  }
  throw new TypeError('runtime identity route facts are inconsistent');
}

function assertCapturedKeySet(record: Record<string, any>, expected: readonly string[]): void {
  const keys = Reflect.ownKeys(record);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) throw new TypeError('runtime identity input keys are inconsistent');
}

function captureBase(input: RuntimeControlMutationBase): CapturedMutation {
  const record = captureRecord(input, ['requestControlId', 'epoch', 'run', 'expectedRevision'], [], 'control request');
  assertUuid(record.requestControlId, 'requestControlId', true); assertUuid(record.epoch, 'epoch', true); assertUuid(record.run, 'run', true);
  if (typeof record.expectedRevision !== 'string' || !revisionPattern.test(record.expectedRevision)) throw new RuntimeControlError('INVALID_REQUEST');
  return Object.freeze({ requestControlId: record.requestControlId, epoch: record.epoch, run: record.run, expectedRevision: record.expectedRevision });
}

function captureDrain(input: DrainRequest): CapturedDrain {
  const record = captureRecord(input, ['requestControlId', 'epoch', 'run', 'expectedRevision', 'timeoutMs'], ['signal'], 'drain request');
  assertUuid(record.requestControlId, 'requestControlId', true);
  assertUuid(record.epoch, 'epoch', true);
  assertUuid(record.run, 'run', true);
  if (typeof record.expectedRevision !== 'string' || !revisionPattern.test(record.expectedRevision)) throw new RuntimeControlError('INVALID_REQUEST');
  if (!Number.isSafeInteger(record.timeoutMs) || record.timeoutMs < 1 || record.timeoutMs > 30_000) throw new RuntimeControlError('INVALID_REQUEST');
  return Object.freeze({
    request: Object.freeze({ requestControlId: record.requestControlId, epoch: record.epoch, run: record.run, expectedRevision: record.expectedRevision }),
    timeoutMs: record.timeoutMs,
    ...(record.signal === undefined ? {} : { signal: captureAbortSignal(record.signal) }),
  });
}

function captureAbortSignal(value: unknown): CapturedAbortSignal {
  try {
    if (nodeTypes.isProxy(value) || typeof AbortSignal === 'undefined' || !(value instanceof AbortSignal)) throw new Error();
    const signal = value as AbortSignal;
    const prototype = AbortSignal.prototype;
    const abortedDescriptor = Object.getOwnPropertyDescriptor(prototype, 'aborted');
    if (typeof EventTarget === 'undefined') throw new Error();
    const eventPrototype = EventTarget.prototype;
    const addDescriptor = Object.getOwnPropertyDescriptor(eventPrototype, 'addEventListener');
    const removeDescriptor = Object.getOwnPropertyDescriptor(eventPrototype, 'removeEventListener');
    if (abortedDescriptor?.get === undefined || addDescriptor === undefined || !('value' in addDescriptor) || typeof addDescriptor.value !== 'function' || removeDescriptor === undefined || !('value' in removeDescriptor) || typeof removeDescriptor.value !== 'function') throw new Error();
    if (nodeTypes.isProxy(abortedDescriptor.get) || nodeTypes.isProxy(addDescriptor.value) || nodeTypes.isProxy(removeDescriptor.value)) throw new Error();
    const initiallyAborted = Reflect.apply(abortedDescriptor.get, signal, []);
    if (typeof initiallyAborted !== 'boolean') throw new Error();
    return Object.freeze({
      initiallyAborted,
      addEventListener: (listener: () => void): void => { Reflect.apply(addDescriptor.value, signal, ['abort', listener, { once: true }]); },
      removeEventListener: (listener: () => void): void => { Reflect.apply(removeDescriptor.value, signal, ['abort', listener]); },
    });
  } catch { throw new RuntimeControlError('INVALID_REQUEST'); }
}

function captureRelease(input: ReleaseRequest): CapturedMutation {
  const record = captureRecord(input, ['requestControlId', 'epoch', 'run', 'expectedRevision', 'controlId'], [], 'release request');
  assertUuid(record.controlId, 'controlId', true);
  assertUuid(record.requestControlId, 'requestControlId', true); assertUuid(record.epoch, 'epoch', true); assertUuid(record.run, 'run', true);
  if (typeof record.expectedRevision !== 'string' || !revisionPattern.test(record.expectedRevision)) throw new RuntimeControlError('INVALID_REQUEST');
  return Object.freeze({ requestControlId: record.requestControlId, epoch: record.epoch, run: record.run, expectedRevision: record.expectedRevision, controlId: record.controlId });
}

function captureRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  acceptedKeySets?: readonly (readonly string[])[],
): Record<string, any> {
  try {
    if (nodeTypes.isProxy(value) || typeof value !== 'object' || value === null) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (nodeTypes.isProxy(prototype) || (prototype !== Object.prototype && prototype !== null)) throw new Error();
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...required, ...optional]);
    if (keys.length < required.length || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw new Error();
    for (const key of required) if (!keys.includes(key)) throw new Error();
    if (acceptedKeySets !== undefined && !acceptedKeySets.some((accepted) => accepted.length === keys.length && accepted.every((key) => keys.includes(key)))) throw new Error();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) throw new Error();
    }
    return value as Record<string, any>;
  } catch { throw new TypeError(`${label} is invalid`); }
}

function consumeOperationToken(value: unknown, issuer: IssuerState): OperationTokenState {
  const tokenState = operationTokens.get(asObject(value));
  if (tokenState === undefined || tokenState.issuer !== issuer || tokenState.consumed) {
    throw new TypeError('operation token is foreign, forged, or already consumed');
  }
  tokenState.consumed = true;
  return tokenState;
}

function reserveControlId(factory: () => string): string {
  let value: string;
  try { value = factory(); } catch { throw new TypeError('control id factory failed'); }
  assertUuid(value, 'controlId');
  if (issuedControlIds.has(value)) throw new TypeError('control id factory returned a duplicate');
  issuedControlIds.add(value);
  return value;
}

function captureDataMethod(target: object, key: string, label: string): (...args: any[]) => any {
  try {
    let cursor: object | null = target;
    while (cursor !== null) {
      if (nodeTypes.isProxy(cursor)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) throw new Error();
        return descriptor.value.bind(target);
      }
      cursor = Object.getPrototypeOf(cursor) as object | null;
    }
  } catch { throw new TypeError(`${label} is invalid`); }
  throw new TypeError(`${label} is invalid`);
}

function assertUuid(value: unknown, label: string, request = false): asserts value is string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    if (request) throw new RuntimeControlError('INVALID_REQUEST');
    throw new TypeError(`${label} must be a canonical UUID v4`);
  }
}
function asObject(value: unknown): object {
  if (nodeTypes.isProxy(value) || (typeof value !== 'object' && typeof value !== 'function') || value === null) throw new TypeError('opaque runtime value is invalid');
  return value;
}
function revisionMatches(value: string, revision: bigint): boolean {
  try { return BigInt(value) === revision; } catch { return false; }
}
function readClock(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError('runtime clock returned an invalid value');
  return value;
}
function derivePhase(manual: boolean, maintenance: boolean, draining: boolean): RuntimeControlPhase {
  if (!maintenance) return manual ? 'MANUAL_HOLD' : 'RUNNING';
  if (draining) return manual ? 'MANUAL_AND_MAINTENANCE_DRAINING' : 'MAINTENANCE_DRAINING';
  return manual ? 'MANUAL_AND_MAINTENANCE_HELD' : 'MAINTENANCE_HELD';
}
