import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'internal-g10b-evidence.mjs')).href;
const runnerUrl = pathToFileURL(join(process.cwd(), 'scripts', 'internal-g10b-evidence-runner.mjs')).href;

describe('G10b private evidence boundary', () => {
  const cleanups: string[] = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))); });

  test('writes a closed 0700/0600 sanitized artifact set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'passhub-g10b-evidence-')); cleanups.push(root);
    const outputRoot = join(root, 'output', 'evidence', 'g10b');
    const evidence = await load();
    const provenance = { format: 'passhub.g10b.evidence.v1', sourceCommit: 'a'.repeat(40), hashes: hashes() };
    const results = evidence.createG10bEvidenceResults({ status: 'PASS', commands: [
      { id: 'unit', exitCode: 0, suiteCount: 1, testCount: 2 },
      { id: 'topology', exitCode: 0, suiteCount: null, testCount: null },
      { id: 'fault', exitCode: 0, suiteCount: 2, testCount: 3 },
    ] });
    const cleanup = evidence.createG10bEvidenceCleanup({ status: 'PASS', dockerResourcesAbsent: absent() });
    const written = await evidence.writeG10bEvidenceArtifacts({ root, outputRoot, runId: 'g10b-a1b2c3d4', provenance, results, cleanup });
    expect(written.artifactNames).toEqual(['manifest.json', 'results.json', 'cleanup.json']);
    const directory = join(outputRoot, written.runId);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    for (const name of written.artifactNames) expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
    const persisted = await Promise.all(written.artifactNames.map(async (name: string) => await readFile(join(directory, name), 'utf8')));
    expect(persisted.join('\n')).toContain('NO_APP_PARTIAL_EFFECT');
    expect(persisted.join('\n')).toMatch(/112|11000/u);
    expect(persisted.join('\n')).not.toMatch(/mongodb(?:\+srv)?:\/\/|lsid|txn|subject|authorization|body/iu);
    const [manifest, resultsJson, cleanupJson] = await Promise.all(['manifest.json', 'results.json', 'cleanup.json'].map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
    expect(Object.keys(manifest).sort()).toEqual(['artifacts', 'format', 'hashes', 'runId', 'sourceCommit']);
    expect(Object.keys(resultsJson).sort()).toEqual(['cases', 'commands', 'format', 'runId', 'status']);
    expect(Object.keys(cleanupJson).sort()).toEqual(['dockerResourcesAbsent', 'format', 'primaryFailurePrecedence', 'runId', 'status']);
  });

  test('rejects adversarial unknown keys and arbitrary fault totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'passhub-g10b-evidence-')); cleanups.push(root);
    const evidence = await load();
    const provenance = { format: 'passhub.g10b.evidence.v1', sourceCommit: 'a'.repeat(40), hashes: hashes() };
    const results = validResults(evidence);
    const cleanup = evidence.createG10bEvidenceCleanup({ status: 'PASS', dockerResourcesAbsent: absent() });
    const write = async (value: Record<string, unknown>) => await evidence.writeG10bEvidenceArtifacts({ root, outputRoot: join(root, 'output', 'evidence', 'g10b'), runId: 'g10b-a1b2c3d4', provenance, results, cleanup, ...value });
    await expect(write({ provenance: { ...provenance, uri: 'forbidden' } })).rejects.toThrow('keyset');
    await expect(write({ results: { ...results, reply: 'forbidden' } })).rejects.toThrow('keyset');
    await expect(write({ cleanup: { ...cleanup, subject: 'forbidden' } })).rejects.toThrow('keyset');
    expect(() => evidence.createG10bEvidenceResults({ status: 'PASS', commands: [
      { id: 'unit', exitCode: 0, suiteCount: 1, testCount: 2 },
      { id: 'topology', exitCode: 0, suiteCount: null, testCount: null },
      { id: 'fault', exitCode: 0, suiteCount: 1, testCount: 99 },
    ] })).toThrow('exactly two suites and three tests');
  });

  test('persists FAIL on cleanup failure and never lets artifact writing mask a phase failure', async () => {
    const runner = await loadRunner(); const captured: any[] = [];
    await expect(runner.runG10bEvidence({
      root: process.cwd(), outputRoot: '/tmp/ignored', runId: 'g10b-a1b2c3d4',
      assertClean: async () => 'a'.repeat(40), assertOutputRoot: async () => '/tmp/ignored',
      collectProvenance: async () => ({ format: 'passhub.g10b.evidence.v1', sourceCommit: 'a'.repeat(40), hashes: hashes() }),
      execute: async (command: string) => command === 'test:g10b:fault' ? { exitCode: 1, output: '' } : { exitCode: 0, output: command === 'test:g10b:unit' ? jestOutput(1, 2) : '' },
      inspectCleanup: async () => absent(),
      writeArtifacts: async (value: unknown) => { captured.push(value); throw new Error('artifact writer'); },
    })).rejects.toThrow('fault failed');
    expect(captured[0].results.status).toBe('FAIL');
    expect(captured[0].cleanup.status).toBe('PASS');

    const cleanupCaptured: any[] = [];
    await expect(runner.runG10bEvidence({
      root: process.cwd(), outputRoot: '/tmp/ignored', runId: 'g10b-e5f6a7b8',
      assertClean: async () => 'a'.repeat(40), assertOutputRoot: async () => '/tmp/ignored',
      collectProvenance: async () => ({ format: 'passhub.g10b.evidence.v1', sourceCommit: 'a'.repeat(40), hashes: hashes() }),
      execute: async (command: string) => ({ exitCode: 0, output: command === 'test:g10:fault-topology' ? '' : command === 'test:g10b:fault' ? jestOutput(2, 3) : jestOutput(1, 2) }),
      inspectCleanup: async () => ({ containers: true, networks: true, volumes: false }),
      writeArtifacts: async (value: unknown) => { cleanupCaptured.push(value); },
    })).rejects.toThrow('cleanup failed');
    expect(cleanupCaptured[0].results.status).toBe('FAIL');
    expect(cleanupCaptured[0].cleanup.status).toBe('FAIL');
  });

  test('rejects dirty provenance before a formal run and preserves primary failures', async () => {
    const evidence = await load();
    await expect(evidence.assertCleanGitWorktree({ root: process.cwd(), git: async (_root: string, args: readonly string[]) => args[0] === 'status' ? ' M test.ts\n' : 'a'.repeat(40) })).rejects.toThrow('clean worktree');
    const primary = new Error('primary');
    await expect(evidence.runWithPrimaryFailure({ execute: async () => { throw primary; }, cleanup: async () => { throw new Error('cleanup'); } })).rejects.toBe(primary);
  });
});

