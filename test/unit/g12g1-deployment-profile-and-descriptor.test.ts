import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import * as descriptorIntake from '../../src/deployment/internal/g12g1-dataset-descriptor-intake.js';
import {
  DatasetDescriptorIntakeError,
} from '../../src/deployment/internal/g12g1-dataset-descriptor-intake.js';
import {
  DeploymentProfileConfigError,
  LOCAL_PRODUCTION_DATASET_TARGET,
  assertExpectedDatasetEpoch,
  parseDeploymentProfile,
  resolveProductionDatasetTarget,
} from '../../src/deployment/internal/g12g1-deployment-profile.js';
import {
  createDatasetDescriptorIntakeForFsTest,
} from '../support/g12g1-dataset-descriptor-test-support.js';

const execFileAsync = promisify(execFile);
const EPOCH = '11111111-1111-4111-8111-111111111111';
const OTHER_EPOCH = '22222222-2222-4222-8222-222222222222';
const ALPHA_EPOCH = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const directories: string[] = [];

afterEach(async () => {
  jest.restoreAllMocks();
  const targets = directories.splice(0);
  const results = await Promise.allSettled(targets.map(async (directory) => {
    if (!directory.startsWith(join(tmpdir(), 'passhub-g12g1-descriptor-'))) {
      throw new Error('unsafe descriptor fixture cleanup');
    }
    await rm(directory, { recursive: true, force: true });
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'descriptor fixture cleanup failed');
});

function canonicalDescriptor(
  slot: 'BLUE' | 'GREEN' = 'BLUE',
  epoch = EPOCH,
): string {
  const databaseName = slot === 'BLUE' ? 'passhub_demo_blue' : 'passhub_demo_green';
  return `${JSON.stringify({ profile: 'ATLAS_MANAGED', slot, databaseName, datasetEpoch: epoch })}\n`;
}

async function runtimeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'passhub-g12g1-descriptor-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

async function descriptorFile(
  content: string | Uint8Array = canonicalDescriptor(),
  mode = 0o400,
): Promise<{ readonly directory: string; readonly path: string }> {
  const directory = await runtimeDirectory();
  const path = join(directory, 'active-dataset.json');
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return { directory, path };
}

async function expectDescriptorFailure(
  operation: Promise<unknown>,
  code: DatasetDescriptorIntakeError['code'],
): Promise<void> {
  try {
    await operation;
    throw new Error('expected descriptor intake failure');
  } catch (error) {
    expect(error).toBeInstanceOf(DatasetDescriptorIntakeError);
    expect(error).toMatchObject({ code, message: code });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('path');
  }
}

describe('G12g-1 exact deployment profile and selection boundary', () => {
  test.each([
    ['LOCAL_SELF_HOSTED'],
    ['ATLAS_MANAGED'],
  ] as const)('accepts only the exact profile %s', (profile) => {
    expect(parseDeploymentProfile(profile)).toBe(profile);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['leading whitespace', ' LOCAL_SELF_HOSTED'],
    ['trailing whitespace', 'ATLAS_MANAGED '],
    ['lowercase', 'local_self_hosted'],
    ['unknown', 'PRODUCTION'],
    ['embedded NUL', 'ATLAS_MANAGED\0'],
  ])('rejects %s profile without normalization or fallback', (_name, value) => {
    expect(() => parseDeploymentProfile(value)).toThrow(expect.objectContaining({
      code: 'DEPLOYMENT_PROFILE_INVALID',
      message: 'DEPLOYMENT_PROFILE_INVALID',
    }));
  });

  test('profile failures expose only the stable code and never echo attacker-controlled input', () => {
    const privateValue = 'ATLAS_MANAGED-private-profile-secret';
    try {
      parseDeploymentProfile(privateValue);
      throw new Error('expected exact profile rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentProfileConfigError);
      expect(String(error)).toBe('DeploymentProfileConfigError: DEPLOYMENT_PROFILE_INVALID');
      expect(String(error)).not.toContain(privateValue);
      expect(error).not.toHaveProperty('cause');
    }
  });

  test('LOCAL_SELF_HOSTED permits probe mode and performs zero descriptor I/O', async () => {
    const intake = jest.spyOn(descriptorIntake, 'readCanonicalAtlasDatasetDescriptor');
    await expect(resolveProductionDatasetTarget('LOCAL_SELF_HOSTED', false))
      .resolves.toBe(LOCAL_PRODUCTION_DATASET_TARGET);
    await expect(resolveProductionDatasetTarget('LOCAL_SELF_HOSTED', true))
      .resolves.toBe(LOCAL_PRODUCTION_DATASET_TARGET);
    expect(intake).not.toHaveBeenCalled();
    expect(LOCAL_PRODUCTION_DATASET_TARGET).toEqual({
      databaseName: 'passhub_demo',
      expectedDatasetEpoch: null,
    });
    expect(Object.isFrozen(LOCAL_PRODUCTION_DATASET_TARGET)).toBe(true);
  });

  test('ATLAS_MANAGED rejects probe mode before descriptor I/O', async () => {
    const intake = jest.spyOn(descriptorIntake, 'readCanonicalAtlasDatasetDescriptor');
    await expect(resolveProductionDatasetTarget('ATLAS_MANAGED', true)).rejects.toEqual(
      expect.objectContaining<Partial<DeploymentProfileConfigError>>({
        code: 'DEPLOYMENT_PROFILE_PROBE_FORBIDDEN',
        message: 'DEPLOYMENT_PROFILE_PROBE_FORBIDDEN',
      }),
    );
    expect(intake).not.toHaveBeenCalled();
  });

  test('ATLAS_MANAGED resolves once to a frozen target that is unaffected by later source mutation', async () => {
    const source = {
      profile: 'ATLAS_MANAGED' as const,
      slot: 'GREEN' as const,
      databaseName: 'passhub_demo_green' as const,
      datasetEpoch: EPOCH,
    };
    const intake = jest.spyOn(descriptorIntake, 'readCanonicalAtlasDatasetDescriptor')
      .mockResolvedValue(source);
    const target = await resolveProductionDatasetTarget('ATLAS_MANAGED', false);
    source.datasetEpoch = OTHER_EPOCH;
    expect(intake).toHaveBeenCalledTimes(1);
    expect(target).toEqual({ databaseName: 'passhub_demo_green', expectedDatasetEpoch: EPOCH });
    expect(Object.isFrozen(target)).toBe(true);
  });

  test('dataset epoch enforcement is exact and Local has no descriptor epoch assertion', () => {
    expect(() => assertExpectedDatasetEpoch(LOCAL_PRODUCTION_DATASET_TARGET, EPOCH)).not.toThrow();
    expect(() => assertExpectedDatasetEpoch({
      databaseName: 'passhub_demo_blue', expectedDatasetEpoch: EPOCH,
    }, EPOCH)).not.toThrow();
    expect(() => assertExpectedDatasetEpoch({
      databaseName: 'passhub_demo_blue', expectedDatasetEpoch: EPOCH,
    }, OTHER_EPOCH)).toThrow(expect.objectContaining({ code: 'DATASET_DESCRIPTOR_EPOCH_MISMATCH' }));
  });

  test('NODE_ENV is neither consulted nor accepted as a database selector', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(resolveProductionDatasetTarget('LOCAL_SELF_HOSTED', false))
        .resolves.toEqual({ databaseName: 'passhub_demo', expectedDatasetEpoch: null });
      expect(() => parseDeploymentProfile(process.env.NODE_ENV)).toThrow(
        expect.objectContaining({ code: 'DEPLOYMENT_PROFILE_INVALID' }),
      );
      const production = await readFile(join(process.cwd(), 'src/deployment/production-main.ts'), 'utf8');
      expect(production).not.toContain('NODE_ENV');
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  test.each([
    ['missing', undefined],
    ['invalid', 'ATLAS_MANAGED-private-profile-secret'],
  ])('production startup rejects %s profile in CONFIG before Mongo construction without echoing input', async (_name, profile) => {
    const environment = { ...process.env };
    if (profile === undefined) delete environment.PASSHUB_DEPLOYMENT_PROFILE;
    else environment.PASSHUB_DEPLOYMENT_PROFILE = profile;
    let failure: { readonly code?: number | string; readonly stdout?: string; readonly stderr?: string } | undefined;
    try {
      await execFileAsync(process.execPath, [join(process.cwd(), 'dist/src/deployment/production-main.js')], {
        cwd: process.cwd(),
        env: environment,
        timeout: 5_000,
      });
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure).toBeDefined();
    expect(failure?.code).toBe(1);
    expect(failure?.stdout ?? '').toBe('');
    expect(failure?.stderr).toBe('PassHub deployment startup failed: CONFIG:DEPLOYMENT_PROFILE_INVALID\n');
    expect(failure?.stderr ?? '').not.toContain('private-profile-secret');

    const source = await readFile(join(process.cwd(), 'src/deployment/production-main.ts'), 'utf8');
    expect(source.indexOf('const config = await loadConfig();')).toBeGreaterThan(-1);
    expect(source.indexOf('const config = await loadConfig();'))
      .toBeLessThan(source.indexOf('const mongo = new MongoClient'));
  });
});

describe('G12g-1 canonical Atlas descriptor wire contract', () => {
  test.each([
    ['BLUE', 'passhub_demo_blue'],
    ['GREEN', 'passhub_demo_green'],
  ] as const)('accepts canonical %s and maps it to %s', async (slot, databaseName) => {
    const fixture = await descriptorFile(canonicalDescriptor(slot));
    await expect(createDatasetDescriptorIntakeForFsTest(fixture.directory)()).resolves.toEqual({
      profile: 'ATLAS_MANAGED', slot, databaseName, datasetEpoch: EPOCH,
    });
  });

  test.each([
    ['wrong profile', `${JSON.stringify({ profile: 'LOCAL_SELF_HOSTED', slot: 'BLUE', databaseName: 'passhub_demo_blue', datasetEpoch: EPOCH })}\n`],
    ['wrong slot', `${JSON.stringify({ profile: 'ATLAS_MANAGED', slot: 'PURPLE', databaseName: 'passhub_demo_blue', datasetEpoch: EPOCH })}\n`],
    ['slot/database mismatch', `${JSON.stringify({ profile: 'ATLAS_MANAGED', slot: 'BLUE', databaseName: 'passhub_demo_green', datasetEpoch: EPOCH })}\n`],
    ['extra field', `${JSON.stringify({ profile: 'ATLAS_MANAGED', slot: 'BLUE', databaseName: 'passhub_demo_blue', datasetEpoch: EPOCH, secret: 'x' })}\n`],
    ['missing field', `${JSON.stringify({ profile: 'ATLAS_MANAGED', slot: 'BLUE', databaseName: 'passhub_demo_blue' })}\n`],
    ['non-object', '[]\n'],
    ['null', 'null\n'],
    ['wrong field type', `${JSON.stringify({ profile: 'ATLAS_MANAGED', slot: 'BLUE', databaseName: 'passhub_demo_blue', datasetEpoch: 1 })}\n`],
    ['uppercase UUID', canonicalDescriptor('BLUE', ALPHA_EPOCH.toUpperCase())],
    ['wrong UUID version', canonicalDescriptor('BLUE', '11111111-1111-1111-8111-111111111111')],
    ['duplicate field', `{"profile":"ATLAS_MANAGED","slot":"BLUE","slot":"BLUE","databaseName":"passhub_demo_blue","datasetEpoch":"${EPOCH}"}\n`],
    ['escaped duplicate field', `{"profile":"ATLAS_MANAGED","slot":"BLUE","\\u0073lot":"BLUE","databaseName":"passhub_demo_blue","datasetEpoch":"${EPOCH}"}\n`],
    ['reordered fields', `${JSON.stringify({ slot: 'BLUE', profile: 'ATLAS_MANAGED', databaseName: 'passhub_demo_blue', datasetEpoch: EPOCH })}\n`],
    ['leading whitespace', ` ${canonicalDescriptor()}`],
    ['trailing whitespace', `${canonicalDescriptor().slice(0, -1)} \n`],
    ['pretty JSON', `${JSON.stringify({ profile: 'ATLAS_MANAGED', slot: 'BLUE', databaseName: 'passhub_demo_blue', datasetEpoch: EPOCH }, null, 2)}\n`],
    ['missing terminal LF', canonicalDescriptor().slice(0, -1)],
    ['CRLF', `${canonicalDescriptor().slice(0, -1)}\r\n`],
    ['second LF', `${canonicalDescriptor()}\n`],
    ['embedded NUL', `${canonicalDescriptor().slice(0, -2)}\0"}\n`],
    ['leading BOM', `\ufeff${canonicalDescriptor()}`],
    ['empty object', '{}\n'],
  ])('rejects non-canonical descriptor: %s', async (_name, content) => {
    const fixture = await descriptorFile(content);
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(fixture.directory)(),
      'DATASET_DESCRIPTOR_INVALID',
    );
  });

  test('rejects empty, oversized, and invalid UTF-8 descriptors', async () => {
    const empty = await descriptorFile('');
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(empty.directory)(),
      'DATASET_DESCRIPTOR_FILE_UNSAFE',
    );
    const oversized = await descriptorFile(`${'a'.repeat(512)}\n`);
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(oversized.directory)(),
      'DATASET_DESCRIPTOR_FILE_UNSAFE',
    );
    const invalidUtf8 = await descriptorFile(Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d, 0x0a]));
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(invalidUtf8.directory)(),
      'DATASET_DESCRIPTOR_INVALID',
    );
  });

  test('descriptor rejection exposes neither invalid wire content nor its private path', async () => {
    const privateValue = 'private-descriptor-secret';
    const fixture = await descriptorFile(`${JSON.stringify({
      profile: 'ATLAS_MANAGED', slot: 'BLUE', databaseName: 'passhub_demo_blue',
      datasetEpoch: EPOCH, privateValue,
    })}\n`);
    try {
      await createDatasetDescriptorIntakeForFsTest(fixture.directory)();
      throw new Error('expected descriptor rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetDescriptorIntakeError);
      expect(String(error)).toBe('DatasetDescriptorIntakeError: DATASET_DESCRIPTOR_INVALID');
      expect(String(error)).not.toContain(privateValue);
      expect(String(error)).not.toContain(fixture.directory);
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('path');
    }
  });
});

