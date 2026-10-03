import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decideG11fMaintenance } from '../../dist/src/deployment/internal/g11f-fault-controller.js';

// G11f proves the policy against real G11d/G11e handoff boundaries.  It does
// not claim to emulate a production crash: the partial case is an intentionally
// truncated private reset-result handoff, followed by a fresh real G11d run.
const allowDirty = process.argv.includes('--allow-dirty-development');
const sourceDirty = execFileSync('git', ['status', '--porcelain=1', '--untracked-files=all'], { encoding: 'utf8' })
  .split('\n').some((line) => line.length > 0 && !line.slice(3).startsWith('node_modules'));
if (sourceDirty && !allowDirty) throw new Error('G11f runtime requires a clean source revision; use --allow-dirty-development only for development evidence');
const uuid = () => randomUUID();
const root = mkdtempSync(join(tmpdir(), 'passhub-g11f-'));
const runtime = join(root, 'runtime');
const maintenance = join(root, 'maintenance');
const lock = join(root, 'controller.lock');
const epochFile = join(root, 'dataset-epoch');
const handoffFile = join(root, 'reset-result.json');
mkdirSync(runtime, { mode: 0o700 }); mkdirSync(maintenance, { mode: 0o700 });
const currentEpoch = uuid(); const runId = uuid();
writeFileSync(join(runtime, 'process-run-id'), `${runId}\n`, { mode: 0o400 });
writeFileSync(epochFile, `${currentEpoch}\n`, { mode: 0o400 });