async function load(): Promise<any> { return await import(`${moduleUrl}?v=${Date.now()}-${Math.random()}`); }
async function loadRunner(): Promise<any> { return await import(`${runnerUrl}?v=${Date.now()}-${Math.random()}`); }
function hashes(): Record<string, string> {
  return Object.fromEntries([
    'g10bImplementation', 'g10bUnitTests', 'g10bIntegrationTests', 'packageJson', 'packageLock', 'tsconfig', 'jestUnit', 'jestFault', 'evidenceEntry', 'evidenceRunner', 'evidenceCore', 'faultRunner', 'faultOrchestrator', 'topologyCheck', 'topologyInit', 'compose', 'toxiproxy', 'toolchain', 'fixture', 'inventory',
  ].map((key) => [key, 'b'.repeat(64)]));
}
function absent() { return { containers: true, networks: true, volumes: true }; }
function validResults(evidence: any) { return evidence.createG10bEvidenceResults({ status: 'PASS', commands: [
  { id: 'unit', exitCode: 0, suiteCount: 1, testCount: 2 },
  { id: 'topology', exitCode: 0, suiteCount: null, testCount: null },
  { id: 'fault', exitCode: 0, suiteCount: 2, testCount: 3 },
] }); }
function jestOutput(suites: number, tests: number) { return `Test Suites: ${suites} passed, ${suites} total\nTests: ${tests} passed, ${tests} total\n`; }
