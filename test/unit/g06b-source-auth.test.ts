import { readFile } from 'node:fs/promises';
import type * as Crypto from 'node:crypto';

import {
  createSourceAuth,
  type SourceAuthCapability,
} from '../../src/auth/application/source-auth.js';
import {
  SourceAuthError,
  SourcePrincipal,
  type SourceAuthErrorCode,
} from '../../src/auth/domain/index.js';
import {
  createSourceCredentialVerifier,
  SourceCredentialVerifierError,
  type SourceCredentialVerifierErrorCode,
} from '../../src/sources/application/source-credential-verifier.js';

const crypto = require('node:crypto') as typeof Crypto;

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const EXIT_ID = '22222222-2222-4222-8222-222222222222';
const ENTRY_SECRET = 'A'.repeat(43);
const EXIT_SECRET = 'B'.repeat(43);
// Independently pinned SHA-256 literals. The production helper is deliberately not used.
const ENTRY_DIGEST = '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a';
const EXIT_DIGEST = '412dc46cc9e3cb26f29f7c1415c556349af62904c5d15b0a2d8cfdc5cfa22b34';

function record(alias: 'entry' | 'exit', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceId: alias === 'entry' ? ENTRY_ID : EXIT_ID,
    credentialAlias: alias,
    credentialDigest: alias === 'entry' ? ENTRY_DIGEST : EXIT_DIGEST,
    ...overrides,
  };
}

function verifierHarness(row: unknown | null = record('entry')): {
  readonly verifier: ReturnType<typeof createSourceCredentialVerifier>;
  readonly findByAlias: jest.Mock<Promise<unknown | null>, ['entry' | 'exit']>;
} {
  const findByAlias = jest.fn<Promise<unknown | null>, ['entry' | 'exit']>(() => Promise.resolve(row));
  return { verifier: createSourceCredentialVerifier({ reader: { findByAlias } }), findByAlias };
}

function authHarness(behavior?: (alias: string, secret: string) => Promise<Readonly<{ sourceId: string }> | null>): {
  readonly auth: SourceAuthCapability;
  readonly verify: jest.Mock<Promise<Readonly<{ sourceId: string }> | null>, [string, string]>;
} {
  const verify = jest.fn<Promise<Readonly<{ sourceId: string }> | null>, [string, string]>(
    behavior ?? ((alias) => Promise.resolve(Object.freeze({ sourceId: alias === 'entry' ? ENTRY_ID : EXIT_ID }))),
  );
  return { auth: createSourceAuth({ credentialVerifier: { verify } }), verify };
}

async function expectAuthCode(work: Promise<unknown>, code: SourceAuthErrorCode): Promise<SourceAuthError> {
  try {
    await work;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SourceAuthError);
    expect((error as SourceAuthError).code).toBe(code);
    return error as SourceAuthError;
  }
  throw new Error(`expected SourceAuthError ${code}`);
}

async function expectVerifierCode(
  work: Promise<unknown>,
  code: SourceCredentialVerifierErrorCode,
): Promise<SourceCredentialVerifierError> {
  try {
    await work;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SourceCredentialVerifierError);
    expect((error as SourceCredentialVerifierError).code).toBe(code);
    return error as SourceCredentialVerifierError;
  }
  throw new Error(`expected SourceCredentialVerifierError ${code}`);
}

