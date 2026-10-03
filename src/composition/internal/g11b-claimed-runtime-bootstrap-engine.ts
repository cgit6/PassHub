import type {
  OperationRegistry,
  OperationRegistryCapabilityIssuer,
} from '../../access/application/internal/operation-registry.js';
import {
  readClaimedPersistentRunForBridge,
  type ClaimedPersistentRun,
  type PersistentRunClaimer,
} from '../../deployment/internal/g11b-persistent-run-claim-engine.js';
import type { ConsumedRunTicket } from '../../deployment/internal/g11b-run-ticket-intake.js';
import type {
  VerifiedDataset,
  VerifiedDatasetVerifier,
} from '../../deployment/internal/g11b-dataset-verification.js';
import {
  readG10aAdmissionCompositionProvenance,
  type G10aAdmissionRuntimeComposition,
} from './g10a-admission-runtime-composition.js';
import {
  readG10aRuntimeHttpApplicationProvenance,
  type G10aRuntimeHttpApplication,
} from './g10a-runtime-http-application.js';
import { isG10aRuntimeCapabilitiesCurrent } from './g10a-runtime-owner.js';

const BOOTSTRAP_MINT = Symbol('G11b claimed runtime bootstrap mint');
const AUTHORITY_MINT = Symbol('G11b registry authority mint');
const REGISTRY_RECEIPT_MINT = Symbol('G11b registry composition receipt mint');
const PRODUCTION_PROOF_MINT = Symbol('G11b production composition proof mint');
const RECEIPT_MINT = Symbol('G11b bootstrap receipt mint');
const GATE_MINT = Symbol('G11b local service gate mint');
const claimedRunsUsedForBootstrap = new WeakSet<ClaimedPersistentRun>();

export type LocalServiceGateState = 'COMPOSING' | 'AUTHORIZABLE' | 'OPEN' | 'SHUTDOWN' | 'FAILED';

export type ClaimedRuntimeBootstrapFailure =
  | 'CLAIMED_RUNTIME_BOOTSTRAP_INVALID'
  | 'CLAIMED_RUNTIME_BOOTSTRAP_ALREADY_USED'
  | 'REGISTRY_AUTHORITY_ALREADY_USED'
  | 'REGISTRY_COMPOSITION_FAILED'
  | 'BOOTSTRAP_LIFECYCLE_INVALID';

export class ClaimedRuntimeBootstrapError extends Error {
  constructor(readonly code: ClaimedRuntimeBootstrapFailure) {
    super(code);
    this.name = 'ClaimedRuntimeBootstrapError';
  }
}

export interface RegistryCompositionOptions {
  readonly registryId: string;
  readonly ownerId: string;
  readonly sameArtifact: (existing: unknown, candidate: unknown) => boolean;
  readonly assertOwnerCurrent: () => unknown;
  readonly assertContinuationEvidence: (evidence: unknown) => unknown;
  readonly capacity?: number;
}

export interface ClaimedRegistryComposition {
  readonly registry: OperationRegistry;
  readonly capabilities: OperationRegistryCapabilityIssuer;
  readonly registryReceipt: RegistryCompositionReceipt;
}

export interface RegistryCompositionBridge {
  readonly compose: (
    facts: Readonly<{ readonly datasetEpoch: string; readonly processRunId: string }>,
    options: RegistryCompositionOptions,
  ) => Readonly<{
    readonly registry: OperationRegistry;
    readonly capabilities: OperationRegistryCapabilityIssuer;
  }>;
}

export class BootstrapReceipt {
  declare private readonly nominalBootstrapReceipt: void;

  constructor(authority: symbol) {
    if (authority !== RECEIPT_MINT) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    Object.freeze(this);
  }
}

export class RegistryCompositionReceipt {
  declare private readonly nominalRegistryCompositionReceipt: void;

  constructor(authority: symbol) {
    if (authority !== REGISTRY_RECEIPT_MINT) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    Object.freeze(this);
  }
}

/** Issued only after the fixed completed HTTP/admission provenance check. */
export class ProductionCompositionProof {
  declare private readonly nominalProductionCompositionProof: void;

  constructor(authority: symbol) {
    if (authority !== PRODUCTION_PROOF_MINT) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    Object.freeze(this);
  }
}

export class LocalServiceGate {
  declare private readonly nominalLocalServiceGate: void;

  constructor(authority: symbol) {
    if (authority !== GATE_MINT) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    Object.freeze(this);
  }

  getState(): LocalServiceGateState {
    const state = gateStates.get(this);
    if (state === undefined) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    if (state.state === 'OPEN' && state.isCompositionCurrent !== undefined && !state.isCompositionCurrent()) {
      state.state = 'SHUTDOWN';
    }
    return state.state;
  }

  isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  beginShutdown(): void {
    const state = gateStates.get(this);
    if (state === undefined) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    state.state = 'SHUTDOWN';
  }
}

export class RegistryAuthority {
  declare private readonly nominalRegistryAuthority: void;

  constructor(authority: symbol) {
    if (authority !== AUTHORITY_MINT) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    Object.freeze(this);
  }

