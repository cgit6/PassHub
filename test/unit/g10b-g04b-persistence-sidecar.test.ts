import type { ClientSession, MongoClient } from 'mongodb';

import { G04bMongoPersistenceAdapter } from '../../src/infrastructure/mongo/g04b-persistence-adapter.js';
import {
  attachG10bScopedPersistenceBindingResolver,
  createG10bScopedPersistenceBindingResolver,
} from '../../src/infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.js';
import { attachG10bG04bPersistenceSidecar } from '../../src/composition/internal/g10b-g04b-persistence-wire.js';
import { createAccessScopeContext } from '../../src/shared/access-scope-context.js';

const SCOPE = () => createAccessScopeContext({
  epoch: '11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
  generation: '33333333-3333-4333-8333-333333333333',
});

interface MongoHarness {
  readonly client: MongoClient;
  readonly startSession: jest.Mock;
  readonly startTransaction: jest.Mock;
}

function mongoHarness(): MongoHarness {
  const startTransaction = jest.fn();
  const session = {
    startTransaction,
    inTransaction: jest.fn(() => true),
    abortTransaction: jest.fn(async () => undefined),
    endSession: jest.fn(async () => undefined),
  } as unknown as ClientSession;
  const startSession = jest.fn(() => session);
  return {
    client: {
      db: jest.fn(() => ({})),
      startSession,
      on: jest.fn(),
    } as unknown as MongoClient,
    startSession,
    startTransaction,
  };
}

describe('G10b G04b scoped-persistence sidecar', () => {
  test('keeps an unattached concrete adapter on the legacy session path', async () => {
    const harness = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_legacy');

    await expect(adapter.readSourceFacts(SCOPE(), 'source-1')).rejects.toMatchObject({
      name: 'G04bTransactionError',
    });

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startTransaction).toHaveBeenCalledTimes(1);
    expect(() => attachG10bScopedPersistenceBindingResolver(
      adapter,
      createG10bScopedPersistenceBindingResolver(() => Object.freeze({})),
    )).toThrow(/before a G04b scoped transaction begins/i);
  });

  test('fails an attached but unbound composition scope before allocating a Mongo session', async () => {
    const harness = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_unbound');
    attachG10bG04bPersistenceSidecar(adapter);

    await expect(adapter.readSourceFacts(SCOPE(), 'source-1')).rejects.toMatchObject({
      name: 'G10bOperationBridgeError',
      code: 'ACCESS_SCOPE_NOT_BOUND',
    });

    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.startTransaction).not.toHaveBeenCalled();
  });

  test('accepts one branded resolver for a concrete adapter and rejects foreign or repeated attachment', () => {
    const harness = mongoHarness();
    const adapter = new G04bMongoPersistenceAdapter(harness.client, 'g10b_sidecar_once');
    const resolver = createG10bScopedPersistenceBindingResolver(() => Object.freeze({}));

    expect(() => attachG10bScopedPersistenceBindingResolver(
      Object.freeze({}) as G04bMongoPersistenceAdapter,
      resolver,
    )).toThrow(/concrete G04b Mongo persistence adapter/i);
    expect(() => attachG10bScopedPersistenceBindingResolver(
      adapter,
      Object.freeze({}) as never,
    )).toThrow(/resolver is foreign/i);
    attachG10bScopedPersistenceBindingResolver(adapter, resolver);
    expect(() => attachG10bScopedPersistenceBindingResolver(adapter, resolver)).toThrow(
      /already attached/i,
    );
  });
});
