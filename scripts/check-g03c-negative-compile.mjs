import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [
  tsc,
  '--noEmit',
  '--strict',
  '--target', 'ES2023',
  '--module', 'Node20',
  '--moduleResolution', 'Node16',
  '--skipLibCheck', 'false',
  '--esModuleInterop',
  '--types', 'node',
  'test/negative/public-surface.ts',
], { cwd: root, stdio: 'inherit' });

if (result.status !== 0) process.exit(result.status ?? 1);
console.log('G03c negative public-surface compile: exit 0 (all expected errors consumed by @ts-expect-error)');
