import assert from 'node:assert/strict';
import {
  assertPhaseOpen,
  createRunnerState,
  runBounded,
  selectFailure,
  stopRunner,
} from './internal-g09b-orchestration.mjs';
import { runG09bCorrectness } from './internal-g09b-runner.mjs';

const timeoutState = createRunnerState();
await assert.rejects(
  runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { state: timeoutState, timeoutMs: 50, stdio: 'ignore' }),
  /failed with SIGTERM|failed with SIGKILL/u,
);
assert.equal(timeoutState.activeChildren.size, 0);
assert.equal(timeoutState.pendingKillTimers.size, 0);

class FakeClock {
  constructor() { this.value = 0; }
  now() { return this.value; }
  advance(value) { this.value += value; }
}

function fakeRunner({ onRun = () => undefined, failures = new Map() } = {}) {
  const calls = [];
  const runner = {
    calls,
    async run(command, args, options) {
      calls.push({ command, args: [...args], options });
      await onRun.call(runner, command, args, options, calls);
      const key = `${options.phase}:${command}:${args[0]}`;
      const error = failures.get(key);
      if (error !== undefined) throw error;
      return undefined;
    },
  };
  return runner;
}

function workerCall(runner) { return runner.calls.find((call) => call.args[0] === 'run'); }
function cleanupCalls(runner) { return runner.calls.filter((call) => call.options.phase === 'cleanup'); }
function assertWorkerContract(runner) {
  const worker = workerCall(runner);
  assert.ok(worker);
  assert.equal(worker.args.includes('--name'), true);
  assert.match(worker.args[worker.args.indexOf('--name') + 1], /^passhub-g09b-worker-/u);
  assert.equal(worker.args.includes('--label'), true);
  assert.match(worker.args[worker.args.indexOf('--label') + 1], /^com\.passhub\.g09b\.b1=/u);
  assert.equal(worker.args.includes('--rm'), false);
}

const successClock = new FakeClock();
const success = fakeRunner();
await runG09bCorrectness({ clock: successClock, commandRunner: success, installSignals: false, pid: 7001, projectName: 'fake-success' });
assertWorkerContract(success);
assert.deepEqual(cleanupCalls(success).map((call) => call.args.slice(0, 3)), [
  ['rm', '-f', 'passhub-g09b-worker-7001'],
  ['compose', '--project-name', 'fake-success'],
]);
assert.equal(cleanupCalls(success)[0].options.state === success.calls[0].options.state, false);
assert.equal(cleanupCalls(success)[0].options.timeoutMs, 60_000);

const deadlineClock = new FakeClock();
const deadlineRunner = fakeRunner({ onRun(command, _args, options) { if (options.phase === 'main' && command === 'docker') deadlineClock.advance(101); } });
await assert.rejects(
  runG09bCorrectness({ clock: deadlineClock, commandRunner: deadlineRunner, installSignals: false, pid: 7002, projectName: 'fake-deadline', deadlineMs: 100 }),
  /1800s deadline exceeded/u,
);
assert.deepEqual(cleanupCalls(deadlineRunner).map((call) => call.args[0]), ['compose']);
assert.equal(deadlineRunner.calls.some((call) => call.args[0] === 'rm'), false);

const signalRunner = fakeRunner({ onRun(_command, _args, options) { if (options.phase === 'main') stopRunner(options.state, 'SIGTERM'); } });
await assert.rejects(
  runG09bCorrectness({ commandRunner: signalRunner, installSignals: false, pid: 7003, projectName: 'fake-signal' }),
  /next phase is forbidden/u,
);
assert.deepEqual(signalRunner.calls.map((call) => call.options.phase), ['main', 'cleanup']);

const cleanupError = new Error('rm cleanup failure');
const rmFailure = fakeRunner({ failures: new Map([['cleanup:docker:rm', cleanupError]]) });
await assert.rejects(
  runG09bCorrectness({ commandRunner: rmFailure, installSignals: false, pid: 7004, projectName: 'fake-rm-failure' }),
  (error) => error === cleanupError,
);
assert.deepEqual(cleanupCalls(rmFailure).map((call) => call.args[0]), ['rm', 'compose']);

const primaryError = new Error('primary phase failure');
const secondaryCleanupError = new Error('secondary cleanup failure');
const precedence = fakeRunner({ failures: new Map([
  ['main:docker:run', primaryError],
  ['cleanup:docker:rm', secondaryCleanupError],
]) });
await assert.rejects(
  runG09bCorrectness({ commandRunner: precedence, installSignals: false, pid: 7005, projectName: 'fake-precedence' }),
  (error) => error === primaryError,
);
assert.deepEqual(cleanupCalls(precedence).map((call) => call.args[0]), ['rm', 'compose']);

const signalDuringCleanup = fakeRunner({ onRun(command, args, options) {
  if (options.phase === 'main' && command === 'docker' && args[0] === 'run') this.mainState = options.state;
  if (options.phase === 'cleanup' && args[0] === 'rm') stopRunner(this.mainState, 'SIGTERM');
} });
await runG09bCorrectness({ commandRunner: signalDuringCleanup, installSignals: false, pid: 7006, projectName: 'fake-cleanup-signal' });
assert.deepEqual(cleanupCalls(signalDuringCleanup).map((call) => call.args[0]), ['rm', 'compose']);
assert.equal(signalDuringCleanup.calls[2].options.state === signalDuringCleanup.calls[3].options.state, false);

const primary = new Error('primary');
const cleanup = new Error('cleanup');
assert.equal(selectFailure(primary, cleanup), primary);
assert.equal(selectFailure(undefined, cleanup), cleanup);
const closedState = createRunnerState();
stopRunner(closedState);
assert.throws(() => assertPhaseOpen(closedState), /next phase is forbidden/u);
console.log('G09b orchestration contract smoke: deadline cleanup, worker identity, order, signal isolation, and precedence PASS');
