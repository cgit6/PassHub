import type {
  ManageQualifications,
  ReadAccessData,
  RecognizeAttempt,
} from '../access/application/index.js';
import {
  ManagementAccessScope as ManagementScopeImplementation,
  RecognitionAccessScope as RecognitionScopeImplementation,
  type ManagementScope,
  type RecognitionScope,
  type ScopeOptions,
} from '../access/application/access-scopes.js';
import {
  ManageQualificationsImplementation,
  RecognizeAttemptImplementation,
} from '../access/application/use-cases.js';
import type {
  AccessQueryPort,
  ManagementDataPort,
  RedactedAccessEventProjection,
  RedactedQualificationProjection,
  RecognitionDataPort,
  SourceFactsPort,
} from '../access/ports/index.js';
import type { ComparisonPort } from '../access/application/comparison/comparison-port.js';

export interface AccessCompositionDependencies {
  readonly management: ManagementDataPort;
  readonly recognition: RecognitionDataPort;
  readonly sourceFacts: SourceFactsPort;
  readonly query: AccessQueryPort;
  readonly epoch: string;
  readonly sourceId: string;
  /** Required for the production composition; the legacy overload exists only for old fakes. */
  readonly comparison: ComparisonPort;
}

export interface AccessComposition {
  readonly manageQualifications: ManageQualifications;
  readonly recognizeAttempt: RecognizeAttempt;
  readonly readAccessData: ReadAccessData;
}

class ReadAccessDataWrapper implements ReadAccessData {
  public constructor(private readonly query: AccessQueryPort) {}

  public qualifications(
    input: Readonly<{ limit: number; cursor?: string }>,
  ): Promise<readonly RedactedQualificationProjection[]> {
    return this.query.qualifications(input);
  }

  public inside(
    input: Readonly<{ limit: number; cursor?: string }>,
  ): Promise<readonly RedactedQualificationProjection[]> {
    return this.query.inside(input);
  }

  public events(
    input: Readonly<{
      limit: number;
      cursor?: string;
      qualificationId?: string;
      outcome?: 'ACCEPTED' | 'REJECTED';
      reasonCode?: string;
    }>,
  ): Promise<readonly RedactedAccessEventProjection[]> {
    return this.query.events(input);
  }
}

function assertDependencies(
  dependencies: AccessCompositionDependencies,
): void {
  if (typeof dependencies !== 'object' || dependencies === null) {
    throw new TypeError('composition dependencies are required');
  }
  for (const [name, value] of [
    ['management', dependencies.management],
    ['recognition', dependencies.recognition],
    ['sourceFacts', dependencies.sourceFacts],
    ['query', dependencies.query],
  ] as const) {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError(`${name} port is required`);
    }
  }
  if (typeof dependencies.epoch !== 'string' || dependencies.epoch.length === 0) {
    throw new TypeError('composition epoch is required');
  }
  if (typeof dependencies.sourceId !== 'string' || dependencies.sourceId.length === 0) {
    throw new TypeError('composition sourceId is required');
  }
  if (typeof dependencies.comparison !== 'object' || dependencies.comparison === null ||
      typeof dependencies.comparison.validate !== 'function' ||
      typeof dependencies.comparison.qrCredential?.lookupDigest !== 'function' ||
      typeof dependencies.comparison.artifact?.create !== 'function') {
    throw new TypeError('verified comparison port is required');
  }
}

export function createAccessComposition(
  dependencies: AccessCompositionDependencies,
): AccessComposition {
  assertDependencies(dependencies);
  const scopeOptions: ScopeOptions = {
    epoch: dependencies.epoch,
  };
  const readAccessData = new ReadAccessDataWrapper(dependencies.query);
  const openManagementScope = (): ManagementScope =>
    new ManagementScopeImplementation(dependencies.management, scopeOptions);
  const openRecognitionScope = (): RecognitionScope =>
    new RecognitionScopeImplementation(
      dependencies.recognition,
      dependencies.sourceFacts,
      dependencies.sourceId,
      scopeOptions,
    );
  const manageQualifications = new ManageQualificationsImplementation(
    openManagementScope,
  );
  const recognizeAttempt = new RecognizeAttemptImplementation(
    () => openRecognitionScope(),
    dependencies.sourceId,
    dependencies.comparison,
  );

  return Object.freeze({
    manageQualifications,
    recognizeAttempt,
    readAccessData,
  });
}

export const composeAccess = createAccessComposition;
