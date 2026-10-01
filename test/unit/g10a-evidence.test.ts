import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'internal-g10a-evidence.mjs')).href;

type EvidenceProvenance = Readonly<{
  format: string;
  sourceCommit: string;
  hashes: Readonly<Record<string, string>>;
  toolchain: Readonly<{ nodeImage: string; mongoImage: string }>;
}>;

type Evidence = Readonly<{
  collectG10aEvidenceProvenance(input: { root: string; git: (root: string, args: readonly string[]) => Promise<string> }): Promise<EvidenceProvenance>;
  writeG10aEvidenceArtifacts(input: { root: string; outputRoot?: string; runId: string; provenance: EvidenceProvenance; resultStatus: 'PASS' | 'FAIL'; cleanupStatus: 'PASS' | 'FAIL' }): Promise<{ runId: string; artifactNames: readonly string[] }>;
  runWithPrimaryFailure(input: { execute: () => Promise<unknown>; cleanup: () => Promise<void> }): Promise<unknown>;
}>;

describe('G10a private evidence boundary', () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
  });

  test('writes only the closed safe artifact set with reproducible provenance hashes', async () => {
    const fixture = await workspaceFixture(); cleanups.push(fixture.root);
    const evidence = await loadEvidence();
    const provenance = await evidence.collectG10aEvidenceProvenance({ root: fixture.root, git: cleanGit });
    const second = await evidence.collectG10aEvidenceProvenance({ root: fixture.root, git: cleanGit });
    expect(provenance).toEqual(second);
    const outputRoot = join(fixture.root, 'private-evidence-root');

    const written = await evidence.writeG10aEvidenceArtifacts({
      root: fixture.root,
      outputRoot,
      runId: 'g10a-20261001-a1b2c3d4',
      provenance,
      resultStatus: 'PASS',
      cleanupStatus: 'PASS',
    });
    expect(written.artifactNames).toEqual(['manifest.json', 'results.json', 'cleanup.json']);

    const directory = join(outputRoot, written.runId);
    const files = await Promise.all(written.artifactNames.map(async (name) => readFile(join(directory, name), 'utf8')));
    const persisted = files.join('\n');
    expect(persisted).toContain('passhub.g10a.evidence.v1');
    expect(persisted).toContain(provenance.hashes.sourceTree);
    expect(persisted).toContain('node:24.21.0-bookworm-slim@sha256:');
    expect(persisted).toContain('mongo:8.0.32-noble@sha256:');
    expect(persisted).not.toMatch(/mongodb(?:\+srv)?:\/\//iu);
    expect(persisted).not.toMatch(/\b(?:uri|secret|token|password|authorization|cookie|body|stack|environment)\b/iu);
    const cleanupJson = files.at(2);
    if (cleanupJson === undefined) throw new Error('missing cleanup evidence');
    expect(JSON.parse(cleanupJson)).toEqual({
      format: 'passhub.g10a.evidence-cleanup.v1',
      runId: written.runId,
      status: 'PASS',
      primaryFailurePrecedence: 'PRESERVED',
    });
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    await Promise.all(written.artifactNames.map(async (name) => {
      expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
    }));
  });

  test('fails closed before hashing when the Git worktree is dirty', async () => {
    const fixture = await workspaceFixture(); cleanups.push(fixture.root);
    const evidence = await loadEvidence();
    await expect(evidence.collectG10aEvidenceProvenance({
      root: fixture.root,
      git: async (_root, args) => args[0] === 'status' ? ' M package-lock.json\n' : 'a'.repeat(40),
    })).rejects.toThrow('clean tracked worktree');
  });

  test('preserves the primary failure even when cleanup also fails', async () => {
    const evidence = await loadEvidence();
    const primary = new Error('primary failure with mongodb://private.example/secret');
    const cleanup = new Error('cleanup failure with token');
    await expect(evidence.runWithPrimaryFailure({
      execute: async () => { throw primary; },
      cleanup: async () => { throw cleanup; },
    })).rejects.toBe(primary);
  });

  test('fails before staging when the final runId is already reserved', async () => {
    const fixture = await workspaceFixture(); cleanups.push(fixture.root);
    const evidence = await loadEvidence();
    const provenance = await evidence.collectG10aEvidenceProvenance({ root: fixture.root, git: cleanGit });
    const outputRoot = join(fixture.root, 'private-evidence-root');
    const reserved = join(outputRoot, 'g10a-20261001-collision');
    await mkdir(reserved, { recursive: true, mode: 0o700 });
    await writeFile(join(reserved, 'preserved'), 'do-not-replace\n', { mode: 0o600 });
    await expect(evidence.writeG10aEvidenceArtifacts({ root: fixture.root, outputRoot, runId: 'g10a-20261001-collision', provenance, resultStatus: 'PASS', cleanupStatus: 'PASS' })).rejects.toThrow('runId collision');
    expect(await readFile(join(reserved, 'preserved'), 'utf8')).toBe('do-not-replace\n');
    expect(await lstat(join(outputRoot, '.g10a-20261001-collision.staging')).catch(() => undefined)).toBeUndefined();
  });

  test('does not remove a pre-existing staging directory', async () => {
    const fixture = await workspaceFixture(); cleanups.push(fixture.root);
    const evidence = await loadEvidence();
    const provenance = await evidence.collectG10aEvidenceProvenance({ root: fixture.root, git: cleanGit });
    const outputRoot = join(fixture.root, 'private-evidence-root');
    const staging = join(outputRoot, '.g10a-20261001-staging.staging');
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(join(staging, 'preserved'), 'do-not-delete\n', { mode: 0o600 });
    await expect(evidence.writeG10aEvidenceArtifacts({ root: fixture.root, outputRoot, runId: 'g10a-20261001-staging', provenance, resultStatus: 'PASS', cleanupStatus: 'PASS' })).rejects.toThrow('staging collision');
    expect(await readFile(join(staging, 'preserved'), 'utf8')).toBe('do-not-delete\n');
  });

  test('rejects nonexact directory permissions and free provenance fields', async () => {
    const fixture = await workspaceFixture(); cleanups.push(fixture.root);
    const evidence = await loadEvidence();
    const provenance = await evidence.collectG10aEvidenceProvenance({ root: fixture.root, git: cleanGit });
    const outputRoot = join(fixture.root, 'private-evidence-root');
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await chmod(outputRoot, 0o750);
    await expect(evidence.writeG10aEvidenceArtifacts({ root: fixture.root, outputRoot, runId: 'g10a-20261001-permissions', provenance, resultStatus: 'PASS', cleanupStatus: 'PASS' })).rejects.toThrow('exactly mode 0700');

    await chmod(outputRoot, 0o700);
    const tainted = { ...provenance, message: 'mongodb://must-not-be-accepted/secret' } as unknown as EvidenceProvenance;
    await expect(evidence.writeG10aEvidenceArtifacts({ root: fixture.root, outputRoot, runId: 'g10a-20261001-tainted', provenance: tainted, resultStatus: 'PASS', cleanupStatus: 'PASS' })).rejects.toThrow('unexpected fields');
  });

  test('rejects symlinked G10a inventory and mismatched runner pin', async () => {
    const fixture = await workspaceFixture(); cleanups.push(fixture.root);
    const evidence = await loadEvidence();
    await symlink(join(fixture.root, 'src', 'runtime', 'internal', 'runtime-control.ts'), join(fixture.root, 'src', 'runtime', 'internal', 'runtime-alias.ts'));
    await expect(evidence.collectG10aEvidenceProvenance({ root: fixture.root, git: cleanGit })).rejects.toThrow('symbolic links');

    await rm(join(fixture.root, 'src', 'runtime', 'internal', 'runtime-alias.ts'));
    await writeFile(join(fixture.root, 'scripts', 'test-g10a-integration.mjs'), `const nodeImage = 'node:24.21.0-bookworm-slim@sha256:${'d'.repeat(64)}';\n`);
    await expect(evidence.collectG10aEvidenceProvenance({ root: fixture.root, git: cleanGit })).rejects.toThrow('Node pin sources disagree');
  });
});

