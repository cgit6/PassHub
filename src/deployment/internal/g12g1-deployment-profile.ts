import {
  DatasetDescriptorIntakeError,
  readCanonicalAtlasDatasetDescriptor,
} from './g12g1-dataset-descriptor-intake.js';

export type DeploymentProfile = 'LOCAL_SELF_HOSTED' | 'ATLAS_MANAGED';
export type ProductionDatasetName = 'passhub_demo' | 'passhub_demo_blue' | 'passhub_demo_green';

export interface ProductionDatasetTarget {
  readonly databaseName: ProductionDatasetName;
  readonly expectedDatasetEpoch: string | null;
}

export const LOCAL_PRODUCTION_DATASET_TARGET: ProductionDatasetTarget = Object.freeze({
  databaseName: 'passhub_demo',
  expectedDatasetEpoch: null,
});

export class DeploymentProfileConfigError extends Error {
  constructor(readonly code: 'DEPLOYMENT_PROFILE_INVALID' | 'DEPLOYMENT_PROFILE_PROBE_FORBIDDEN') {
    super(code);
    this.name = 'DeploymentProfileConfigError';
  }
}

export function parseDeploymentProfile(raw: string | undefined): DeploymentProfile {
  if (raw !== 'LOCAL_SELF_HOSTED' && raw !== 'ATLAS_MANAGED') {
    throw new DeploymentProfileConfigError('DEPLOYMENT_PROFILE_INVALID');
  }
  return raw;
}

export async function resolveProductionDatasetTarget(
  profile: DeploymentProfile,
  probeMode: boolean,
): Promise<ProductionDatasetTarget> {
  if (profile === 'LOCAL_SELF_HOSTED') {
    return LOCAL_PRODUCTION_DATASET_TARGET;
  }
  if (probeMode) throw new DeploymentProfileConfigError('DEPLOYMENT_PROFILE_PROBE_FORBIDDEN');
  const descriptor = await readCanonicalAtlasDatasetDescriptor();
  return Object.freeze({
    databaseName: descriptor.databaseName,
    expectedDatasetEpoch: descriptor.datasetEpoch,
  });
}

export function assertExpectedDatasetEpoch(
  target: ProductionDatasetTarget,
  actualDatasetEpoch: string,
): void {
  if (target.expectedDatasetEpoch !== null && target.expectedDatasetEpoch !== actualDatasetEpoch) {
    throw new DatasetDescriptorIntakeError('DATASET_DESCRIPTOR_EPOCH_MISMATCH');
  }
}
