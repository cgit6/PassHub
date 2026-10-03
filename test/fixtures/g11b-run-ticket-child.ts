import { lstat, readFile, writeFile } from 'node:fs/promises';
import {
  RunTicketIntakeError,
} from '../../src/deployment/internal/g11b-run-ticket-intake.js';
import { createG11bRunTicketIntakeForFsTest } from '../support/g11b-run-ticket-test-support.js';

async function main(): Promise<void> {
  const directory = process.argv[2];
  const identityPath = process.argv[3];
  const mode = process.argv[4] ?? 'consume';
  const barrierPath = process.argv[5];
  const readyPath = process.argv[6];
  if (directory === undefined || identityPath === undefined) process.exit(64);

  const processRunId = (await readFile(identityPath, 'utf8')).trim();
  if (barrierPath !== undefined && readyPath !== undefined) {
    await writeFile(readyPath, '', { mode: 0o400, flag: 'wx' });
    await waitForBarrier(barrierPath);
  }
  const consume = createG11bRunTicketIntakeForFsTest(directory, {
    faults: mode === 'crash-after-marker'
      ? { directoryFirstSync: () => { process.kill(process.pid, 'SIGKILL'); } }
      : {},
  });
  try {
    await consume(processRunId);
    process.stdout.write('CONSUMED\n');
  } catch (error) {
    const code = error instanceof RunTicketIntakeError ? error.code : 'UNEXPECTED';
    process.stdout.write(`${code}\n`);
    process.exitCode = 1;
  }
}

async function waitForBarrier(path: string): Promise<void> {
  for (;;) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

void main();
