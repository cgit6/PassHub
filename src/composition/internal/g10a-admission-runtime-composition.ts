import { types as nodeTypes } from 'node:util';

import {
  createG07bAdmissionHandler,
  type G07bAdmissionHandlerOptions,
} from './g07b-admission-handler.js';
import { createG10aWriterPermissionBinding } from './g10a-writer-permission-binding.js';
import { createG10aQueryPermissionBinding } from './g10a-query-permission-binding.js';
import {
  createRuntimeControl,
  createRuntimeIdentityIssuer,
  type RuntimeClock,
  type RuntimeControl,
} from '../../runtime/internal/runtime-control.js';
import type { AcceptedIngressHandler } from '../../shared/internal/http/index.js';

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
}

export interface G10aAdmissionRuntimeComposition {
  readonly handler: AcceptedIngressHandler;
  /** Internal control handle retained by the future private control transport. */
  readonly control: RuntimeControl;
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
] as const);

export function createG10aAdmissionRuntimeComposition(
  input: G10aAdmissionRuntimeCompositionOptions,
): G10aAdmissionRuntimeComposition {
  const options = captureFactoryOptions(input);
  if (options.admission.currentDatasetEpoch !== options.epoch) {
    throw new TypeError('G10a runtime epoch does not match G07b admission epoch');
  }

  const identityIssuer = createRuntimeIdentityIssuer({
    datasetEpoch: options.epoch,
    processRunId: options.run,
  });
  const control = createRuntimeControl({
    epoch: options.epoch,
    run: options.run,
    identityIssuer,
    clock: options.monotonicClock,
    awaitObservation: options.awaitObservation,
    ...(options.controlIdFactory === undefined ? {} : { controlIdFactory: options.controlIdFactory }),
  });
  const writerPermission = createG10aWriterPermissionBinding(control);
  const queryPermission = createG10aQueryPermissionBinding(control);
  const handler = createG07bAdmissionHandler({
    ...options.admission,
    writerPermission,
    queryPermission,
  });
  return Object.freeze({ handler, control });
}

function captureFactoryOptions(input: unknown): Readonly<{
  readonly epoch: string;
  readonly run: string;
  readonly monotonicClock: RuntimeClock;
  readonly awaitObservation: (remainingMs: number) => PromiseLike<void> | void;
  readonly admission: Omit<G07bAdmissionHandlerOptions, 'writerPermission' | 'queryPermission'>;
  readonly controlIdFactory: (() => string) | undefined;
}> {
  const record = capturePlainRecord(
    input,
    ['epoch', 'run', 'monotonicClock', 'awaitObservation', 'admission'],
    ['controlIdFactory'],
    'G10a admission runtime options',
  );
  return Object.freeze({
    epoch: record.epoch as string,
    run: record.run as string,
    monotonicClock: record.monotonicClock as RuntimeClock,
    awaitObservation: record.awaitObservation as (remainingMs: number) => PromiseLike<void> | void,
    admission: captureAdmissionOptions(record.admission),
    controlIdFactory: record.controlIdFactory as (() => string) | undefined,
  });
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