async function loadEvidence(): Promise<Evidence> {
  return await import(moduleUrl) as Evidence;
}

async function workspaceFixture(): Promise<{ readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'passhub-g10a-evidence-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'src', 'composition', 'internal'), { recursive: true });
  await mkdir(join(root, 'src', 'runtime', 'internal'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'infra'), { recursive: true });
  await mkdir(join(root, 'test', 'unit'), { recursive: true });
  await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
  await writeFile(join(root, 'src', 'composition', 'internal', 'g10a-owner.ts'), 'export const owner = 1;\n');
  await writeFile(join(root, 'src', 'runtime', 'internal', 'runtime-control.ts'), 'export const control = 1;\n');
  await writeFile(join(root, 'test', 'unit', 'g10a-owner.test.ts'), 'test(\'owner\', () => undefined);\n');
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(root, 'scripts', 'test-g10a-integration.mjs'), `const nodeImage = 'node:24.21.0-bookworm-slim@sha256:${'a'.repeat(64)}';\n`);
  await writeFile(join(root, 'scripts', 'internal-g10a-evidence.mjs'), 'export {};\n');
  await writeFile(join(root, 'infra', 'toolchain-images.json'), JSON.stringify({ images: {
    node: `node:24.21.0-bookworm-slim@sha256:${'a'.repeat(64)}`,
    mongo: `mongo:8.0.32-noble@sha256:${'b'.repeat(64)}`,
  } }));
  await writeFile(join(root, 'infra', 'g04b-mongo-compose.yml'), `services:\n  mongo:\n    image: mongo:8.0.32-noble@sha256:${'b'.repeat(64)}\n`);
  await Promise.all(['unit', 'socket', 'integration'].map(async (tier) => writeFile(join(root, `jest.g10a.${tier}.config.cjs`), 'module.exports = {};\n')));
  return { root };
}

async function cleanGit(_root: string, args: readonly string[]): Promise<string> {
  if (args[0] === 'status') return '';
  if (args[0] === 'rev-parse') return `${'c'.repeat(40)}\n`;
  throw new Error(`unexpected Git invocation: ${args.join(' ')}`);
}
