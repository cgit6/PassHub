import { captureClosedMetadata } from './g11b-closed-metadata-capture.js';
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
  const metadata = captureClosedMetadata(input);
  return Object.freeze({
    datasetEpoch: metadata.datasetEpoch,
    observedWriteRunClaim: metadata.writeRunClaim === null ? 'NULL' : 'PRESENT',
  });
}
