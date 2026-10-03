import { types as nodeTypes } from 'node:util';

import {
  createG07bAdmissionHandler,
  readG07bHandlerWriterQuiescence,
  type G07bAdmissionHandlerOptions,
} from './g07b-admission-handler.js';
import { createG10aWriterPermissionBinding } from './g10a-writer-permission-binding.js';
import { createG10aQueryPermissionBinding } from './g10a-query-permission-binding.js';
import {
  createRuntimeControl,
  createRuntimeIdentityIssuer,
  bindRuntimeControlLiveCounters,
  type RuntimeClock,
  type RuntimeControl,
} from '../../runtime/internal/runtime-control.js';
import { createRuntimeLiveCounterSnapshotSource, publishRuntimeLiveCounterSnapshot } from '../../runtime/internal/runtime-live-counter-snapshot.js';
import { createRuntimeLiveCounterBridge } from '../../runtime/internal/runtime-live-counter-bridge.js';
import { readWriterQuiescenceCounters } from '../../access/application/internal/writer-quiescence.js';
import { readOperationRegistryUnknownCount, bindOperationRegistryMetricsBridge } from '../../access/application/internal/operation-registry.js';
import { assertRuntimeLogSink, type RuntimeLogSink } from '../../runtime/internal/runtime-log-sink.js';
import type { AcceptedIngressHandler } from '../../shared/internal/http/index.js';
import { createG10aIngressIdentityHandler } from './g10a-ingress-identity.js';
import { createG10aOperationIdentityBinding } from './g10a-operation-identity-binding.js';
import { createG10aBusinessStepLogBinding } from './g10a-business-step-log-binding.js';
import { createG10aDriverLogBinding } from './g10a-driver-log-binding.js';
import {
  assertG10aRuntimeCapabilities,
  type G10aRuntimeCapabilities,
} from './g10a-runtime-owner.js';
import type { G04bMongoPersistenceAdapter } from '../../infrastructure/mongo/g04b-persistence-adapter.js';
import { attachG10bG04bPersistenceSidecar } from './g10b-g04b-persistence-wire.js';
import { createG10bOperationBudgetBindingFactory } from './g10b-operation-bridge.js';
import { createG10cPostCommitUnknownHandoffBundle } from '../../infrastructure/mongo/internal/g10c-post-commit-unknown-handoff.js';
import { createG10cG07RecoveryBridge, type G10cG07RecoveryBridge } from './g10c-g07-recovery-bridge.js';
import {
  createG10cRecoveryScheduler,
  type G10cRecoveryScheduler,
} from './g10c-recovery-scheduler.js';

/**
 * Private composition seam for the G10a runtime and the existing G07b writer
 * hand-off.  It is deliberately not re-exported: a bootstrap may construct it,
 * but application callers cannot supply a writer permission themselves.
 */
export interface G10aAdmissionRuntimeCompositionOptions {
  readonly epoch: string;
  readonly run: string;
  readonly monotonicClock: RuntimeClock;
  readonly awaitObservation: (remainingMs: number) => PromiseLike<void> | void;
  readonly admission: Omit<G07bAdmissionHandlerOptions, 'writerPermission' | 'queryPermission'>;
  readonly controlIdFactory?: () => string;
  /** Optional, private best-effort logger. It is not an application input. */
  readonly runtimeLogSink?: RuntimeLogSink;
  /** A started, nominal runtime owner may inject its single process capabilities. */
  readonly runtime?: G10aRuntimeCapabilities;
  /**
   * Concrete Mongo composition opt-in.  Without this value the historical
   * G10a/G07 composition is retained byte-for-byte; with it, G10b and G10c
   * are wired around this one adapter before any writer can start.
   */
  readonly g10cMongoAdapter?: G04bMongoPersistenceAdapter;
}

export interface G10aAdmissionRuntimeComposition {
  readonly handler: AcceptedIngressHandler;
  /** Internal control handle retained by the future private control transport. */
  readonly control: RuntimeControl;
  /** Private inspection seam for composition tests and runtime shutdown. */
  readonly recoveryScheduler?: G10cRecoveryScheduler;
}

const ADMISSION_REQUIRED = Object.freeze([
  'currentDatasetEpoch',
  'registry',
  'registryCapabilities',
  'responsePlans',
  'workHandoff',
  'validator',
  'work',
  'unknownRecognition',
] as const);
const ADMISSION_OPTIONAL = Object.freeze([
  'wallClock',
  'monotonicClock',
  'resources',
  'rates',
  'writerQuiescence',
  'operationBudgetBindingFactory',
] as const);