describe('G12g-1 protected descriptor real-FS intake', () => {
  test.each([0o600, 0o440, 0o000])('rejects descriptor mode %s', async (mode) => {
    const fixture = await descriptorFile(canonicalDescriptor(), mode);
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(fixture.directory)(),
      'DATASET_DESCRIPTOR_FILE_UNSAFE',
    );
  });

  test('rejects unsafe directory mode, directory symlink, and simulated wrong owners', async () => {
    const badMode = await descriptorFile();
    await chmod(badMode.directory, 0o755);
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(badMode.directory)(),
      'DATASET_DESCRIPTOR_DIRECTORY_UNSAFE',
    );

    const real = await descriptorFile();
    const alias = `${real.directory}-alias`;
    directories.push(alias);
    await symlink(real.directory, alias);
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(alias)(),
      'DATASET_DESCRIPTOR_DIRECTORY_UNSAFE',
    );

    const wrongDirectoryOwner = await descriptorFile();
    await expectDescriptorFailure(createDatasetDescriptorIntakeForFsTest(wrongDirectoryOwner.directory, {
      expectedDirectoryOwnerUid: differentUid(),
    })(), 'DATASET_DESCRIPTOR_DIRECTORY_UNSAFE');

    const wrongFileOwner = await descriptorFile();
    await expectDescriptorFailure(createDatasetDescriptorIntakeForFsTest(wrongFileOwner.directory, {
      expectedDescriptorOwnerUid: differentUid(),
    })(), 'DATASET_DESCRIPTOR_FILE_UNSAFE');
  });

  test('rejects missing, directory, symlink, FIFO, and socket descriptor nodes without hanging', async () => {
    const missing = await runtimeDirectory();
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(missing)(),
      'DATASET_DESCRIPTOR_FILE_UNSAFE',
    );

    const directoryNode = await runtimeDirectory();
    await mkdir(join(directoryNode, 'active-dataset.json'), { mode: 0o400 });
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(directoryNode)(),
      'DATASET_DESCRIPTOR_FILE_UNSAFE',
    );

    const linkNode = await runtimeDirectory();
    const target = join(linkNode, 'target.json');
    await writeFile(target, canonicalDescriptor(), { mode: 0o400 });
    await symlink(target, join(linkNode, 'active-dataset.json'));
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(linkNode)(),
      'DATASET_DESCRIPTOR_FILE_UNSAFE',
    );

    const fifoNode = await runtimeDirectory();
    await execFileAsync('mkfifo', [join(fifoNode, 'active-dataset.json')]);
    await chmod(join(fifoNode, 'active-dataset.json'), 0o400);
    await expectDescriptorFailure(
      createDatasetDescriptorIntakeForFsTest(fifoNode)(),
      'DATASET_DESCRIPTOR_FILE_UNSAFE',
    );

    const socketNode = await runtimeDirectory();
    const socketPath = join(socketNode, 'active-dataset.json');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expectDescriptorFailure(
        createDatasetDescriptorIntakeForFsTest(socketNode)(),
        'DATASET_DESCRIPTOR_FILE_UNSAFE',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('rejects path replacement after open and closes all owned descriptors', async () => {
    const fixture = await descriptorFile();
    const replacement = join(fixture.directory, 'replacement.json');
    await writeFile(replacement, canonicalDescriptor('GREEN'), { mode: 0o400 });
    await expectDescriptorFailure(createDatasetDescriptorIntakeForFsTest(fixture.directory, {
      faults: {
        beforeRead: async () => {
          const old = join(fixture.directory, 'old.json');
          await rename(fixture.path, old);
          await rename(replacement, fixture.path);
        },
      },
    })(), 'DATASET_DESCRIPTOR_FILE_UNSAFE');
    await expectNoOpenDescriptorsUnder(fixture.directory);
  });

  test('rejects same-inode same-size content mutation during intake', async () => {
    const fixture = await descriptorFile(canonicalDescriptor('BLUE', EPOCH));
    await expectDescriptorFailure(createDatasetDescriptorIntakeForFsTest(fixture.directory, {
      faults: {
        beforeRead: async () => {
          await chmod(fixture.path, 0o600);
          await writeFile(fixture.path, canonicalDescriptor('BLUE', OTHER_EPOCH));
          await chmod(fixture.path, 0o400);
        },
      },
    })(), 'DATASET_DESCRIPTOR_FILE_UNSAFE');
  });

  test.each([
    ['directoryStat', { directoryStat: () => { throw new Error('private-directory-stat'); } }],
    ['beforeRead', { beforeRead: () => { throw new Error('private-read'); } }],
    ['descriptorClose', { descriptorClose: () => { throw new Error('private-file-close'); } }],
    ['directoryClose', { directoryClose: () => { throw new Error('private-directory-close'); } }],
  ] as const)('fails closed, sanitizes, and closes handles for %s fault', async (_name, faults) => {
    const fixture = await descriptorFile();
    await expectDescriptorFailure(createDatasetDescriptorIntakeForFsTest(fixture.directory, { faults })(),
      'DATASET_DESCRIPTOR_READ_FAILED');
    await expectNoOpenDescriptorsUnder(fixture.directory);
  });

  test('production descriptor facade has one fixed path and cannot consume env or argv paths', async () => {
    expect(descriptorIntake.G12G1_DATASET_DESCRIPTOR_DIRECTORY).toBe('/run/passhub/dataset');
    expect(descriptorIntake.G12G1_DATASET_DESCRIPTOR_PATH)
      .toBe('/run/passhub/dataset/active-dataset.json');
    const facade = await readFile(
      join(process.cwd(), 'src/deployment/internal/g12g1-dataset-descriptor-intake.ts'),
      'utf8',
    );
    expect(facade).not.toContain('process.env');
    expect(facade).not.toContain('process.argv');
  });

  test('LOCAL_SELF_HOSTED Compose has no Atlas descriptor path or mount', async () => {
    const compose = await readFile(join(process.cwd(), 'infra/g11/compose.yml'), 'utf8');
    expect(compose).toContain('PASSHUB_DEPLOYMENT_PROFILE: LOCAL_SELF_HOSTED');
    expect(compose).not.toContain('/run/passhub/dataset');
    expect(compose).not.toContain('active-dataset.json');
    expect(compose).not.toMatch(/PASSHUB_[A-Z_]*DESCRIPTOR/u);
  });
});

