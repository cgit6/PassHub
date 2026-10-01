import {
  type BudgetLedger,
  type NativePrecommitOutcome,
  type NativePrecommitCommandPermit,
  type NativePrecommitGroupPermit,
} from './budget-ledger.js';

/**
 * Internal-only, synchronous ownership of the driver abort lifecycle.
 *
 * This object deliberately has no MongoDB, HTTP, or timer behaviour.  It owns
 * the narrow asynchronous boundary around a driver send, so the internal
 * one-shot permit is always settled before its group may end.  The underlying
 * BudgetLedger owns the shared confirmation budget and two-second deadline.
 */

export type PrecommitTerminationScope = 'PRECOMMIT' | 'COMMIT_UNKNOWN';
export type PrecommitTerminationPhase = 'OPEN' | 'SEALED_PRECOMMIT' | 'SEALED_COMMIT_UNKNOWN' | 'TERMINATED';

export type PrecommitTerminationErrorCode =
  | 'LIFECYCLE_FROZEN'
  | 'REENTRANT'
  | 'OWNER_STALE'
  | 'SCOPE_NOT_SEALED'
  | 'SCOPE_ALREADY_SEALED'
  | 'UNKNOWN_COMMIT_ABORT_FORBIDDEN'
  | 'LIFECYCLE_TERMINATED'
  | 'ABORT_GROUP_ACTIVE'
  | 'INVALID_ABORT_GROUP'
  | 'ABORT_GROUP_TERMINATED'
  | 'INVALID_ABORT_COMMAND'
  | 'ABORT_COMMAND_ALREADY_SETTLED'
  | 'ABORT_COMMAND_IN_FLIGHT'
  | 'ABORT_GROUP_UNSETTLED';

export class PrecommitTerminationError extends Error {
  readonly code: PrecommitTerminationErrorCode;

  constructor(code: PrecommitTerminationErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'PrecommitTerminationError';
    this.code = code;
  }
}

export interface PrecommitTerminationOwnerFence {
  assertCurrent(): void;
}

export interface PrecommitTerminationLifecycleOptions {
  readonly ledger: BudgetLedger;
  readonly ownerFence: PrecommitTerminationOwnerFence;
}

declare const abortGroupPermitBrand: unique symbol;

/** Opaque lifecycle wrapper around a native precommit group permit. */
export interface PrecommitAbortGroupPermit {
  readonly [abortGroupPermitBrand]: never;
  readonly timeoutMs: number;
}

/** The only facts an abort sender needs; it never receives a permit. */
export interface PrecommitAbortCommandContext {
  readonly timeoutMs: number;
  readonly attempt: number;
}

export interface PrecommitTerminationSnapshot {
  readonly frozen: boolean;
  readonly phase: PrecommitTerminationPhase;
  readonly scope: PrecommitTerminationScope | null;
  readonly activeGroup: boolean;
  readonly abortCommandsAdmitted: number;
  readonly abortCommandInFlight: boolean;
}

export interface PrecommitTerminationLifecycle {
  /** The current owner irrevocably closes this lifecycle's scope. */
  sealScope(scope: PrecommitTerminationScope): void;
  /** Reserve the existing native two-send/2-second group for a sealed precommit scope. */
  reserveAbortGroup(): PrecommitAbortGroupPermit;
  /**
   * Lifecycle-owned one-shot driver send.  The internal native permit is
   * admitted before `send` and settled on every sync/async outcome.
   */
  executeAbort(group: PrecommitAbortGroupPermit, send: (context: PrecommitAbortCommandContext) => void | PromiseLike<void>): Promise<void>;
  /** End a fully settled group and permanently close this lifecycle. */
  terminate(group: PrecommitAbortGroupPermit, outcome: NativePrecommitOutcome): void;
  /** End a sealed unknown-commit scope without attempting native abort. */
  closeUnknownCommit(): void;
  snapshot(): PrecommitTerminationSnapshot;
}

interface GroupState {
  readonly lifecycle: object;
  readonly nativePermit: NativePrecommitGroupPermit;
  readonly publicPermit: PrecommitAbortGroupPermit;
  active: boolean;
  commandsAdmitted: number;
  command: CommandState | null;
}

interface CommandState {
  readonly lifecycle: object;
  readonly group: GroupState;
  readonly nativePermit: NativePrecommitCommandPermit;
  readonly context: PrecommitAbortCommandContext;
  active: boolean;
}

