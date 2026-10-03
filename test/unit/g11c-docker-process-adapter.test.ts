import {
  createG11cDockerProcessAdapter,
  G11cDockerProcessError,
  type G11cCommandResult,
} from '../../src/deployment/internal/g11c-docker-process-adapter.js';

const apiId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const mongoId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const composeFile = '/srv/passhub/infra/g11/compose.yml';

function state(running: boolean, pid: number, health?: string) {
  return JSON.stringify({ Running: running, Pid: pid, Status: running ? 'running' : 'exited', ...(health === undefined ? {} : { Health: { Status: health } }) });
}

function fixture() {
  const calls: readonly (readonly string[])[] = [];
  const mutableCalls = calls as (readonly string[])[];
  const outputs = new Map<string, string[]>();
  outputs.set(apiId, [state(true, 101), state(false, 0)]);
  outputs.set(mongoId, [state(true, 202), state(false, 0), state(true, 303, 'healthy')]);
  const runner = async (_binary: string, args: readonly string[], _timeout: number): Promise<G11cCommandResult> => {
    mutableCalls.push(args);
    if (args.includes('ps')) return { stdout: args.at(-1) === 'api' ? `${apiId}\n` : `${mongoId}\n`, stderr: '' };
    if (args[0] === 'inspect') {
      const id = args.at(-1)!;
      const queue = outputs.get(id);
      if (queue === undefined || queue.length === 0) throw new Error('unexpected inspect');
      return { stdout: `${queue.shift()!}\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { calls: mutableCalls, runner };
}

describe('G11c Docker process lifecycle adapter', () => {
  test('stops and observes API then Mongo, starts Mongo, and waits for healthy PRIMARY', async () => {
    const ctx = fixture();
    const adapter = createG11cDockerProcessAdapter({ project: 'passhub-g11c', composeFile, commandRunner: ctx.runner, pollIntervalMs: 1, observeTimeoutMs: 100 });
    await adapter.requestApiStop();
    await adapter.awaitApiProcessGone();
    await adapter.requestMongoStop();
    await adapter.awaitMongoProcessGone();
    await adapter.awaitMongoPrimary();
    expect(ctx.calls.map((args) => args.slice(0, 5))).toEqual([
      ['compose', '--project-name', 'passhub-g11c', '--file', composeFile],
      ['inspect', '--format={{json .State}}', apiId],
      ['compose', '--project-name', 'passhub-g11c', '--file', composeFile],
      ['inspect', '--format={{json .State}}', apiId],
      ['compose', '--project-name', 'passhub-g11c', '--file', composeFile],
      ['inspect', '--format={{json .State}}', mongoId],
      ['compose', '--project-name', 'passhub-g11c', '--file', composeFile],
      ['inspect', '--format={{json .State}}', mongoId],
      ['compose', '--project-name', 'passhub-g11c', '--file', composeFile],
      ['inspect', '--format={{json .State}}', mongoId],
    ]);
    expect(ctx.calls[2]).toContain('api');
    expect(ctx.calls[6]).toContain('mongo');
    expect(ctx.calls[8]).toContain('start');
  });

  test('a successful stop command is insufficient while the original API process remains running', async () => {
    const ctx = fixture();
    const runner = async (binary: string, args: readonly string[], timeout: number) => {
      const result = await ctx.runner(binary, args, timeout);
      if (args[0] === 'inspect' && args.at(-1) === apiId) return { stdout: `${state(true, 101)}\n`, stderr: '' };
      return result;
    };
    const adapter = createG11cDockerProcessAdapter({ project: 'passhub-g11c', composeFile, commandRunner: runner, pollIntervalMs: 1, observeTimeoutMs: 2 });
    await adapter.requestApiStop();
    await expect(adapter.awaitApiProcessGone()).rejects.toMatchObject({ code: 'API_PROCESS_NOT_GONE' });
  });

  test('fails closed if the same container identity reports a replacement PID', async () => {
    const ctx = fixture();
    const runner = async (binary: string, args: readonly string[], timeout: number) => {
      const result = await ctx.runner(binary, args, timeout);
      if (args[0] === 'inspect' && args.at(-1) === apiId) return { stdout: `${state(true, 999)}\n`, stderr: '' };
      return result;
    };
    const adapter = createG11cDockerProcessAdapter({ project: 'passhub-g11c', composeFile, commandRunner: runner, pollIntervalMs: 1, observeTimeoutMs: 2 });
    await adapter.requestApiStop();
    await expect(adapter.awaitApiProcessGone()).rejects.toMatchObject({ code: 'API_PROCESS_NOT_GONE' });
  });

  test('Mongo stop is a distinct command; lifecycle composition owns API-before-Mongo ordering', async () => {
    const ctx = fixture();
    const adapter = createG11cDockerProcessAdapter({ project: 'passhub-g11c', composeFile, commandRunner: ctx.runner, pollIntervalMs: 1, observeTimeoutMs: 100 });
    await adapter.requestMongoStop();
    expect(ctx.calls.some((args) => args.includes('stop') && args.includes('mongo'))).toBe(true);
  });

  test('rejects malformed container identity instead of guessing a process', async () => {
    const runner = async (): Promise<G11cCommandResult> => ({ stdout: 'not-a-container\n', stderr: '' });
    const adapter = createG11cDockerProcessAdapter({ project: 'passhub-g11c', composeFile, commandRunner: runner });
    await expect(adapter.requestApiStop()).rejects.toBeInstanceOf(G11cDockerProcessError);
  });
});
