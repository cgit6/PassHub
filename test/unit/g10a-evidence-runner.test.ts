import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'internal-g10a-evidence-runner.mjs')).href;
const environmentProof = 'G10A_ENVIRONMENT_PROOF={"format":"passhub.g10a.environment-proof.v1","nodeVersion":"24.21.0","mongoVersion":"8.0.32","replicaSet":"rs0","writablePrimary":true}';

type Runner = Readonly<{
  parseJestCounts(output: unknown): { suiteCount: number | null; testCount: number | null };
  runG10aEvidence(input: Record<string, unknown>): Promise<{ phases: readonly { identifier: string; exitCode: number; durationMs: number; suiteCount: number | null; testCount: number | null }[]; cleanup: { status: string } }>;
}>;

describe('G10a evidence top-level runner', () => {
  test('keeps only whitelist summaries, then writes actual phase and cleanup results', async () => {
    const runner = await loadRunner();
    const writes: unknown[] = [];
    const commandCalls: string[] = [];
    const result = await runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-runner',
      now: sequenceNow(100, 113, 113, 144, 144, 199),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined,
      collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => {
        commandCalls.push(identifier);
        return { exitCode: 0, stdout: `Test Suites: 1 passed, 1 total\nTests:       7 passed, 7 total\nprivate mongodb://not-persisted/secret${identifier === 'test:g10a:integration' ? `\n${environmentProof}` : ''}` };
      },
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: unknown) => { writes.push(input); return {}; },
    });
    expect(commandCalls).toEqual(['test:g10a:unit', 'test:g10a:socket', 'test:g10a:integration']);
    expect(result.phases).toEqual([
      { identifier: 'test:g10a:unit', exitCode: 0, durationMs: 13, suiteCount: 1, testCount: 7 },
      { identifier: 'test:g10a:socket', exitCode: 0, durationMs: 31, suiteCount: 1, testCount: 7 },
      { identifier: 'test:g10a:integration', exitCode: 0, durationMs: 55, suiteCount: 1, testCount: 7 },
    ]);
    expect(JSON.stringify(writes)).not.toContain('mongodb://');
    expect(JSON.stringify(writes)).not.toContain('secret');
    expect(writes).toHaveLength(1);
  });

  test('preserves phase failure over cleanup failure and does not launch later phases', async () => {
    const runner = await loadRunner();
    const calls: string[] = [];
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-fail', now: sequenceNow(0, 4),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => { calls.push(identifier); return { exitCode: 9, stdout: 'Tests: 3 failed, 3 total' }; },
      inspectDocker: async () => ({ dockerContainersAbsent: false, composeContainersAbsent: false, composeNetworksAbsent: false }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('test:g10a:unit failed with exit 9');
    expect(calls).toEqual(['test:g10a:unit']);
    expect(writes[0].results.status).toBe('FAIL');
    expect(writes[0].cleanup.status).toBe('FAIL');
  });

  test('preserves phase failure when artifact persistence also fails', async () => {
    const runner = await loadRunner();
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-write-fail', now: sequenceNow(0, 1),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async () => ({ exitCode: 7, stdout: '' }),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async () => { throw new Error('private artifact failure must not win'); },
    })).rejects.toThrow('test:g10a:unit failed with exit 7');
  });

  test.each([
    ['reported leftovers', async () => ({ dockerContainersAbsent: false, composeContainersAbsent: true, composeNetworksAbsent: true }), 'G10a Docker resources remain after execution'],
    ['inspection failure', async () => { throw new Error('private docker output'); }, 'G10a Docker cleanup verification failed'],
  ])('writes successful phase evidence before rejecting independent cleanup failure: %s', async (_caseName, inspectDocker, message) => {
    const runner = await loadRunner();
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-cleanup-fail', now: sequenceNow(0, 1, 1, 2, 2, 3),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => ({ exitCode: 0, stdout: `Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total${identifier === 'test:g10a:integration' ? `\n${environmentProof}` : ''}` }),
      inspectDocker, writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow(message);
    expect(writes).toHaveLength(1);
    expect(writes[0].results.status).toBe('PASS');
    expect(writes[0].cleanup.status).toBe('FAIL');
  });

  test('keeps a phase failure primary when cleanup also fails', async () => {
    const runner = await loadRunner();
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-phase-primary', now: sequenceNow(0, 1),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async () => ({ exitCode: 4, stdout: '' }),
      inspectDocker: async () => { throw new Error('cleanup'); }, writeArtifacts: async () => ({}),
    })).rejects.toThrow('test:g10a:unit failed with exit 4');
  });

  test('fails evidence when a successful integration omits or expands its fixed environment proof', async () => {
    const runner = await loadRunner();
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-missing-proof', now: sequenceNow(0, 1, 1, 2, 2, 3),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async () => ({ exitCode: 0, stdout: 'Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total' }),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('did not emit a valid G10a environment proof');
    expect(writes).toHaveLength(1);
    expect(writes[0].results.status).toBe('FAIL');
    expect(writes[0].results.environment).toBeNull();
  });

  test('does not read output, provenance, or commands when clean preflight fails', async () => {
    const runner = await loadRunner();
    const calls: string[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-preflight',
      assertClean: async () => { calls.push('clean'); throw new Error('dirty'); },
      assertOutputRoot: async () => { calls.push('output'); return '/safe/private-output'; },
      collectProvenance: async () => { calls.push('provenance'); return provenance(); },
      executeCommand: async () => { calls.push('command'); return { exitCode: 0, stdout: '' }; },
      inspectDocker: async () => { calls.push('docker'); return { dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }; },
      writeArtifacts: async () => { calls.push('write'); return {}; },
    })).rejects.toThrow('dirty');
    expect(calls).toEqual(['clean']);
  });

  test('parses only Jest total suite/test counts and rejects unstructured text', async () => {
    const runner = await loadRunner();
    expect(runner.parseJestCounts('\u001b[32mTest Suites:\u001b[0m 2 passed, 2 total\nTests:       15 passed, 15 total')).toEqual({ suiteCount: 2, testCount: 15 });
    expect(runner.parseJestCounts('arbitrary request body token=not-a-summary')).toEqual({ suiteCount: null, testCount: null });
  });
});

async function loadRunner(): Promise<Runner> { return await import(moduleUrl) as Runner; }
function sequenceNow(...values: number[]) { let index = 0; return () => values[index++] ?? values.at(-1) ?? 0; }
function provenance() { return { format: 'passhub.g10a.evidence.v1', sourceCommit: 'a'.repeat(40), hashes: {}, toolchain: {} }; }
