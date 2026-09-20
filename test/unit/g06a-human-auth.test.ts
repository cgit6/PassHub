import { readFile } from 'node:fs/promises';
import { createHmac, generateKeyPairSync, scrypt as nodeScrypt } from 'node:crypto';
import jwt from 'jsonwebtoken';

import {
  createHumanAuth,
  type HumanAuthCapability,
  type HumanAuthDependencies,
} from '../../src/auth/application/human-auth.js';
import {
  HumanAuthError,
  HumanPrincipal,
  type HumanAuthErrorCode,
} from '../../src/auth/domain/index.js';
import { NodeScryptPasswordDeriver } from '../../src/auth/infrastructure/node-scrypt-password-deriver.js';

const NOW = 1_800_000_000;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const JWT_KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const SALT = '00112233445566778899aabbccddeeff';
const HASH = 'ab'.repeat(64);
const PARAMS = Object.freeze({ N: 131072, r: 8, p: 1, keyLength: 64 });

function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: USER_ID,
    username: 'operator',
    role: 'OPERATOR',
    enabled: true,
    passwordSalt: SALT,
    passwordHash: HASH,
    scryptParams: PARAMS,
    ...overrides,
  };
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { userId: USER_ID, role: 'OPERATOR', enabled: true, ...overrides };
}

interface Harness {
  readonly auth: HumanAuthCapability;
  readonly findByUsername: jest.Mock<Promise<unknown | null>, [string]>;
  readonly findCurrentById: jest.Mock<Promise<unknown | null>, [string]>;
  readonly derive: jest.Mock<Promise<Uint8Array>, [string, Uint8Array]>;
}

function harness(options: {
  readonly row?: unknown | null;
  readonly current?: unknown | null;
  readonly derived?: Uint8Array;
  readonly key?: Uint8Array;
  readonly clock?: () => number;
} = {}): Harness {
  const findByUsername = jest.fn<Promise<unknown | null>, [string]>(() => Promise.resolve(
    options.row === undefined ? account() : options.row,
  ));
  const findCurrentById = jest.fn<Promise<unknown | null>, [string]>(() => Promise.resolve(
    options.current === undefined ? status() : options.current,
  ));
  const derive = jest.fn<Promise<Uint8Array>, [string, Uint8Array]>(() => Promise.resolve(
    options.derived ?? Buffer.from(HASH, 'hex'),
  ));
  const dependencies: HumanAuthDependencies = {
    accountReader: { findByUsername, findCurrentById },
    passwordDeriver: { derive },
    jwtKey: options.key ?? JWT_KEY,
    clock: options.clock ?? (() => NOW),
  };
  return { auth: createHumanAuth(dependencies), findByUsername, findCurrentById, derive };
}

async function expectCode(work: Promise<unknown>, code: HumanAuthErrorCode): Promise<HumanAuthError> {
  try {
    await work;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HumanAuthError);
    expect((error as HumanAuthError).code).toBe(code);
    return error as HumanAuthError;
  }
  throw new Error(`expected HumanAuthError ${code}`);
}

function signClaims(claims: Record<string, unknown>, options: jwt.SignOptions = {}, key: jwt.Secret = JWT_KEY): string {
  return jwt.sign(claims, key, { algorithm: 'HS256', ...options });
}

function rawHs256(claims: Record<string, unknown>): string {
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${unsigned}.${createHmac('sha256', JWT_KEY).update(unsigned).digest('base64url')}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sub: USER_ID, iat: NOW, exp: NOW + 900, iss: 'PassHub', aud: 'human-api', ...overrides };
}

