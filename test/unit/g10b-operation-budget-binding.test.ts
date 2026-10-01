import {
  OperationBudgetBindingError,
  beginOperationExecutionRound,
  createOperationBudgetBindingFactory,
  executeOperationCrud,
  executeOperationInitialCommit,
  executeOperationPrecommitAbort,
  finishOperationExecutionRound,
  reserveOperationPrecommitAbortGroup,
  startOperationPrecommitTermination,
  terminateOperationPrecommit,
  type OperationBudgetBinding,
  type OperationBudgetBindingErrorCode,
  type OperationBudgetBindingFactory,
  type OperationBudgetRound,
} from '../../src/access/application/internal/operation-budget-binding.js';
import {
  BudgetLedgerError,
  type BudgetLedgerConfig,
} from '../../src/access/application/internal/budget-ledger.js';
import {
  createWriteOperationCoordinatorBundle,
  type TrustedWriteClock,
  type WriteOperationContext,
} from '../../src/access/application/internal/write-operation-coordinator.js';

class Clock implements TrustedWriteClock {
  value = 1_000;

  nowMs(): number {
    return this.value;
  }
}

async function withActiveContext<T>(
  work: (context: WriteOperationContext, clock: TrustedWriteClock) => T | Promise<T>,
  clock: TrustedWriteClock = new Clock(),
): Promise<T> {
  let value!: T;
  let workFailed = false;
  let workError: unknown;
  const bundle = createWriteOperationCoordinatorBundle({
    clock: { nowMs: () => 0 },
    executors: {
      managementCreate: async (_input, context, settlement) => {
        try {
          value = await work(context, clock);
          settlement.businessResultPersisted('binding-test-complete');
        } catch (error: unknown) {
          workFailed = true;
          workError = error;
          settlement.knownNoEffect(error);
        }
      },
      managementUpdate: (_input, _context, settlement) => { settlement.businessResultPersisted('unused'); },
      managementRevoke: (_input, _context, settlement) => { settlement.businessResultPersisted('unused'); },
      recognition: (_input, _context, settlement) => { settlement.businessResultPersisted('unused'); },
    },
  });
  await bundle.managementCreate.enqueue(undefined);
  if (workFailed) throw workError;
  return value;
}

function expectBindingCode(work: () => unknown, code: OperationBudgetBindingErrorCode): OperationBudgetBindingError {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(OperationBudgetBindingError);
    expect((error as OperationBudgetBindingError).code).toBe(code);
    return error as OperationBudgetBindingError;
  }
  throw new Error(`expected OperationBudgetBindingError ${code}`);
}

function makeFactory(
  clock: TrustedWriteClock,
  config?: Partial<BudgetLedgerConfig>,
): OperationBudgetBindingFactory {
  return createOperationBudgetBindingFactory({
    clock,
    assertContinuationEvidence: () => undefined,
    ...(config === undefined ? {} : { config }),
  });
}

function makeBinding(context: WriteOperationContext, clock: TrustedWriteClock): OperationBudgetBinding {
  return makeFactory(clock).bind(context);
}

