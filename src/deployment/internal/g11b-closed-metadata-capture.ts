import { types as nodeTypes } from 'node:util';

import { G04B_STARTUP_VECTORS } from '../../infrastructure/mongo/g04b-schema.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ClosedMetadataFacts {
  readonly datasetEpoch: string;
  readonly writeRunClaim: null | Readonly<{
    readonly runId: string;
    readonly claimedAtMillis: number;
  }>;
}

export class ClosedMetadataCaptureError extends Error {
  constructor() {
    super('CLOSED_METADATA_INVALID');
    this.name = 'ClosedMetadataCaptureError';
  }
}

/** Shared private capture for b2 verification and b3 claim observations. */
export function captureClosedMetadata(input: unknown): ClosedMetadataFacts {
  const metadata = captureExactObject(input, [
    '_id', 'kind', 'datasetEpoch', 'comparisonReferenceId', 'frameVersion',
    'startupVectors', 'qrGuardVersion', 'faceGuardVersion', 'slotCount', 'writeRunClaim',
  ]);
  if (metadata._id !== 'system' || metadata.kind !== 'system' || metadata.frameVersion !== 'v2'
    || typeof metadata.datasetEpoch !== 'string' || !UUID_V4.test(metadata.datasetEpoch)
    || typeof metadata.comparisonReferenceId !== 'string' || !UUID_V4.test(metadata.comparisonReferenceId)
    || !Number.isSafeInteger(metadata.qrGuardVersion) || (metadata.qrGuardVersion as number) < 0
    || !Number.isSafeInteger(metadata.faceGuardVersion) || (metadata.faceGuardVersion as number) < 0
    || !Number.isSafeInteger(metadata.slotCount) || (metadata.slotCount as number) < 0
    || (metadata.slotCount as number) > 4096) throw new ClosedMetadataCaptureError();
  captureStartupVectors(metadata.startupVectors);

  let writeRunClaim: ClosedMetadataFacts['writeRunClaim'];
  if (metadata.writeRunClaim === null) {
    writeRunClaim = null;
  } else {
    const claim = captureExactObject(metadata.writeRunClaim, ['runId', 'claimedAt']);
    if (typeof claim.runId !== 'string' || !UUID_V4.test(claim.runId)
      || !(claim.claimedAt instanceof Date) || nodeTypes.isProxy(claim.claimedAt)
      || Object.getPrototypeOf(claim.claimedAt) !== Date.prototype
      || Reflect.ownKeys(claim.claimedAt).length !== 0
      || !Number.isFinite(claim.claimedAt.getTime())) throw new ClosedMetadataCaptureError();
    writeRunClaim = Object.freeze({
      runId: claim.runId,
      claimedAtMillis: claim.claimedAt.getTime(),
    });
  }
  return Object.freeze({ datasetEpoch: metadata.datasetEpoch, writeRunClaim });
}

function captureStartupVectors(input: unknown): void {
  if (nodeTypes.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new ClosedMetadataCaptureError();
  }
  const keys = Reflect.ownKeys(input);
  const expectedKeys: readonly PropertyKey[] = ['0', '1', '2', 'length'];
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    throw new ClosedMetadataCaptureError();
  }
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  if (length === undefined || !Object.hasOwn(length, 'value') || length.value !== 3) {
    throw new ClosedMetadataCaptureError();
  }
  for (let index = 0; index < 3; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new ClosedMetadataCaptureError();
    }
    const vector = captureExactObject(descriptor.value, ['name', 'expectedFrameHex', 'expectedHmacHex']);
    const expected = G04B_STARTUP_VECTORS[index];
    if (expected === undefined || vector.name !== expected.name
      || vector.expectedFrameHex !== expected.expectedFrameHex
      || vector.expectedHmacHex !== expected.expectedHmacHex) throw new ClosedMetadataCaptureError();
  }
}

function captureExactObject(input: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || nodeTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw new ClosedMetadataCaptureError();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    throw new ClosedMetadataCaptureError();
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new ClosedMetadataCaptureError();
    }
    result[key] = descriptor.value;
  }
  return result;
}