describe('G06a strict login input and credential handling', () => {
  test.each([
    ['one byte', 'a'],
    ['128 bytes', 'a'.repeat(128)],
    ['emoji UTF-8 accounting', '😀'.repeat(32)],
    ['spaces preserved', ' operator '],
    ['case preserved', 'Operator'],
    ['normalization preserved', 'e\u0301'],
  ])('passes exact legal username and password: %s', async (_label, value) => {
    const h = harness({ row: account({ username: value }) });
    await expect(h.auth.login({ username: value, password: value })).resolves.toEqual({ accessToken: expect.any(String) });
    expect(h.findByUsername).toHaveBeenCalledWith(value);
    expect(h.derive).toHaveBeenCalledWith(value, Buffer.from(SALT, 'hex'));
  });

  test.each([
    ['empty username', { username: '', password: 'p' }],
    ['empty password', { username: 'u', password: '' }],
    ['129 byte username', { username: 'a'.repeat(129), password: 'p' }],
    ['129 byte password', { username: 'u', password: 'a'.repeat(129) }],
    ['unpaired high surrogate', { username: '\ud800', password: 'p' }],
    ['unpaired low surrogate', { username: 'u', password: '\udc00' }],
    ['extra property', { username: 'u', password: 'p', role: 'OPERATOR' }],
    ['missing property', { username: 'u' }],
    ['non-string username', { username: 1, password: 'p' }],
    ['non-string password', { username: 'u', password: null }],
    ['array', ['u', 'p']],
    ['null', null],
  ])('rejects %s before touching dependencies', async (_label, input) => {
    const h = harness();
    await expectCode(h.auth.login(input as never), 'INVALID_LOGIN_INPUT');
    expect(h.findByUsername).not.toHaveBeenCalled();
    expect(h.derive).not.toHaveBeenCalled();
    expect(h.findCurrentById).not.toHaveBeenCalled();
  });

  test.each(['OPERATOR', 'VIEWER'] as const)('authenticates a correct enabled %s account with one KDF', async (role) => {
    const h = harness({ row: account({ role }) });
    await expect(h.auth.login({ username: 'operator', password: 'correct' })).resolves.toEqual({ accessToken: expect.any(String) });
    expect(h.findByUsername).toHaveBeenCalledTimes(1);
    expect(h.derive).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['unknown', null, Buffer.alloc(64), '7f468db033614111ba5d38f36f10cb81'],
    ['wrong password', account(), Buffer.alloc(64), SALT],
    ['disabled', account({ enabled: false }), Buffer.alloc(64), '7f468db033614111ba5d38f36f10cb81'],
  ])('%s is generic INVALID_CREDENTIALS and executes exactly one KDF', async (_label, row, derived, saltHex) => {
    const h = harness({ row, derived });
    const error = await expectCode(h.auth.login({ username: 'operator', password: 'secret' }), 'INVALID_CREDENTIALS');
    expect(error).toEqual(expect.objectContaining({ name: 'HumanAuthError', code: 'INVALID_CREDENTIALS' }));
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(h.findByUsername).toHaveBeenCalledTimes(1);
    expect(h.derive).toHaveBeenCalledTimes(1);
    expect(Buffer.from(h.derive.mock.calls[0]![1]).toString('hex')).toBe(saltHex);
  });

  test.each([
    ['non-object', 'row'],
    ['extra field', account({ extra: true })],
    ['missing field', (() => { const value = account(); delete value.role; return value; })()],
    ['UUID', account({ userId: OTHER_ID.replace('-4', '-3') })],
    ['role', account({ role: 'ADMIN' })],
    ['enabled', account({ enabled: 1 })],
    ['username mismatch', account({ username: 'other' })],
    ['salt odd', account({ passwordSalt: `${SALT}a` })],
    ['salt uppercase', account({ passwordSalt: SALT.toUpperCase() })],
    ['salt short', account({ passwordSalt: 'aa'.repeat(15) })],
    ['hash uppercase', account({ passwordHash: HASH.toUpperCase() })],
    ['hash short', account({ passwordHash: '11'.repeat(63) })],
    ['params value', account({ scryptParams: { ...PARAMS, N: 65536 } })],
    ['params extra', account({ scryptParams: { ...PARAMS, maxmem: 1 } })],
  ])('treats malformed account %s as technical and does not derive', async (_label, row) => {
    const h = harness({ row });
    await expectCode(h.auth.login({ username: 'operator', password: 'secret' }), 'AUTH_DEPENDENCY_FAILURE');
    expect(h.derive).not.toHaveBeenCalled();
  });
});

