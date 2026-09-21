export const SOURCE_CREDENTIAL_VERIFIER_ERROR_CODES = Object.freeze([
  'SOURCE_CREDENTIAL_CONFIGURATION_FAILURE',
  'SOURCE_CREDENTIAL_DEPENDENCY_FAILURE',
  'SOURCE_CREDENTIAL_CRYPTO_FAILURE',
  'SOURCE_CREDENTIAL_REENTRANT',
  'SOURCE_CREDENTIAL_FROZEN',
] as const);

export type SourceCredentialVerifierErrorCode =
  (typeof SOURCE_CREDENTIAL_VERIFIER_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<SourceCredentialVerifierErrorCode, string>> = Object.freeze({
  SOURCE_CREDENTIAL_CONFIGURATION_FAILURE: 'Source credential verifier configuration is invalid',
  SOURCE_CREDENTIAL_DEPENDENCY_FAILURE: 'Source credential verifier dependency failed',
  SOURCE_CREDENTIAL_CRYPTO_FAILURE: 'Source credential verifier cryptography failed',
  SOURCE_CREDENTIAL_REENTRANT: 'Source credential verifier reentrant call rejected',
  SOURCE_CREDENTIAL_FROZEN: 'Source credential verifier is frozen',
});

export class SourceCredentialVerifierError extends Error {
  public readonly code: SourceCredentialVerifierErrorCode;

  public constructor(code: SourceCredentialVerifierErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SourceCredentialVerifierError';
    this.code = code;
  }
}
