import {
  createOperationRegistry,
  createOperationRegistryCapabilityIssuer,
} from '../../access/application/internal/operation-registry.js';
import type { ConsumedRunTicket } from '../../deployment/internal/g11b-run-ticket-intake.js';
import type {
  VerifiedDataset,
  VerifiedDatasetVerifier,
} from '../../deployment/internal/g11b-dataset-verification.js';
import {
  createClaimedRuntimeBootstrapWithBridge,
  createOrdinaryReadOnlyLocalServiceGate,
  type ClaimedRuntimeBootstrapClaim,
  type ClaimedRuntimeBootstrapClaimer,
  type ClaimedRuntimeBootstrapBundle,
} from './g11b-claimed-runtime-bootstrap-engine.js';

export {
  BootstrapReceipt,
  ClaimedRuntimeBootstrap,
  ClaimedRuntimeBootstrapError,
  LocalServiceGate,
  ProductionCompositionProof,
  RegistryAuthority,
  RegistryCompositionReceipt,
  type ClaimedRegistryComposition,
  type ClaimedRuntimeBootstrapClaim,
  type ClaimedRuntimeBootstrapClaimer,
  type ClaimedRuntimeBootstrapBundle,
  type ClaimedRuntimeBootstrapFailure,
  type LocalServiceGateState,
  type RegistryCompositionOptions,
} from './g11b-claimed-runtime-bootstrap-engine.js';

/** Production-private bridge from an exact claimed-run provenance into G05c. */
export function createClaimedRuntimeBootstrap(
  claimer: ClaimedRuntimeBootstrapClaimer,
  claim: ClaimedRuntimeBootstrapClaim,
  target: object,
  verifier: VerifiedDatasetVerifier,
  verified: VerifiedDataset,
  ticket: ConsumedRunTicket,
): ClaimedRuntimeBootstrapBundle {
  return createClaimedRuntimeBootstrapWithBridge(
    claimer,
    claim,
    target,
    verifier,
    verified,
    ticket,
    {
      compose: (facts, options) => {
        const capabilities = createOperationRegistryCapabilityIssuer({
          registryId: options.registryId,
          datasetEpoch: facts.datasetEpoch,
          processRunId: facts.processRunId,
          ownerId: options.ownerId,
          sameArtifact: options.sameArtifact,
        });
        const registry = createOperationRegistry({
          capabilities,
          writeRunClaim: capabilities.issueWriteRunClaim('WRITABLE'),
          assertOwnerCurrent: options.assertOwnerCurrent,
          assertContinuationEvidence: options.assertContinuationEvidence,
          ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
        });
        return Object.freeze({ registry, capabilities });
      },
    },
  );
}

/** Ordinary same-epoch boot receives no authority path and can never open itself. */
export function createOrdinaryReadOnlyServiceGate(): ReturnType<typeof createOrdinaryReadOnlyLocalServiceGate> {
  return createOrdinaryReadOnlyLocalServiceGate();
}
