import process from 'node:process';
import {
  G09B_CLEANUP_DEADLINE_MS,
  G09B_CORRECTNESS_DEADLINE_MS,
  assertPhaseOpen,
  createRunnerState,
  formatError,
  runBounded,
  selectFailure,
  stopRunner,
} from './internal-g09b-orchestration.mjs';

const DEFAULT_NODE_IMAGE = 'node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';

export async function runG09bCorrectness(options = {}) {
  const clock = options.clock ?? { now: () => Date.now() };
  const commandRunner = options.commandRunner ?? { run: (command, args, runOptions) => runBounded(command, args, runOptions) };
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const workspace = options.workspace ?? process.cwd();
  const projectName = options.projectName ?? `passhub-g09b-b1-${pid}`;
  const workerName = options.workerName ?? `passhub-g09b-worker-${pid}`;
  const workerLabel = options.workerLabel ?? `com.passhub.g09b.b1=${projectName}`;
  const compose = ['compose', '--project-name', projectName, '-f', options.composeFile ?? 'infra/g09b-mongo-compose.yml'];
  const mongoUri = options.mongoUri ?? 'mongodb://127.0.0.1:27039/?replicaSet=rs0';
  const databaseName = options.databaseName ?? `passhub_g09b_b1_${pid}_${clock.now()}`.slice(0, 63);
  const nodeImage = options.nodeImage ?? DEFAULT_NODE_IMAGE;
  const deadline = clock.now() + (options.deadlineMs ?? G09B_CORRECTNESS_DEADLINE_MS);
  const mainState = createRunnerState();
  const cleanupState = createRunnerState();
  let workerAttempted = false;
  let interrupted = false;
  let failure;

  const onSignal = (signal) => {
    interrupted = true;
    stopRunner(mainState, signal);
  };
  if (options.installSignals !== false) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  try {
    await runPhase('docker', [...compose, 'up', '-d']);
    await runPhase('node', ['scripts/internal-g09b-init-replica-set.mjs'], {
      ...env,
      G09B_MONGO_URI: mongoUri,
      G09B_MONGO_BOOTSTRAP_URI: 'mongodb://127.0.0.1:27039/?directConnection=true',
    });
    workerAttempted = true;
    await runPhase('docker', [
      'run', '--name', workerName, '--label', workerLabel, '--network', 'host', '-v', `${workspace}:/workspace`, '-w', '/workspace',
      '-e', `G09B_MONGO_URI=${mongoUri}`, '-e', `G09B_MONGO_DATABASE=${databaseName}`,
      nodeImage, 'sh', '-lc',
      'node --version && npm --version && npm run build && node scripts/internal-g09b-correctness-worker.mjs',
    ]);
  } catch (error) {
    failure = error;
  } finally {
    let cleanupFailure;
    if (workerAttempted) {
      try {
        await runCleanup('docker', ['rm', '-f', workerName]);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
        if (options.report) options.report(`G09b worker cleanup failed: ${formatError(cleanupError)}`);
      }
    }
    try {
      await runCleanup('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
    } catch (cleanupError) {
      cleanupFailure ??= cleanupError;
      if (options.report) options.report(`G09b compose cleanup failed: ${formatError(cleanupError)}`);
    }
    failure = selectFailure(failure, cleanupFailure);
  }
  if (options.installSignals !== false) {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  if (interrupted && failure === undefined) failure = new Error('G09b correctness interrupted');
  if (failure !== undefined) throw failure;
  return Object.freeze({ projectName, workerName, workerLabel, workerAttempted, mainState, cleanupState });

  async function runPhase(command, args, phaseEnv = env) {
    assertPhaseOpen(mainState);
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw new Error('G09b correctness 1800s deadline exceeded');
    return commandRunner.run(command, args, { phase: 'main', state: mainState, timeoutMs: remaining, env: phaseEnv, stdio: 'inherit' });
  }

  async function runCleanup(command, args) {
    return commandRunner.run(command, args, { phase: 'cleanup', state: cleanupState, timeoutMs: G09B_CLEANUP_DEADLINE_MS, env, stdio: 'inherit' });
  }
}
