import { closeSync, constants, existsSync, openSync, readFileSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

// Production service fixes this to /run/passhub/api; the explicit override is
// only for isolated tests that cannot write the host /run tree.
const runtimeDirectory = resolve(process.env.PASSHUB_RUNTIME_DIRECTORY ?? '/run/passhub/api');
const datasetEpochFile = resolve(process.env.PASSHUB_DATASET_EPOCH_FILE ?? '/run/passhub/maintenance/dataset-epoch');
const processIdentityFile = join(runtimeDirectory, 'process-run-id');
const ticketId = randomUUID();
const ticketPath = join(runtimeDirectory, 'bootstrap-ticket.json');
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function fail(code) { process.stderr.write(`${code}\n`); process.exitCode = 1; }
function validDirectory(path) {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.geteuid?.() && (stat.mode & 0o777) === 0o700; } catch { return false; }
}
function readProtectedUuid(path, code) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o400) { fail(code); return null; }
    const value = readFileSync(path, 'utf8');
    if (!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\n$/u.test(value)) { fail(code); return null; }
    return value.trim();
  } catch { fail(code); return null; }
}
const datasetEpoch = readProtectedUuid(datasetEpochFile, 'G11E_INVALID_EPOCH');
const processRunId = readProtectedUuid(processIdentityFile, 'G11E_INVALID_PROCESS_ID');
if (datasetEpoch === null || processRunId === null) {
  // readProtectedUuid already emitted a safe reason code
} else if (!validDirectory(runtimeDirectory)) {
  fail('G11E_RUNTIME_DIRECTORY');
} else if (existsSync(ticketPath)) {
  fail('G11E_TICKET_EXISTS');
} else {
  const wire = `${JSON.stringify({ v: 'g11b.run-ticket.v1', ticketId, datasetEpoch, processRunId })}\n`;
  try {
    const fd = openSync(ticketPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try { writeFileSync(fd, wire, { encoding: 'utf8' }); } finally { closeSync(fd); }
    chmodSync(ticketPath, 0o400);
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    const holdMs = Number.parseInt(process.env.PASSHUB_MAINTENANCE_HOLD_MS ?? '0', 10);
    if (Number.isSafeInteger(holdMs) && holdMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  } catch { fail('G11E_TICKET_WRITE_FAILED'); }
}