describe('G06b exact Source credential parser', () => {
  test.each([
    ['entry', ENTRY_SECRET, ENTRY_ID],
    ['exit', EXIT_SECRET, EXIT_ID],
  ] as const)('accepts exact %s credential and passes the unmodified secret', async (alias, secret, sourceId) => {
    const h = authHarness();
    const principal = await h.auth.verifySourceCredential(`${alias}.${secret}`);
    expect(h.verify).toHaveBeenCalledWith(alias, secret);
    expect(h.auth.facts(principal)).toEqual({ sourceId });
  });

  test.each([
    ['non-string null', null],
    ['non-string object', { credential: `entry.${ENTRY_SECRET}` }],
    ['zero dots', `entry${ENTRY_SECRET}`],
    ['two dots', `entry.${ENTRY_SECRET}.x`],
    ['alias case', `Entry.${ENTRY_SECRET}`],
    ['unknown alias', `door.${ENTRY_SECRET}`],
    ['fullwidth confusable', `ｅntry.${ENTRY_SECRET}`],
    ['Cyrillic confusable', `еntry.${ENTRY_SECRET}`],
    ['42 chars', `entry.${'A'.repeat(42)}`],
    ['44 chars', `entry.${'A'.repeat(44)}`],
    ['plus', `entry.${'A'.repeat(42)}+`],
    ['equals', `entry.${'A'.repeat(42)}=`],
    ['dot in secret', `entry.${'A'.repeat(21)}.${'A'.repeat(21)}`],
    ['leading whitespace', ` entry.${ENTRY_SECRET}`],
    ['trailing whitespace', `entry.${ENTRY_SECRET} `],
    ['embedded LF', `entry.${'A'.repeat(21)}\n${'A'.repeat(21)}`],
    ['CRLF', `entry.${ENTRY_SECRET}\r\n`],
    ['Unicode secret', `entry.${'A'.repeat(42)}é`],
    ['Unicode normalization', `entry.${'A'.repeat(41)}e\u0301`],
  ])('rejects %s generically without lookup', async (_label, credential) => {
    const h = authHarness();
    const error = await expectAuthCode(
      h.auth.verifySourceCredential(credential as string),
      'INVALID_SOURCE_CREDENTIAL',
    );
    expect(h.verify).not.toHaveBeenCalled();
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(JSON.stringify(error)).not.toMatch(/AAAA|entry|exit|secret|digest|cause/iu);
  });
});

describe('G06b Source credential verifier and SHA-256 contract', () => {
  test('known raw ASCII secret matches independently pinned lower-hex SHA-256 and returns a frozen identity', async () => {
    const h = verifierHarness(record('entry'));
    const result = await h.verifier.verify('entry', ENTRY_SECRET);
    expect(result).toEqual({ sourceId: ENTRY_ID });
    expect(Object.isFrozen(result)).toBe(true);
    expect(h.findByAlias).toHaveBeenCalledWith('entry');
  });

  test.each([
    ['entry', ENTRY_SECRET, record('entry')],
    ['exit', EXIT_SECRET, record('exit')],
  ] as const)('decodes an exact 64-char lower-hex digest for %s', async (alias, secret, row) => {
    const h = verifierHarness(row);
    await expect(h.verifier.verify(alias, secret)).resolves.toEqual({ sourceId: row.sourceId });
  });

  test('wrong secret and missing row are indistinguishable null results', async () => {
    const wrong = verifierHarness(record('entry'));
    const missing = verifierHarness(null);
    await expect(wrong.verifier.verify('entry', 'C'.repeat(43))).resolves.toBeNull();
    await expect(missing.verifier.verify('entry', ENTRY_SECRET)).resolves.toBeNull();
  });

  test('missing row still executes a 32-byte dummy timing-safe comparison', async () => {
    const equal = jest.spyOn(crypto, 'timingSafeEqual');
    const h = verifierHarness(null);
    await expect(h.verifier.verify('entry', ENTRY_SECRET)).resolves.toBeNull();
    expect(equal).toHaveBeenCalledTimes(1);
    const [actual, expected] = equal.mock.calls[0]!;
    expect(actual).toEqual(Buffer.from(ENTRY_DIGEST, 'hex'));
    expect(expected).toEqual(Buffer.alloc(32));
  });

  test.each([
    ['odd digest', record('entry', { credentialDigest: 'a'.repeat(63) })],
    ['uppercase digest', record('entry', { credentialDigest: ENTRY_DIGEST.toUpperCase() })],
    ['non-hex digest', record('entry', { credentialDigest: `${'a'.repeat(63)}g` })],
    ['short digest', record('entry', { credentialDigest: 'aa'.repeat(31) })],
    ['long digest', record('entry', { credentialDigest: 'aa'.repeat(33) })],
    ['alias mismatch', record('exit', { credentialDigest: ENTRY_DIGEST })],
    ['invalid UUID', record('entry', { sourceId: '11111111-1111-3111-8111-111111111111' })],
    ['extra key', record('entry', { active: true })],
    ['missing key', (() => { const value = record('entry'); delete value.credentialDigest; return value; })()],
  ])('maps malformed row (%s) to a technical dependency error', async (_label, row) => {
    const h = verifierHarness(row);
    const error = await expectVerifierCode(
      h.verifier.verify('entry', ENTRY_SECRET),
      'SOURCE_CREDENTIAL_DEPENDENCY_FAILURE',
    );
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(JSON.stringify(error)).not.toMatch(/0f0073|AAAA|sourceId|credentialDigest|cause/iu);
  });

  test.each([
    ['bad alias', 'Entry', ENTRY_SECRET],
    ['unknown alias', 'door', ENTRY_SECRET],
    ['non-string secret', 'entry', null],
    ['short secret', 'entry', 'A'.repeat(42)],
    ['plus in secret', 'entry', `${'A'.repeat(42)}+`],
  ])('rejects caller contract violation %s before lookup', async (_label, alias, secret) => {
    const h = verifierHarness();
    await expectVerifierCode(
      h.verifier.verify(alias, secret as string),
      'SOURCE_CREDENTIAL_CONFIGURATION_FAILURE',
    );
    expect(h.findByAlias).not.toHaveBeenCalled();
  });
});

