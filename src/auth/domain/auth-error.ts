export const HUMAN_AUTH_ERROR_CODES = Object.freeze([
  'INVALID_LOGIN_INPUT',
  'INVALID_CREDENTIALS',
  'INVALID_TOKEN',
  'ROLE_FORBIDDEN',
  'AUTH_CLOCK_FAILURE',
  'AUTH_CONFIGURATION_FAILURE',
  'AUTH_DEPENDENCY_FAILURE',
  'AUTH_REENTRANT',
  'AUTH_FROZEN',
] as const);

export type HumanAuthErrorCode = (typeof HUMAN_AUTH_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<HumanAuthErrorCode, string>> = Object.freeze({
  INVALID_LOGIN_INPUT: 'Human login input is invalid',
  INVALID_CREDENTIALS: 'Human credentials are invalid',
  INVALID_TOKEN: 'Human access token is invalid',
  ROLE_FORBIDDEN: 'Human role is forbidden',
  AUTH_CLOCK_FAILURE: 'Human authentication clock failed',
  AUTH_CONFIGURATION_FAILURE: 'Human authentication configuration is invalid',
  AUTH_DEPENDENCY_FAILURE: 'Human authentication dependency failed',
  AUTH_REENTRANT: 'Human authentication reentrant call rejected',
  AUTH_FROZEN: 'Human authentication capability is frozen',
});

export class HumanAuthError extends Error {
  public readonly code: HumanAuthErrorCode;

  public constructor(code: HumanAuthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'HumanAuthError';
    this.code = code;
  }
}