describe('G12g-1 module boundary', () => {
  test('descriptor engine has exact importers and no public barrel exports profile or descriptor internals', async () => {
    const engineName = ['g12g1', 'dataset', 'descriptor', 'engine'].join('-');
    const engineImporters: string[] = [];
    for (const rootName of ['src', 'test']) {
      const root = join(process.cwd(), rootName);
      for (const name of (await readdir(root, { recursive: true })).filter((entry) => entry.endsWith('.ts'))) {
        const source = await readFile(join(root, name), 'utf8');
        if (source.includes(engineName)) engineImporters.push(`${rootName}/${name}`);
      }
    }
    expect(engineImporters.sort()).toEqual([
      'src/deployment/internal/g12g1-dataset-descriptor-intake.ts',
      'test/support/g12g1-dataset-descriptor-test-support.ts',
    ]);
    for (const barrel of [
      'src/index.ts', 'src/composition/index.ts', 'src/infrastructure/mongo/index.ts',
    ]) {
      const source = await readFile(join(process.cwd(), barrel), 'utf8');
      expect(source).not.toContain('g12g1');
      expect(source).not.toContain('DeploymentProfile');
      expect(source).not.toContain('ProductionDatasetTarget');
    }
  });
});

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

async function expectNoOpenDescriptorsUnder(directory: string): Promise<void> {
  const leaked = (await openFileDescriptorTargets()).filter((target) =>
    target === directory || target.startsWith(`${directory}/`) || target.startsWith(`${directory} (deleted)`));
  expect(leaked).toEqual([]);
}
