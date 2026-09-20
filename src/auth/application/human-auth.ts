import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

import {
  HumanAuthError,
  HumanPrincipal,
  type HumanPrincipalFacts,
  type HumanRole,
} from '../domain/index.js';
import type {
  HumanAccountReaderPort,
  HumanPasswordDeriverPort,
} from '../ports/index.js';

const JWT_ALGORITHM = 'HS256' as const;
const JWT_ISSUER = 'PassHub';
const JWT_AUDIENCE = 'human-api';
const JWT_TTL_SECONDS = 900;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWER_HEX_SALT = /^(?:[0-9a-f]{2}){16,}$/u;
const LOWER_HEX_HASH = /^[0-9a-f]{128}$/u;
const DUMMY_SALT = Buffer.from('7f468db033614111ba5d38f36f10cb81', 'hex');
const DUMMY_HASH = Buffer.from('00'.repeat(64), 'hex');
const LOGIN_KEYS = Object.freeze(['password', 'username'] as const);
const ACCOUNT_KEYS = Object.freeze([
  'enabled', 'passwordHash', 'passwordSalt', 'role', 'scryptParams', 'userId', 'username',
] as const);
const STATUS_KEYS = Object.freeze(['enabled', 'role', 'userId'] as const);
const SCRYPT_KEYS = Object.freeze(['N', 'keyLength', 'p', 'r'] as const);
const CLAIM_KEYS = Object.freeze(['aud', 'exp', 'iat', 'iss', 'sub'] as const);

interface AccountRecord {
  readonly userId: string;
  readonly username: string;
  readonly role: HumanRole;
  readonly enabled: boolean;
  readonly passwordSalt: string;
  readonly passwordHash: string;
}

export interface HumanLoginInput {
  readonly username: string;
  readonly password: string;
}

export interface HumanLoginResult {
  readonly accessToken: string;
}

export interface HumanAuthCapability {
  login(input: HumanLoginInput): Promise<HumanLoginResult>;
  verifyAccessToken(accessToken: string): Promise<HumanPrincipal>;
  facts(principal: HumanPrincipal): HumanPrincipalFacts;
  assertRole(principal: HumanPrincipal, requiredRole: HumanRole): void;
}

export interface HumanAuthDependencies {
  readonly accountReader: HumanAccountReaderPort;
  readonly passwordDeriver: HumanPasswordDeriverPort;
  readonly jwtKey: Uint8Array;
  readonly clock?: () => number;
}

