import type {
  OperationConfirmationLease,
  OperationObservationReference,
} from '../../access/application/internal/operation-registry.js';
import { types as utilTypes } from 'node:util';

declare const unknownRecognitionReceiptBrand: unique symbol;

export interface UnknownRecognitionReceipt {
  readonly [unknownRecognitionReceiptBrand]: never;
}

export interface UnknownRecognitionSafeContext {
  readonly operationId: string;
  readonly receivedAtMs: number;
  readonly sequence: bigint;
}

export interface UnknownRecognitionItem {
  readonly confirmationLease: OperationConfirmationLease;
  readonly operation: UnknownRecognitionSafeContext;
  readonly observationReference: OperationObservationReference;
}

export interface UnknownRecognitionOfferPort {
  offer(item: UnknownRecognitionItem): UnknownRecognitionReceipt;
  accept(receipt: UnknownRecognitionReceipt): void;
}

export interface UnknownRecognitionDrainPort {
  drain(): readonly UnknownRecognitionReceipt[];
  take(receipt: UnknownRecognitionReceipt): UnknownRecognitionItem;
}

export interface UnknownRecognitionCoordinatorBundle {
  readonly handler: UnknownRecognitionOfferPort;
  /** Reserved for the future G10 confirmation owner. G07b never consumes it. */
  readonly drain: UnknownRecognitionDrainPort;
}

interface ReceiptState {
  readonly item: UnknownRecognitionItem;
  status: 'OFFERED' | 'ACCEPTED' | 'TAKEN';
}

const offerPorts = new WeakSet<object>();

export function assertUnknownRecognitionOfferPort(port: UnknownRecognitionOfferPort): void {
  if ((typeof port !== 'object' && typeof port !== 'function')
    || port === null
    || !offerPorts.has(port)) {
    throw new TypeError('unknown recognition offer port has no runtime provenance');
  }
}

export function createUnknownRecognitionCoordinatorBundle(): UnknownRecognitionCoordinatorBundle {
  const receipts = new WeakMap<object, ReceiptState>();
  const accepted: UnknownRecognitionReceipt[] = [];

  const requireReceipt = (receipt: UnknownRecognitionReceipt): ReceiptState => {
    if ((typeof receipt !== 'object' && typeof receipt !== 'function') || receipt === null) {
      throw new TypeError('unknown recognition receipt is invalid');
    }
    const state = receipts.get(receipt);
    if (state === undefined) throw new TypeError('unknown recognition receipt is foreign or forged');
    return state;
  };

  const handler: UnknownRecognitionOfferPort = Object.freeze({
    offer(item: UnknownRecognitionItem): UnknownRecognitionReceipt {
      const copied = copyItem(item);
      const receipt = Object.freeze({}) as UnknownRecognitionReceipt;
      receipts.set(receipt, { item: copied, status: 'OFFERED' });
      return receipt;
    },
    accept(receipt: UnknownRecognitionReceipt): void {
      const state = requireReceipt(receipt);
      if (state.status !== 'OFFERED') {
        throw new TypeError('unknown recognition receipt was already accepted');
      }
      state.status = 'ACCEPTED';
      accepted.push(receipt);
    },
  });

  const drain: UnknownRecognitionDrainPort = Object.freeze({
    drain(): readonly UnknownRecognitionReceipt[] {
      return Object.freeze([...accepted]);
    },
    take(receipt: UnknownRecognitionReceipt): UnknownRecognitionItem {
      const state = requireReceipt(receipt);
      if (state.status !== 'ACCEPTED') {
        throw new TypeError('unknown recognition item is not available for take');
      }
      const index = accepted.indexOf(receipt);
      if (index < 0) throw new TypeError('unknown recognition receipt is not queued');
      accepted.splice(index, 1);
      state.status = 'TAKEN';
      return state.item;
    },
  });

  offerPorts.add(handler);
  return Object.freeze({ handler, drain });
}

function copyItem(item: UnknownRecognitionItem): UnknownRecognitionItem {
  const record = exactDataRecord(
    item,
    ['confirmationLease', 'operation', 'observationReference'],
    'item',
  );
  assertConfirmationLease(record.confirmationLease);
  assertOpaque(record.observationReference, 'observation reference');
  const operation = exactDataRecord(
    record.operation,
    ['operationId', 'receivedAtMs', 'sequence'],
    'operation context',
  );
  if (typeof operation.operationId !== 'string' || operation.operationId.length === 0
    || !Number.isSafeInteger(operation.receivedAtMs)
    || typeof operation.sequence !== 'bigint') {
    throw new TypeError('unknown recognition operation context is invalid');
  }
  return Object.freeze({
    confirmationLease: record.confirmationLease as OperationConfirmationLease,
    operation: Object.freeze({
      operationId: operation.operationId,
      receivedAtMs: operation.receivedAtMs as number,
      sequence: operation.sequence,
    }),
    observationReference: record.observationReference as OperationObservationReference,
  });
}

function assertOpaque(value: unknown, label: string): asserts value is object {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null
    || utilTypes.isProxy(value) || !Object.isFrozen(value) || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(`unknown recognition ${label} is not opaque`);
  }
}

function assertConfirmationLease(value: unknown): asserts value is OperationConfirmationLease {
  const record = exactDataRecord(value, ['generation'], 'confirmation lease');
  if (!Object.isFrozen(value) || !Number.isSafeInteger(record.generation)
    || (record.generation as number) < 1) {
    throw new TypeError('unknown recognition confirmation lease is not canonical');
  }
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`unknown recognition ${label} must be a non-proxy record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`unknown recognition ${label} must be a plain record`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string')
    || expectedKeys.some((key) => !keys.includes(key))) {
    throw new TypeError(`unknown recognition ${label} has non-canonical keys`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`unknown recognition ${label} properties must be data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
