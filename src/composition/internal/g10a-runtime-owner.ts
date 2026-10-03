import { isAbsolute } from 'node:path';
import { types as nodeTypes } from 'node:util';

import {
  createRuntimeControl,
  createRuntimeIdentityIssuer,
  type RuntimeClock,
  type RuntimeControl,
  type RuntimeIdentityIssuer,
} from '../../runtime/internal/runtime-control.js';
import {
  createRuntimeControlSocketService,
  type RuntimeControlSocketService,
} from '../../runtime/internal/runtime-control-socket-service.js';
import {
  createRuntimeLogFileStore,
} from '../../runtime/internal/runtime-log-file-store.js';
import { type RuntimeLogSink } from '../../runtime/internal/runtime-log-sink.js';

/**
 * The one private owner for the G10a process-local facilities.  It is not an
 * HTTP composition and is deliberately absent from every public barrel:
 * callers cannot turn the control socket or log sink into an application API.
 */
export interface G10aRuntimeOwnerOptions {
  readonly epoch: string;
  readonly run: string;
  /** Explicit absolute directory.  The factory never derives paths from cwd. */
  readonly logDirectory: string;
  /** Explicit absolute control directory, validated by the AF_UNIX adapter. */
  readonly controlDirectory: string;
  /** Explicit absolute fixed-name child of controlDirectory. */
  readonly controlSocketPath: string;
  readonly monotonicClock: RuntimeClock;
  readonly awaitObservation: (remainingMs: number) => PromiseLike<void> | void;
}

/**
 * Internal capabilities retained by the application's later private
 * composition.  In particular, one identity issuer belongs to one process
 * run; future ingress wiring must use this issuer rather than making a
 * parallel issuer with the same strings.
 */
export interface G10aRuntimeCapabilities {
  /**
   * Compile-time nominal marker.  The matching runtime WeakSet check below is
   * the authority at the JavaScript boundary; together they stop a caller
   * from assembling an ingress runtime out of independently acquired parts.
   */
  readonly __g10aRuntimeCapabilities: unique symbol;
  readonly control: RuntimeControl;
  readonly identityIssuer: RuntimeIdentityIssuer;
  readonly runtimeLogSink: RuntimeLogSink;
  readonly socketPath: string;
  readonly loggingAvailable: boolean;
}

export interface G10aRuntimeOwner {
  /** Starts exactly one private logger/control/socket set for this owner. */
  start(): Promise<G10aRuntimeCapabilities>;
  /**
   * Stops intake before closing the logger: listener close first, then the
   * sink's bounded close/flush.  It is idempotent and also settles a racing
   * start, so the factory leaves no owned listener running.
   */
  close(): Promise<void>;
}

// These are internal capabilities, not structural configuration objects.  The
// later HTTP composition must only consume the bundle created by this owner;
// otherwise a caller could splice an unrelated issuer or sink into one run.
const runtimeOwners = new WeakSet<object>();
const runtimeCapabilities = new WeakSet<object>();
const runtimeLifecycles = new WeakMap<object, () => boolean>();

/** Private lifecycle check for an exact owner-issued runtime bundle. */
export function isG10aRuntimeCapabilitiesCurrent(runtime: G10aRuntimeCapabilities): boolean {
  return runtimeLifecycles.get(runtime)?.() === true;
}

export function assertG10aRuntimeOwner(value: unknown): asserts value is G10aRuntimeOwner {
  if (typeof value !== 'object' || value === null || !runtimeOwners.has(value)) {
    throw new TypeError('G10a runtime owner is not trusted');
  }
}

export function assertG10aRuntimeCapabilities(value: unknown): asserts value is G10aRuntimeCapabilities {
  if (typeof value !== 'object' || value === null || !runtimeCapabilities.has(value)) {
    throw new TypeError('G10a runtime capabilities are not trusted');
  }
}

export class G10aRuntimeOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'G10aRuntimeOwnerError';
  }
}

/**
 * Constructs an unstarted, private runtime owner.  Startup is intentionally
 * explicit so a process can finish its outer bootstrap before accepting any
 * application traffic.  Logging initialization is best effort by D184: an
 * unsafe/unavailable log namespace produces a nominal degraded sink, whereas
 * control-socket startup failure rejects and closes that sink.
 */
export function createG10aRuntimeOwner(input: G10aRuntimeOwnerOptions): G10aRuntimeOwner {
  const owner = new PrivateG10aRuntimeOwner(captureOptions(input));
  runtimeOwners.add(owner);
  return owner;
}

type OwnerState = 'NEW' | 'STARTING' | 'RUNNING' | 'FAILED' | 'CLOSING' | 'CLOSED';

class PrivateG10aRuntimeOwner implements G10aRuntimeOwner {
  private state: OwnerState = 'NEW';
  private startPromise: Promise<G10aRuntimeCapabilities> | undefined;
  private closePromise: Promise<void> | undefined;
  private service: RuntimeControlSocketService | undefined;
  private sink: RuntimeLogSink | undefined;

