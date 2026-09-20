import {
  assertQualificationState,
  DomainInvariantError,
  type Presence,
  type QualificationState,
} from './qualification.js';

export const DIRECTIONS = ['ENTRY', 'EXIT'] as const;
export const OUTCOMES = ['ACCEPTED', 'REJECTED'] as const;
export const REASON_CODES = [
  'SOURCE_INACTIVE',
  'INVALID_QR_CREDENTIAL',
  'FACE_UNKNOWN',
  'FACE_SUBJECT_NOT_MAPPED',
  'QUALIFICATION_REVOKED',
  'ALREADY_INSIDE',
  'QUALIFICATION_ALREADY_USED',
  'QUALIFICATION_NOT_YET_VALID',
  'QUALIFICATION_EXPIRED',
  'ENTRY_GRANTED',
  'NOT_INSIDE',
  'ALREADY_EXITED',
  'EXIT_RECORDED',
] as const;

export type Direction = (typeof DIRECTIONS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type ReasonCode = (typeof REASON_CODES)[number];

export type IdentityResolution =
  | Readonly<{
      kind: 'RESOLVED';
      qualification: QualificationState;
    }>
  | Readonly<{ kind: 'INVALID_QR_CREDENTIAL' }>
  | Readonly<{ kind: 'FACE_UNKNOWN' }>
  | Readonly<{ kind: 'FACE_SUBJECT_NOT_MAPPED' }>;

export type QualificationEffect = 'NONE' | 'EXPIRE_NOT_ENTERED';
export type FaceMappingEffect = 'KEEP' | 'RELEASE';

export interface AccessDecision {
  readonly outcome: Outcome;
  readonly reasonCode: ReasonCode;
  readonly presenceTransition: Readonly<{
    from: Presence;
    to: Presence;
  }> | null;
  readonly qualificationEffect: QualificationEffect;
  readonly faceMappingEffect: FaceMappingEffect;
}

const NO_EFFECTS = Object.freeze({
  presenceTransition: null,
  qualificationEffect: 'NONE',
  faceMappingEffect: 'KEEP',
} as const);

function assertKnownDirection(value: unknown): asserts value is Direction {
  if (value !== 'ENTRY' && value !== 'EXIT') {
    throw new DomainInvariantError('direction must be ENTRY or EXIT');
  }
}

function assertKnownResolution(
  value: unknown,
): asserts value is IdentityResolution {
  if (typeof value !== 'object' || value === null) {
    throw new DomainInvariantError('identity resolution must be an object');
  }
  const kind = (value as { kind?: unknown }).kind;
  switch (kind) {
    case 'RESOLVED':
    case 'INVALID_QR_CREDENTIAL':
    case 'FACE_UNKNOWN':
    case 'FACE_SUBJECT_NOT_MAPPED':
      return;
    default:
      throw new DomainInvariantError('identity resolution kind is unknown');
  }
}

function rejected(reasonCode: ReasonCode): AccessDecision {
  return {
    outcome: 'REJECTED',
    reasonCode,
    ...NO_EFFECTS,
  };
}

function mappingFailure(
  resolution: Exclude<IdentityResolution, { kind: 'RESOLVED' }>,
): AccessDecision {
  return rejected(resolution.kind);
}

function decideEntry(
  qualification: QualificationState,
  receivedAtMs: number,
): AccessDecision {
  if (qualification.revokedAtMs !== null) {
    return rejected('QUALIFICATION_REVOKED');
  }
  if (qualification.presence === 'INSIDE') {
    return rejected('ALREADY_INSIDE');
  }
  if (qualification.presence === 'EXITED') {
    return rejected('QUALIFICATION_ALREADY_USED');
  }
  if (receivedAtMs < qualification.validFromMs) {
    return rejected('QUALIFICATION_NOT_YET_VALID');
  }
  if (
    qualification.expiredTerminalAtMs !== null ||
    receivedAtMs >= qualification.validUntilMs
  ) {
    const alreadyTerminal = qualification.expiredTerminalAtMs !== null;
    return {
      outcome: 'REJECTED',
      reasonCode: 'QUALIFICATION_EXPIRED',
      presenceTransition: null,
      qualificationEffect: alreadyTerminal ? 'NONE' : 'EXPIRE_NOT_ENTERED',
      faceMappingEffect: alreadyTerminal ? 'KEEP' : 'RELEASE',
    };
  }
  return {
    outcome: 'ACCEPTED',
    reasonCode: 'ENTRY_GRANTED',
    presenceTransition: { from: 'NOT_ENTERED', to: 'INSIDE' },
    qualificationEffect: 'NONE',
    faceMappingEffect: 'KEEP',
  };
}

function decideExit(qualification: QualificationState): AccessDecision {
  if (qualification.presence === 'NOT_ENTERED') {
    return rejected('NOT_INSIDE');
  }
  if (qualification.presence === 'EXITED') {
    return rejected('ALREADY_EXITED');
  }
  return {
    outcome: 'ACCEPTED',
    reasonCode: 'EXIT_RECORDED',
    presenceTransition: { from: 'INSIDE', to: 'EXITED' },
    qualificationEffect: 'NONE',
    faceMappingEffect: 'RELEASE',
  };
}

export function decideAccess(input: Readonly<{
  direction: Direction;
  sourceActive: boolean;
  resolution: IdentityResolution;
  receivedAtMs: number;
}>): AccessDecision {
  if (typeof input !== 'object' || input === null) {
    throw new DomainInvariantError('access input must be an object');
  }
  assertKnownDirection(input.direction);
  assertKnownResolution(input.resolution);
  if (typeof input.sourceActive !== 'boolean') {
    throw new DomainInvariantError('sourceActive must be a boolean');
  }
  if (!Number.isSafeInteger(input.receivedAtMs)) {
    throw new TypeError('receivedAtMs must be a safe integer instant');
  }
  if (!input.sourceActive) {
    return rejected('SOURCE_INACTIVE');
  }
  if (input.resolution.kind !== 'RESOLVED') {
    return mappingFailure(input.resolution);
  }

  assertQualificationState(input.resolution.qualification);
  return input.direction === 'ENTRY'
    ? decideEntry(input.resolution.qualification, input.receivedAtMs)
    : decideExit(input.resolution.qualification);
}