const g11dArgs = ['scripts/g11/test-g11d-runtime.mjs'];
if (allowDirty) g11dArgs.push('--allow-dirty-development');
let g11dRuns = 0;
function startG11d({ injectPartial = false, authorizationFile } = {}) {
  g11dRuns += 1;
  const child = spawn('node', g11dArgs, { cwd: process.cwd(), env: { ...process.env, PASSHUB_G11D_HANDOFF_FILE: handoffFile,
    ...(injectPartial ? { PASSHUB_G11D_PARTIAL_HANDOFF_FILE: handoffFile, PASSHUB_G11D_PARTIAL_EPOCH_FILE: epochFile, PASSHUB_G11D_RERUN_AUTHORIZATION_FILE: authorizationFile } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`G11d failed: ${stderr}`)); return; }
      try {
        const result = JSON.parse(stdout.trim().split('\n').at(-1));
        if (!Array.isArray(result.cases) || result.cases.length !== 8 || result.first?.indexesPreserved !== true
          || result.second?.indexesPreserved !== true || result.first?.datasetEpoch === result.second?.datasetEpoch) throw new Error('G11d evidence shape invalid');
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

function runController(extra = {}) {
  return new Promise((resolve) => {
    const child = spawn('scripts/g11/run-maintenance.sh', { cwd: process.cwd(), env: {
      ...process.env, PASSHUB_RUNTIME_DIRECTORY: runtime, PASSHUB_MAINTENANCE_RUNTIME_DIR: maintenance,
      PASSHUB_MAINTENANCE_LOCK_PATH: lock, PASSHUB_DATASET_EPOCH_FILE: epochFile,
      PASSHUB_RESET_RESULT_FILE: handoffFile, ...extra,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

try {
  const authorizationFile = join(root, 'rerun-authorized');
  const firstMongoPromise = startG11d({ injectPartial: true, authorizationFile });
  const partialDeadline = Date.now() + 120_000;
  while (!existsSync(handoffFile)) {
    if (Date.now() >= partialDeadline) throw new Error('same-dataset partial handoff was not observed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let targetEpoch = uuid();
  const base = Object.freeze({ operation: 'RESET', marker: 'ACTIVE', api: 'STOPPED', mongo: 'PRIMARY', writers: 0,
    lock: 'ACQUIRED', ticket: 'VALID', currentEpoch, targetEpoch, writeRunClaim: 'NULL', resetState: 'NONE', controlledRerun: false });
  const cases = [
    ['MARKER_OFF', { marker: 'MISSING' }, 'MARKER_NOT_ACTIVE'], ['API_RUNNING', { api: 'RUNNING' }, 'API_NOT_STOPPED'],
    ['MONGO_NOT_PRIMARY', { mongo: 'NOT_PRIMARY' }, 'MONGO_NOT_PRIMARY'], ['EXTRA_WRITER', { writers: 1 }, 'WRITERS_PRESENT'],
    ['ORDINARY_RESTART', { operation: 'ORDINARY_RESTART' }, 'ORDINARY_RESTART_WRITE_CLOSED'], ['UNKNOWN_RESET', { resetState: 'UNKNOWN' }, 'RESET_STATE_UNKNOWN'],
    ['LOCK_LOST', { lock: 'HELD' }, 'LOCK_NOT_OWNED'], ['TICKET_INVALID', { ticket: 'INVALID' }, 'TICKET_NOT_VALID'],
  ];
  const policyCases = []; let resetCalls = 0;
  for (const [name, override, expected] of cases) {
    const before = resetCalls; let closed = false;
    try { const decision = decideG11fMaintenance({ ...base, ...override }); if (decision.action === 'REQUIRE_RESET' || decision.action === 'REPAIR_RERUN') resetCalls += 1; }
    catch (error) { closed = error?.code === expected; }
    if (!closed || resetCalls !== before || g11dRuns !== 1) throw new Error(`${name} was not fail-closed before reset`);
    policyCases.push(name);
  }

  const partial = { ...base, resetState: 'PARTIAL' };
  try { decideG11fMaintenance(partial); throw new Error('uncontrolled partial reset was admitted'); }
  catch (error) { if (error?.code !== 'PARTIAL_RESET_REQUIRES_CONTROL' || g11dRuns !== 1) throw error; }
  const rerunDecision = decideG11fMaintenance({ ...partial, controlledRerun: true });
  if (rerunDecision.action !== 'REPAIR_RERUN') throw new Error('controlled rerun was not admitted');
  writeFileSync(authorizationFile, 'G11F_REPAIR_RERUN\n', { mode: 0o400 });
  const firstMongo = await firstMongoPromise;
  if (firstMongo.partialHandoffRejected !== true) throw new Error('same-dataset partial handoff evidence missing');
  const handoff = JSON.parse(readFileSync(handoffFile, 'utf8'));
  targetEpoch = firstMongo.second.datasetEpoch;
  if (handoff.datasetEpoch !== targetEpoch || g11dRuns !== 1) throw new Error(`controlled rerun handoff mismatch: handoff=${handoff.datasetEpoch} target=${targetEpoch} runs=${g11dRuns}`);
  policyCases.push('PARTIAL_HANDOFF_FAIL_CLOSED', 'REAL_SAME_DATASET_G11E_PARTIAL_REJECT', 'CONTROLLED_SAME_DATASET_G11D_RERUN');

  const nominal = await runController({ PASSHUB_MAINTENANCE_HOLD_MS: '300' });
  const outputLines = nominal.out.trim().split('\n').filter(Boolean);
  if (nominal.code !== 0 || outputLines.length < 1 || outputLines.some((line) => line !== '{"ok":true}')) throw new Error(`G11e handoff failed: ${nominal.err}`);
  const ticket = JSON.parse(readFileSync(join(runtime, 'bootstrap-ticket.json'), 'utf8'));
  if (ticket.datasetEpoch !== targetEpoch || ticket.processRunId !== runId) throw new Error('G11e ticket did not use real G11d epoch');
  if ((statSync(join(runtime, 'bootstrap-ticket.json')).mode & 0o777) !== 0o400) throw new Error('ticket mode mismatch');
  unlinkSync(join(runtime, 'bootstrap-ticket.json'));
  const held = runController({ PASSHUB_MAINTENANCE_HOLD_MS: '500' });
  await new Promise((resolve) => setTimeout(resolve, 75));
  const competing = await runController();
  const heldResult = await held;
  if (competing.code !== 75 || !competing.err.includes('G11E_CONTROLLER_BUSY') || heldResult.code !== 0) throw new Error('real G11e lock contention did not fail closed');
  policyCases.push('REAL_G11E_LOCK_CONTENTION');
  policyCases.push('REAL_G11E_HANDOFF_FROM_G11D_RESULT');
  process.stdout.write(JSON.stringify({ ok: true, sourceDirty, g11dRuns, policyCases, firstMongo }) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