  constructor(private readonly options: Readonly<G10aRuntimeOwnerOptions>) {}

  start(): Promise<G10aRuntimeCapabilities> {
    if (this.state === 'CLOSING' || this.state === 'CLOSED') {
      return Promise.reject(new G10aRuntimeOwnerError('runtime owner is closed'));
    }
    if (this.startPromise !== undefined) return this.startPromise;
    this.state = 'STARTING';
    this.startPromise = this.startOwnedRuntime();
    return this.startPromise;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = this.closeOwnedRuntime();
    return this.closePromise;
  }

  private async startOwnedRuntime(): Promise<G10aRuntimeCapabilities> {
    const logs = await createRuntimeLogFileStore({ directory: this.options.logDirectory });
    this.sink = logs.sink;
    const identityIssuer = createRuntimeIdentityIssuer({
      datasetEpoch: this.options.epoch,
      processRunId: this.options.run,
    });
    const control = createRuntimeControl({
      epoch: this.options.epoch,
      run: this.options.run,
      identityIssuer,
      clock: this.options.monotonicClock,
      awaitObservation: this.options.awaitObservation,
      runtimeLogSink: logs.sink,
    });
    try {
      const service = await createRuntimeControlSocketService({
        control,
        directory: this.options.controlDirectory,
        socketPath: this.options.controlSocketPath,
        ...(logs.store === null ? {} : { logReader: logs.store }),
      });
      this.service = service;
      const runtime = Object.freeze({
        control,
        identityIssuer,
        runtimeLogSink: logs.sink,
        socketPath: service.socketPath,
        loggingAvailable: logs.store !== null,
      }) as G10aRuntimeCapabilities;
      runtimeCapabilities.add(runtime);
      runtimeLifecycles.set(runtime, () => this.state === 'RUNNING');
      if (this.state === 'CLOSING' || this.state === 'CLOSED') {
        // A concurrent close awaits this start and performs the canonical
        // listener-then-sink shutdown.  Do not create a second cleanup path.
        return runtime;
      }
      this.state = 'RUNNING';
      return runtime;
    } catch (error) {
      this.state = 'FAILED';
      await logs.sink.close().catch(() => undefined);
      throw new G10aRuntimeOwnerError('cannot start private runtime control');
    }
  }

  private async closeOwnedRuntime(): Promise<void> {
    const priorState = this.state;
    this.state = 'CLOSING';
    if (this.startPromise !== undefined) {
      try {
        await this.startPromise;
      } catch {
        // Startup has already bounded and closed its logger on a listener
        // failure.  There is no socket to close in this branch.
        this.state = 'CLOSED';
        return;
      }
    }
    let listenerError: unknown;
    try {
      await this.service?.close();
    } catch (error) {
      listenerError = error;
    }
    try {
      await this.sink?.close();
    } catch (error) {
      if (listenerError === undefined) listenerError = error;
    }
    this.state = 'CLOSED';
    if (listenerError !== undefined) {
      throw new G10aRuntimeOwnerError('cannot close private runtime control');
    }
    // Preserve the explicit NEW -> CLOSED lifecycle as a valid no-resource
    // shutdown.  `priorState` makes that intent visible without changing the
    // externally identical idempotent result.
    void priorState;
  }
}

function captureOptions(input: unknown): Readonly<G10aRuntimeOwnerOptions> {
  const fields = [
    'epoch', 'run', 'logDirectory', 'controlDirectory', 'controlSocketPath',
    'monotonicClock', 'awaitObservation',
  ] as const;
  try {
    if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))
      || keys.some((key) => typeof key !== 'string' || !fields.includes(key as typeof fields[number]))) throw new Error();
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
      captured[field] = descriptor.value;
    }
    for (const field of ['epoch', 'run', 'logDirectory', 'controlDirectory', 'controlSocketPath'] as const) {
      if (typeof captured[field] !== 'string') throw new Error();
    }
    if (!isAbsolute(captured.logDirectory as string) || !isAbsolute(captured.controlDirectory as string)
      || !isAbsolute(captured.controlSocketPath as string)
      || (captured.logDirectory as string).includes('\0') || (captured.controlDirectory as string).includes('\0')
      || (captured.controlSocketPath as string).includes('\0')) throw new Error();
    if (nodeTypes.isProxy(captured.awaitObservation) || typeof captured.awaitObservation !== 'function') throw new Error();
    if (nodeTypes.isProxy(captured.monotonicClock) || typeof captured.monotonicClock !== 'object' || captured.monotonicClock === null) throw new Error();
    return Object.freeze({
      epoch: captured.epoch as string,
      run: captured.run as string,
      logDirectory: captured.logDirectory as string,
      controlDirectory: captured.controlDirectory as string,
      controlSocketPath: captured.controlSocketPath as string,
      monotonicClock: captured.monotonicClock as RuntimeClock,
      awaitObservation: captured.awaitObservation as (remainingMs: number) => PromiseLike<void> | void,
    });
  } catch {
    throw new TypeError('G10a runtime owner options are invalid');
  }
}
