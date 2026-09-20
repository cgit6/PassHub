export const PRESENCES = ['NOT_ENTERED', 'INSIDE', 'EXITED'] as const;

export type Presence = (typeof PRESENCES)[number];

export interface QualificationState {
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly presence: Presence;
  readonly enteredAtMs: number | null;
  readonly exitedAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly revocationReason: string | null;
  readonly expiredTerminalAtMs: number | null;
}

export type WindowRejectionReason =
  | 'VALID_UNTIL_NOT_AFTER_VALID_FROM'
  | 'VALID_UNTIL_NOT_AFTER_RECEIVED_AT';

export type WindowDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: WindowRejectionReason }>;

export type ManagementRejectionReason =
  | 'QUALIFICATION_ALREADY_ENTERED'
  | 'QUALIFICATION_ALREADY_USED'
  | 'QUALIFICATION_ALREADY_REVOKED'
  | 'QUALIFICATION_ALREADY_EXPIRED'
  | 'REVOCATION_REASON_REQUIRED'
  | WindowRejectionReason;

export type UpdateDecision =
  | Readonly<{
      allowed: true;
      preserveQrCredential: true;
    }>
  | Readonly<{
      allowed: false;
      reason: ManagementRejectionReason;
    }>;

export type RevocationDecision =
  | Readonly<{
      allowed: true;
      releaseFaceMapping: true;
    }>
  | Readonly<{
      allowed: false;
      reason: ManagementRejectionReason;
    }>;

export type ExpirationDecision = Readonly<{
  terminalize: boolean;
  releaseFaceMapping: boolean;
}>;

export class DomainInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DomainInvariantError';
  }
}

function assertInstant(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainInvariantError(`${field} must be a safe integer instant`);
  }
}

function assertNullableInstant(value: number | null, field: string): void {
  if (value !== null) {
    assertInstant(value, field);
  }
}

function assertPresence(value: unknown): asserts value is Presence {
  if (!PRESENCES.includes(value as Presence)) {
    throw new DomainInvariantError('presence must be a known qualification state');
  }
}

export function assertQualificationState(
  qualification: QualificationState,
): void {
  if (typeof qualification !== 'object' || qualification === null) {
    throw new DomainInvariantError('qualification state must be an object');
  }
  assertPresence(qualification.presence);
  if (
    qualification.revocationReason !== null &&
    typeof qualification.revocationReason !== 'string'
  ) {
    throw new DomainInvariantError('revocationReason must be a string or null');
  }
  assertInstant(qualification.validFromMs, 'validFromMs');
  assertInstant(qualification.validUntilMs, 'validUntilMs');
  assertNullableInstant(qualification.enteredAtMs, 'enteredAtMs');
  assertNullableInstant(qualification.exitedAtMs, 'exitedAtMs');
  assertNullableInstant(qualification.revokedAtMs, 'revokedAtMs');
  assertNullableInstant(
    qualification.expiredTerminalAtMs,
    'expiredTerminalAtMs',
  );

  if (qualification.validUntilMs <= qualification.validFromMs) {
    throw new DomainInvariantError('qualification window must be increasing');
  }

  const hasRevocation = qualification.revokedAtMs !== null;
  const hasReason = qualification.revocationReason !== null;
  if (hasRevocation !== hasReason) {
    throw new DomainInvariantError(
      'revokedAtMs and revocationReason must be present together',
    );
  }
  if (hasReason && qualification.revocationReason.length === 0) {
    throw new DomainInvariantError('revocationReason must not be empty');
  }

  if (qualification.presence === 'NOT_ENTERED') {
    if (
      qualification.enteredAtMs !== null ||
      qualification.exitedAtMs !== null
    ) {
      throw new DomainInvariantError(
        'NOT_ENTERED cannot contain entry or exit timestamps',
      );
    }
    if (hasRevocation && qualification.expiredTerminalAtMs !== null) {
      throw new DomainInvariantError(
        'revocation and explicit expiration are mutually exclusive',
      );
    }
    return;
  }

  if (hasRevocation || qualification.expiredTerminalAtMs !== null) {
    throw new DomainInvariantError(
      'INSIDE and EXITED cannot be revoked or explicitly expired',
    );
  }

  if (qualification.presence === 'INSIDE') {
    if (
      qualification.enteredAtMs === null ||
      qualification.exitedAtMs !== null
    ) {
      throw new DomainInvariantError(
        'INSIDE requires enteredAtMs and forbids exitedAtMs',
      );
    }
    return;
  }

  if (
    qualification.enteredAtMs === null ||
    qualification.exitedAtMs === null
  ) {
    throw new DomainInvariantError(
      'EXITED requires both entry and exit timestamps',
    );
  }
}

