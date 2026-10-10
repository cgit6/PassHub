import type { DeploymentProfile } from './g12g1-deployment-profile.js';

const LOCAL_MONGO_VERSION = '8.0.32';

export type MongoCapabilityCommand = Readonly<{ readonly buildInfo: 1 } | { readonly hello: 1 }>;
export type MongoCapabilityCommandRunner = (command: MongoCapabilityCommand) => Promise<unknown>;

export class MongoCapabilityVerificationError extends Error {
  readonly code = 'MONGO_CAPABILITY_VERIFICATION_FAILED' as const;

  constructor() {
    super('MONGO_CAPABILITY_VERIFICATION_FAILED');
    this.name = 'MongoCapabilityVerificationError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertLocalBuildInfo(value: unknown): void {
  if (!isRecord(value) || value.version !== LOCAL_MONGO_VERSION) {
    throw new MongoCapabilityVerificationError();
  }
}

function assertLocalHello(value: unknown): void {
  if (!isRecord(value) || value.setName !== 'rs0' || value.isWritablePrimary !== true
    || !Array.isArray(value.hosts) || value.hosts.length !== 1
    || typeof value.hosts[0] !== 'string' || value.hosts[0].length === 0) {
    throw new MongoCapabilityVerificationError();
  }
}

function assertAtlasHello(value: unknown): void {
  if (!isRecord(value) || value.isWritablePrimary !== true
    || !Number.isSafeInteger(value.logicalSessionTimeoutMinutes)
    || (value.logicalSessionTimeoutMinutes as number) <= 0) {
    throw new MongoCapabilityVerificationError();
  }
}

/**
 * Deployment-private verifier. It performs only read-only administrative
 * commands; schema/index inspection remains owned by the existing dataset
 * verifier and no capability probe may mutate application data.
 */
export async function verifyMongoCapabilitiesWithRunner(
  profile: DeploymentProfile,
  runCommand: MongoCapabilityCommandRunner,
): Promise<void> {
  try {
    if (profile === 'LOCAL_SELF_HOSTED') {
      assertLocalBuildInfo(await runCommand(Object.freeze({ buildInfo: 1 })));
      assertLocalHello(await runCommand(Object.freeze({ hello: 1 })));
      return;
    }
    if (profile === 'ATLAS_MANAGED') {
      assertAtlasHello(await runCommand(Object.freeze({ hello: 1 })));
      return;
    }
    throw new MongoCapabilityVerificationError();
  } catch {
    // Never retain or expose driver errors, topology values, hosts, URIs, or versions.
    throw new MongoCapabilityVerificationError();
  }
}
