import type { MongoClient } from 'mongodb';

import type { DeploymentProfile } from './g12g1-deployment-profile.js';
import {
  verifyMongoCapabilitiesWithRunner,
} from './g12g2-mongo-capability-engine.js';

export { MongoCapabilityVerificationError } from './g12g2-mongo-capability-engine.js';

/** Production-private facade: capability commands always target admin. */
export async function verifyProductionMongoCapabilities(
  mongo: MongoClient,
  profile: DeploymentProfile,
): Promise<void> {
  const admin = mongo.db('admin');
  await verifyMongoCapabilitiesWithRunner(profile, async (command) => admin.command(command));
}
