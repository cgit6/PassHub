import { closeG11bProductionResources } from './g11b-production-http-lifecycle.js';

export interface G11bShutdownDependencies {
  readonly onSignal: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => void;
  readonly armDeadline: (callback: () => void, milliseconds: number) => unknown;
  readonly clearDeadline: (handle: unknown) => void;
  readonly exit: (code: number) => void;
  readonly setExitCode: (code: number) => void;
}

export interface G11bShutdownResources {
  readonly beginShutdown: () => void;
  readonly closeHttp: () => Promise<void>;
  readonly closeMongo: () => Promise<void>;
}

/** Private engine allows deterministic signal/deadline tests of the production owner. */
export function createG11bShutdownOwnerWithEngine(resources: G11bShutdownResources, dependencies: G11bShutdownDependencies) {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    let settle!: () => void;
    closing = new Promise<void>((resolve) => { settle = resolve; });
    void (async () => {
      let succeeded = false;
      let deadlineExpired = false;
      const deadline = dependencies.armDeadline(() => {
        if (succeeded || deadlineExpired) return;
        deadlineExpired = true;
        dependencies.exit(1);
      }, 25_000);
      let failed = false;
      try { resources.beginShutdown(); } catch { failed = true; }
      try { await closeG11bProductionResources(resources.closeHttp, resources.closeMongo); }
      catch { failed = true; }
      if (!failed && !deadlineExpired) {
        succeeded = true;
        dependencies.clearDeadline(deadline);
      }
      dependencies.setExitCode(failed || deadlineExpired ? 1 : 0);
    })().then(settle, () => { dependencies.setExitCode(1); settle(); });
    return closing;
  };
  dependencies.onSignal('SIGTERM', () => { void close(); });
  dependencies.onSignal('SIGINT', () => { void close(); });
  return Object.freeze({ close });
}