  composeRegistry(options: RegistryCompositionOptions): ClaimedRegistryComposition {
    const authority = authorityStates.get(this);
    if (authority === undefined) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    const runtime = authority.runtime;
    if (authority.used || gateState(runtime).state !== 'COMPOSING') {
      fail(runtime);
      invalid('REGISTRY_AUTHORITY_ALREADY_USED');
    }
    authority.used = true;
    let composition: ReturnType<RegistryCompositionBridge['compose']>;
    try {
      composition = runtime.bridge.compose(Object.freeze({
        datasetEpoch: runtime.datasetEpoch,
        processRunId: runtime.processRunId,
      }), options);
    } catch {
      fail(runtime);
      invalid('REGISTRY_COMPOSITION_FAILED');
    }
    const registryReceipt = new RegistryCompositionReceipt(REGISTRY_RECEIPT_MINT);
    registryReceiptStates.set(registryReceipt, Object.freeze({
      runtime, registry: composition.registry, capabilities: composition.capabilities,
    }));
    return Object.freeze({
      registry: composition.registry,
      capabilities: composition.capabilities,
      registryReceipt,
    });
  }
}

export class ClaimedRuntimeBootstrap {
  declare private readonly nominalClaimedRuntimeBootstrap: void;

  constructor(authority: symbol) {
    if (authority !== BOOTSTRAP_MINT) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    Object.freeze(this);
  }

  takeRegistryAuthority(): RegistryAuthority {
    const runtime = runtimeStates.get(this);
    if (runtime === undefined) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    if (runtime.authorityTaken || gateState(runtime).state !== 'COMPOSING') {
      fail(runtime);
      invalid('REGISTRY_AUTHORITY_ALREADY_USED');
    }
    runtime.authorityTaken = true;
    const authority = new RegistryAuthority(AUTHORITY_MINT);
    authorityStates.set(authority, { runtime, used: false });
    return authority;
  }

  markCompositionComplete(proof: ProductionCompositionProof): BootstrapReceipt {
    const runtime = runtimeStates.get(this);
    if (runtime === undefined) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    const proofState = productionProofStates.get(proof);
    if (gateState(runtime).state !== 'COMPOSING' || proofState === undefined
      || proofState.runtime !== runtime || usedProductionProofs.has(proof)) {
      fail(runtime);
      invalid('BOOTSTRAP_LIFECYCLE_INVALID');
    }
    if (!proofState.isCompositionCurrent()) {
      fail(runtime);
      invalid('BOOTSTRAP_LIFECYCLE_INVALID');
    }
    usedProductionProofs.add(proof);
    gateState(runtime).state = 'AUTHORIZABLE';
    const receipt = new BootstrapReceipt(RECEIPT_MINT);
    receiptStates.set(receipt, Object.freeze({
      runtime, isCompositionCurrent: proofState.isCompositionCurrent, isLifecycleCurrent: proofState.isLifecycleCurrent,
    }));
    return receipt;
  }

  authorizeReady(receipt: BootstrapReceipt): void {
    const runtime = runtimeStates.get(this);
    if (runtime === undefined) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    const receiptState = receiptStates.get(receipt);
    if (gateState(runtime).state !== 'AUTHORIZABLE' || receiptState === undefined
      || receiptState.runtime !== runtime || usedReceipts.has(receipt)) {
      fail(runtime);
      invalid('BOOTSTRAP_LIFECYCLE_INVALID');
    }
    if (!receiptState.isCompositionCurrent()) {
      fail(runtime);
      invalid('BOOTSTRAP_LIFECYCLE_INVALID');
    }
    usedReceipts.add(receipt);
    gateState(runtime).isCompositionCurrent = receiptState.isLifecycleCurrent;
    gateState(runtime).state = 'OPEN';
  }
}

export interface ClaimedRuntimeBootstrapBundle {
  readonly bootstrap: ClaimedRuntimeBootstrap;
  readonly serviceGate: LocalServiceGate;
}

export type ClaimedRuntimeBootstrapClaimer = PersistentRunClaimer;
export type ClaimedRuntimeBootstrapClaim = ClaimedPersistentRun;

interface RuntimeState {
  readonly bridge: RegistryCompositionBridge;
  readonly serviceGate: LocalServiceGate;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  authorityTaken: boolean;
}

interface GateState {
  state: LocalServiceGateState;
  isCompositionCurrent?: () => boolean;
}

const runtimeStates = new WeakMap<ClaimedRuntimeBootstrap, RuntimeState>();
const gateStates = new WeakMap<LocalServiceGate, GateState>();
const authorityStates = new WeakMap<RegistryAuthority, { readonly runtime: RuntimeState; used: boolean }>();
const registryReceiptStates = new WeakMap<RegistryCompositionReceipt, {
  readonly runtime: RuntimeState;
  readonly registry: OperationRegistry;
  readonly capabilities: OperationRegistryCapabilityIssuer;
}>();
const productionProofStates = new WeakMap<ProductionCompositionProof, {
  readonly runtime: RuntimeState;
  readonly isCompositionCurrent: () => boolean;
  readonly isLifecycleCurrent: () => boolean;
}>();
const receiptStates = new WeakMap<BootstrapReceipt, {
  readonly runtime: RuntimeState;
  readonly isCompositionCurrent: () => boolean;
  readonly isLifecycleCurrent: () => boolean;
}>();
const usedProductionProofs = new WeakSet<ProductionCompositionProof>();
const usedReceipts = new WeakSet<BootstrapReceipt>();
const usedRegistryReceipts = new WeakSet<RegistryCompositionReceipt>();

