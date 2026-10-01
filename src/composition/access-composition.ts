import type {
  ManageQualifications,
  ReadAccessData,
} from '../access/application/index.js';
import {
  ManagementAccessScope as ManagementScopeImplementation,
  type FirstScopedPersistenceUse,
  type ManagementScope,
  type ScopeOptions,
} from '../access/application/access-scopes.js';
import { registerG10bManagementScopeFactory } from './internal/g10b-management-scope-bridge.js';
import { ManageQualificationsImplementation } from '../access/application/use-cases.js';
import type {
  AccessQueryPort,
  ManagementDataPort,
  RedactedAccessEventProjection,
  RedactedQualificationProjection,
} from '../access/ports/index.js';

export interface AccessCompositionDependencies {
  readonly management: ManagementDataPort;
  readonly query: AccessQueryPort;
  readonly epoch: string;
}

export interface AccessComposition {
  readonly manageQualifications: ManageQualifications;
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
    ['query', dependencies.query],
  ] as const) {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError(`${name} port is required`);
    }
  }
  if (typeof dependencies.epoch !== 'string' || dependencies.epoch.length === 0) {
    throw new TypeError('composition epoch is required');
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
  const openManagementScope = (firstUse?: FirstScopedPersistenceUse): ManagementScope =>
    new ManagementScopeImplementation(dependencies.management, scopeOptions, firstUse);
  const manageQualifications = new ManageQualificationsImplementation(
    openManagementScope,
  );
  registerG10bManagementScopeFactory(manageQualifications, openManagementScope);
  const result = {
    manageQualifications,
    readAccessData,
  };
  return Object.freeze(result);
}

export const composeAccess = createAccessComposition;
