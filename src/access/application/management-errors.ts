export const MANAGEMENT_APPLICATION_ERROR_CODES = Object.freeze([
  'QUALIFICATION_NOT_FOUND',
  'VALID_UNTIL_NOT_AFTER_VALID_FROM',
  'VALID_UNTIL_NOT_AFTER_RECEIVED_AT',
  'QUALIFICATION_ALREADY_ENTERED',
  'QUALIFICATION_ALREADY_USED',
  'QUALIFICATION_ALREADY_REVOKED',
  'QUALIFICATION_ALREADY_EXPIRED',
  'REVOCATION_REASON_REQUIRED',
  'UPDATE_FIELD_REQUIRED',
] as const);

export type ManagementApplicationErrorCode =
  (typeof MANAGEMENT_APPLICATION_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<
  Record<ManagementApplicationErrorCode, string>
> = Object.freeze({
  QUALIFICATION_NOT_FOUND: 'Qualification was not found',
  VALID_UNTIL_NOT_AFTER_VALID_FROM:
    'Qualification validUntil must be later than validFrom',
  VALID_UNTIL_NOT_AFTER_RECEIVED_AT:
    'Qualification validUntil must be later than the received time',
  QUALIFICATION_ALREADY_ENTERED:
    'Qualification cannot be changed after entry',
  QUALIFICATION_ALREADY_USED: 'Qualification has already been used',
  QUALIFICATION_ALREADY_REVOKED: 'Qualification has already been revoked',
  QUALIFICATION_ALREADY_EXPIRED: 'Qualification has already expired',
  REVOCATION_REASON_REQUIRED: 'A revocation reason is required',
  UPDATE_FIELD_REQUIRED: 'At least one qualification update field is required',
});

/** Typed business/application rejection for management operations. */
export class ManagementApplicationError extends Error {
  public readonly code: ManagementApplicationErrorCode;
  public readonly effect: 'NONE' | 'EXPIRED_TERMINAL_PERSISTED';

  public constructor(
    code: ManagementApplicationErrorCode,
    effect: 'NONE' | 'EXPIRED_TERMINAL_PERSISTED' = 'NONE',
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ManagementApplicationError';
    this.code = code;
    this.effect = effect;
  }
}
