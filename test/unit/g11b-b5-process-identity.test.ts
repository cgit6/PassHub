import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  G11B_PROCESS_IDENTITY_PATH,
  ProcessIdentityIntakeError,
} from '../../src/deployment/internal/g11b-process-identity-intake.js';
import { G11B_RUN_TICKET_DIRECTORY } from '../../src/deployment/internal/g11b-run-ticket-intake.js';
import {
  createProcessIdentityIntakeForFsTest,
} from '../support/g11b-process-identity-test-support.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  const targets = directories.splice(0);
  const results = await Promise.allSettled(targets.map(async (directory) => {
    if (!directory.startsWith(join(tmpdir(), 'passhub-process-identity-'))) throw new Error('unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'process identity cleanup failed');
});

async function runtimeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'passhub-process-identity-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

async function identityFile(
  content: string | Uint8Array,
  mode = 0o400,
): Promise<{ readonly directory: string; readonly path: string }> {
  const directory = await runtimeDirectory();
  const path = join(directory, 'process-run-id');
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return { directory, path };
}

async function expectFailure(
  operation: Promise<unknown>,
  code: ProcessIdentityIntakeError['code'],
): Promise<void> {
  try {
    await operation;
    throw new Error('expected process identity intake failure');
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessIdentityIntakeError);
    expect(error).toMatchObject({ code, message: code });
    expect(error).not.toHaveProperty('cause');
  }
}

describe('G11b b5 process identity real-FS intake', () => {
  test('reads the canonical lowercase UUID without consuming or mutating it across restarts', async () => {
    const runId = randomUUID();
    const fixture = await identityFile(`${runId}\n`);
    const readIdentity = createProcessIdentityIntakeForFsTest(fixture.directory);
    await expect(readIdentity()).resolves.toBe(runId);
    await expect(readIdentity()).resolves.toBe(runId);
    await expect(readFile(fixture.path, 'utf8')).resolves.toBe(`${runId}\n`);
    await expect(lstat(fixture.path)).resolves.toMatchObject({ size: 37 });
  });

  test.each([
    ['empty', ''],
    ['no terminal LF', randomUUID()],
    ['two terminal LFs', `${randomUUID()}\n\n`],
    ['CRLF', `${randomUUID()}\r\n`],
    ['leading whitespace', ` ${randomUUID()}\n`],
    ['trailing whitespace', `${randomUUID()} \n`],
    ['uppercase UUID', `${randomUUID().toUpperCase()}\n`],
    ['wrong UUID version', '11111111-1111-1111-8111-111111111111\n'],
    ['non-UUID', 'not-a-process-run-id\n'],
    ['leading BOM', `\ufeff${randomUUID()}\n`],
    ['embedded LF', `${randomUUID().slice(0, 18)}\n${randomUUID().slice(19)}\n`],
  ])('rejects invalid exact wire: %s', async (_name, content) => {
    const fixture = await identityFile(content);
    const code = content.length === 0 ? 'PROCESS_IDENTITY_FILE_UNSAFE' : 'PROCESS_IDENTITY_INVALID';
    await expectFailure(createProcessIdentityIntakeForFsTest(fixture.directory)(), code);
  });

  test('rejects invalid UTF-8 and oversized input', async () => {
    const invalid = await identityFile(Uint8Array.from([0xc3, 0x28, 0x0a]));
    await expectFailure(
      createProcessIdentityIntakeForFsTest(invalid.directory)(),
      'PROCESS_IDENTITY_INVALID',
    );
    const oversized = await identityFile(`${'a'.repeat(64)}\n`);
    await expectFailure(
      createProcessIdentityIntakeForFsTest(oversized.directory)(),
      'PROCESS_IDENTITY_FILE_UNSAFE',
    );
  });

  test.each([0o600, 0o440, 0o000])('rejects identity mode %s', async (mode) => {
    const fixture = await identityFile(`${randomUUID()}\n`, mode);
    await expectFailure(
      createProcessIdentityIntakeForFsTest(fixture.directory)(),
      'PROCESS_IDENTITY_FILE_UNSAFE',
    );
  });

  test('rejects missing, directory, symlink, FIFO, and socket nodes without hanging', async () => {
    const missing = await runtimeDirectory();
    await expectFailure(
      createProcessIdentityIntakeForFsTest(missing)(),
      'PROCESS_IDENTITY_FILE_UNSAFE',
    );

    const asDirectory = await runtimeDirectory();
    await mkdirIdentityNode(asDirectory);
    await expectFailure(
      createProcessIdentityIntakeForFsTest(asDirectory)(),
      'PROCESS_IDENTITY_FILE_UNSAFE',
    );

    const linkDirectory = await runtimeDirectory();
    const target = join(linkDirectory, 'target');
    await writeFile(target, `${randomUUID()}\n`, { mode: 0o400 });
    await symlink(target, join(linkDirectory, 'process-run-id'));
    await expectFailure(
      createProcessIdentityIntakeForFsTest(linkDirectory)(),
      'PROCESS_IDENTITY_FILE_UNSAFE',
    );

    const fifoDirectory = await runtimeDirectory();
    await execFileAsync('mkfifo', [join(fifoDirectory, 'process-run-id')]);
    await chmod(join(fifoDirectory, 'process-run-id'), 0o400);
    await expectFailure(
      createProcessIdentityIntakeForFsTest(fifoDirectory)(),
      'PROCESS_IDENTITY_FILE_UNSAFE',
    );

    const socketDirectory = await runtimeDirectory();
    const socketPath = join(socketDirectory, 'process-run-id');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expectFailure(
        createProcessIdentityIntakeForFsTest(socketDirectory)(),
        'PROCESS_IDENTITY_FILE_UNSAFE',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('rejects unsafe runtime directory paths, modes, and simulated owners', async () => {
    const fixture = await identityFile(`${randomUUID()}\n`);
    await chmod(fixture.directory, 0o755);
    await expectFailure(
      createProcessIdentityIntakeForFsTest(fixture.directory)(),
      'RUNTIME_DIRECTORY_UNSAFE',
    );

    const real = await identityFile(`${randomUUID()}\n`);
    const alias = `${real.directory}-alias`;
    directories.push(alias);
    await symlink(real.directory, alias);
    await expectFailure(
      createProcessIdentityIntakeForFsTest(alias)(),
      'RUNTIME_DIRECTORY_UNSAFE',
    );

    const wrongDirectoryOwner = await identityFile(`${randomUUID()}\n`);
    await expectFailure(createProcessIdentityIntakeForFsTest(wrongDirectoryOwner.directory, {
      expectedDirectoryOwnerUid: differentUid(),
    })(), 'RUNTIME_DIRECTORY_UNSAFE');

    const wrongFileOwner = await identityFile(`${randomUUID()}\n`);
    await expectFailure(createProcessIdentityIntakeForFsTest(wrongFileOwner.directory, {
      expectedIdentityOwnerUid: differentUid(),
    })(), 'PROCESS_IDENTITY_FILE_UNSAFE');
  });

  test.each([
    ['beforeRead', { beforeRead: () => { throw new Error('private-read-secret'); } }],
    ['identityClose', { identityClose: () => { throw new Error('private-close-secret'); } }],
    ['directoryClose', { directoryClose: () => { throw new Error('private-directory-secret'); } }],
  ] as const)('fails closed and sanitizes the %s fault', async (_name, faults) => {
    const runId = randomUUID();
    const fixture = await identityFile(`${runId}\n`);
    const operation = createProcessIdentityIntakeForFsTest(fixture.directory, { faults })();
    try {
      await operation;
      throw new Error('expected process identity fault');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROCESS_IDENTITY_READ_FAILED' });
      expect(String(error)).not.toContain('private-');
      expect(String(error)).not.toContain(runId);
      expect(error).not.toHaveProperty('cause');
    }
  });

  test('sanitizes a post-open directory stat failure and closes the opened directory handle', async () => {
    const fixture = await identityFile(`${randomUUID()}\n`);
    const privatePath = `${fixture.directory}/private-stat-path`;
    try {
      await createProcessIdentityIntakeForFsTest(fixture.directory, {
        faults: { directoryStat: () => { throw Object.assign(new Error(privatePath), { code: 'EIO', path: privatePath }); } },
      })();
      throw new Error('expected directory stat failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessIdentityIntakeError);
      expect(error).toMatchObject({
        code: 'PROCESS_IDENTITY_READ_FAILED',
        message: 'PROCESS_IDENTITY_READ_FAILED',
      });
      expect(String(error)).not.toContain(privatePath);
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('path');
    }
    await expect(openFileDescriptorTargets()).resolves.not.toContain(fixture.directory);
  });
});

describe('G11b b5 process identity production boundary', () => {
  test('production path is fixed, derived from the canonical runtime directory, and not wired yet', async () => {
    expect(G11B_RUN_TICKET_DIRECTORY).toBe('/run/passhub/api');
    expect(G11B_PROCESS_IDENTITY_PATH).toBe('/run/passhub/api/process-run-id');
    const facade = await readFile(
      join(process.cwd(), 'src/deployment/internal/g11b-process-identity-intake.ts'),
      'utf8',
    );
    expect(facade).not.toContain('process.env');
    expect(facade).not.toContain('process.argv');
    expect(facade).not.toContain('directory: string');
    const productionMain = await readFile(join(process.cwd(), 'src/deployment/production-main.ts'), 'utf8');
    expect(productionMain).not.toContain('g11b-process-identity');
    expect(productionMain).not.toContain('process-run-id');
  });

  test('configurable engine importers are exact and test support cannot enter production', async () => {
    const engineName = ['g11b', 'process', 'identity', 'engine'].join('-');
    const supportName = ['g11b', 'process', 'identity', 'test', 'support'].join('-');
    const engineImporters: string[] = [];
    const supportProductionImporters: string[] = [];
    for (const rootName of ['src', 'test']) {
      const root = join(process.cwd(), rootName);
      for (const name of (await readdir(root, { recursive: true })).filter((entry) => entry.endsWith('.ts'))) {
        const source = await readFile(join(root, name), 'utf8');
        const path = `${rootName}/${name}`;
        if (source.includes(engineName)) engineImporters.push(path);
        if (rootName === 'src' && source.includes(supportName)) supportProductionImporters.push(path);
      }
    }
    expect(engineImporters.sort()).toEqual([
      'src/deployment/internal/g11b-process-identity-intake.ts',
      'test/support/g11b-process-identity-test-support.ts',
    ]);
    expect(supportProductionImporters).toEqual([]);
    for (const barrel of [
      'src/index.ts', 'src/composition/index.ts', 'src/infrastructure/mongo/index.ts',
    ]) {
      const source = await readFile(join(process.cwd(), barrel), 'utf8');
      expect(source).not.toContain('g11b-process-identity');
      expect(source).not.toContain('readCanonicalProcessRunId');
    }
  });
});

async function mkdirIdentityNode(directory: string): Promise<void> {
  await mkdir(join(directory, 'process-run-id'), { mode: 0o400 });
}

function differentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('POSIX uid required');
  return uid === 0 ? 1 : uid - 1;
}

async function openFileDescriptorTargets(): Promise<readonly string[]> {
  const descriptors = await readdir('/proc/self/fd');
  const targets = await Promise.all(descriptors.map(async (descriptor) => {
    try { return await readlink(join('/proc/self/fd', descriptor)); } catch { return ''; }
  }));
  return targets.filter((target) => target.length > 0);
}
