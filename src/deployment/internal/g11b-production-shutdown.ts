import { createG11bShutdownOwnerWithEngine, type G11bShutdownResources } from './g11b-production-shutdown-engine.js';

/** Production binds only native process signals and the fixed 25-second deadline. */
export function installG11bProductionShutdown(resources: G11bShutdownResources): void {
  createG11bShutdownOwnerWithEngine(resources, {
    onSignal: (signal, listener) => { process.once(signal, listener); },
    armDeadline: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref(); return timer; },
    clearDeadline: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
    exit: (code) => { process.exit(code); },
    setExitCode: (code) => { process.exitCode = code; },
  });
}