describe('G06b trusted identity and opacity', () => {
  test('entry and exit identities contain only sourceId even when the database source is inactive', async () => {
    for (const [alias, secret, sourceId] of [
      ['entry', ENTRY_SECRET, ENTRY_ID],
      ['exit', EXIT_SECRET, EXIT_ID],
    ] as const) {
      const h = authHarness((actualAlias, actualSecret) => {
        expect(actualAlias).toBe(alias);
        expect(actualSecret).toBe(secret);
        return Promise.resolve(Object.freeze({ sourceId }));
      });
      const principal = await h.auth.verifySourceCredential(`${alias}.${secret}`);
      const facts = h.auth.facts(principal);
      expect(facts).toEqual({ sourceId });
      expect(Object.keys(facts)).toEqual(['sourceId']);
      expect(Object.isFrozen(facts)).toBe(true);
      expect(facts).not.toBe(h.auth.facts(principal));
    }
  });

  test('principal is a frozen, empty, opaque issuer-bound capability', async () => {
    const h = authHarness();
    const principal = await h.auth.verifySourceCredential(`entry.${ENTRY_SECRET}`);
    expect(principal).toBeInstanceOf(SourcePrincipal);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Reflect.ownKeys(principal)).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(principal)).toEqual({});
    expect(JSON.stringify(principal)).toBe('{}');
    for (const key of ['sourceId', 'alias', 'secret', 'credentialDigest', 'active', 'direction']) {
      expect(key in (principal as unknown as object)).toBe(false);
      expect(key in (h.auth.facts(principal) as unknown as object)).toBe(key === 'sourceId');
    }
  });

  test('rejects plain, direct, subclass, foreign, and cross-instance principals', async () => {
    const first = authHarness();
    const second = authHarness();
    const foreign = await second.auth.verifySourceCredential(`entry.${ENTRY_SECRET}`);
    class FakePrincipal extends SourcePrincipal {}
    for (const principal of [{}, new SourcePrincipal(), new FakePrincipal(), foreign]) {
      expect(() => first.auth.facts(principal as SourcePrincipal)).toThrow(
        expect.objectContaining({ code: 'INVALID_SOURCE_CREDENTIAL' }),
      );
    }
  });

  test('missing credential is generic while malformed verifier identities are technical', async () => {
    const missing = authHarness(() => Promise.resolve(null));
    await expectAuthCode(
      missing.auth.verifySourceCredential(`entry.${ENTRY_SECRET}`),
      'INVALID_SOURCE_CREDENTIAL',
    );

    for (const value of [
      { sourceId: ENTRY_ID },
      Object.freeze({ sourceId: ENTRY_ID, active: true }),
      Object.freeze({}),
      Object.freeze({ sourceId: '11111111-1111-3111-8111-111111111111' }),
      Object.freeze({ sourceId: ENTRY_ID, alias: 'entry' }),
      Object.freeze({ sourceId: ENTRY_ID, credentialDigest: ENTRY_DIGEST }),
      Object.freeze({ sourceId: ENTRY_ID, direction: 'ENTRY' }),
    ]) {
      const h = authHarness(() => Promise.resolve(value as Readonly<{ sourceId: string }>));
      await expectAuthCode(
        h.auth.verifySourceCredential(`entry.${ENTRY_SECRET}`),
        'SOURCE_AUTH_DEPENDENCY_FAILURE',
      );
    }
  });
});

