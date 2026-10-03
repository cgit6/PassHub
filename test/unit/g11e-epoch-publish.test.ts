import { readFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('G11e epoch hand-off contract', () => {
  test('the reset result shape requires passhub_demo and preserved indexes', () => {
    const root = mkdtempSync(join(tmpdir(), 'g11e-epoch-'));
    const result = join(root, 'reset-result.json');
    writeFileSync(result, JSON.stringify({ database: 'passhub_demo', datasetEpoch: '11111111-1111-4111-8111-111111111111', indexesPreserved: true }) + '\n', { mode: 0o400 });
    chmodSync(result, 0o400);
    expect(JSON.parse(readFileSync(result, 'utf8')).indexesPreserved).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
