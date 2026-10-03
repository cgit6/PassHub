import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repository = process.cwd();
const config = 'jest.g11b.b5-production.unit.config.cjs';
const temporary = mkdtempSync(join(tmpdir(), 'passhub-g11b-manifest-'));
const outputFile = join(temporary, 'jest.json');

try {
  const result = execFileSync(process.execPath, ['node_modules/jest/bin/jest.js', '--config', config,
    '--runInBand', '--json', `--outputFile=${outputFile}`], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(readFileSync(outputFile, 'utf8'));
  const failures = [];
  if (report.numTotalTestSuites !== 6) failures.push(`suite-count:${report.numTotalTestSuites}`);
  if (report.numTotalTests !== 33) failures.push(`test-count:${report.numTotalTests}`);
  if (report.numFailedTestSuites !== 0 || report.numFailedTests !== 0) failures.push('failed');
  if (report.numPendingTests !== 0 || report.numTodoTests !== 0) failures.push('pending-or-todo');
  if (report.wasInterrupted === true) failures.push('interrupted');
  if (failures.length > 0) throw new Error(`G11b unit manifest rejected: ${failures.join(',')}`);
  process.stdout.write(JSON.stringify({
    gate: 'G11b', slice: 'b5-unit', status: 'PASS', config,
    suites: report.numTotalTestSuites, tests: report.numTotalTests,
    failed: report.numFailedTests, pending: report.numPendingTests, todo: report.numTodoTests,
  }) + '\n');
  void result;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