/** Fixed private completion seam; all structural or cross-runtime assemblies reject. */
export function completeClaimedRuntimeProductionComposition(
  bootstrap: ClaimedRuntimeBootstrap,
  registryReceipt: RegistryCompositionReceipt,
  admission: G10aAdmissionRuntimeComposition,
  application: G10aRuntimeHttpApplication,
): ProductionCompositionProof {
  const runtime = runtimeStates.get(bootstrap);
  if (runtime === undefined) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
  try {
    const registry = registryReceiptStates.get(registryReceipt);
    const composed = readG10aAdmissionCompositionProvenance(admission);
    const http = readG10aRuntimeHttpApplicationProvenance(application);
    if (gateState(runtime).state !== 'COMPOSING' || registry === undefined
      || registry.runtime !== runtime || usedRegistryReceipts.has(registryReceipt)
      || composed.registry !== registry.registry || composed.capabilities !== registry.capabilities
      || composed.epoch !== runtime.datasetEpoch || composed.run !== runtime.processRunId
      || composed.runtime === undefined || composed.runtime !== http.runtime
      || admission.handler !== http.handler || http.isClosing()
      || !isG10aRuntimeCapabilitiesCurrent(http.runtime)) invalid('BOOTSTRAP_LIFECYCLE_INVALID');
    const snapshot = http.runtime.control.snapshot();
    if (snapshot.epoch !== runtime.datasetEpoch || snapshot.run !== runtime.processRunId
      || snapshot.maintenance.active) invalid('BOOTSTRAP_LIFECYCLE_INVALID');
    usedRegistryReceipts.add(registryReceipt);
    const proof = new ProductionCompositionProof(PRODUCTION_PROOF_MINT);
    const isLifecycleCurrent = () => !http.isClosing() && isG10aRuntimeCapabilitiesCurrent(http.runtime);
    const isCompositionCurrent = () => {
      if (!isLifecycleCurrent()) return false;
      const current = http.runtime.control.snapshot();
      return current.epoch === runtime.datasetEpoch && current.run === runtime.processRunId && !current.maintenance.active;
    };
    productionProofStates.set(proof, Object.freeze({ runtime, isCompositionCurrent, isLifecycleCurrent }));
    return proof;
  } catch {
    fail(runtime);
    invalid('BOOTSTRAP_LIFECYCLE_INVALID');
  }
}

/** Private engine factory; the production facade fixes the G05c bridge. */
export function createClaimedRuntimeBootstrapWithBridge(
  claimer: PersistentRunClaimer,
  claim: ClaimedPersistentRun,
  target: object,
  verifier: VerifiedDatasetVerifier,
  verified: VerifiedDataset,
  ticket: ConsumedRunTicket,
  bridge: RegistryCompositionBridge,
): ClaimedRuntimeBootstrapBundle {
  let facts: ReturnType<typeof readClaimedPersistentRunForBridge>;
  try {
    facts = readClaimedPersistentRunForBridge(claimer, claim, target, verifier, verified, ticket);
  } catch {
    invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
  }
  if (claimedRunsUsedForBootstrap.has(claim)) invalid('CLAIMED_RUNTIME_BOOTSTRAP_ALREADY_USED');
  claimedRunsUsedForBootstrap.add(claim);

  const serviceGate = createGate('COMPOSING');
  const bootstrap = new ClaimedRuntimeBootstrap(BOOTSTRAP_MINT);
  runtimeStates.set(bootstrap, {
    bridge,
    serviceGate,
    datasetEpoch: facts.datasetEpoch,
    processRunId: facts.processRunId,
    authorityTaken: false,
  });
  return Object.freeze({ bootstrap, serviceGate });
}

export function createOrdinaryReadOnlyLocalServiceGate(): LocalServiceGate {
  return createGate('FAILED');
}

function createGate(initial: LocalServiceGateState): LocalServiceGate {
  const gate = new LocalServiceGate(GATE_MINT);
  gateStates.set(gate, { state: initial });
  return gate;
}

function gateState(runtime: RuntimeState): GateState {
  const state = gateStates.get(runtime.serviceGate);
  if (state === undefined) invalid('CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
  return state;
}

function fail(runtime: RuntimeState): void {
  const state = gateState(runtime);
  if (state.state !== 'SHUTDOWN') state.state = 'FAILED';
}

function invalid(code: ClaimedRuntimeBootstrapFailure): never {
  throw new ClaimedRuntimeBootstrapError(code);
}