export function createPrecommitTerminationLifecycle(
  options: PrecommitTerminationLifecycleOptions,
): PrecommitTerminationLifecycle {
  assertOptions(options);

  // Capture trusted dependencies once; subsequent caller-owned mutations must
  // not transfer ownership or replace the budget ledger method set.
  const reserveNativeGroup = options.ledger.reserveNativePrecommitGroup.bind(options.ledger);
  const admitNativeCommand = options.ledger.admitNativePrecommitCommand.bind(options.ledger);
  const finishNativeCommand = options.ledger.finishNativePrecommitCommand.bind(options.ledger);
  const finishNativeGroup = options.ledger.finishNativePrecommitGroup.bind(options.ledger);
  const assertOwnerCurrent = options.ownerFence.assertCurrent.bind(options.ownerFence);
  const lifecycleIdentity = Object.freeze({});
  const groups = new WeakMap<object, GroupState>();

  let frozen = false;
  let transitioning = false;
  let phase: PrecommitTerminationPhase = 'OPEN';
  let scope: PrecommitTerminationScope | null = null;
  let activeGroup: GroupState | null = null;
  let lastCommandsAdmitted = 0;

  const failClosed = (code: PrecommitTerminationErrorCode, message: string, cause?: unknown): never => {
    frozen = true;
    throw new PrecommitTerminationError(code, message, cause === undefined ? undefined : { cause });
  };

  const assertOwner = (): void => {
    let result: unknown;
    try {
      result = assertOwnerCurrent();
    } catch (error: unknown) {
      failClosed('OWNER_STALE', 'precommit termination owner is stale', error);
    }
    if (frozen) failClosed('OWNER_STALE', 'precommit termination owner fence reentered the lifecycle');
    if (result !== undefined) failClosed('OWNER_STALE', 'precommit termination owner fence must return undefined');
  };

  const transition = <T>(work: () => T): T => {
    if (transitioning) failClosed('REENTRANT', 'precommit termination lifecycle is reentrant');
    if (frozen) throw new PrecommitTerminationError('LIFECYCLE_FROZEN', 'precommit termination lifecycle is permanently frozen');
    transitioning = true;
    try {
      assertOwner();
      return work();
    } finally {
      transitioning = false;
    }
  };

  const requireGroup = (permit: PrecommitAbortGroupPermit): GroupState => {
    if ((typeof permit !== 'object' && typeof permit !== 'function') || permit === null) {
      failClosed('INVALID_ABORT_GROUP', 'abort group permit is invalid');
    }
    const state = groups.get(permit);
    if (state === undefined || state.lifecycle !== lifecycleIdentity) {
      failClosed('INVALID_ABORT_GROUP', 'abort group permit belongs to another lifecycle');
    }
    return state as GroupState;
  };

  const snapshot = (): PrecommitTerminationSnapshot => Object.freeze({
    frozen,
    phase,
    scope,
    activeGroup: activeGroup !== null,
    abortCommandsAdmitted: activeGroup?.commandsAdmitted ?? lastCommandsAdmitted,
    abortCommandInFlight: activeGroup !== null && activeGroup.command !== null,
  });

  const lifecycle: PrecommitTerminationLifecycle = {
    sealScope: (requestedScope: PrecommitTerminationScope): void => transition(() => {
      if (phase !== 'OPEN') throw denial('SCOPE_ALREADY_SEALED', 'precommit termination scope is already sealed');
      if (requestedScope !== 'PRECOMMIT' && requestedScope !== 'COMMIT_UNKNOWN') {
        throw denial('SCOPE_NOT_SEALED', 'precommit termination scope is invalid');
      }
      scope = requestedScope;
      phase = requestedScope === 'PRECOMMIT' ? 'SEALED_PRECOMMIT' : 'SEALED_COMMIT_UNKNOWN';
    }),

    reserveAbortGroup: (): PrecommitAbortGroupPermit => transition(() => {
      if (phase === 'OPEN') throw denial('SCOPE_NOT_SEALED', 'precommit scope must be sealed before abort reservation');
      if (phase === 'SEALED_COMMIT_UNKNOWN') {
        throw denial('UNKNOWN_COMMIT_ABORT_FORBIDDEN', 'an unknown commit result cannot enter the precommit abort path');
      }
      if (phase === 'TERMINATED') throw denial('LIFECYCLE_TERMINATED', 'precommit termination lifecycle has ended');
      if (activeGroup !== null) throw denial('ABORT_GROUP_ACTIVE', 'an abort group is already active');

      const nativePermit = reserveNativeGroup();
      const publicPermit = Object.freeze({ timeoutMs: nativePermit.timeoutMs }) as PrecommitAbortGroupPermit;
      const state: GroupState = {
        lifecycle: lifecycleIdentity,
        nativePermit,
        publicPermit,
        active: true,
        commandsAdmitted: 0,
        command: null,
      };
      groups.set(publicPermit, state);
      activeGroup = state;
      lastCommandsAdmitted = 0;
      return publicPermit;
    }),

    executeAbort: (permit: PrecommitAbortGroupPermit, send: (context: PrecommitAbortCommandContext) => void | PromiseLike<void>): Promise<void> => {
      if (typeof send !== 'function') throw new TypeError('precommit abort sender must be a function');
      const command = transition(() => {
        const group = requireGroup(permit);
        if (!group.active || activeGroup !== group) throw denial('ABORT_GROUP_TERMINATED', 'abort group is no longer active');
        if (phase !== 'SEALED_PRECOMMIT') throw denial('LIFECYCLE_TERMINATED', 'precommit termination lifecycle has ended');
        if (group.command !== null) throw denial('ABORT_COMMAND_IN_FLIGHT', 'an abort command is already in flight');

        const nativePermit = admitNativeCommand(group.nativePermit);
        const context = Object.freeze({ timeoutMs: nativePermit.timeoutMs, attempt: nativePermit.attempt });
        const state: CommandState = { lifecycle: lifecycleIdentity, group, nativePermit, context, active: true };
        group.command = state;
        group.commandsAdmitted += 1;
        lastCommandsAdmitted = group.commandsAdmitted;
        return state;
      });

      // Invoke synchronously: termination cannot interleave before the sender
      // has begun, and the active permit keeps the group non-terminal until
      // the returned work settles.  Assimilation supports the driver's
      // PromiseLike result without exposing any lifecycle capability to it.
      let result: void | PromiseLike<void>;
      try {
        result = send(command.context);
      } catch (error: unknown) {
        try {
          settleCommand(command);
        } catch (lifecycleError: unknown) {
          // A permit/owner/budget settlement failure has fail-closed
          // precedence over the callback failure and must not be retried.
          return Promise.reject(lifecycleError);
        }
        // The lifecycle only owns permit settlement.  It must preserve the
        // driver's original rejection so the terminator can record an
        // uncertain outcome, but it must never turn that rejection into an
        // authorization for a second high-level driver abort call.
        return Promise.reject(error);
      }
      return Promise.resolve(result).then(
        () => { settleCommand(command); },
        (error: unknown) => {
          try {
            settleCommand(command);
          } catch (lifecycleError: unknown) {
            // Preserve lifecycle errors exactly.  They do not mean the
            // driver callback is eligible for a second abort attempt.
            throw lifecycleError;
          }
          // See the synchronous path: preserving the original error prevents
          // this lower layer from encoding any retry policy for the driver.
          throw error;
        },
      );
    },

    terminate: (permit: PrecommitAbortGroupPermit, outcome: NativePrecommitOutcome): void => transition(() => {
      const group = requireGroup(permit);
      if (!group.active || activeGroup !== group) throw denial('ABORT_GROUP_TERMINATED', 'abort group is no longer active');
      if (group.command !== null) throw denial('ABORT_GROUP_UNSETTLED', 'abort command must settle before ending its group');
      if (group.commandsAdmitted < 1) throw denial('ABORT_GROUP_UNSETTLED', 'abort group must settle at least one abort command before ending');
      if (outcome !== 'STILL_UNKNOWN' && outcome !== 'NO_EFFECT_CONFIRMED') {
        throw denial('ABORT_GROUP_UNSETTLED', 'abort group outcome is invalid');
      }
      finishNativeGroup(group.nativePermit, outcome);
      group.active = false;
      activeGroup = null;
      lastCommandsAdmitted = group.commandsAdmitted;
      phase = 'TERMINATED';
    }),

    closeUnknownCommit: (): void => transition(() => {
      if (phase === 'OPEN') throw denial('SCOPE_NOT_SEALED', 'unknown commit scope must be sealed before closure');
      if (phase === 'TERMINATED') throw denial('LIFECYCLE_TERMINATED', 'precommit termination lifecycle has ended');
      if (phase !== 'SEALED_COMMIT_UNKNOWN' || scope !== 'COMMIT_UNKNOWN') {
        throw denial('UNKNOWN_COMMIT_ABORT_FORBIDDEN', 'only a sealed unknown commit scope can close without abort');
      }
      if (activeGroup !== null) failClosed('ABORT_GROUP_ACTIVE', 'unknown commit closure cannot coexist with an abort group');
      phase = 'TERMINATED';
    }),

    snapshot: (): PrecommitTerminationSnapshot => frozen ? snapshot() : transition(snapshot),
  };

  return Object.freeze(lifecycle);

  function settleCommand(command: CommandState): void {
    transition(() => {
      if (!command.active) failClosed('ABORT_COMMAND_ALREADY_SETTLED', 'abort command is already settled');
      if (!command.group.active || activeGroup !== command.group || command.group.command !== command) {
        failClosed('INVALID_ABORT_COMMAND', 'abort command is not current');
      }
      finishNativeCommand(command.nativePermit);
      command.active = false;
      command.group.command = null;
    });
  }

  function denial(code: PrecommitTerminationErrorCode, message: string): PrecommitTerminationError {
    return new PrecommitTerminationError(code, message);
  }
}

function assertOptions(options: PrecommitTerminationLifecycleOptions): void {
  if (typeof options !== 'object' || options === null) throw new TypeError('precommit termination lifecycle options are required');
  if (typeof options.ledger !== 'object' || options.ledger === null
    || typeof options.ledger.reserveNativePrecommitGroup !== 'function'
    || typeof options.ledger.admitNativePrecommitCommand !== 'function'
    || typeof options.ledger.finishNativePrecommitCommand !== 'function'
    || typeof options.ledger.finishNativePrecommitGroup !== 'function') {
    throw new TypeError('precommit termination lifecycle budget ledger is required');
  }
  if (typeof options.ownerFence !== 'object' || options.ownerFence === null || typeof options.ownerFence.assertCurrent !== 'function') {
    throw new TypeError('precommit termination lifecycle owner fence is required');
  }
}
