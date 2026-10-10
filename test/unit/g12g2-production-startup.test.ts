import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';

const ENVIRONMENT_KEYS = [
  'PASSHUB_DEPLOYMENT_PROFILE',
  'PASSHUB_HTTP_HOST',
  'PASSHUB_HTTP_PORT',
  'PASSHUB_TRUSTED_PROXY_IP',
  'PASSHUB_MONGO_URI_FILE',
  'PASSHUB_JWT_KEY_FILE',
  'PASSHUB_COMPARISON_KEY_FILE',
  'PASSHUB_G11A_PROBE_MODE',
] as const;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('production startup test timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('G12g-2 production startup fail-closed ordering', () => {
  const originalEnvironment = new Map<string, string | undefined>();
  const originalExitCode = process.exitCode;
  let directory = '';

  beforeEach(async () => {
    jest.resetModules();
    for (const key of ENVIRONMENT_KEYS) originalEnvironment.set(key, process.env[key]);
    directory = await mkdtemp(join(tmpdir(), 'passhub-g12g2-startup-'));
    const mongoPath = join(directory, 'mongo-uri');
    const jwtPath = join(directory, 'jwt-key');
    const comparisonPath = join(directory, 'comparison-key');
    await writeFile(mongoPath, 'mongodb://private-user:private-password@private-host.invalid/passhub\n');
    await writeFile(jwtPath, `${'j'.repeat(32)}\n`);
    await writeFile(comparisonPath, `${'00'.repeat(32)}\n`);
    Object.assign(process.env, {
      PASSHUB_DEPLOYMENT_PROFILE: 'LOCAL_SELF_HOSTED',
      PASSHUB_HTTP_HOST: '127.0.0.1',
      PASSHUB_HTTP_PORT: '31999',
      PASSHUB_TRUSTED_PROXY_IP: '127.0.0.1',
      PASSHUB_MONGO_URI_FILE: mongoPath,
      PASSHUB_JWT_KEY_FILE: jwtPath,
      PASSHUB_COMPARISON_KEY_FILE: comparisonPath,
      PASSHUB_G11A_PROBE_MODE: '1',
    });
    process.exitCode = undefined;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const key of ENVIRONMENT_KEYS) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnvironment.clear();
    process.exitCode = originalExitCode;
    if (directory.startsWith(join(tmpdir(), 'passhub-g12g2-startup-'))) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('capability rejection closes Mongo before reporting and never selects an application database', async () => {
    const calls: string[] = [];
    const close = jest.fn(async () => { calls.push('close'); });
    const command = jest.fn(async (input: Readonly<Record<string, unknown>>) => {
      calls.push(`command:${Object.keys(input)[0] ?? 'unknown'}`);
      return { version: '8.0.31', privateDetail: 'must-not-leak' };
    });
    const db = jest.fn((name: string) => {
      calls.push(`db:${name}`);
      if (name !== 'admin') throw new Error('dataset composition must not run');
      return { command };
    });
    const connect = jest.fn(async () => { calls.push('connect'); });
    const constructor = jest.fn(() => ({ connect, close, db }));

    jest.doMock('mongodb', () => ({ MongoClient: constructor }));
    const stderr: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation(((value: string | Uint8Array) => {
      stderr.push(String(value));
      return true;
    }) as typeof process.stderr.write);

    await import('../../src/deployment/production-main.js');
    await waitFor(() => process.exitCode === 1);

    expect(calls).toEqual(['connect', 'db:admin', 'command:buildInfo', 'close']);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
    expect(stderr.filter((line) => line.startsWith('PassHub deployment startup failed:'))).toEqual([
      'PassHub deployment startup failed: MONGO_CAPABILITY:MONGO_CAPABILITY_VERIFICATION_FAILED\n',
    ]);
    expect(stderr.join('')).not.toMatch(/private|password|8\.0\.31/u);
  });
});
