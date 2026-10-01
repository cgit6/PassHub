import type { ClientSession } from 'mongodb';

import {
  G10bPrecommitMongoTerminatorError,
  createG10bPrecommitMongoTerminator,
} from '../../src/infrastructure/mongo/internal/g10b-precommit-mongo-terminator.js';
import type { G10bScopedPersistencePrecommitAuthority } from '../../src/infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.js';

function authority(outcome: 'NO_EFFECT_CONFIRMED' | 'STILL_UNKNOWN' = 'NO_EFFECT_CONFIRMED'): {
  readonly authority: G10bScopedPersistencePrecommitAuthority;
  readonly abortOnce: jest.Mock;
  readonly terminate: jest.Mock;
} {
  const abortOnce = jest.fn(async (send: (context: { readonly timeoutMs: number; readonly attempt: number }) => Promise<void> | void) => {
    await send({ timeoutMs: 2_000, attempt: 0 });
    return outcome;
  });
  const terminate = jest.fn(() => undefined);
  return {
    authority: { abortOnce, terminate },
    abortOnce,
    terminate,
  };
}

describe('G10b internal Mongo precommit terminator', () => {
  test('uses one authority-owned abort with its fixed timeout, terminally settles, then ends session', async () => {
    const calls: string[] = [];
    const h = authority();
    const terminator = createG10bPrecommitMongoTerminator({
      authority: h.authority,
      session: {
        abortTransaction: jest.fn(async (options?: { readonly timeoutMS?: number }) => { calls.push(`abort:${options?.timeoutMS}`); }),
        endSession: jest.fn(async () => { calls.push('end'); }),
        inTransaction: jest.fn(() => false),
      } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession' | 'inTransaction'>,
    });

    await expect(terminator.terminatePrecommit()).resolves.toEqual({ outcome: 'NO_EFFECT_CONFIRMED', abortAttempts: 1 });
    expect(calls).toEqual(['abort:2000', 'end']);
    expect(h.abortOnce).toHaveBeenCalledTimes(1);
    expect(h.terminate).toHaveBeenCalledWith('NO_EFFECT_CONFIRMED');
  });

  test('preserves terminal STILL_UNKNOWN from a settled authority abort and still ends session once', async () => {
    const h = authority('STILL_UNKNOWN');
    const abortTransaction = jest.fn(async () => undefined);
    const endSession = jest.fn(async () => undefined);
    const terminator = createG10bPrecommitMongoTerminator({
      authority: h.authority,
      session: { abortTransaction, endSession, inTransaction: jest.fn(() => false) } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession' | 'inTransaction'>,
    });

    await expect(terminator.terminatePrecommit()).resolves.toEqual({ outcome: 'STILL_UNKNOWN', abortAttempts: 1 });
    expect(abortTransaction).toHaveBeenCalledTimes(1);
    expect(h.terminate).toHaveBeenCalledWith('STILL_UNKNOWN');
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  test('does not terminally settle or end session when authority abort admission is unsafe', async () => {
    const failure = new Error('authority became unsafe');
    const abortOnce = jest.fn(async () => { throw failure; });
    const terminate = jest.fn();
    const abortTransaction = jest.fn(async () => undefined);
    const endSession = jest.fn(async () => undefined);
    const terminator = createG10bPrecommitMongoTerminator({
      authority: { abortOnce, terminate } as unknown as G10bScopedPersistencePrecommitAuthority,
      session: { abortTransaction, endSession, inTransaction: jest.fn(() => false) } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession' | 'inTransaction'>,
    });

    await expect(terminator.terminatePrecommit()).rejects.toBe(failure);
    expect(abortTransaction).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
  });

  test('closes before endSession settles and cannot issue a second high-level abort', async () => {
    let release!: () => void;
    const ending = new Promise<void>((resolve) => { release = resolve; });
    const h = authority();
    const abortTransaction = jest.fn(async () => undefined);
    const endSession = jest.fn(() => ending);
    const terminator = createG10bPrecommitMongoTerminator({
      authority: h.authority,
      session: { abortTransaction, endSession, inTransaction: jest.fn(() => false) } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession' | 'inTransaction'>,
    });

    const running = terminator.terminatePrecommit();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await expect(terminator.terminatePrecommit()).rejects.toMatchObject({ code: 'TERMINATOR_CLOSED' });
    expect(abortTransaction).toHaveBeenCalledTimes(1);
    release();
    await expect(running).resolves.toEqual({ outcome: 'NO_EFFECT_CONFIRMED', abortAttempts: 1 });
  });

  test('reports an endSession failure only after authority terminal settlement', async () => {
    const h = authority();
    const endFailure = new Error('end failed');
    const terminator = createG10bPrecommitMongoTerminator({
      authority: h.authority,
      session: {
        abortTransaction: jest.fn(async () => undefined),
        endSession: jest.fn(async () => { throw endFailure; }),
        inTransaction: jest.fn(() => false),
      } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession' | 'inTransaction'>,
    });

    await expect(terminator.terminatePrecommit()).rejects.toMatchObject<Partial<G10bPrecommitMongoTerminatorError>>({
      code: 'END_SESSION_FAILED', cause: endFailure,
    });
    expect(h.terminate).toHaveBeenCalledWith('NO_EFFECT_CONFIRMED');
  });

  test('does not end a session that remains active after terminal authority settlement', async () => {
    const h = authority();
    const endSession = jest.fn(async () => undefined);
    const terminator = createG10bPrecommitMongoTerminator({
      authority: h.authority,
      session: {
        abortTransaction: jest.fn(async () => undefined),
        endSession,
        inTransaction: jest.fn(() => true),
      } as unknown as Pick<ClientSession, 'abortTransaction' | 'endSession' | 'inTransaction'>,
    });

    await expect(terminator.terminatePrecommit()).rejects.toMatchObject({ code: 'SESSION_STILL_ACTIVE' });
    expect(h.terminate).toHaveBeenCalledWith('NO_EFFECT_CONFIRMED');
    expect(endSession).not.toHaveBeenCalled();
  });
});
