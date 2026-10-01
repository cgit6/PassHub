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
      collectCategories: async () => completeCategories(),
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
    expect(JSON.stringify(writes)).not.toContain('not-persisted');
    expect(writes).toHaveLength(1);
  });

  test('accepts valid Jest totals and integration proof emitted only to stderr without persisting stderr', async () => {
    const runner = await loadRunner();
    const writes: any[] = [];
    const stderrMarker = 'stderr-private-mongodb://not-persisted/secret';
    const result = await runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-stderr', now: sequenceNow(0, 1, 1, 2, 2, 3),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => ({
        exitCode: 0,
        stdout: '',
        stderr: `Test Suites: 1 passed, 1 total\nTests: 7 passed, 7 total\n${stderrMarker}${identifier === 'test:g10a:integration' ? `\n${environmentProof}` : ''}`,
      }),
      collectCategories: async () => completeCategories(),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    });
    expect(result.phases).toEqual([
      { identifier: 'test:g10a:unit', exitCode: 0, durationMs: 1, suiteCount: 1, testCount: 7 },
      { identifier: 'test:g10a:socket', exitCode: 0, durationMs: 1, suiteCount: 1, testCount: 7 },
      { identifier: 'test:g10a:integration', exitCode: 0, durationMs: 1, suiteCount: 1, testCount: 7 },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0].results.status).toBe('PASS');
    expect(JSON.stringify(writes[0])).not.toContain(stderrMarker);
    expect(JSON.stringify(writes[0])).not.toContain('mongodb://');
  });

  test('preserves phase failure over cleanup failure and does not launch later phases', async () => {
    const runner = await loadRunner();
    const calls: string[] = [];
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-fail', now: sequenceNow(0, 4),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      collectCategories: async () => failedCategories(),
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
      collectCategories: async () => incompleteCategories(),
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
      collectCategories: async () => completeCategories(),
      executeCommand: async (identifier: string) => ({ exitCode: 0, stdout: `Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total${identifier === 'test:g10a:integration' ? `\n${environmentProof}` : ''}` }),
      inspectDocker, writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow(message);
    expect(writes).toHaveLength(1);
    expect(writes[0].results.status).toBe('PASS');
    expect(writes[0].cleanup.status).toBe('FAIL');
  });

  test.each([
    ['empty stderr', '', null, null],
    ['malformed stderr', 'Test Suites: 1 passed, one total\nTests: 1 passed, 1 total', null, 1],
  ])('fails closed when zero-exit Jest totals on stderr are %s', async (_caseName, stderr, suiteCount, testCount) => {
    const runner = await loadRunner();
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-stderr-invalid', now: sequenceNow(0, 1),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async () => ({ exitCode: 0, stdout: '', stderr }),
      collectCategories: async () => incompleteCategories(),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('test:g10a:unit did not emit valid Jest total counts');
    expect(writes).toHaveLength(1);
    expect(writes[0].results.phases).toEqual([
      { identifier: 'test:g10a:unit', exitCode: 0, durationMs: 1, suiteCount, testCount },
    ]);
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
      collectCategories: async () => completeCategories(),
      executeCommand: async () => ({ exitCode: 0, stdout: 'Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total' }),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('did not emit a valid G10a environment proof');
    expect(writes).toHaveLength(1);
    expect(writes[0].results.status).toBe('FAIL');
    expect(writes[0].results.environment).toBeNull();
  });

  test.each([
    ['missing test total', 'Test Suites: 1 passed, 1 total', 1, null],
    ['malformed suite total', 'Test Suites: 1 passed, one total\nTests: 1 passed, 1 total', null, 1],
    ['zero totals', 'Test Suites: 0 total\nTests: 0 total', null, null],
  ])('treats zero-exit %s as a failed phase and writes a closed artifact', async (_caseName, stdout, suiteCount, testCount) => {
    const runner = await loadRunner();
    const calls: string[] = [];
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-missing-counts', now: sequenceNow(0, 1),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => { calls.push(identifier); return { exitCode: 0, stdout }; },
      collectCategories: async () => incompleteCategories(),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('test:g10a:unit did not emit valid Jest total counts');
    expect(calls).toEqual(['test:g10a:unit']);
    expect(writes).toHaveLength(1);
    expect(writes[0].results).toMatchObject({ status: 'FAIL', categoryEvidenceStatus: 'INCOMPLETE' });
    expect(writes[0].results.phases).toEqual([
      { identifier: 'test:g10a:unit', exitCode: 0, durationMs: 1, suiteCount, testCount },
    ]);
    expect(Object.values(writes[0].categories).every((category: any) => category.status === 'NOT_COLLECTED')).toBe(true);
  });

  test('preserves a valid integration environment proof but fails closed when its Jest totals are incomplete', async () => {
    const runner = await loadRunner();
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-integration-missing-counts', now: sequenceNow(0, 1, 1, 2, 2, 3),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => ({
        exitCode: 0,
        stdout: identifier === 'test:g10a:integration'
          ? `Test Suites: 1 passed, 1 total\n${environmentProof}`
          : 'Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total',
      }),
      collectCategories: async () => incompleteCategories(),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('test:g10a:integration did not emit valid Jest total counts');
    expect(writes).toHaveLength(1);
    expect(writes[0].results).toMatchObject({ status: 'FAIL', categoryEvidenceStatus: 'INCOMPLETE', environment: JSON.parse(environmentProof.slice('G10A_ENVIRONMENT_PROOF='.length)) });
    expect(writes[0].results.phases).toEqual([
      { identifier: 'test:g10a:unit', exitCode: 0, durationMs: 1, suiteCount: 1, testCount: 1 },
      { identifier: 'test:g10a:socket', exitCode: 0, durationMs: 1, suiteCount: 1, testCount: 1 },
      { identifier: 'test:g10a:integration', exitCode: 0, durationMs: 1, suiteCount: 1, testCount: null },
    ]);
  });

  test('writes closed failed phase evidence when a command runner throws', async () => {
    const runner = await loadRunner();
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-command-throws', now: sequenceNow(0, 1),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async () => { throw new Error('raw command failure must not escape'); },
      collectCategories: async () => incompleteCategories(),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('test:g10a:unit failed with exit 1');
    expect(writes).toHaveLength(1);
    expect(writes[0].results).toMatchObject({ status: 'FAIL', categoryEvidenceStatus: 'INCOMPLETE' });
    expect(writes[0].results.phases).toEqual([
      { identifier: 'test:g10a:unit', exitCode: 1, durationMs: 1, suiteCount: null, testCount: null },
    ]);
    expect(JSON.stringify(writes[0])).not.toContain('raw command failure');
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

  test('writes explicit incomplete category skeletons and does not call them successful evidence', async () => {
    const runner = await loadRunner();
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-incomplete', now: sequenceNow(0, 1, 1, 2, 2, 3),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => ({ exitCode: 0, stdout: `Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total${identifier === 'test:g10a:integration' ? `\n${environmentProof}` : ''}` }),
      collectCategories: async () => incompleteCategories(),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('categories are incomplete');
    expect(writes).toHaveLength(1);
    expect(writes[0].results.status).toBe('INCOMPLETE');
    expect(writes[0].results.categoryEvidenceStatus).toBe('INCOMPLETE');
    expect(writes[0].categories.secret.cases).toEqual([]);
  });

  test('still hands closed incomplete artifacts to the writer when category collection and cleanup inspection are themselves malformed', async () => {
    const runner = await loadRunner();
    const writes: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-finalization-seam', now: sequenceNow(0, 1, 1, 2, 2, 3),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => ({ exitCode: 0, stdout: `Test Suites: 1 passed, 1 total\nTests:       1 passed, 1 total${identifier === 'test:g10a:integration' ? `\n${environmentProof}` : ''}` }),
      // The seam simulates a collector bug, rather than merely an ordinary
      // NOT_COLLECTED response. The runner must not throw before write.
      collectCategories: async () => { throw new Error('collector raw secret must not escape'); },
      // A malformed cleanup probe previously made createG10aEvidenceCleanup
      // throw before the artifact writer was reached.
      inspectDocker: async () => ({ dockerContainersAbsent: true }),
      writeArtifacts: async (input: any) => { writes.push(input); return {}; },
    })).rejects.toThrow('G10a evidence category collection failed');
    expect(writes).toHaveLength(1);
    expect(writes[0].results).toMatchObject({ status: 'INCOMPLETE', categoryEvidenceStatus: 'INCOMPLETE' });
    expect(writes[0].cleanup).toMatchObject({ status: 'FAIL', dockerContainersAbsent: false, composeContainersAbsent: false, composeNetworksAbsent: false });
    expect(Object.values(writes[0].categories).every((category: any) => category.status === 'NOT_COLLECTED')).toBe(true);
    expect(JSON.stringify(writes[0])).not.toContain('collector raw secret');
  });

  test('keeps a collected category failure distinct from incomplete collection and beneath a phase failure', async () => {
    const runner = await loadRunner();
    const categoryWrites: any[] = [];
    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-category-failed', now: sequenceNow(0, 1, 1, 2, 2, 3),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async (identifier: string) => ({ exitCode: 0, stdout: `Test Suites: 1 passed, 1 total\nTests: 1 passed, 1 total${identifier === 'test:g10a:integration' ? `\n${environmentProof}` : ''}` }),
      collectCategories: async () => failedCategories(),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }),
      writeArtifacts: async (input: any) => { categoryWrites.push(input); return {}; },
    })).rejects.toThrow('category failed');
    expect(categoryWrites[0].results).toMatchObject({ status: 'FAILED', categoryEvidenceStatus: 'FAILED' });

    await expect(runner.runG10aEvidence({
      root: '/safe/workspace', outputRoot: '/safe/private-output', runId: 'g10a-20261001-phase-over-category', now: sequenceNow(0, 1),
      assertOutputRoot: async () => '/safe/private-output', assertClean: async () => undefined, collectProvenance: async () => provenance(),
      executeCommand: async () => ({ exitCode: 9, stdout: '' }), collectCategories: async () => failedCategories(),
      inspectDocker: async () => ({ dockerContainersAbsent: true, composeContainersAbsent: true, composeNetworksAbsent: true }), writeArtifacts: async () => ({}),
    })).rejects.toThrow('test:g10a:unit failed with exit 9');
  });

  test('parses only Jest total suite/test counts and rejects unstructured text', async () => {
    const runner = await loadRunner();
    expect(runner.parseJestCounts('\u001b[32mTest Suites:\u001b[0m 2 passed, 2 total\nTests:       15 passed, 15 total')).toEqual({ suiteCount: 2, testCount: 15 });
    expect(runner.parseJestCounts('arbitrary request body token=not-a-summary')).toEqual({ suiteCount: null, testCount: null });
    expect(runner.parseJestCounts('Test Suites: 1 passed, one total\nTests: 1 passed, 1 total')).toEqual({ suiteCount: null, testCount: 1 });
    expect(runner.parseJestCounts('Test Suites: 0 total\nTests: 0 total')).toEqual({ suiteCount: null, testCount: null });
  });
});

