import type { ComparisonArtifact } from '../../ports/comparison-artifact.js';
import type {
  RecognitionAttemptCommand,
  RecognitionAttemptResult,
  RecognizeAttempt,
} from '../use-cases.js';

const artifactBoundExecutors = new WeakSet<object>();

export function registerArtifactBoundRecognizeAttempt(executor: object): void {
  artifactBoundExecutors.add(executor);
}

export function isArtifactBoundRecognizeAttempt(value: unknown): value is ArtifactBoundRecognizeAttempt {
  return typeof value === 'object' && value !== null && artifactBoundExecutors.has(value);
}

/** Internal bridge: G08b may hand the one validated artifact into the use case. */
export interface ArtifactBoundRecognizeAttempt extends RecognizeAttempt {
  executeWithComparisonArtifact(
    input: RecognitionAttemptCommand,
    artifact: ComparisonArtifact,
  ): Promise<RecognitionAttemptResult>;
}

export function executeRecognitionWithArtifact(
  executor: RecognizeAttempt,
  input: RecognitionAttemptCommand,
  artifact: ComparisonArtifact,
): Promise<RecognitionAttemptResult> {
  if (!isArtifactBoundRecognizeAttempt(executor)) {
    throw new TypeError('recognition executor lacks trusted artifact bridge');
  }
  return executor.executeWithComparisonArtifact(input, artifact);
}
