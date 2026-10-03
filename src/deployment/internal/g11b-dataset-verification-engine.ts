import { types as nodeTypes } from 'node:util';

import { G04B_STARTUP_VECTORS } from '../../infrastructure/mongo/g04b-schema.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_MINT = Symbol('G11b verified dataset token mint');
const VERIFIER_MINT = Symbol('G11b dataset verifier mint');

export type DatasetVerificationFailure =
  | 'DATASET_VERIFICATION_FAILED'
  | 'VERIFIED_DATASET_INVALID';

export interface VerifiedDatasetFacts {
  readonly datasetEpoch: string;
  readonly observedWriteRunClaim: 'NULL' | 'PRESENT';
}

export class DatasetVerificationError extends Error {
  constructor(readonly code: DatasetVerificationFailure) {
    super(code);
    this.name = 'DatasetVerificationError';
  }
}

/** Empty nominal capability. All authority and facts are held in private WeakMaps. */
export class VerifiedDataset {
  declare private readonly nominalVerifiedDataset: void;

  constructor(authority: symbol) {
    if (authority !== TOKEN_MINT) throw new DatasetVerificationError('VERIFIED_DATASET_INVALID');
    Object.freeze(this);
  }
}

export class VerifiedDatasetVerifier {
  declare private readonly nominalVerifiedDatasetVerifier: void;

  constructor(authority: symbol) {
    if (authority !== VERIFIER_MINT) throw new DatasetVerificationError('VERIFIED_DATASET_INVALID');
    Object.freeze(this);
  }

  async verify(): Promise<VerifiedDataset> {
    const state = verifierStates.get(this);
    if (state === undefined) throw new DatasetVerificationError('VERIFIED_DATASET_INVALID');
    let projection: unknown;
    try {
      projection = await state.inspect();
      const facts = captureProjection(projection);
      const token = new VerifiedDataset(TOKEN_MINT);
      tokenStates.set(token, Object.freeze({ owner: this, target: state.target, facts }));
      return token;
    } catch {
      throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
    }
  }
}

type Inspector = () => unknown | Promise<unknown>;

interface VerifierState {
  readonly inspect: Inspector;
  readonly target: object;
}

interface TokenState {
  readonly owner: VerifiedDatasetVerifier;
  readonly target: object;
  readonly facts: VerifiedDatasetFacts;
}

const verifierStates = new WeakMap<VerifiedDatasetVerifier, VerifierState>();
const tokenStates = new WeakMap<VerifiedDataset, TokenState>();

/** Shared engine constructor; importer graph is locked to facade and test support. */
export function createVerifiedDatasetVerifierWithInspector(
  target: object,
  inspect: Inspector,
): VerifiedDatasetVerifier {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null
    || typeof inspect !== 'function') {
    throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
  }
  const verifier = new VerifiedDatasetVerifier(VERIFIER_MINT);
  verifierStates.set(verifier, Object.freeze({ target, inspect }));
  return verifier;
}

/** Private composition reader. It never invokes the inspector or any external capability. */
export function readVerifiedDatasetForRuntime(
  verifier: VerifiedDatasetVerifier,
  token: VerifiedDataset,
  target: object,
): VerifiedDatasetFacts {
  const verifierState = verifierStates.get(verifier);
  const tokenState = tokenStates.get(token);
  if (verifierState === undefined || tokenState === undefined || tokenState.owner !== verifier
    || verifierState.target !== target || tokenState.target !== target) {
    throw new DatasetVerificationError('VERIFIED_DATASET_INVALID');
  }
  return Object.freeze({
    datasetEpoch: tokenState.facts.datasetEpoch,
    observedWriteRunClaim: tokenState.facts.observedWriteRunClaim,
  });
}

function captureProjection(input: unknown): VerifiedDatasetFacts {
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
    || (metadata.slotCount as number) > 4096) {
    throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
  }
  captureStartupVectors(metadata.startupVectors);

  let observedWriteRunClaim: 'NULL' | 'PRESENT';
  if (metadata.writeRunClaim === null) {
    observedWriteRunClaim = 'NULL';
  } else {
    const claim = captureExactObject(metadata.writeRunClaim, ['runId', 'claimedAt']);
    if (typeof claim.runId !== 'string' || !UUID_V4.test(claim.runId)
      || !(claim.claimedAt instanceof Date) || nodeTypes.isProxy(claim.claimedAt)
      || Object.getPrototypeOf(claim.claimedAt) !== Date.prototype
      || Reflect.ownKeys(claim.claimedAt).length !== 0
      || !Number.isFinite(claim.claimedAt.getTime())) {
      throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
    }
    observedWriteRunClaim = 'PRESENT';
  }
  return Object.freeze({ datasetEpoch: metadata.datasetEpoch, observedWriteRunClaim });
}

function captureStartupVectors(input: unknown): void {
  if (nodeTypes.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
  }
  const keys = Reflect.ownKeys(input);
  const expectedKeys: readonly PropertyKey[] = ['0', '1', '2', 'length'];
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
  }
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  if (length === undefined || !Object.hasOwn(length, 'value') || length.value !== 3) {
    throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
  }
  for (let index = 0; index < 3; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
    }
    const vector = descriptor.value;
    const captured = captureExactObject(vector, ['name', 'expectedFrameHex', 'expectedHmacHex']);
    const expected = G04B_STARTUP_VECTORS[index];
    if (expected === undefined || captured.name !== expected.name
      || captured.expectedFrameHex !== expected.expectedFrameHex
      || captured.expectedHmacHex !== expected.expectedHmacHex) {
      throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
    }
  }
}

function captureExactObject(input: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || nodeTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new DatasetVerificationError('DATASET_VERIFICATION_FAILED');
    }
    result[key] = descriptor.value;
  }
  return result;
}