export function decideQualificationWindow(input: Readonly<{
  validFromMs: number;
  validUntilMs: number;
  receivedAtMs: number;
}>): WindowDecision {
  assertInstant(input.validFromMs, 'validFromMs');
  assertInstant(input.validUntilMs, 'validUntilMs');
  assertInstant(input.receivedAtMs, 'receivedAtMs');

  if (input.validUntilMs <= input.validFromMs) {
    return {
      allowed: false,
      reason: 'VALID_UNTIL_NOT_AFTER_VALID_FROM',
    };
  }
  if (input.validUntilMs <= input.receivedAtMs) {
    return {
      allowed: false,
      reason: 'VALID_UNTIL_NOT_AFTER_RECEIVED_AT',
    };
  }
  return { allowed: true };
}

function decideMutableQualification(
  qualification: QualificationState,
  receivedAtMs: number,
): ManagementRejectionReason | null {
  assertQualificationState(qualification);
  assertInstant(receivedAtMs, 'receivedAtMs');

  if (qualification.presence === 'INSIDE') {
    return 'QUALIFICATION_ALREADY_ENTERED';
  }
  if (qualification.presence === 'EXITED') {
    return 'QUALIFICATION_ALREADY_USED';
  }
  if (qualification.revokedAtMs !== null) {
    return 'QUALIFICATION_ALREADY_REVOKED';
  }
  if (
    qualification.expiredTerminalAtMs !== null ||
    receivedAtMs >= qualification.validUntilMs
  ) {
    return 'QUALIFICATION_ALREADY_EXPIRED';
  }
  return null;
}

export function decideQualificationUpdate(input: Readonly<{
  qualification: QualificationState;
  proposedValidFromMs: number;
  proposedValidUntilMs: number;
  receivedAtMs: number;
}>): UpdateDecision {
  const immutableReason = decideMutableQualification(
    input.qualification,
    input.receivedAtMs,
  );
  if (immutableReason !== null) {
    return { allowed: false, reason: immutableReason };
  }

  const window = decideQualificationWindow({
    validFromMs: input.proposedValidFromMs,
    validUntilMs: input.proposedValidUntilMs,
    receivedAtMs: input.receivedAtMs,
  });
  if (!window.allowed) {
    return window;
  }
  return { allowed: true, preserveQrCredential: true };
}

export function decideQualificationRevocation(input: Readonly<{
  qualification: QualificationState;
  receivedAtMs: number;
  reason: string | null;
}>): RevocationDecision {
  if (input.reason !== null && typeof input.reason !== 'string') {
    throw new DomainInvariantError('revocation reason must be a string or null');
  }
  const immutableReason = decideMutableQualification(
    input.qualification,
    input.receivedAtMs,
  );
  if (immutableReason !== null) {
    return { allowed: false, reason: immutableReason };
  }
  if (input.reason === null || input.reason.length === 0) {
    return { allowed: false, reason: 'REVOCATION_REASON_REQUIRED' };
  }
  return { allowed: true, releaseFaceMapping: true };
}

export function decideQualificationExpiration(input: Readonly<{
  qualification: QualificationState;
  receivedAtMs: number;
}>): ExpirationDecision {
  assertQualificationState(input.qualification);
  assertInstant(input.receivedAtMs, 'receivedAtMs');

  const terminalize =
    input.qualification.presence === 'NOT_ENTERED' &&
    input.qualification.revokedAtMs === null &&
    input.qualification.expiredTerminalAtMs === null &&
    input.receivedAtMs >= input.qualification.validUntilMs;

  return {
    terminalize,
    releaseFaceMapping: terminalize,
  };
}

export function qualificationCanRetainFaceMapping(
  qualification: QualificationState,
  atMs: number,
): boolean {
  assertQualificationState(qualification);
  assertInstant(atMs, 'atMs');
  return (
    qualification.presence !== 'EXITED' &&
    qualification.revokedAtMs === null &&
    qualification.expiredTerminalAtMs === null &&
    (qualification.presence === 'INSIDE' || atMs < qualification.validUntilMs)
  );
}