describe('G06b hostile dependency boundaries, reentry, and concurrency', () => {
  test.each([
    null,
    {},
    { reader: {} },
    { reader: { findByAlias: 1 } },
  ])('rejects malformed verifier configuration: %#', (dependencies) => {
    expect(() => createSourceCredentialVerifier(dependencies as never)).toThrow(
      expect.objectContaining({ code: 'SOURCE_CREDENTIAL_CONFIGURATION_FAILURE' }),
    );
  });

  test.each([
    null,
    {},
    { credentialVerifier: {} },
    { credentialVerifier: { verify: 1 } },
  ])('rejects malformed Auth configuration: %#', (dependencies) => {
    expect(() => createSourceAuth(dependencies as never)).toThrow(
      expect.objectContaining({ code: 'SOURCE_AUTH_CONFIGURATION_FAILURE' }),
    );
  });

  test('captures bound reader method and receiver against later method/options mutation', async () => {
    let receiver = '';
    const reader = {
      marker: 'original',
      findByAlias(this: { marker: string }, alias: 'entry' | 'exit'): Promise<unknown> {
        receiver = this.marker;
        return Promise.resolve(record(alias));
      },
    };
    const dependencies = { reader };
    const verifier = createSourceCredentialVerifier(dependencies);
    reader.findByAlias = () => Promise.reject(new Error('mutated secret'));
    dependencies.reader = { marker: 'replacement', findByAlias: () => Promise.reject(new Error('replacement')) };
    await expect(verifier.verify('entry', ENTRY_SECRET)).resolves.toEqual({ sourceId: ENTRY_ID });
    expect(receiver).toBe('original');
  });

  test('captures bound Auth verifier method and copies its frozen result', async () => {
    let receiver = '';
    const result = Object.freeze({ sourceId: ENTRY_ID });
    const credentialVerifier = {
      marker: 'original',
      verify(this: { marker: string }): Promise<Readonly<{ sourceId: string }>> {
        receiver = this.marker;
        return Promise.resolve(result);
      },
    };
    const dependencies = { credentialVerifier };
    const auth = createSourceAuth(dependencies);
    credentialVerifier.verify = () => Promise.reject(new Error('mutated'));
    dependencies.credentialVerifier = { marker: 'replacement', verify: () => Promise.reject(new Error('replacement')) };
    const principal = await auth.verifySourceCredential(`entry.${ENTRY_SECRET}`);
    expect(auth.facts(principal)).toEqual({ sourceId: ENTRY_ID });
    expect(receiver).toBe('original');
  });

  test.each([
    ['sync throw', () => { throw new Error('row-secret'); }, true],
    ['async reject', () => Promise.reject(new Error('row-secret')), false],
    ['non-Promise', () => record('entry'), true],
    ['thenable', () => ({ then: (resolve: (value: unknown) => void) => resolve(record('entry')) }), true],
  ])('reader %s is sanitized; only synchronous contract failures freeze', async (_label, behavior, freezes) => {
    const findByAlias = jest.fn<Promise<unknown | null>, ['entry' | 'exit']>(behavior as never);
    const verifier = createSourceCredentialVerifier({ reader: { findByAlias } });
    const error = await expectVerifierCode(
      verifier.verify('entry', ENTRY_SECRET),
      'SOURCE_CREDENTIAL_DEPENDENCY_FAILURE',
    );
    expect(JSON.stringify(error)).not.toMatch(/row-secret|AAAA|digest|cause/iu);
    findByAlias.mockImplementation(() => Promise.resolve(record('entry')));
    if (freezes) await expectVerifierCode(verifier.verify('entry', ENTRY_SECRET), 'SOURCE_CREDENTIAL_FROZEN');
    else await expect(verifier.verify('entry', ENTRY_SECRET)).resolves.toEqual({ sourceId: ENTRY_ID });
  });

  test.each([
    ['sync throw', () => { throw new Error('verifier-secret'); }, true],
    ['async reject', () => Promise.reject(new Error('verifier-secret')), false],
    ['non-Promise', () => Object.freeze({ sourceId: ENTRY_ID }), true],
    ['thenable', () => ({ then: (resolve: (value: unknown) => void) => resolve(Object.freeze({ sourceId: ENTRY_ID })) }), true],
  ])('Auth verifier %s is sanitized; only synchronous contract failures freeze', async (_label, behavior, freezes) => {
    const verify = jest.fn<Promise<Readonly<{ sourceId: string }> | null>, [string, string]>(behavior as never);
    const auth = createSourceAuth({ credentialVerifier: { verify } });
    const error = await expectAuthCode(
      auth.verifySourceCredential(`entry.${ENTRY_SECRET}`),
      'SOURCE_AUTH_DEPENDENCY_FAILURE',
    );
    expect(JSON.stringify(error)).not.toMatch(/verifier-secret|AAAA|digest|cause/iu);
    verify.mockImplementation(() => Promise.resolve(Object.freeze({ sourceId: ENTRY_ID })));
    if (freezes) await expectAuthCode(auth.verifySourceCredential(`entry.${ENTRY_SECRET}`), 'SOURCE_AUTH_FROZEN');
    else await expect(auth.verifySourceCredential(`entry.${ENTRY_SECRET}`)).resolves.toBeInstanceOf(SourcePrincipal);
  });

  test.each([
    ['ownKeys', new Proxy(record('entry'), { ownKeys: () => { throw new Error('proxy-secret'); } })],
    ['get', new Proxy(record('entry'), { get: () => { throw new Error('proxy-secret'); } })],
  ])('hostile row Proxy %s is typed, sanitized, and verifier remains usable', async (_label, hostile) => {
    const h = verifierHarness(hostile);
    const error = await expectVerifierCode(h.verifier.verify('entry', ENTRY_SECRET), 'SOURCE_CREDENTIAL_DEPENDENCY_FAILURE');
    expect(JSON.stringify(error)).not.toContain('proxy-secret');
    h.findByAlias.mockResolvedValue(record('entry'));
    await expect(h.verifier.verify('entry', ENTRY_SECRET)).resolves.toEqual({ sourceId: ENTRY_ID });
  });

  test.each([
    ['ownKeys', new Proxy(Object.freeze({ sourceId: ENTRY_ID }), { ownKeys: () => { throw new Error('proxy-secret'); } })],
    ['get', new Proxy(Object.freeze({ sourceId: ENTRY_ID }), { get: () => { throw new Error('proxy-secret'); } })],
    ['isFrozen/isExtensible', new Proxy(Object.freeze({ sourceId: ENTRY_ID }), { isExtensible: () => { throw new Error('proxy-secret'); } })],
  ])('hostile verification Proxy %s is typed, sanitized, and Auth remains usable', async (_label, hostile) => {
    const h = authHarness(() => Promise.resolve(hostile as Readonly<{ sourceId: string }>));
    const error = await expectAuthCode(h.auth.verifySourceCredential(`entry.${ENTRY_SECRET}`), 'SOURCE_AUTH_DEPENDENCY_FAILURE');
    expect(JSON.stringify(error)).not.toContain('proxy-secret');
    h.verify.mockResolvedValue(Object.freeze({ sourceId: ENTRY_ID }));
    await expect(h.auth.verifySourceCredential(`entry.${ENTRY_SECRET}`)).resolves.toBeInstanceOf(SourcePrincipal);
  });

  test('dependency-triggered verifier reentry freezes the verifier even when its rejection is observed', async () => {
    let verifier!: ReturnType<typeof createSourceCredentialVerifier>;
    const reader = {
      findByAlias(): Promise<unknown> {
        void verifier.verify('entry', ENTRY_SECRET).catch(() => undefined);
        return Promise.resolve(record('entry'));
      },
    };
    verifier = createSourceCredentialVerifier({ reader });
    await expectVerifierCode(verifier.verify('entry', ENTRY_SECRET), 'SOURCE_CREDENTIAL_FROZEN');
    await expectVerifierCode(verifier.verify('entry', ENTRY_SECRET), 'SOURCE_CREDENTIAL_FROZEN');
  });

  test('caught and uncaught synchronous Auth reentry freeze Auth', async () => {
    for (const caught of [true, false]) {
      let auth!: SourceAuthCapability;
      const credentialVerifier = {
        verify(): Promise<Readonly<{ sourceId: string }>> {
          if (caught) {
            try { auth.facts(new SourcePrincipal()); } catch { /* deliberately caught */ }
          } else {
            auth.facts(new SourcePrincipal());
          }
          return Promise.resolve(Object.freeze({ sourceId: ENTRY_ID }));
        },
      };
      auth = createSourceAuth({ credentialVerifier });
      await expectAuthCode(auth.verifySourceCredential(`entry.${ENTRY_SECRET}`), caught
        ? 'SOURCE_AUTH_FROZEN'
        : 'SOURCE_AUTH_DEPENDENCY_FAILURE');
      await expectAuthCode(auth.verifySourceCredential(`entry.${ENTRY_SECRET}`), 'SOURCE_AUTH_FROZEN');
    }
  });

  test('two legitimate verifier/Auth operations overlap without a mutex', async () => {
    const releases: Array<() => void> = [];
    const h = verifierHarness();
    h.findByAlias.mockImplementation((alias) => new Promise((resolve) => {
      releases.push(() => resolve(record(alias)));
    }));
    const first = h.verifier.verify('entry', ENTRY_SECRET);
    const second = h.verifier.verify('exit', EXIT_SECRET);
    expect(h.findByAlias).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { sourceId: ENTRY_ID }, { sourceId: EXIT_ID },
    ]);

    h.findByAlias.mockImplementation((alias) => Promise.resolve(record(alias)));
    const auth = createSourceAuth({ credentialVerifier: h.verifier });
    await expect(Promise.all([
      auth.verifySourceCredential(`entry.${ENTRY_SECRET}`),
      auth.verifySourceCredential(`exit.${EXIT_SECRET}`),
    ])).resolves.toHaveLength(2);
  });

  test('ordinary rejection cannot spoof the verifier crypto-failure contract', async () => {
    const auth = authHarness(() => Promise.reject({ code: 'SOURCE_CREDENTIAL_CRYPTO_FAILURE' })).auth;
    await expectAuthCode(
      auth.verifySourceCredential(`entry.${ENTRY_SECRET}`),
      'SOURCE_AUTH_DEPENDENCY_FAILURE',
    );
  });

  test('ordinary Error with forged verifier name and code cannot spoof the nominal crypto-failure contract', async () => {
    const spoof = new Error('forged crypto failure') as Error & { code: string };
    spoof.name = 'SourceCredentialVerifierError';
    spoof.code = 'SOURCE_CREDENTIAL_CRYPTO_FAILURE';
    const auth = authHarness(() => Promise.reject(spoof)).auth;
    const error = await expectAuthCode(
      auth.verifySourceCredential(`entry.${ENTRY_SECRET}`),
      'SOURCE_AUTH_DEPENDENCY_FAILURE',
    );
    expect(JSON.stringify(error)).not.toMatch(/forged|AAAA|digest|cause/iu);
  });

  test('real verifier crypto failure is sanitized by Auth', async () => {
    const cryptoFailure = new SourceCredentialVerifierError('SOURCE_CREDENTIAL_CRYPTO_FAILURE');
    const auth = authHarness(() => Promise.reject(cryptoFailure)).auth;
    const error = await expectAuthCode(
      auth.verifySourceCredential(`entry.${ENTRY_SECRET}`),
      'SOURCE_AUTH_CRYPTO_FAILURE',
    );
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(JSON.stringify(error)).not.toMatch(/AAAA|digest|cause/iu);
  });
});

