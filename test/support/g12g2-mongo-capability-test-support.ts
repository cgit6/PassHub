import type { DeploymentProfile } from '../../src/deployment/internal/g12g1-deployment-profile.js';
import {
  MongoCapabilityVerificationError,
  verifyMongoCapabilitiesWithRunner,
  type MongoCapabilityCommand,
} from '../../src/deployment/internal/g12g2-mongo-capability-engine.js';

export { MongoCapabilityVerificationError, type MongoCapabilityCommand };

/** Test-only command seam. Production binds the exact Mongo admin database. */
export async function verifyMongoCapabilitiesForTest(
  profile: DeploymentProfile,
  runCommand: (command: MongoCapabilityCommand) => Promise<unknown>,
): Promise<void> {
  await verifyMongoCapabilitiesWithRunner(profile, runCommand);
}
