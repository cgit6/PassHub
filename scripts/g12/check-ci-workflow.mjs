import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const workflowPath = resolve(root, '.github/workflows/ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const required = [
  'node-version-file: .nvmrc',
  'cache: npm',
  'npm ci',
  'npm run build',
  'npm run test:unit',
  'npm run test:g07a:e2e',
  'npm run test:g07b:e2e',
  'npm run test:g08a:e2e',
  'npm run test:g08b:e2e',
  'npm run test:g09a:e2e',
  'scripts/check-g03c-boundary.mjs',
  'scripts/check-g06a-boundary.mjs',
  'scripts/check-g06b-boundary.mjs',
  'scripts/check-g08a-boundary.mjs',
  'scripts/check-g08b-boundary.mjs',
  'scripts/check-g09a-boundary.mjs',
  'scripts/check-g10-fault-topology.mjs',
  'scripts/g11/check-g11a-topology.mjs',
  'scripts/g11/check-g11e-contract.mjs',
  'npm run check:g12b:openapi',
  'npm run check:g12c:requirements',
  'git diff --check',
];
const missing = required.filter((value) => !workflow.includes(value));
if (missing.length) throw new Error(`G12E_WORKFLOW_MISSING:${missing.join('|')}`);
if (workflow.includes('check-g07a-boundary') || workflow.includes('check-g07b-boundary')) {
  throw new Error('G12E_WORKFLOW_USES_STALE_G07_BOUNDARY');
}
if (!/runs-on:\s*ubuntu-24\.04/u.test(workflow) || !/timeout-minutes:\s*20/u.test(workflow)) {
  throw new Error('G12E_WORKFLOW_RUNNER_POLICY_INVALID');
}
process.stdout.write(`${JSON.stringify({ gate: 'G12e', status: 'PASS', workflow: '.github/workflows/ci.yml', requiredChecks: required.length, remoteRun: 'NOT_EXECUTED' })}\n`);