function authError(code: ConstructorParameters<typeof HumanAuthError>[0]): HumanAuthError {
  return new HumanAuthError(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isExactLoginString(value: unknown): value is string {
  return typeof value === 'string'
    && !hasUnpairedSurrogate(value)
    && Buffer.byteLength(value, 'utf8') >= 1
    && Buffer.byteLength(value, 'utf8') <= 128;
}

function parseLoginInput(value: unknown): HumanLoginInput {
  if (!isObject(value) || !hasExactKeys(value, LOGIN_KEYS)
      || !isExactLoginString(value.username) || !isExactLoginString(value.password)) {
    throw authError('INVALID_LOGIN_INPUT');
  }
  return { username: value.username, password: value.password };
}

function isRole(value: unknown): value is HumanRole {
  return value === 'OPERATOR' || value === 'VIEWER';
}

function hasFixedScryptParams(value: unknown): boolean {
  return isObject(value)
    && hasExactKeys(value, SCRYPT_KEYS)
    && value.N === 131072
    && value.r === 8
    && value.p === 1
    && value.keyLength === 64;
}

function parseAccount(value: unknown): AccountRecord {
  if (!isObject(value) || !hasExactKeys(value, ACCOUNT_KEYS)
      || typeof value.userId !== 'string' || !UUID_V4.test(value.userId)
      || !isExactLoginString(value.username) || !isRole(value.role)
      || typeof value.enabled !== 'boolean'
      || typeof value.passwordSalt !== 'string' || !LOWER_HEX_SALT.test(value.passwordSalt)
      || typeof value.passwordHash !== 'string' || !LOWER_HEX_HASH.test(value.passwordHash)
      || !hasFixedScryptParams(value.scryptParams)) {
    throw authError('AUTH_DEPENDENCY_FAILURE');
  }
  return {
    userId: value.userId,
    username: value.username,
    role: value.role,
    enabled: value.enabled,
    passwordSalt: value.passwordSalt,
    passwordHash: value.passwordHash,
  };
}

function parseCurrentStatus(value: unknown, expectedUserId: string): HumanPrincipalFacts & { readonly enabled: boolean } {
  if (!isObject(value) || !hasExactKeys(value, STATUS_KEYS)
      || typeof value.userId !== 'string' || value.userId !== expectedUserId || !UUID_V4.test(value.userId)
      || !isRole(value.role) || typeof value.enabled !== 'boolean') {
    throw authError('AUTH_DEPENDENCY_FAILURE');
  }
  return { userId: value.userId, role: value.role, enabled: value.enabled };
}

function parseClaims(value: unknown, now: number): string {
  if (!isObject(value) || !hasExactKeys(value, CLAIM_KEYS)
      || typeof value.sub !== 'string' || !UUID_V4.test(value.sub)
      || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp)
      || value.iss !== JWT_ISSUER || value.aud !== JWT_AUDIENCE) {
    throw authError('INVALID_TOKEN');
  }
  const issuedAt = value.iat as number;
  const expiresAt = value.exp as number;
  if (issuedAt < 0 || issuedAt > now || expiresAt !== issuedAt + JWT_TTL_SECONDS || expiresAt <= now) {
    throw authError('INVALID_TOKEN');
  }
  return value.sub;
}

export function createHumanAuth(dependencies: HumanAuthDependencies): HumanAuthCapability {
  if (!isObject(dependencies)
      || !isObject(dependencies.accountReader)
      || typeof dependencies.accountReader.findByUsername !== 'function'
      || typeof dependencies.accountReader.findCurrentById !== 'function'
      || !isObject(dependencies.passwordDeriver)
      || typeof dependencies.passwordDeriver.derive !== 'function'
      || !(dependencies.jwtKey instanceof Uint8Array)
      || dependencies.jwtKey.byteLength !== 32
      || (dependencies.clock !== undefined && typeof dependencies.clock !== 'function')) {
    throw authError('AUTH_CONFIGURATION_FAILURE');
  }

  const reader = dependencies.accountReader;
  const findByUsername = reader.findByUsername.bind(reader);
  const findCurrentById = reader.findCurrentById.bind(reader);
  const deriver = dependencies.passwordDeriver;
  const derive = deriver.derive.bind(deriver);
  const jwtKey = Buffer.from(dependencies.jwtKey);
  const clock = dependencies.clock ?? (() => Math.floor(Date.now() / 1_000));
  const principals = new WeakMap<HumanPrincipal, HumanPrincipalFacts>();
  let invokingDependency = false;
  let frozen = false;

  function freeze(code: 'AUTH_CLOCK_FAILURE' | 'AUTH_DEPENDENCY_FAILURE' | 'AUTH_REENTRANT'): never {
    frozen = true;
    throw authError(code);
  }

  function enter(): void {
    if (frozen) throw authError('AUTH_FROZEN');
    if (invokingDependency) freeze('AUTH_REENTRANT');
  }

  function nowSeconds(): number {
    enter();
    invokingDependency = true;
    let value: unknown;
    try {
      value = clock();
    } catch {
      freeze('AUTH_CLOCK_FAILURE');
    } finally {
      invokingDependency = false;
    }
    if (frozen) throw authError('AUTH_FROZEN');
    if (!Number.isSafeInteger(value) || (value as number) < 0
        || (value as number) > Number.MAX_SAFE_INTEGER - JWT_TTL_SECONDS) {
      freeze('AUTH_CLOCK_FAILURE');
    }
    return value as number;
  }

  async function invokeAsync<T>(operation: () => Promise<T>): Promise<T> {
    enter();
    invokingDependency = true;
    let promise: Promise<T>;
    try {
      promise = operation();
    } catch {
      freeze('AUTH_DEPENDENCY_FAILURE');
    } finally {
      invokingDependency = false;
    }
    if (!(promise instanceof Promise)) freeze('AUTH_DEPENDENCY_FAILURE');
    try {
      return await promise;
    } catch {
      throw authError('AUTH_DEPENDENCY_FAILURE');
    }
  }

  async function derivePassword(password: string, salt: Uint8Array): Promise<Buffer> {
    const derived = await invokeAsync(() => derive(password, Buffer.from(salt)));
    if (!(derived instanceof Uint8Array) || derived.byteLength !== 64) {
      throw authError('AUTH_DEPENDENCY_FAILURE');
    }
    return Buffer.from(derived);
  }

  function currentFacts(principal: HumanPrincipal): HumanPrincipalFacts {
    enter();
    if (!(principal instanceof HumanPrincipal)) throw authError('INVALID_TOKEN');
    const facts = principals.get(principal);
    if (facts === undefined) throw authError('INVALID_TOKEN');
    return facts;
  }

  const capability: HumanAuthCapability = {
    async login(input: HumanLoginInput): Promise<HumanLoginResult> {
      enter();
      let login: HumanLoginInput;
      try {
        login = parseLoginInput(input);
      } catch {
        throw authError('INVALID_LOGIN_INPUT');
      }
      const rawAccount = await invokeAsync(() => findByUsername(login.username));
      if (frozen) throw authError('AUTH_FROZEN');

      let account: AccountRecord | null = null;
      if (rawAccount !== null) {
        try {
          account = parseAccount(rawAccount);
        } catch {
          throw authError('AUTH_DEPENDENCY_FAILURE');
        }
        if (account.username !== login.username) throw authError('AUTH_DEPENDENCY_FAILURE');
      }

      const useRealCredential = account?.enabled === true;
      const salt = useRealCredential && account !== null ? Buffer.from(account.passwordSalt, 'hex') : DUMMY_SALT;
      const expectedHash = useRealCredential && account !== null ? Buffer.from(account.passwordHash, 'hex') : DUMMY_HASH;
      const actualHash = await derivePassword(login.password, salt);
      if (frozen) throw authError('AUTH_FROZEN');
      const passwordMatches = timingSafeEqual(actualHash, expectedHash);
      if (!useRealCredential || !passwordMatches || account === null) {
        throw authError('INVALID_CREDENTIALS');
      }

      const issuedAt = nowSeconds();
      const claims = {
        sub: account.userId,
        iat: issuedAt,
        exp: issuedAt + JWT_TTL_SECONDS,
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
      };
      let accessToken: string;
      try {
        accessToken = jwt.sign(claims, jwtKey, { algorithm: JWT_ALGORITHM });
      } catch {
        throw authError('AUTH_DEPENDENCY_FAILURE');
      }
      return Object.freeze({ accessToken });
    },

    async verifyAccessToken(accessToken: string): Promise<HumanPrincipal> {
      enter();
      if (typeof accessToken !== 'string' || accessToken.length === 0) throw authError('INVALID_TOKEN');
      const now = nowSeconds();
      let decoded: unknown;
      try {
        decoded = jwt.verify(accessToken, jwtKey, {
          algorithms: [JWT_ALGORITHM],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          maxAge: JWT_TTL_SECONDS,
          clockTimestamp: now,
        });
      } catch {
        throw authError('INVALID_TOKEN');
      }
      let userId: string;
      try {
        userId = parseClaims(decoded, now);
      } catch {
        throw authError('INVALID_TOKEN');
      }
      const rawStatus = await invokeAsync(() => findCurrentById(userId));
      if (frozen) throw authError('AUTH_FROZEN');
      if (rawStatus === null) throw authError('INVALID_TOKEN');
      let status: HumanPrincipalFacts & { readonly enabled: boolean };
      try {
        status = parseCurrentStatus(rawStatus, userId);
      } catch {
        throw authError('AUTH_DEPENDENCY_FAILURE');
      }
      if (!status.enabled) throw authError('INVALID_TOKEN');
      const facts = Object.freeze({ userId: status.userId, role: status.role });
      const principal = new HumanPrincipal();
      principals.set(principal, facts);
      return principal;
    },

    facts(principal: HumanPrincipal): HumanPrincipalFacts {
      const facts = currentFacts(principal);
      return Object.freeze({ userId: facts.userId, role: facts.role });
    },

    assertRole(principal: HumanPrincipal, requiredRole: HumanRole): void {
      const facts = currentFacts(principal);
      if (!isRole(requiredRole) || facts.role !== requiredRole) throw authError('ROLE_FORBIDDEN');
    },
  };
  return Object.freeze(capability);
}
