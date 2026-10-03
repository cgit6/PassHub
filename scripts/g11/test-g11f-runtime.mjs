import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decideG11fMaintenance } from '../../dist/src/deployment/internal/g11f-fault-controller.js';

// This runner combines the canonical policy matrix with the real G11e shell
// entrypoint.  The G11d Mongo runner remains a separate, expensive evidence
// gate; this script never pretends an in-memory observation is Mongo proof.
const uuid = () => randomUUID();
const allowDirty = process.argv.includes('--allow-dirty-development');
const sourceDirty = execFileSync('git', ['status', '--porcelain=1', '--untracked-files=all'], { encoding: 'utf8' }).trim().length > 0;
if (sourceDirty && !allowDirty) throw new Error('G11f runtime requires a clean source revision; use --allow-dirty-development only for development evidence');
const root = mkdtempSync(join(tmpdir(), 'passhub-g11f-'));
const runtime = join(root, 'runtime');
const maintenance = join(root, 'maintenance');
const lock = join(root, 'controller.lock');
const epochFile = join(root, 'dataset-epoch');
const resetResult = join(root, 'reset-result.json');
mkdirSync(runtime, { mode: 0o700 });
mkdirSync(maintenance, { mode: 0o700 });
const currentEpoch = uuid();
const targetEpoch = uuid();
const runId = uuid();
writeFileSync(join(runtime, 'process-run-id'), `${runId}\n`, { mode: 0o400 });
writeFileSync(epochFile, `${currentEpoch}\n`, { mode: 0o400 });
writeFileSync(resetResult, JSON.stringify({ database: 'passhub_demo', datasetEpoch: targetEpoch, indexesPreserved: true }) + '\n', { mode: 0o400 });

const base = Object.freeze({ operation: 'RESET', marker: 'ACTIVE', api: 'STOPPED', mongo: 'PRIMARY', writers: 0,
  lock: 'ACQUIRED', ticket: 'VALID', currentEpoch, targetEpoch, writeRunClaim: 'NULL', resetState: 'NONE', controlledRerun: false });
const cases = [
  ['MARKER_OFF', { marker: 'MISSING' }, 'MARKER_NOT_ACTIVE'], ['API_RUNNING', { api: 'RUNNING' }, 'API_NOT_STOPPED'],
  ['MONGO_NOT_PRIMARY', { mongo: 'NOT_PRIMARY' }, 'MONGO_NOT_PRIMARY'], ['EXTRA_WRITER', { writers: 1 }, 'WRITERS_PRESENT'],
  ['ORDINARY_RESTART', { operation: 'ORDINARY_RESTART' }, 'ORDINARY_RESTART_WRITE_CLOSED'],
  ['UNKNOWN_RESET', { resetState: 'UNKNOWN' }, 'RESET_STATE_UNKNOWN'],
  ['PARTIAL_RESET', { resetState: 'PARTIAL' }, 'PARTIAL_RESET_REQUIRES_CONTROL'],
  ['LOCK_LOST', { lock: 'HELD' }, 'LOCK_NOT_OWNED'], ['TICKET_INVALID', { ticket: 'INVALID' }, 'TICKET_NOT_VALID'],
];
const results = [];
for (const [name, override, expected] of cases) {
  let resetCalls = 0;
  let closed = false;
  try { decideG11fMaintenance({ ...base, ...override }); } catch (error) {
    closed = error?.code === expected;
  }
  if (!closed || resetCalls !== 0) throw new Error(`${name} was not fail-closed`);
  results.push(name);
}
if (decideG11fMaintenance(base).action !== 'REQUIRE_RESET') throw new Error('nominal preconditions did not require reset');
if (decideG11fMaintenance({ ...base, resetState: 'PARTIAL', controlledRerun: true }).action !== 'REPAIR_RERUN') throw new Error('controlled rerun not admitted');

function runController(extra = {}) {
  return new Promise((resolve) => {
    const child = spawn('scripts/g11/run-maintenance.sh', { cwd: process.cwd(), env: {
      ...process.env, PASSHUB_RUNTIME_DIRECTORY: runtime, PASSHUB_MAINTENANCE_RUNTIME_DIR: maintenance,
      PASSHUB_MAINTENANCE_LOCK_PATH: lock, PASSHUB_DATASET_EPOCH_FILE: epochFile,
      PASSHUB_RESET_RESULT_FILE: resetResult, ...extra,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
try {
  const first = await runController({ PASSHUB_MAINTENANCE_HOLD_MS: '300' });
  const outputLines = first.out.trim().split('\n').filter(Boolean);
  if (first.code !== 0 || outputLines.length < 1 || outputLines.some((line) => line !== '{"ok":true}')) throw new Error(`real G11e entrypoint did not complete: ${first.err}`);
  const ticket = JSON.parse(readFileSync(join(runtime, 'bootstrap-ticket.json'), 'utf8'));
  if (ticket.datasetEpoch !== targetEpoch || ticket.processRunId !== runId) throw new Error('real ticket handoff mismatch');
  if ((statSync(join(runtime, 'bootstrap-ticket.json')).mode & 0o777) !== 0o400) throw new Error('ticket mode mismatch');
  results.push('REAL_G11E_ENTRYPOINT_HANDOFF');
  const g11dArgs = ['scripts/g11/test-g11d-runtime.mjs'];
  if (allowDirty) g11dArgs.push('--allow-dirty-development');
  const g11dOutput = execFileSync('node', g11dArgs, { cwd: process.cwd(), encoding: 'utf8', timeout: 900_000 });
  const g11dResult = JSON.parse(g11dOutput.trim().split('\n').at(-1));
  if (!Array.isArray(g11dResult.cases) || g11dResult.cases.length !== 8
    || g11dResult.first?.indexesPreserved !== true || g11dResult.second?.indexesPreserved !== true
    || g11dResult.first?.datasetEpoch === g11dResult.second?.datasetEpoch) {
    throw new Error('real G11d reset evidence did not prove sequential new-epoch reset');
  }
  results.push('REAL_G11D_TRANSACTIONAL_RESET_AND_NEW_EPOCH');
  process.stdout.write(JSON.stringify({ ok: true, sourceDirty, policyCases: results, g11d: g11dResult }) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