describe('G10b per-original-write operation budget binding', () => {
  test('accepts only a coordinator-issued active context and creates at most one binding for it', async () => {
    const fakeOwner = Object.freeze({ assertCurrent: () => undefined });
    const fakeContext = Object.freeze({
      operationId: 'fake-context', receivedAtMs: 0, sequence: 0n, owner: fakeOwner, assertCurrent: fakeOwner.assertCurrent,
    }) as WriteOperationContext;
    expectBindingCode(
      () => makeFactory(new Clock()).bind(fakeContext),
      'INVALID_CONTEXT',
    );

    await withActiveContext((context, clock) => {
      const factory = makeFactory(clock);
      const binding = factory.bind(context);
      expectBindingCode(() => factory.bind(context), 'BINDING_ALREADY_CREATED');
      const round = beginOperationExecutionRound(binding);
      finishOperationExecutionRound(binding, round);
    });
  });

  test('rejects forged round capabilities, freezes the owning binding, and rejects a forged binding by provenance', async () => {
    expectBindingCode(
      () => beginOperationExecutionRound(Object.freeze({}) as OperationBudgetBinding),
      'INVALID_BINDING',
    );

    await withActiveContext((context, clock) => {
      const binding = makeBinding(context, clock);
      expectBindingCode(
        () => finishOperationExecutionRound(binding, Object.freeze({}) as OperationBudgetRound),
        'INVALID_ROUND',
      );
      expectBindingCode(() => beginOperationExecutionRound(binding), 'BINDING_FROZEN');
    });
  });

  test('uses the captured coordinator owner fence on every later method and fails closed after completion', async () => {
    let binding!: OperationBudgetBinding;
    await withActiveContext((context, clock) => {
      binding = makeBinding(context, clock);
      const round = beginOperationExecutionRound(binding);
      finishOperationExecutionRound(binding, round);
    });

    expectBindingCode(() => beginOperationExecutionRound(binding), 'OWNER_STALE');
    expectBindingCode(() => beginOperationExecutionRound(binding), 'BINDING_FROZEN');
  });

  test('a stale coordinator context cannot create or register a binding', async () => {
    let factory!: OperationBudgetBindingFactory;
    let context!: WriteOperationContext;
    await withActiveContext((activeContext, clock) => {
      context = activeContext;
      factory = makeFactory(clock);
    });

    expectBindingCode(() => factory.bind(context), 'OWNER_STALE');
    // The first rejected bind must not reserve the context as already bound.
    expectBindingCode(() => factory.bind(context), 'OWNER_STALE');
  });

  test('execution helper synchronously admits, forwards frozen minimal timeout context, and settles its permit', async () => {
    await withActiveContext(async (context, clock) => {
      const binding = makeFactory(clock, { singleCommandMs: 123 }).bind(context);
      const round = beginOperationExecutionRound(binding);
      let commandContext: Readonly<{ readonly kind: string; readonly timeoutMs: number }> | undefined;
      await executeOperationCrud(binding, round, (received) => {
        commandContext = received;
        expect(Object.isFrozen(received)).toBe(true);
        expect(received).toEqual({ kind: 'CRUD', timeoutMs: 123 });
      });
      expect(commandContext).toEqual({ kind: 'CRUD', timeoutMs: 123 });
      await executeOperationInitialCommit(binding, round, (received) => {
        expect(received).toEqual({ kind: 'INITIAL_COMMIT', timeoutMs: 123 });
      });
      const senderFailure = new Error('sender failed synchronously');
      await expect(executeOperationCrud(binding, round, () => { throw senderFailure; })).rejects.toBe(senderFailure);
      finishOperationExecutionRound(binding, round);
    });
  });

  test('rejected execution admission performs zero sends', async () => {
    const clock = new Clock();
    await withActiveContext(async (context) => {
      const binding = makeBinding(context, clock);
      const round = beginOperationExecutionRound(binding);
      clock.value = 16_000;
      let sends = 0;
      await expect(executeOperationCrud(binding, round, () => { sends += 1; })).rejects.toMatchObject({
        code: 'EXECUTION_DEADLINE',
      });
      expect(sends).toBe(0);
      finishOperationExecutionRound(binding, round);
    }, clock);
  });

  test('execution helper keeps its permit active through an async sender and settles before resolving', async () => {
    await withActiveContext(async (context, clock) => {
      const binding = makeBinding(context, clock);
      const round = beginOperationExecutionRound(binding);
      let release!: () => void;
      const sent = executeOperationCrud(binding, round, () => new Promise<void>((resolve) => { release = resolve; }));
      expect(() => finishOperationExecutionRound(binding, round)).toThrow('execution command is still in flight');
      release();
      await sent;
      const senderFailure = new Error('sender failed asynchronously');
      await expect(executeOperationCrud(binding, round, () => Promise.reject(senderFailure))).rejects.toBe(senderFailure);
      finishOperationExecutionRound(binding, round);
    });
  });

  test('a stale coordinator owner rejects before the execution sender is invoked', async () => {
    let binding!: OperationBudgetBinding;
    let round!: OperationBudgetRound;
    await withActiveContext((context, clock) => {
      binding = makeBinding(context, clock);
      round = beginOperationExecutionRound(binding);
    });

    let sends = 0;
    await expect(executeOperationCrud(binding, round, () => { sends += 1; })).rejects.toMatchObject({ code: 'OWNER_STALE' });
    expect(sends).toBe(0);
  });

  test('starts the matching precommit confirmation lifecycle only after execution is settled and lifecycle-owns its two abort sends', async () => {
    await withActiveContext(async (context, clock) => {
      const binding = makeBinding(context, clock);
      const round = beginOperationExecutionRound(binding);
      await executeOperationCrud(binding, round, () => undefined);
      finishOperationExecutionRound(binding, round);

      const precommit = startOperationPrecommitTermination(binding);
      const group = reserveOperationPrecommitAbortGroup(binding, precommit);
      const sends: Array<Readonly<{ readonly attempt: number; readonly timeoutMs: number }>> = [];
      await executeOperationPrecommitAbort(binding, group, (command) => { sends.push(command); });
      await executeOperationPrecommitAbort(binding, group, (command) => { sends.push(command); });
      expect(sends).toEqual([{ attempt: 0, timeoutMs: 2_000 }, { attempt: 1, timeoutMs: 2_000 }]);
      await expect(executeOperationPrecommitAbort(binding, group, () => undefined)).rejects.toMatchObject({
        code: 'NATIVE_GROUP_COMMANDS_EXHAUSTED',
      });
      terminateOperationPrecommit(binding, group, 'STILL_UNKNOWN');
    });
  });

  test('fails closed when a trusted ledger callback reenters through the same binding', async () => {
    let binding: OperationBudgetBinding | null = null;
    let nestedError: unknown = null;
    let reentered = false;
    const clock: TrustedWriteClock = {
      nowMs: () => {
        if (!reentered && binding !== null) {
          reentered = true;
          try {
            beginOperationExecutionRound(binding);
          } catch (error: unknown) {
            nestedError = error;
            throw error;
          }
        }
        return 1_000;
      },
    };

    await withActiveContext((context) => {
      binding = makeBinding(context, clock);
      expect(() => beginOperationExecutionRound(binding as OperationBudgetBinding)).toThrow(BudgetLedgerError);
      expect(nestedError).toBeInstanceOf(OperationBudgetBindingError);
      expect((nestedError as OperationBudgetBindingError).code).toBe('REENTRANT');
      expectBindingCode(() => beginOperationExecutionRound(binding as OperationBudgetBinding), 'BINDING_FROZEN');
    }, clock);
  });
});