describe('G06a fixed asynchronous scrypt boundary', () => {
  test('real Node async scrypt matches the fixed known vector and returns exactly 64 bytes', async () => {
    const deriver = new NodeScryptPasswordDeriver();
    const promise = deriver.derive('correct horse battery staple', Buffer.from(SALT, 'hex'));
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).resolves.toEqual(Buffer.from(
      '383c0968df8f334694cccb4bbe115d0f1d4df21157c63ab9d7a040ffcaaab7c66'
      + 'f3c214fac03bee52f1bc74bd54e2155fba7f74fd2cf2f960f044509eb24d1d9',
      'hex',
    ));
  });

  test('known vector independently pins N/r/p/keylen/maxmem', async () => {
    const expected = await new Promise<Buffer>((resolve, reject) => {
      nodeScrypt('correct horse battery staple', Buffer.from(SALT, 'hex'), 64,
        { N: 131072, r: 8, p: 1, maxmem: 268435456 }, (error, value) => error === null ? resolve(value) : reject(error));
    });
    expect(expected.toString('hex')).toBe(
      '383c0968df8f334694cccb4bbe115d0f1d4df21157c63ab9d7a040ffcaaab7c66'
      + 'f3c214fac03bee52f1bc74bd54e2155fba7f74fd2cf2f960f044509eb24d1d9',
    );
  });

  test.each([
    ['throws', () => { throw new Error('secret throw'); }],
    ['rejects', () => Promise.reject(new Error('secret reject'))],
    ['non-Promise', () => Buffer.alloc(64)],
    ['thenable', () => ({ then: (resolve: (value: Buffer) => void) => resolve(Buffer.alloc(64)) })],
    ['wrong length', () => Promise.resolve(Buffer.alloc(63))],
  ])('maps deriver that %s to a secret-free technical error', async (_label, behavior) => {
    const h = harness();
    h.derive.mockImplementation(behavior as never);
    const error = await expectCode(h.auth.login({ username: 'operator', password: 'never-leak-this' }), 'AUTH_DEPENDENCY_FAILURE');
    expect(JSON.stringify(error)).not.toMatch(/never-leak|secret|001122|11111111/iu);
  });

  test('an asynchronous rejection is transient and does not freeze later calls', async () => {
    const h = harness();
    h.derive.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(Buffer.from(HASH, 'hex'));
    await expectCode(h.auth.login({ username: 'operator', password: 'p' }), 'AUTH_DEPENDENCY_FAILURE');
    await expect(h.auth.login({ username: 'operator', password: 'p' })).resolves.toEqual({ accessToken: expect.any(String) });
  });
});

