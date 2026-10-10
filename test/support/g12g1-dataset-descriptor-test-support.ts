import {
  readDatasetDescriptorWithEngine,
  type DatasetDescriptorEngineFaults,
  type DatasetDescriptorEngineOptions,
} from '../../src/deployment/internal/g12g1-dataset-descriptor-engine.js';

export type G12g1DatasetDescriptorTestFaults = DatasetDescriptorEngineFaults;
export type G12g1DatasetDescriptorTestOptions = DatasetDescriptorEngineOptions;

/** Test-only configurable real-FS adapter; production imports are statically forbidden. */
export function createDatasetDescriptorIntakeForFsTest(
  directory: string,
  options: G12g1DatasetDescriptorTestOptions = {},
) {
  return async () => readDatasetDescriptorWithEngine(directory, options);
}