describe('G06b cryptographic primitive fault containment', () => {
  test.each(['createHash', 'update', 'digest', 'timingSafeEqual'] as const)(
    '%s first fault is crypto failure and freezes all later use',
    async (stage) => {
      if (stage === 'createHash') {
        jest.spyOn(crypto, 'createHash').mockImplementationOnce(() => { throw new Error('crypto-secret'); });
      } else if (stage === 'update') {
        jest.spyOn(crypto, 'createHash').mockReturnValueOnce({
          update: () => { throw new Error('crypto-secret'); },
        } as never);
      } else if (stage === 'digest') {
        jest.spyOn(crypto, 'createHash').mockReturnValueOnce({
          update: () => ({ digest: () => { throw new Error('crypto-secret'); } }),
        } as never);
      } else {
        jest.spyOn(crypto, 'timingSafeEqual').mockImplementationOnce(() => { throw new Error('crypto-secret'); });
      }
      const h = verifierHarness(record('entry'));
      const error = await expectVerifierCode(
        h.verifier.verify('entry', ENTRY_SECRET),
        'SOURCE_CREDENTIAL_CRYPTO_FAILURE',
      );
      expect(Object.keys(error).sort()).toEqual(['code', 'name']);
      expect(JSON.stringify(error)).not.toMatch(/crypto-secret|AAAA|digest|cause/iu);
      await expectVerifierCode(h.verifier.verify('entry', ENTRY_SECRET), 'SOURCE_CREDENTIAL_FROZEN');
    },
  );
});

describe('G06b static unit assertions', () => {
  test('production uses SHA-256 and timingSafeEqual, never string/equality digest comparison', async () => {
    const source = await readFile('src/sources/application/source-credential-verifier.ts', 'utf8');
    expect(source).toMatch(/createHash\('sha256'\)/u);
    expect(source).toMatch(/timingSafeEqual\(actualDigest, expectedDigest\)/u);
    expect(source).not.toMatch(/credentialDigest\s*(?:===|==)|\.equals\(/u);
  });
});