export function createG10aAdmissionRuntimeComposition(
  input: G10aAdmissionRuntimeCompositionOptions,
): G10aAdmissionRuntimeComposition {
  const options = captureFactoryOptions(input);
  if (options.admission.currentDatasetEpoch !== options.epoch) {
    throw new TypeError('G10a runtime epoch does not match G07b admission epoch');
  }

  const runtime = options.runtime;
  if (runtime !== undefined && (options.controlIdFactory !== undefined || options.runtimeLogSink !== undefined)) {
    throw new TypeError('G10a runtime owner cannot be combined with local control options');
  }
  const identityIssuer = runtime?.identityIssuer ?? createRuntimeIdentityIssuer({
    datasetEpoch: options.epoch,
    processRunId: options.run,
  });
  const control = runtime?.control ?? createRuntimeControl({
    epoch: options.epoch,
    run: options.run,
    identityIssuer,
    clock: options.monotonicClock,
    awaitObservation: options.awaitObservation,
    ...(options.controlIdFactory === undefined ? {} : { controlIdFactory: options.controlIdFactory }),
    ...(options.runtimeLogSink === undefined ? {} : { runtimeLogSink: options.runtimeLogSink }),
  });
  if (runtime !== undefined) {
    const snapshot = control.snapshot();
    if (snapshot.epoch !== options.epoch || snapshot.run !== options.run) {
      throw new TypeError('G10a runtime owner identity does not match admission runtime');
    }
  }
  const driverLogBinding = runtime === undefined ? undefined : createG10aDriverLogBinding(runtime);
  const writerPermission = createG10aWriterPermissionBinding(control);
  const queryPermission = createG10aQueryPermissionBinding(control);
  let recoveryScheduler: G10cRecoveryScheduler | undefined;
  let recoveryBridge: G10cG07RecoveryBridge | undefined;
  let g10bBindingFactory = options.admission.operationBudgetBindingFactory;
  if (options.g10cMongoAdapter !== undefined) {
    attachG10bG04bPersistenceSidecar(options.g10cMongoAdapter);
    if (g10bBindingFactory === undefined) {
      g10bBindingFactory = createG10bOperationBudgetBindingFactory({
        clock: options.monotonicClock,
        // Continuation evidence is verified by the private coordinator/owner
        // boundary in this composition; the ledger receives no caller data.
        assertContinuationEvidence: () => undefined,
      });
    }
    let wakeScheduler: (() => void) | undefined;
    const handoffs = createG10cPostCommitUnknownHandoffBundle();
    recoveryBridge = createG10cG07RecoveryBridge({
      adapter: options.g10cMongoAdapter,
      handoffs,
      // G07 changes REQUESTED -> PAUSED after the executor returns. Defer
      // recovery work one microtask so the scheduler cannot adopt the ticket
      // while the coordinator still rejects recovery as not yet paused.
      onPausedTicket: () => { if (wakeScheduler !== undefined) queueMicrotask(wakeScheduler); },
    });
    recoveryScheduler = createG10cRecoveryScheduler({
      clock: options.monotonicClock,
      timer: Object.freeze({
        setTimeout: (callback: () => void, delayMs: number): unknown => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (handle: unknown): void => { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>); },
      }),
      pausedTickets: recoveryBridge.pausedTickets,
    });
    wakeScheduler = recoveryScheduler.wake;
  }
  let refreshCounters: (() => void) | undefined;
  const counterSource = createRuntimeLiveCounterSnapshotSource(Object.freeze({
    writers: Object.freeze({ provisional: 0, queued: 0, running: 0, blocked: 0, unknown: 0 }), registryUnknown: 0,
  }));
  const counterBridge = createRuntimeLiveCounterBridge(() => refreshCounters?.());
  const admissionHandler = createG07bAdmissionHandler({
    ...options.admission,
    ...(g10bBindingFactory === undefined ? {} : { operationBudgetBindingFactory: g10bBindingFactory }),
    ...(recoveryBridge === undefined ? {} : { postCommitUnknownRecoveryBridge: recoveryBridge }),
    writerPermission,
    queryPermission,
    ...(runtime === undefined ? {} : {
      operationIdentityBinding: createG10aOperationIdentityBinding(runtime),
      businessStepLogBinding: createG10aBusinessStepLogBinding(runtime),
      ...(driverLogBinding === undefined ? {} : { driverLogBinding }),
    }),
    runtimeCounterBridge: counterBridge,
  });
  const writerQuiescence = readG07bHandlerWriterQuiescence(admissionHandler);
  refreshCounters = () => publishRuntimeLiveCounterSnapshot(counterSource, Object.freeze({
    writers: readWriterQuiescenceCounters(writerQuiescence), registryUnknown: readOperationRegistryUnknownCount(options.admission.registry),
  }));
  refreshCounters();
  bindOperationRegistryMetricsBridge(options.admission.registry, counterBridge);
  bindRuntimeControlLiveCounters(control, counterSource);
  const handler = runtime === undefined
    ? admissionHandler
    : createG10aIngressIdentityHandler({
      handler: admissionHandler,
      // Only an owner-issued capability bundle may drive ingress logging.
      // Local standalone compositions intentionally retain their old handler
      // until a real process owner supplies the indivisible runtime.
      runtime,
      ...(driverLogBinding === undefined ? {} : { driverLogBinding }),
    });
  return Object.freeze({
    handler,
    control,
    ...(recoveryScheduler === undefined ? {} : { recoveryScheduler }),
  });
}

