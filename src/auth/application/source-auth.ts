import {
  SourceAuthError,
  SourcePrincipal,
  type SourceAuthErrorCode,
  type SourcePrincipalFacts,
} from '../domain/index.js';
import type { SourceCredentialVerifierPort } from '../ports/index.js';
import { SourceCredentialVerifierError } from '../../shared/internal/source-credential-verifier-error.js';

const CREDENTIAL = /^(entry|exit)\.([A-Za-z0-9_-]{43})$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERIFICATION_KEYS = Object.freeze(['sourceId'] as const);

export interface SourceAuthCapability {
  verifySourceCredential(credential: string): Promise<SourcePrincipal>;
  facts(principal: SourcePrincipal): SourcePrincipalFacts;
}

export interface SourceAuthDependencies {
  readonly credentialVerifier: SourceCredentialVerifierPort;
}

function sourceAuthError(code: SourceAuthErrorCode): SourceAuthError {
  return new SourceAuthError(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCredential(value: unknown): Readonly<{ alias: 'entry' | 'exit'; secret: string }> {
  if (typeof value !== 'string') throw sourceAuthError('INVALID_SOURCE_CREDENTIAL');
  const match = CREDENTIAL.exec(value);
  if (match === null) throw sourceAuthError('INVALID_SOURCE_CREDENTIAL');
  const alias = match[1];
  const secret = match[2];
  if ((alias !== 'entry' && alias !== 'exit') || secret === undefined) {
    throw sourceAuthError('INVALID_SOURCE_CREDENTIAL');
  }
  return Object.freeze({ alias, secret });
}

function parseVerification(value: unknown): SourcePrincipalFacts | null {
  if (value === null) return null;
  if (!isObject(value) || !Object.isFrozen(value) || !hasExactKeys(value, VERIFICATION_KEYS)
      || typeof value.sourceId !== 'string' || !UUID_V4.test(value.sourceId)) {
    throw sourceAuthError('SOURCE_AUTH_DEPENDENCY_FAILURE');
  }
  return Object.freeze({ sourceId: value.sourceId });
}

function sanitizeVerification(value: unknown): SourcePrincipalFacts | null {
  try {
    return parseVerification(value);
  } catch {
    throw sourceAuthError('SOURCE_AUTH_DEPENDENCY_FAILURE');
  }
}

export function createSourceAuth(dependencies: SourceAuthDependencies): SourceAuthCapability {
  if (!isObject(dependencies) || !isObject(dependencies.credentialVerifier)
      || typeof dependencies.credentialVerifier.verify !== 'function') {
    throw sourceAuthError('SOURCE_AUTH_CONFIGURATION_FAILURE');
  }

  const verifier = dependencies.credentialVerifier;
  const verify = verifier.verify.bind(verifier);
  const principals = new WeakMap<SourcePrincipal, SourcePrincipalFacts>();
  let invokingDependency = false;
  let frozen = false;

  function freeze(
    code: 'SOURCE_AUTH_DEPENDENCY_FAILURE' | 'SOURCE_AUTH_REENTRANT',
  ): never {
    frozen = true;
    throw sourceAuthError(code);
  }

  function enter(): void {
    if (frozen) throw sourceAuthError('SOURCE_AUTH_FROZEN');
    if (invokingDependency) freeze('SOURCE_AUTH_REENTRANT');
  }

  async function invokeVerifier(
    alias: 'entry' | 'exit',
    secret: string,
  ): Promise<Readonly<{ sourceId: string }> | null> {
    enter();
    invokingDependency = true;
    let promise: Promise<Readonly<{ sourceId: string }> | null>;
    try {
      promise = verify(alias, secret);
    } catch {
      freeze('SOURCE_AUTH_DEPENDENCY_FAILURE');
    } finally {
      invokingDependency = false;
    }
    if (frozen) throw sourceAuthError('SOURCE_AUTH_FROZEN');
    if (!(promise instanceof Promise)) freeze('SOURCE_AUTH_DEPENDENCY_FAILURE');
    try {
      return await promise;
    } catch (error: unknown) {
      if (error instanceof SourceCredentialVerifierError
          && error.code === 'SOURCE_CREDENTIAL_CRYPTO_FAILURE') {
        throw sourceAuthError('SOURCE_AUTH_CRYPTO_FAILURE');
      }
      throw sourceAuthError('SOURCE_AUTH_DEPENDENCY_FAILURE');
    }
  }

  function currentFacts(principal: SourcePrincipal): SourcePrincipalFacts {
    enter();
    if (!(principal instanceof SourcePrincipal)) throw sourceAuthError('INVALID_SOURCE_CREDENTIAL');
    const facts = principals.get(principal);
    if (facts === undefined) throw sourceAuthError('INVALID_SOURCE_CREDENTIAL');
    return facts;
  }

  const capability: SourceAuthCapability = {
    async verifySourceCredential(credential: string): Promise<SourcePrincipal> {
      enter();
      const parsed = parseCredential(credential);
      const rawVerification = await invokeVerifier(parsed.alias, parsed.secret);
      if (frozen) throw sourceAuthError('SOURCE_AUTH_FROZEN');
      const facts = sanitizeVerification(rawVerification);
      if (facts === null) throw sourceAuthError('INVALID_SOURCE_CREDENTIAL');
      const principal = new SourcePrincipal();
      principals.set(principal, facts);
      return principal;
    },

    facts(principal: SourcePrincipal): SourcePrincipalFacts {
      const facts = currentFacts(principal);
      return Object.freeze({ sourceId: facts.sourceId });
    },
  };
  return Object.freeze(capability);
}
