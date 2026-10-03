import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'passhub-g11e-'));
const runtime = join(root, 'runtime');
const lock = join(root, 'controller.lock');
const script = join(process.cwd(), 'scripts/g11/run-maintenance.sh');
const epoch = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
function start(extra = {}) {
  return spawn(script, { cwd: process.cwd(), env: { ...process.env, PASSHUB_MAINTENANCE_RUNTIME_DIR: runtime, PASSHUB_MAINTENANCE_LOCK_PATH: lock, PASSHUB_DATASET_EPOCH: epoch, PASSHUB_PROCESS_RUN_ID: run, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
}
function collect(child) { return new Promise((resolve) => { let out = ''; let err = ''; child.stdout.on('data', (x) => { out += x; }); child.stderr.on('data', (x) => { err += x; }); child.on('close', (code) => resolve({ code, out, err })); }); }
try {
  const first = start({ PASSHUB_MAINTENANCE_HOLD_MS: '600' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await collect(start());
  const firstResult = await collect(first);
  if (second.code !== 75 || firstResult.code !== 0) throw new Error('nonblocking lock did not select one controller');
  const ticketPath = join(runtime, 'bootstrap-ticket.json');
  const ticket = JSON.parse(readFileSync(ticketPath, 'utf8'));
  if (ticket.v !== 'g11b.run-ticket.v1' || ticket.datasetEpoch !== epoch || ticket.processRunId !== run) throw new Error('ticket wire mismatch');
  if ((statSync(ticketPath).mode & 0o777) !== 0o400) throw new Error('ticket mode mismatch');
  unlinkSync(ticketPath);
  const timerRun = await collect(start());
  if (timerRun.code !== 0) throw new Error('shared timer command did not run after lock release');
  process.stdout.write(JSON.stringify({ ok: true, cases: ['ONE_CONTROLLER_WINS', 'SECOND_CONTROLLER_NONBLOCKING_BUSY', 'TICKET_WIRE_AND_MODE', 'SHARED_ENTRY_REUSE'] }) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