async function loadRunner(): Promise<Runner> { return await import(moduleUrl) as Runner; }
function sequenceNow(...values: number[]) { let index = 0; return () => values[index++] ?? values.at(-1) ?? 0; }
function provenance() { return { format: 'passhub.g10a.evidence.v1', sourceCommit: 'a'.repeat(40), hashes: {}, toolchain: {} }; }
function completeCategories() {
  return Object.freeze({
    socket: category('socket'), rotation: category('rotation'), control: category('control'), mongo: category('mongo'), secret: category('secret'),
  });
}
function incompleteCategories() {
  return Object.freeze({
    socket: incomplete('socket'), rotation: incomplete('rotation'), control: incomplete('control'), mongo: incomplete('mongo'), secret: incomplete('secret'),
  });
}
function category(category: string) {
  const cases = [{ id: categoryCaseCode(category), status: 'PASS' }];
  return { format: 'passhub.g10a.evidence-category.v1', version: 'g10a-category-summary-v1', category, status: 'PASS', cases, passedCaseCount: 1, failedCaseCount: 0, summaryHash: require('node:crypto').createHash('sha256').update(JSON.stringify(['g10a-category-summary-v1', category, cases.map((entry) => [entry.id, entry.status])]), 'utf8').digest('hex') };
}
function incomplete(category: string) {
  return { format: 'passhub.g10a.evidence-category.v1', version: 'g10a-category-summary-v1', category, status: 'NOT_COLLECTED', cases: [], passedCaseCount: 0, failedCaseCount: 0, summaryHash: null };
}
function failedCategories() {
  return Object.freeze({
    socket: category('socket'), rotation: category('rotation'), control: category('control'), mongo: category('mongo'),
    secret: failed('secret'),
  });
}
function failed(category: string) {
  const cases = [{ id: categoryCaseCode(category), status: 'FAIL' }];
  return { format: 'passhub.g10a.evidence-category.v1', version: 'g10a-category-summary-v1', category, status: 'FAIL', cases, passedCaseCount: 0, failedCaseCount: 1, summaryHash: require('node:crypto').createHash('sha256').update(JSON.stringify(['g10a-category-summary-v1', category, cases.map((entry) => [entry.id, entry.status])]), 'utf8').digest('hex') };
}
function categoryCaseCode(category: string) {
  return ({ socket: 'G10A_SOCKET_PROTOCOL', rotation: 'G10A_ROTATION_ARCHIVE', control: 'G10A_CONTROL_DRAIN', mongo: 'G10A_MONGO_DRIVER_MONITORING', secret: 'G10A_SECRET_LOG_REDACTION' } as Record<string, string>)[category] ?? 'G10A_SOCKET_PROTOCOL';
}
