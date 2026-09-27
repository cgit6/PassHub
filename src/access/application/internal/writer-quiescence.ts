import type {
  WriteOperationLifecycleDisposition,
  WriteOperationRegistrationReceipt,
} from './write-operation-coordinator.js';

export interface WriterQuiescenceClock { nowMs(): number; }
export type WriterQuiescenceState = 'PROVISIONAL' | 'QUEUED' | 'RUNNING' | 'BLOCKED' | 'UNKNOWN';
declare const readObservationLeaseBrand: unique symbol;
export interface ReadObservationLease { readonly [readObservationLeaseBrand]: never; readonly observedAtMs: number; release(): void; }
export type ReadObservationLeaseResult =
  | Readonly<{ readonly kind: 'ACQUIRED'; readonly lease: ReadObservationLease }>
  | Readonly<{ readonly kind: 'TECHNICAL_BUSY' }>;
export interface WriterQuiescencePort {
  readonly lifecycle: WriterQuiescenceLifecycle;
  canStartWriter(): boolean;
  acquireReadObservationLease(): ReadObservationLeaseResult;
  bindCoordinatorWake(wake: () => void): void;
}
export interface WriterQuiescenceLifecycle {
  registered(receipt: WriteOperationRegistrationReceipt): void;
  queued(receipt: WriteOperationRegistrationReceipt): void;
  started(receipt: WriteOperationRegistrationReceipt): void;
  blocked(receipt: WriteOperationRegistrationReceipt): void;
  settled(receipt: WriteOperationRegistrationReceipt, disposition: WriteOperationLifecycleDisposition): void;
}
interface LeaseState { readonly identity: object; active: boolean; }
const leaseStates = new WeakMap<object, LeaseState>();
const quiescencePorts = new WeakSet<object>();
export function isWriterQuiescencePort(value: unknown): value is WriterQuiescencePort {
  return typeof value === 'object' && value !== null && quiescencePorts.has(value);
}
export function createWriterQuiescence(options: Readonly<{ readonly clock: WriterQuiescenceClock; readonly onLeaseReleased?: () => void }>): WriterQuiescencePort {
  if (typeof options !== 'object' || options === null || typeof options.clock !== 'object' || options.clock === null
    || typeof options.clock.nowMs !== 'function' || (options.onLeaseReleased !== undefined && typeof options.onLeaseReleased !== 'function')) throw new TypeError('writer quiescence options are invalid');
  const clockNowMs = options.clock.nowMs.bind(options.clock);
  const states = new Map<string, WriterQuiescenceState>();
  const identity = Object.freeze({});
  let readLeaseActive = false;
  let coordinatorWake = options.onLeaseReleased;
  let wakeBound = false;
  const notifyWake = (): void => { try { coordinatorWake?.(); } catch { /* remain fail-closed */ } };
  const lifecycle: WriterQuiescenceLifecycle = Object.freeze({
    registered(receipt: WriteOperationRegistrationReceipt) { assertReceipt(receipt); if (states.has(receipt.operationId)) throw new TypeError('writer receipt is already registered'); states.set(receipt.operationId, 'PROVISIONAL'); },
    queued(receipt: WriteOperationRegistrationReceipt) { assertReceipt(receipt); requireState(receipt.operationId, 'PROVISIONAL'); states.set(receipt.operationId, 'QUEUED'); },
    started(receipt: WriteOperationRegistrationReceipt) { assertReceipt(receipt); requireState(receipt.operationId, 'QUEUED'); states.set(receipt.operationId, 'RUNNING'); },
    blocked(receipt: WriteOperationRegistrationReceipt) { assertReceipt(receipt); states.set(receipt.operationId, 'BLOCKED'); },
    settled(receipt: WriteOperationRegistrationReceipt, disposition: WriteOperationLifecycleDisposition) { assertReceipt(receipt); if (!states.has(receipt.operationId)) throw new TypeError('writer receipt is not registered'); if (disposition === 'UNKNOWN_EFFECT') states.set(receipt.operationId, 'UNKNOWN'); else states.delete(receipt.operationId); },
  });
  const canStartWriter = (): boolean => !readLeaseActive;
  const release = (lease: ReadObservationLease): void => {
    const state = leaseStates.get(lease as object);
    if (state === undefined || state.identity !== identity || !state.active) throw new TypeError('read observation lease is invalid or already released');
    state.active = false; readLeaseActive = false; notifyWake();
  };
  const acquireReadObservationLease = (): ReadObservationLeaseResult => {
    if (readLeaseActive || states.size !== 0) return Object.freeze({ kind: 'TECHNICAL_BUSY' as const });
    readLeaseActive = true;
    let observedAtMs: number;
    try { observedAtMs = clockNowMs(); if (!Number.isSafeInteger(observedAtMs)) throw new TypeError('writer quiescence clock must return a safe integer'); }
    catch (error) { readLeaseActive = false; notifyWake(); throw error; }
    if (states.size !== 0) { readLeaseActive = false; notifyWake(); return Object.freeze({ kind: 'TECHNICAL_BUSY' as const }); }
    const lease = Object.freeze({ observedAtMs, release(): void { release(lease); } }) as ReadObservationLease;
    leaseStates.set(lease as object, { identity, active: true });
    return Object.freeze({ kind: 'ACQUIRED' as const, lease });
  };
  const bindCoordinatorWake = (wake: () => void): void => { if (typeof wake !== 'function' || wakeBound) throw new TypeError('writer coordinator wake is already bound'); wakeBound = true; coordinatorWake = wake; };
  const port = Object.freeze({ lifecycle, canStartWriter, acquireReadObservationLease, bindCoordinatorWake });
  quiescencePorts.add(port); return port;
  function requireState(operationId: string, expected: WriterQuiescenceState): void { if (states.get(operationId) !== expected) throw new TypeError(`writer lifecycle expected ${expected}`); }
}
function assertReceipt(receipt: WriteOperationRegistrationReceipt): void {
  if (typeof receipt !== 'object' || receipt === null || typeof receipt.operationId !== 'string' || receipt.operationId.length === 0 || !Number.isSafeInteger(receipt.receivedAtMs) || !Number.isFinite(receipt.registeredAtMonotonicMs) || typeof receipt.sequence !== 'bigint') throw new TypeError('writer registration receipt is invalid');
}
