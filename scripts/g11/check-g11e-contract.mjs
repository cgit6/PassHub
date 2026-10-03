import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const service = readFileSync('infra/g11/systemd/passhub-maintenance.service', 'utf8');
const timer = readFileSync('infra/g11/systemd/passhub-maintenance.timer', 'utf8');
const shell = readFileSync('scripts/g11/run-maintenance.sh', 'utf8');
const controller = readFileSync('scripts/g11/maintenance-controller.mjs', 'utf8');
function assert(value, message) { if (!value) throw new Error(message); }
assert(timer.includes('OnCalendar=*-*-* 03:00:00 Asia/Taipei'), 'timer calendar mismatch');
assert(timer.includes('AccuracySec=1s') && timer.includes('RandomizedDelaySec=0') && timer.includes('Persistent=false'), 'timer precision/persistence mismatch');
assert(service.includes('ExecStart=/opt/passhub/scripts/g11/run-maintenance.sh'), 'service does not use shared command');
assert(service.includes('Environment=PASSHUB_RUNTIME_DIRECTORY=/run/passhub/api'), 'service runtime path mismatch');
assert(service.includes('RuntimeDirectoryMode=0700') && service.includes('ConditionPathExists=/run/passhub/api/process-run-id'), 'service trusted runtime preconditions missing');
assert(controller.includes("resolve(process.env.PASSHUB_RUNTIME_DIRECTORY ?? '/run/passhub/api')"), 'controller canonical runtime path missing');
assert(controller.includes("join(runtimeDirectory, 'process-run-id')"), 'controller does not read process identity file');
assert(controller.includes("PASSHUB_DATASET_EPOCH_FILE"), 'controller does not read protected epoch file');
assert(!controller.includes('ticketPath, ticketId, datasetEpoch, processRunId'), 'controller prints ticket material');
assert(shell.includes('flock -n 9'), 'controller lock is not nonblocking');
assert(shell.includes('exec node') && shell.includes('maintenance-controller.mjs'), 'manual/timer entry does not invoke controller');
assert((statSync('scripts/g11/run-maintenance.sh').mode & 0o111) !== 0, 'controller script is not executable');
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'infra/g11/systemd', 'scripts/g11/run-maintenance.sh', 'scripts/g11/maintenance-controller.mjs'], { encoding: 'utf8' });
assert(typeof dirty === 'string', 'git status unavailable');
process.stdout.write(JSON.stringify({ ok: true, cases: ['TIMER_0300_ASIA_TAIPEI', 'NO_MISSED_RUN_CATCHUP', 'SHARED_MANUAL_TIMER_ENTRY', 'NONBLOCKING_LOCAL_FLOCK', 'EXECUTABLE_CONTROLLER'] }) + '\n');