describe('G06a JWT issue, verification, and current identity', () => {
  test('issues a real HS256 token with exactly five claims and 900 second TTL', async () => {
    const h = harness();
    const result = await h.auth.login({ username: 'operator', password: 'p' });
    expect(Object.isFrozen(result)).toBe(true);
    const header = jwt.decode(result.accessToken, { complete: true });
    expect(header).toMatchObject({ header: { alg: 'HS256', typ: 'JWT' } });
    const claims = jwt.verify(result.accessToken, JWT_KEY, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub']);
    expect(claims).toEqual(validClaims());
  });

  test('copies the 32-byte signing key and ignores later source mutation', async () => {
    const mutableKey = Buffer.from(JWT_KEY);
    const h = harness({ key: mutableKey });
    mutableKey.fill(0);
    const result = await h.auth.login({ username: 'operator', password: 'p' });
    expect(() => jwt.verify(result.accessToken, JWT_KEY, { algorithms: ['HS256'] })).not.toThrow();
    await expect(h.auth.verifyAccessToken(signClaims(validClaims()))).resolves.toBeInstanceOf(HumanPrincipal);
  });

  test.each([
    ['wrong signature', () => signClaims(validClaims(), {}, Buffer.alloc(32, 9))],
    ['none algorithm', () => jwt.sign(validClaims(), '', { algorithm: 'none' })],
    ['issuer', () => signClaims(validClaims({ iss: 'Other' }))],
    ['audience', () => signClaims(validClaims({ aud: 'other' }))],
    ['missing claim', () => { const claims = validClaims(); delete claims.aud; return signClaims(claims); }],
    ['extra claim', () => signClaims(validClaims({ role: 'OPERATOR' }))],
    ['claim type', () => rawHs256(validClaims({ iat: '1800000000' }))],
    ['future iat', () => signClaims(validClaims({ iat: NOW + 1, exp: NOW + 901 }))],
    ['wrong exp relation', () => signClaims(validClaims({ exp: NOW + 901 }))],
    ['expired', () => signClaims(validClaims({ iat: NOW - 901, exp: NOW - 1 }))],
  ])('rejects token with %s before current-user lookup', async (_label, makeToken) => {
    const h = harness();
    await expectCode(h.auth.verifyAccessToken(makeToken()), 'INVALID_TOKEN');
    expect(h.findCurrentById).not.toHaveBeenCalled();
  });

  test('rejects RS256 even with a valid-looking payload', async () => {
    const h = harness();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = jwt.sign(validClaims(), privateKey, { algorithm: 'RS256' });
    await expectCode(h.auth.verifyAccessToken(token), 'INVALID_TOKEN');
  });

  test('accepts at age 899 and rejects at exact 900-second expiry boundary', async () => {
    const token = signClaims(validClaims());
    await expect(harness({ clock: () => NOW + 899 }).auth.verifyAccessToken(token)).resolves.toBeInstanceOf(HumanPrincipal);
    await expectCode(harness({ clock: () => NOW + 900 }).auth.verifyAccessToken(token), 'INVALID_TOKEN');
  });

  test('always reloads current status and immediately reflects role changes', async () => {
    const h = harness();
    h.findCurrentById
      .mockResolvedValueOnce(status({ role: 'OPERATOR' }))
      .mockResolvedValueOnce(status({ role: 'VIEWER' }));
    const token = signClaims(validClaims());
    const first = await h.auth.verifyAccessToken(token);
    const second = await h.auth.verifyAccessToken(token);
    expect(h.auth.facts(first)).toEqual({ userId: USER_ID, role: 'OPERATOR' });
    expect(h.auth.facts(second)).toEqual({ userId: USER_ID, role: 'VIEWER' });
    expect(h.findCurrentById).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['deleted', null, 'INVALID_TOKEN'],
    ['disabled', status({ enabled: false }), 'INVALID_TOKEN'],
    ['extra row', status({ extra: true }), 'AUTH_DEPENDENCY_FAILURE'],
    ['wrong id', status({ userId: OTHER_ID }), 'AUTH_DEPENDENCY_FAILURE'],
    ['bad role', status({ role: 'ADMIN' }), 'AUTH_DEPENDENCY_FAILURE'],
  ] as const)('maps current reader %s safely', async (_label, current, code) => {
    const h = harness({ current });
    await expectCode(h.auth.verifyAccessToken(signClaims(validClaims())), code);
  });

  test('reader throw, reject, and non-Promise are technical; async reject does not freeze', async () => {
    const h = harness();
    h.findCurrentById.mockImplementationOnce(() => { throw new Error('db'); });
    await expectCode(h.auth.verifyAccessToken(signClaims(validClaims())), 'AUTH_DEPENDENCY_FAILURE');
    await expectCode(h.auth.verifyAccessToken(signClaims(validClaims())), 'AUTH_FROZEN');

    const transient = harness();
    transient.findCurrentById.mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce(status());
    await expectCode(transient.auth.verifyAccessToken(signClaims(validClaims())), 'AUTH_DEPENDENCY_FAILURE');
    await expect(transient.auth.verifyAccessToken(signClaims(validClaims()))).resolves.toBeInstanceOf(HumanPrincipal);

    const nonPromise = harness();
    nonPromise.findCurrentById.mockImplementation(() => status() as never);
    await expectCode(nonPromise.auth.verifyAccessToken(signClaims(validClaims())), 'AUTH_DEPENDENCY_FAILURE');
  });
});

describe('G06a principal, dependency capture, clocks, reentry, and concurrency', () => {
  test.each([
    null,
    {},
    { accountReader: {}, passwordDeriver: {}, jwtKey: JWT_KEY },
    { accountReader: { findByUsername: () => Promise.resolve(null), findCurrentById: () => Promise.resolve(null) }, passwordDeriver: {}, jwtKey: JWT_KEY },
    { accountReader: { findByUsername: () => Promise.resolve(null), findCurrentById: () => Promise.resolve(null) }, passwordDeriver: { derive: () => Promise.resolve(Buffer.alloc(64)) }, jwtKey: Buffer.alloc(31) },
    { accountReader: { findByUsername: () => Promise.resolve(null), findCurrentById: () => Promise.resolve(null) }, passwordDeriver: { derive: () => Promise.resolve(Buffer.alloc(64)) }, jwtKey: JWT_KEY, clock: 1 },
  ])('rejects malformed configuration before use: %#', (dependencies) => {
    expect(() => createHumanAuth(dependencies as never)).toThrow(expect.objectContaining({ code: 'AUTH_CONFIGURATION_FAILURE' }));
  });

  test('principal is frozen and empty; facts are frozen defensive results', async () => {
    const h = harness();
    const principal = await h.auth.verifyAccessToken(signClaims(validClaims()));
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.keys(principal)).toEqual([]);
    const first = h.auth.facts(principal);
    const second = h.auth.facts(principal);
    expect(first).toEqual({ userId: USER_ID, role: 'OPERATOR' });
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  test('rejects plain, fake-subclass, foreign, and cross-instance principals', async () => {
    const first = harness();
    const second = harness();
    const foreign = await second.auth.verifyAccessToken(signClaims(validClaims()));
    class FakePrincipal extends HumanPrincipal {}
    for (const principal of [{}, new HumanPrincipal(), new FakePrincipal(), foreign]) {
      expect(() => first.auth.facts(principal as HumanPrincipal)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
    }
  });

  test('assertRole accepts both exact roles and rejects mismatch or invalid required role', async () => {
    const operator = harness();
    const operatorPrincipal = await operator.auth.verifyAccessToken(signClaims(validClaims()));
    expect(() => operator.auth.assertRole(operatorPrincipal, 'OPERATOR')).not.toThrow();
    expect(() => operator.auth.assertRole(operatorPrincipal, 'VIEWER')).toThrow(expect.objectContaining({ code: 'ROLE_FORBIDDEN' }));
    expect(() => operator.auth.assertRole(operatorPrincipal, 'ADMIN' as never)).toThrow(expect.objectContaining({ code: 'ROLE_FORBIDDEN' }));
    const viewer = harness({ current: status({ role: 'VIEWER' }) });
    const viewerPrincipal = await viewer.auth.verifyAccessToken(signClaims(validClaims()));
    expect(() => viewer.auth.assertRole(viewerPrincipal, 'VIEWER')).not.toThrow();
  });

  test.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER])('invalid clock %p freezes capability', async (value) => {
    const h = harness({ clock: () => value });
    await expectCode(h.auth.login({ username: 'operator', password: 'p' }), 'AUTH_CLOCK_FAILURE');
    await expectCode(h.auth.login({ username: 'operator', password: 'p' }), 'AUTH_FROZEN');
  });

  test('throwing clock freezes capability without leaking cause', async () => {
    const h = harness({ clock: () => { throw new Error('clock-secret'); } });
    const error = await expectCode(h.auth.login({ username: 'operator', password: 'p' }), 'AUTH_CLOCK_FAILURE');
    expect(JSON.stringify(error)).not.toContain('clock-secret');
    await expectCode(h.auth.login({ username: 'operator', password: 'p' }), 'AUTH_FROZEN');
  });

  test('captures options and bound dependency methods against later mutation', async () => {
    let receiverSeen = '';
    const reader = {
      marker: 'captured',
      findByUsername(this: { marker: string }, username: string): Promise<unknown> {
        receiverSeen = this.marker;
        return Promise.resolve(account({ username }));
      },
      findCurrentById(): Promise<unknown> { return Promise.resolve(status()); },
    };
    const derive = jest.fn(() => Promise.resolve(Buffer.from(HASH, 'hex')));
    const dependencies = { accountReader: reader, passwordDeriver: { derive }, jwtKey: Buffer.from(JWT_KEY), clock: () => NOW };
    const auth = createHumanAuth(dependencies);
    reader.findByUsername = () => Promise.reject(new Error('mutated'));
    (dependencies.passwordDeriver as { derive: (password: string, salt: Uint8Array) => Promise<Uint8Array> }).derive =
      () => Promise.reject(new Error('mutated'));
    dependencies.clock = () => 0;
    const result = await auth.login({ username: 'operator', password: 'p' });
    expect(receiverSeen).toBe('captured');
    expect(derive).toHaveBeenCalledTimes(1);
    expect(jwt.decode(result.accessToken)).toMatchObject({ iat: NOW, exp: NOW + 900 });
  });

  test('caught synchronous reentry freezes the whole capability', async () => {
    let auth!: HumanAuthCapability;
    const reader = {
      findByUsername(): Promise<unknown> {
        try { auth.facts(new HumanPrincipal()); } catch { /* caller caught */ }
        return Promise.resolve(account());
      },
      findCurrentById(): Promise<unknown> { return Promise.resolve(status()); },
    };
    auth = createHumanAuth({ accountReader: reader, passwordDeriver: { derive: () => Promise.resolve(Buffer.from(HASH, 'hex')) }, jwtKey: JWT_KEY, clock: () => NOW });
    await expectCode(auth.login({ username: 'operator', password: 'p' }), 'AUTH_FROZEN');
    await expectCode(auth.login({ username: 'operator', password: 'p' }), 'AUTH_FROZEN');
  });

  test('uncaught synchronous reentry is sanitized and still freezes the whole capability', async () => {
    let auth!: HumanAuthCapability;
    const reader = {
      findByUsername(): Promise<unknown> {
        auth.facts(new HumanPrincipal());
        return Promise.resolve(account());
      },
      findCurrentById(): Promise<unknown> { return Promise.resolve(status()); },
    };
    auth = createHumanAuth({ accountReader: reader, passwordDeriver: { derive: () => Promise.resolve(Buffer.from(HASH, 'hex')) }, jwtKey: JWT_KEY, clock: () => NOW });
    await expectCode(auth.login({ username: 'operator', password: 'p' }), 'AUTH_DEPENDENCY_FAILURE');
    await expectCode(auth.login({ username: 'operator', password: 'p' }), 'AUTH_FROZEN');
  });

  test('two legal logins overlap with no mutex or retry', async () => {
    let releases: Array<() => void> = [];
    const h = harness();
    h.findByUsername.mockImplementation(() => new Promise((resolve) => releases.push(() => resolve(account()))));
    const first = h.auth.login({ username: 'operator', password: 'p' });
    const second = h.auth.login({ username: 'operator', password: 'p' });
    expect(h.findByUsername).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(2);
    for (const release of releases) release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(h.findByUsername).toHaveBeenCalledTimes(2);
    expect(h.derive).toHaveBeenCalledTimes(2);
  });

  test('errors and public results do not expose password, hash, salt, token, or cause fields', async () => {
    const h = harness({ derived: Buffer.alloc(64) });
    const error = await expectCode(h.auth.login({ username: 'operator', password: 'ultra-secret' }), 'INVALID_CREDENTIALS');
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(JSON.stringify(error)).not.toMatch(/ultra-secret|001122|111111|cause|token|hash|salt/iu);
    const success = await harness().auth.login({ username: 'operator', password: 'p' });
    expect(Object.keys(success)).toEqual(['accessToken']);
  });
});

describe('G06a static boundaries and excluded feature surface', () => {
  test('auth core does not import Access, Sources, Mongo, HTTP, or Nest; Mongo adapter stays infrastructure-only', async () => {
    const core = await readFile('src/auth/application/human-auth.ts', 'utf8');
    expect(core).not.toMatch(/from\s+['"][^'"]*(?:access|sources|mongodb|express|@nestjs|http)[^'"]*['"]/iu);
    const domain = `${await readFile('src/auth/domain/auth-error.ts', 'utf8')}\n${await readFile('src/auth/domain/human-principal.ts', 'utf8')}`;
    expect(domain).not.toMatch(/from\s+['"][^'"]*(?:access|sources|mongodb|express|@nestjs|http)[^'"]*['"]/iu);
    const mongo = await readFile('src/auth/infrastructure/mongo-human-account-reader.ts', 'utf8');
    expect(mongo).toMatch(/from 'mongodb'/u);
    expect(mongo).not.toMatch(/src\/access|src\/sources|@nestjs|express/iu);
  });

  test('auth has no Source auth/active/direction or forbidden account lifecycle features', async () => {
    const files = [
      'src/auth/application/human-auth.ts', 'src/auth/domain/human-principal.ts',
      'src/auth/ports/human-account-reader-port.ts', 'src/auth/index.ts',
    ];
    const text = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    expect(text).not.toMatch(/credentialAlias|sourceActive|\bdirection\b|\b(?:register|refresh|logout|resetPassword|admin)\s*\(/iu);
  });

  test('auth core contains no transaction, write, retry, or Promise.all orchestration', async () => {
    const text = await readFile('src/auth/application/human-auth.ts', 'utf8');
    expect(text).not.toMatch(/transaction|insertOne|updateOne|deleteOne|retry|Promise\.all/iu);
  });
});