function captureFactoryOptions(input: unknown): Readonly<{
  readonly epoch: string;
  readonly run: string;
  readonly monotonicClock: RuntimeClock;
  readonly awaitObservation: (remainingMs: number) => PromiseLike<void> | void;
  readonly admission: Omit<G07bAdmissionHandlerOptions, 'writerPermission' | 'queryPermission'>;
  readonly controlIdFactory: (() => string) | undefined;
  readonly runtimeLogSink: RuntimeLogSink | undefined;
  readonly runtime: G10aRuntimeCapabilities | undefined;
  readonly g10cMongoAdapter: G04bMongoPersistenceAdapter | undefined;
}> {
  const record = capturePlainRecord(
    input,
    ['epoch', 'run', 'monotonicClock', 'awaitObservation', 'admission'],
    ['controlIdFactory', 'runtimeLogSink', 'runtime', 'g10cMongoAdapter'],
    'G10a admission runtime options',
  );
  return Object.freeze({
    epoch: record.epoch as string,
    run: record.run as string,
    monotonicClock: record.monotonicClock as RuntimeClock,
    awaitObservation: record.awaitObservation as (remainingMs: number) => PromiseLike<void> | void,
    admission: captureAdmissionOptions(record.admission),
    controlIdFactory: record.controlIdFactory as (() => string) | undefined,
    runtimeLogSink: captureRuntimeLogSink(record.runtimeLogSink),
    runtime: captureRuntime(record.runtime),
    g10cMongoAdapter: captureG10cMongoAdapter(record.g10cMongoAdapter),
  });
}

function captureG10cMongoAdapter(value: unknown): G04bMongoPersistenceAdapter | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw new TypeError('G10c Mongo adapter is invalid');
  return value as G04bMongoPersistenceAdapter;
}

function captureRuntime(value: unknown): G10aRuntimeCapabilities | undefined {
  if (value === undefined) return undefined;
  assertG10aRuntimeCapabilities(value);
  return value;
}

function captureRuntimeLogSink(value: unknown): RuntimeLogSink | undefined {
  if (value === undefined) return undefined;
  assertRuntimeLogSink(value);
  return value;
}

function captureAdmissionOptions(value: unknown): Omit<G07bAdmissionHandlerOptions, 'writerPermission' | 'queryPermission'> {
  const record = capturePlainRecord(value, ADMISSION_REQUIRED, ADMISSION_OPTIONAL, 'G10a admission options');
  return Object.freeze({
    currentDatasetEpoch: record.currentDatasetEpoch,
    registry: record.registry,
    registryCapabilities: record.registryCapabilities,
    responsePlans: record.responsePlans,
    workHandoff: record.workHandoff,
    validator: record.validator,
    work: record.work,
    unknownRecognition: record.unknownRecognition,
    ...(Object.hasOwn(record, 'wallClock') ? { wallClock: record.wallClock } : {}),
    ...(Object.hasOwn(record, 'monotonicClock') ? { monotonicClock: record.monotonicClock } : {}),
    ...(Object.hasOwn(record, 'resources') ? { resources: record.resources } : {}),
    ...(Object.hasOwn(record, 'rates') ? { rates: record.rates } : {}),
    ...(Object.hasOwn(record, 'writerQuiescence') ? { writerQuiescence: record.writerQuiescence } : {}),
    ...(Object.hasOwn(record, 'operationBudgetBindingFactory') ? { operationBudgetBindingFactory: record.operationBudgetBindingFactory } : {}),
  }) as Omit<G07bAdmissionHandlerOptions, 'writerPermission' | 'queryPermission'>;
}

function capturePlainRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (nodeTypes.isProxy(value) || typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (nodeTypes.isProxy(prototype) || (prototype !== Object.prototype && prototype !== null)) throw new Error();
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...required, ...optional]);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((key) => !keys.includes(key))) throw new Error();
    const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
      copied[key] = descriptor.value;
    }
    return Object.freeze(copied);
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
}
