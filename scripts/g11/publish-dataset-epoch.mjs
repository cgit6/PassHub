import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// This is the hand-off from the already completed G11d reset to G11e.  The
// reset caller supplies a private result JSON; the controller never accepts a
// raw epoch from an environment variable or command argument.
const resultFile = resolve(process.env.PASSHUB_RESET_RESULT_FILE ?? '/run/passhub/maintenance/reset-result.json');
const epochFile = resolve(process.env.PASSHUB_DATASET_EPOCH_FILE ?? '/run/passhub/maintenance/dataset-epoch');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function fail(code) { process.stderr.write(`${code}\n`); process.exitCode = 1; }
try {
  const stat = lstatSync(resultFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o400) throw new Error('source');
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  if (typeof result.datasetEpoch !== 'string' || !uuid.test(result.datasetEpoch) || result.database !== 'passhub_demo' || result.indexesPreserved !== true) throw new Error('shape');
  const temporary = `${epochFile}.next-${process.pid}`;
  if (existsSync(temporary)) unlinkSync(temporary);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { writeFileSync(fd, `${result.datasetEpoch}\n`, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(temporary, 0o400);
  // Same-directory rename is atomic: an existing epoch remains visible until
  // the new validated reset result is ready, and no empty window is created.
  renameSync(temporary, epochFile);
  process.stdout.write('{"ok":true}\n');
} catch { fail('G11E_EPOCH_PUBLISH_FAILED'); }
