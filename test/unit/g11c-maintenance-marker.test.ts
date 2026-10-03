import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createG11cMaintenanceMarkerAdapter,
  G11cMaintenanceMarkerError,
} from '../../src/deployment/internal/g11c-maintenance-marker.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'passhub-g11c-marker-'));
  directories.push(value);
  await chmod(value, 0o755);
  return value;
}

describe('G11c persistent maintenance marker adapter', () => {
  test('creates an empty owner-only marker and adopts it idempotently without release', async () => {
    const root = await directory();
    const adapter = createG11cMaintenanceMarkerAdapter({ directory: root });
    const first = await adapter.acquire();
    expect(first).toBeDefined();
    expect(await readFile(adapter.path)).toEqual(Buffer.alloc(0));
    expect(statSync(adapter.path).mode & 0o7777).toBe(0o600);
    const second = await adapter.acquire();
    expect(second).toBeDefined();
    expect(adapter.path).toBe(join(root, 'maintenance'));
  });

  test('rejects a symlink marker rather than adopting a different path', async () => {
    const root = await directory();
    const target = join(root, 'target');
    await writeFile(target, 'secret');
    await symlink(target, join(root, 'maintenance'));
    const adapter = createG11cMaintenanceMarkerAdapter({ directory: root });
    await expect(adapter.acquire()).rejects.toBeInstanceOf(G11cMaintenanceMarkerError);
  });

  test('rejects a non-empty or unsafe existing marker', async () => {
    const root = await directory();
    const path = join(root, 'maintenance');
    await writeFile(path, 'unexpected', { mode: 0o600 });
    const adapter = createG11cMaintenanceMarkerAdapter({ directory: root });
    await expect(adapter.acquire()).rejects.toMatchObject({ code: 'MARKER_ACQUIRE_FAILED' });
  });

  test('rejects an unsafe marker directory', async () => {
    const root = await directory();
    await chmod(root, 0o700);
    const adapter = createG11cMaintenanceMarkerAdapter({ directory: root });
    await expect(adapter.acquire()).rejects.toMatchObject({ code: 'MARKER_ACQUIRE_FAILED' });
  });
});
