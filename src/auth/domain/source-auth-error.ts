export const SOURCE_AUTH_ERROR_CODES = Object.freeze([
  'INVALID_SOURCE_CREDENTIAL',
  'SOURCE_AUTH_CONFIGURATION_FAILURE',
  'SOURCE_AUTH_DEPENDENCY_FAILURE',
  'SOURCE_AUTH_CRYPTO_FAILURE',
  'SOURCE_AUTH_REENTRANT',
  'SOURCE_AUTH_FROZEN',
] as const);

export type SourceAuthErrorCode = (typeof SOURCE_AUTH_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<SourceAuthErrorCode, string>> = Object.freeze({
  INVALID_SOURCE_CREDENTIAL: 'Source credential is invalid',
  SOURCE_AUTH_CONFIGURATION_FAILURE: 'Source authentication configuration is invalid',
  SOURCE_AUTH_DEPENDENCY_FAILURE: 'Source authentication dependency failed',
  SOURCE_AUTH_CRYPTO_FAILURE: 'Source authentication cryptography failed',
  SOURCE_AUTH_REENTRANT: 'Source authentication reentrant call rejected',
  SOURCE_AUTH_FROZEN: 'Source authentication capability is frozen',
});

export class SourceAuthError extends Error {
  public readonly code: SourceAuthErrorCode;

  public constructor(code: SourceAuthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SourceAuthError';
    this.code = code;
  }
}
