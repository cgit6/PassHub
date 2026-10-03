import {
  readProcessIdentityWithEngine,
  type ProcessIdentityEngineFaults,
  type ProcessIdentityEngineOptions,
} from '../../src/deployment/internal/g11b-process-identity-engine.js';

export type G11bProcessIdentityTestFaults = ProcessIdentityEngineFaults;
export type G11bProcessIdentityTestOptions = ProcessIdentityEngineOptions;

/** Test-only configurable real-FS adapter; production imports are statically forbidden. */
export function createProcessIdentityIntakeForFsTest(
  directory: string,
  options: G11bProcessIdentityTestOptions = {},
): () => Promise<string> {
  return async (): Promise<string> => readProcessIdentityWithEngine(directory, options);
}
