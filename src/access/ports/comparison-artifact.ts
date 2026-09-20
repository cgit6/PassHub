const artifactBrand: unique symbol = Symbol('ComparisonArtifact');
const artifacts = new WeakSet<object>();

export interface ComparisonArtifact {
  readonly inputHmac: string;
  readonly comparisonReferenceId: string;
  readonly [artifactBrand]: true;
}

export interface ComparisonArtifactIssuer {
  create(input: unknown): ComparisonArtifact;
}

export function registerComparisonArtifact(
  artifact: object,
): asserts artifact is ComparisonArtifact {
  Object.defineProperty(artifact, artifactBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  artifacts.add(artifact);
}

export function isComparisonArtifact(value: unknown): value is ComparisonArtifact {
  return typeof value === 'object' && value !== null && artifacts.has(value);
}
