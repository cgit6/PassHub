import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const runtimeDirectory = resolve(process.env.PASSHUB_MAINTENANCE_RUNTIME_DIR ?? '/run/passhub/maintenance');
const datasetEpoch = process.env.PASSHUB_DATASET_EPOCH;
const processRunId = process.env.PASSHUB_PROCESS_RUN_ID;
const ticketId = randomUUID();
const ticketPath = join(runtimeDirectory, 'bootstrap-ticket.json');
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function fail(code) { process.stderr.write(`${code}\n`); process.exitCode = 1; }
function validDirectory(path) {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
}
if (typeof datasetEpoch !== 'string' || !uuidV4.test(datasetEpoch) || typeof processRunId !== 'string' || !uuidV4.test(processRunId)) {
  fail('G11E_INVALID_IDENTITY');
} else if (!validDirectory(runtimeDirectory)) {
  fail('G11E_RUNTIME_DIRECTORY');
} else if (existsSync(ticketPath)) {
  fail('G11E_TICKET_EXISTS');
} else {
  const wire = `${JSON.stringify({ v: 'g11b.run-ticket.v1', ticketId, datasetEpoch, processRunId })}\n`;
  try {
    const fd = openSync(ticketPath, 'wx', 0o400);
    try { writeFileSync(fd, wire, { encoding: 'utf8' }); } finally { closeSync(fd); }
    chmodSync(ticketPath, 0o400);
    process.stdout.write(JSON.stringify({ ok: true, ticketPath, ticketId, datasetEpoch, processRunId }) + '\n');
    const holdMs = Number.parseInt(process.env.PASSHUB_MAINTENANCE_HOLD_MS ?? '0', 10);
    if (Number.isSafeInteger(holdMs) && holdMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
    }
  } catch { fail('G11E_TICKET_WRITE_FAILED'); }
}
