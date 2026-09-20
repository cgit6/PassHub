export {
  type AccessScopeContext,
  type AccessQueryPort,
  type FaceMappingSnapshot,
  type ManagementChangePlan,
  type ManagementChangeResult,
  type ManagementDataPort,
  type QualificationSnapshot,
  type RecognitionDataPort,
  type RecognitionPersistenceResult,
  type RecognitionResultPlan,
  type RedactedAccessEventProjection,
  type RedactedQualificationProjection,
  type ResolvedIdentitySnapshot,
  type SourceFacts,
  type SourceFactsPort,
} from './access-ports.js';
export {
  isComparisonArtifact,
  type ComparisonArtifact,
  type ComparisonArtifactIssuer,
} from './comparison-artifact.js';
export {
  type ManagementPersistenceEnvelope,
  type RecognitionPersistenceEnvelope,
} from './trusted-operation.js';
