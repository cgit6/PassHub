import { createHash, timingSafeEqual } from 'node:crypto';

import {
  SOURCE_CREDENTIAL_VERIFIER_ERROR_CODES,
  SourceCredentialVerifierError,
  type SourceCredentialVerifierErrorCode,
} from '../../shared/internal/source-credential-verifier-error.js';
import type {
  SourceCredentialRecordReaderPort,
  SourceCredentialVerificationPort,
} from '../ports/index.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWER_HEX_DIGEST = /^[0-9a-f]{64}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const RECORD_KEYS = Object.freeze(['credentialAlias', 'credentialDigest', 'sourceId'] as const);
const DUMMY_DIGEST = Buffer.from('00'.repeat(32), 'hex');

export {
  SOURCE_CREDENTIAL_VERIFIER_ERROR_CODES,
  SourceCredentialVerifierError,
  type SourceCredentialVerifierErrorCode,
};

export interface SourceCredentialVerifierDependencies {
  readonly reader: SourceCredentialRecordReaderPort;
}

interface SourceCredentialRecord {
  readonly sourceId: string;
  readonly credentialAlias: string;
  readonly credentialDigest: string;
}

function verifierError(code: SourceCredentialVerifierErrorCode): SourceCredentialVerifierError {
  return new SourceCredentialVerifierError(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isAlias(value: unknown): value is 'entry' | 'exit' {
  return value === 'entry' || value === 'exit';
}

function parseRecord(value: unknown, alias: string): SourceCredentialRecord {
  if (!isObject(value) || !hasExactKeys(value, RECORD_KEYS)
      || typeof value.sourceId !== 'string' || !UUID_V4.test(value.sourceId)
      || value.credentialAlias !== alias || !isAlias(value.credentialAlias)
      || typeof value.credentialDigest !== 'string' || !LOWER_HEX_DIGEST.test(value.credentialDigest)) {
    throw verifierError('SOURCE_CREDENTIAL_DEPENDENCY_FAILURE');
  }
  return {
    sourceId: value.sourceId,
    credentialAlias: value.credentialAlias,
    credentialDigest: value.credentialDigest,
  };
}

function decodeStoredDigest(value: string): Buffer {
  if (!LOWER_HEX_DIGEST.test(value)) {
    throw verifierError('SOURCE_CREDENTIAL_DEPENDENCY_FAILURE');
  }
  const decoded = Buffer.from(value, 'hex');
  if (decoded.byteLength !== 32) {
    throw verifierError('SOURCE_CREDENTIAL_DEPENDENCY_FAILURE');
  }
  return decoded;
}

export function createSourceCredentialVerifier(
  dependencies: SourceCredentialVerifierDependencies,
): SourceCredentialVerificationPort {
  if (!isObject(dependencies) || !isObject(dependencies.reader)
      || typeof dependencies.reader.findByAlias !== 'function') {
    throw verifierError('SOURCE_CREDENTIAL_CONFIGURATION_FAILURE');
  }

  const reader = dependencies.reader;
  const findByAlias = reader.findByAlias.bind(reader);
  let invokingDependency = false;
  let frozen = false;

  function freeze(
    code: 'SOURCE_CREDENTIAL_DEPENDENCY_FAILURE' | 'SOURCE_CREDENTIAL_REENTRANT',
  ): never {
    frozen = true;
    throw verifierError(code);
  }

  function enter(): void {
    if (frozen) throw verifierError('SOURCE_CREDENTIAL_FROZEN');
    if (invokingDependency) freeze('SOURCE_CREDENTIAL_REENTRANT');
  }

  function freezeCrypto(): never {
    frozen = true;
    throw verifierError('SOURCE_CREDENTIAL_CRYPTO_FAILURE');
  }

  function sha256Ascii(secret: string): Buffer {
    try {
      return createHash('sha256').update(secret, 'ascii').digest();
    } catch {
      freezeCrypto();
    }
  }

  function sanitizeRecord(value: unknown, alias: string): SourceCredentialRecord {
    try {
      return parseRecord(value, alias);
    } catch {
      throw verifierError('SOURCE_CREDENTIAL_DEPENDENCY_FAILURE');
    }
  }

  async function read(alias: 'entry' | 'exit'): Promise<unknown | null> {
    enter();
    invokingDependency = true;
    let promise: Promise<unknown | null>;
    try {
      promise = findByAlias(alias);
    } catch {
      freeze('SOURCE_CREDENTIAL_DEPENDENCY_FAILURE');
    } finally {
      invokingDependency = false;
    }
    if (frozen) throw verifierError('SOURCE_CREDENTIAL_FROZEN');
    if (!(promise instanceof Promise)) freeze('SOURCE_CREDENTIAL_DEPENDENCY_FAILURE');
    try {
      return await promise;
    } catch {
      throw verifierError('SOURCE_CREDENTIAL_DEPENDENCY_FAILURE');
    }
  }

  const capability: SourceCredentialVerificationPort = {
    async verify(alias: string, secret: string): Promise<Readonly<{ sourceId: string }> | null> {
      enter();
      if (!isAlias(alias) || typeof secret !== 'string' || !SECRET.test(secret)) {
        throw verifierError('SOURCE_CREDENTIAL_CONFIGURATION_FAILURE');
      }

      const actualDigest = sha256Ascii(secret);
      const rawRecord = await read(alias);
      if (frozen) throw verifierError('SOURCE_CREDENTIAL_FROZEN');
      const record = rawRecord === null ? null : sanitizeRecord(rawRecord, alias);
      const expectedDigest = record === null
        ? DUMMY_DIGEST
        : decodeStoredDigest(record.credentialDigest);

      let matches: boolean;
      try {
        matches = timingSafeEqual(actualDigest, expectedDigest);
      } catch {
        freezeCrypto();
      }
      if (record === null || !matches) return null;
      return Object.freeze({ sourceId: record.sourceId });
    },
  };
  return Object.freeze(capability);
}
