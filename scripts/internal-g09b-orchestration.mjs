import { spawn } from 'node:child_process';

export const G09B_CORRECTNESS_DEADLINE_MS = 1_800_000;
export const G09B_CLEANUP_DEADLINE_MS = 60_000;

export function createRunnerState() {
  return { phaseOpen: true, activeChildren: new Set(), pendingKillTimers: new Set() };
}

export function stopRunner(state, signal = 'SIGTERM') {
  state.phaseOpen = false;
  for (const child of state.activeChildren) child.kill(signal);
}

export function assertPhaseOpen(state) {
  if (!state.phaseOpen) throw new Error('G09b correctness stopped; next phase is forbidden');
}

export function selectFailure(primary, cleanup) {
  return primary ?? cleanup;
}

export async function runBounded(command, args, options = {}) {
  const state = options.state ?? createRunnerState();
  const timeoutMs = options.timeoutMs ?? G09B_CORRECTNESS_DEADLINE_MS;
  if (options.gate !== false) assertPhaseOpen(state);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio ?? 'inherit', env: options.env ?? process.env, shell: false });
    state.activeChildren.add(child);
    let killTimer;
    const timeoutTimer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      state.pendingKillTimers.add(killTimer);
    }, timeoutMs);
    const finish = (error) => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        state.pendingKillTimers.delete(killTimer);
      }
      state.activeChildren.delete(child);
      if (error === undefined) resolve(); else reject(error);
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0 || options.acceptExitCodes?.includes(code)) finish();
      else finish(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

export function formatError(error) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
