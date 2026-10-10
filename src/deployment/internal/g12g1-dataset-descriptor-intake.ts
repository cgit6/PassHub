import { readDatasetDescriptorWithEngine } from './g12g1-dataset-descriptor-engine.js';

export {
  DatasetDescriptorIntakeError,
  type DatasetDescriptorIntakeFailure,
} from './g12g1-dataset-descriptor-engine.js';

export const G12G1_DATASET_DESCRIPTOR_DIRECTORY = '/run/passhub/dataset';
export const G12G1_DATASET_DESCRIPTOR_PATH = `${G12G1_DATASET_DESCRIPTOR_DIRECTORY}/active-dataset.json`;

/** Sole production intake. Neither its directory nor its file name is configurable. */
export async function readCanonicalAtlasDatasetDescriptor() {
  return readDatasetDescriptorWithEngine(G12G1_DATASET_DESCRIPTOR_DIRECTORY);
}
