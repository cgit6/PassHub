import {
  MongoCapabilityVerificationError,
  verifyMongoCapabilitiesForTest,
  type MongoCapabilityCommand,
} from '../support/g12g2-mongo-capability-test-support.js';
import {
  assertG12g2LocalIntegrationTarget,
  G12G2_LOCAL_INTEGRATION_URI,
} from '../support/g12g2-local-target-guard.js';

const LOCAL_BUILD = Object.freeze({ version: '8.0.32' });
const LOCAL_HELLO = Object.freeze({
  setName: 'rs0',
  isWritablePrimary: true,
  hosts: ['mongo:27017'],
});
const ATLAS_HELLO = Object.freeze({
  isWritablePrimary: true,
  logicalSessionTimeoutMinutes: 30,
});

function stableFailure(): Readonly<Record<string, unknown>> {
  return expect.objectContaining({
    name: 'MongoCapabilityVerificationError',
    message: 'MONGO_CAPABILITY_VERIFICATION_FAILED',
    code: 'MONGO_CAPABILITY_VERIFICATION_FAILED',
  }) as Readonly<Record<string, unknown>>;
}

describe('G12g-2 Mongo capability verifier', () => {
  test('destructive Local integration target guard accepts only the isolated canonical target', () => {
    expect(assertG12g2LocalIntegrationTarget(
      G12G2_LOCAL_INTEGRATION_URI,
      'passhub_g12g2_12345',
    )).toEqual({
      uri: G12G2_LOCAL_INTEGRATION_URI,
      databaseName: 'passhub_g12g2_12345',
    });
  });

  test.each([
    ['remote host', 'mongodb://example.invalid:27029/?replicaSet=rs0', 'passhub_g12g2_123'],
    ['localhost alias', 'mongodb://localhost:27029/?replicaSet=rs0', 'passhub_g12g2_123'],
    ['wrong port', 'mongodb://127.0.0.1:27017/?replicaSet=rs0', 'passhub_g12g2_123'],
    ['credentials', 'mongodb://user:password@127.0.0.1:27029/?replicaSet=rs0', 'passhub_g12g2_123'],
    ['database path', 'mongodb://127.0.0.1:27029/passhub?replicaSet=rs0', 'passhub_g12g2_123'],
    ['missing replica set', 'mongodb://127.0.0.1:27029/', 'passhub_g12g2_123'],
    ['extra query', 'mongodb://127.0.0.1:27029/?replicaSet=rs0&retryWrites=true', 'passhub_g12g2_123'],
    ['arbitrary database', G12G2_LOCAL_INTEGRATION_URI, 'passhub_demo'],
    ['database suffix', G12G2_LOCAL_INTEGRATION_URI, 'passhub_g12g2_123_other'],
    ['zero identifier', G12G2_LOCAL_INTEGRATION_URI, 'passhub_g12g2_0'],
    ['path-like database', G12G2_LOCAL_INTEGRATION_URI, '../passhub_g12g2_123'],
  ])('destructive Local integration target guard rejects %s', (_case, uri, databaseName) => {
    expect(() => assertG12g2LocalIntegrationTarget(uri, databaseName))
      .toThrow('G12G2_LOCAL_INTEGRATION_TARGET_REJECTED');
  });

  test('Local requires buildInfo then hello, exactly once each', async () => {
    const commands: MongoCapabilityCommand[] = [];
    await verifyMongoCapabilitiesForTest('LOCAL_SELF_HOSTED', async (command) => {
      commands.push(command);
      return 'buildInfo' in command ? LOCAL_BUILD : LOCAL_HELLO;
    });
    expect(commands).toEqual([{ buildInfo: 1 }, { hello: 1 }]);
    expect(commands.every(Object.isFrozen)).toBe(true);
  });

  test.each([
    ['missing build document', null, LOCAL_HELLO],
    ['wrong patch', { version: '8.0.31' }, LOCAL_HELLO],
    ['non-string patch', { version: 8 }, LOCAL_HELLO],
    ['missing hello document', LOCAL_BUILD, null],
    ['wrong replica set', LOCAL_BUILD, { ...LOCAL_HELLO, setName: 'atlas-0' }],
    ['not writable', LOCAL_BUILD, { ...LOCAL_HELLO, isWritablePrimary: false }],
    ['missing hosts', LOCAL_BUILD, { setName: 'rs0', isWritablePrimary: true }],
    ['empty hosts', LOCAL_BUILD, { ...LOCAL_HELLO, hosts: [] }],
    ['multiple hosts', LOCAL_BUILD, { ...LOCAL_HELLO, hosts: ['a', 'b'] }],
    ['non-string host', LOCAL_BUILD, { ...LOCAL_HELLO, hosts: [1] }],
    ['empty host', LOCAL_BUILD, { ...LOCAL_HELLO, hosts: [''] }],
  ])('Local rejects %s with a stable failure', async (_case, buildInfo, hello) => {
    await expect(verifyMongoCapabilitiesForTest('LOCAL_SELF_HOSTED', async (command) => (
      'buildInfo' in command ? buildInfo : hello
    ))).rejects.toEqual(stableFailure());
  });

  test('Atlas issues hello only and ignores patch, setName, hosts, and msg topology fields', async () => {
    const commands: MongoCapabilityCommand[] = [];
    const result = await verifyMongoCapabilitiesForTest('ATLAS_MANAGED', async (command) => {
      commands.push(command);
      return {
        ...ATLAS_HELLO,
        version: '99.123.456',
        setName: 'atlas-managed-shard-0',
        hosts: ['a', 'b', 'c'],
        msg: 'isdbgrid',
      };
    });
    expect(commands).toEqual([{ hello: 1 }]);
    // A branch-only mock proves command selection, not real Atlas compatibility.
    expect(result).toBeUndefined();
  });

  test.each([
    ['missing hello document', null],
    ['not writable', { ...ATLAS_HELLO, isWritablePrimary: false }],
    ['missing session timeout', { isWritablePrimary: true }],
    ['zero session timeout', { ...ATLAS_HELLO, logicalSessionTimeoutMinutes: 0 }],
    ['negative session timeout', { ...ATLAS_HELLO, logicalSessionTimeoutMinutes: -1 }],
    ['fractional session timeout', { ...ATLAS_HELLO, logicalSessionTimeoutMinutes: 1.5 }],
    ['unsafe session timeout', { ...ATLAS_HELLO, logicalSessionTimeoutMinutes: Number.MAX_SAFE_INTEGER + 1 }],
    ['string session timeout', { ...ATLAS_HELLO, logicalSessionTimeoutMinutes: '30' }],
  ])('Atlas rejects %s with a stable failure', async (_case, hello) => {
    await expect(verifyMongoCapabilitiesForTest('ATLAS_MANAGED', async () => hello))
      .rejects.toEqual(stableFailure());
  });

  test('driver failures are replaced and do not retain sensitive cause or message', async () => {
    const secret = 'mongodb+srv://user:password@example.invalid/private-host';
    let caught: unknown;
    try {
      await verifyMongoCapabilitiesForTest('ATLAS_MANAGED', async () => {
        throw new Error(secret);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MongoCapabilityVerificationError);
    expect(String(caught)).toBe('MongoCapabilityVerificationError: MONGO_CAPABILITY_VERIFICATION_FAILED');
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
  });

  test('Local driver failures are also replaced without retaining the rejected value', async () => {
    const secret = 'mongodb://root:password@private-local-host:27017/admin';
    let caught: unknown;
    try {
      await verifyMongoCapabilitiesForTest('LOCAL_SELF_HOSTED', async () => {
        throw Object.freeze({ message: secret, topology: ['private-local-host:27017'] });
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MongoCapabilityVerificationError);
    expect(String(caught)).toBe('MongoCapabilityVerificationError: MONGO_CAPABILITY_VERIFICATION_FAILED');
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
  });

  test('an untyped invalid profile fails closed without invoking Mongo', async () => {
    const runner = jest.fn(async () => ATLAS_HELLO);
    await expect(verifyMongoCapabilitiesForTest(
      'INVALID' as 'LOCAL_SELF_HOSTED',
      runner,
    )).rejects.toEqual(stableFailure());
    expect(runner).not.toHaveBeenCalled();
  });
});
