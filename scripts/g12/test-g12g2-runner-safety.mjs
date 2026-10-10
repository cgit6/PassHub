import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const runner = resolve(root, 'scripts/g12/test-g12g2-local-runtime.mjs');

await exercise(null);
await exercise('SIGTERM');
await exercise('SIGINT');
process.stdout.write(`${JSON.stringify({
  gate: 'G12g-2-runner-safety',
  status: 'PASS',
  cases: ['NORMAL_SCOPED_CLEANUP', 'SIGTERM_SCOPED_CLEANUP', 'SIGINT_SCOPED_CLEANUP'],
})}\n`);

async function exercise(signal) {
  const directory = await mkdtemp(join(tmpdir(), 'passhub-g12g2-runner-safety-'));
  const bin = join(directory, 'bin');
  const state = join(directory, 'state');
  const log = join(directory, 'commands.jsonl');
  const unrelatedContainer = join(state, 'container-unrelated-do-not-remove');
  const unrelatedCompose = join(state, 'compose-unrelated-do-not-remove');
  let child;
  try {
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(state, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(bin, 'docker'), fakeDockerProgram(), { mode: 0o700 }),
      writeFile(join(bin, 'node'), fakeNodeProgram(), { mode: 0o700 }),
      writeFile(unrelatedContainer, 'keep'),
      writeFile(unrelatedCompose, 'keep'),
    ]);
    await Promise.all([chmod(join(bin, 'docker'), 0o700), chmod(join(bin, 'node'), 0o700)]);

    child = spawn(process.execPath, [runner], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        G12G2_FAKE_STATE_DIR: state,
        G12G2_FAKE_LOG: log,
        G12G2_FAKE_HANG_RUN: signal === null ? '0' : '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const completion = childResult(child);

    if (signal !== null) {
      await waitFor(async () => (await readCommands(log)).some(({ args }) => args[0] === 'run'));
      child.kill(signal);
    }
    const result = await completion;
    const expectedCode = signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 0;
    if (result.code !== expectedCode || result.signal !== null) {
      throw new Error(`G12G2_RUNNER_SAFETY_EXIT_INVALID:${String(result.code)}:${String(result.signal)}:${stderr.join('').slice(0, 300)}`);
    }
    const commands = await readCommands(log);
    const expectedProject = `passhub-g12g2-${child.pid}`;
    const expectedContainer = `${expectedProject}-node-test`;
    const run = commands.find(({ args }) => args[0] === 'run');
    const nameAt = run?.args.indexOf('--name') ?? -1;
    if (nameAt < 0 || run?.args[nameAt + 1] !== expectedContainer) {
      throw new Error('G12G2_RUNNER_SAFETY_CONTAINER_NAME_INVALID');
    }
    if (!commands.some(({ args }) => args[0] === 'rm' && args[1] === '--force' && args[2] === expectedContainer)) {
      throw new Error('G12G2_RUNNER_SAFETY_EXACT_CONTAINER_CLEANUP_MISSING');
    }
    if (!commands.some(({ args }) => args[0] === 'compose'
      && args.includes(expectedProject) && args.includes('down')
      && args.includes('--volumes') && args.includes('--remove-orphans'))) {
      throw new Error('G12G2_RUNNER_SAFETY_COMPOSE_CLEANUP_MISSING');
    }
    if (commands.some(({ args }) => args.includes('prune') || args.includes('unrelated-do-not-remove'))) {
      throw new Error('G12G2_RUNNER_SAFETY_CLEANUP_SCOPE_BROADENED');
    }
    await Promise.all([access(unrelatedContainer), access(unrelatedCompose)]);
    const projectArtifacts = (await readdir(state))
      .filter((name) => name.includes(expectedProject));
    if (projectArtifacts.length !== 0) {
      throw new Error(`G12G2_RUNNER_SAFETY_RESOURCE_LEAK:${projectArtifacts.join('|')}`);
    }
    if (signal !== null && !stderr.join('').includes(`interrupted by ${signal}; scoped cleanup completed`)) {
      throw new Error('G12G2_RUNNER_SAFETY_SIGNAL_COMPLETION_MISSING');
    }
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('G12G2_RUNNER_SAFETY_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readCommands(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return text.trim().length === 0 ? [] : text.trim().split('\n').map((line) => JSON.parse(line));
}

function fakeNodeProgram() {
  return `#!${process.execPath}\nprocess.exitCode = 0;\n`;
}

function fakeDockerProgram() {
  return `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const state = process.env.G12G2_FAKE_STATE_DIR;
const log = process.env.G12G2_FAKE_LOG;
mkdirSync(state, { recursive: true });
appendFileSync(log, JSON.stringify({ args }) + '\\n');
const valueAfter = (flag) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const project = valueAfter('--project-name');
const file = (kind, name) => join(state, kind + '-' + name);
if (args[0] === 'compose' && args.includes('up')) {
  writeFileSync(file('compose', project), 'active');
  process.exit(0);
}
if (args[0] === 'compose' && args.includes('down')) {
  rmSync(file('compose', project), { force: true });
  process.exit(0);
}
if (args[0] === 'run') {
  const name = valueAfter('--name');
  writeFileSync(file('container', name), 'active');
  if (process.env.G12G2_FAKE_HANG_RUN === '1') setInterval(() => undefined, 1000);
  else { rmSync(file('container', name), { force: true }); process.exit(0); }
} else if (args[0] === 'rm' && args[1] === '--force') {
  rmSync(file('container', args[2]), { force: true });
  process.exit(0);
} else if (args[0] === 'ps') {
  const filter = valueAfter('--filter') || '';
  if (filter.startsWith('name=^/')) {
    const name = filter.slice(7, -1);
    if (existsSync(file('container', name))) process.stdout.write(name + '\\n');
  } else if (filter.startsWith('label=com.docker.compose.project=')) {
    const name = filter.split('=').at(-1);
    if (existsSync(file('compose', name))) process.stdout.write(name + '-mongo\\n');
  }
  process.exit(0);
} else if ((args[0] === 'network' || args[0] === 'volume') && args[1] === 'ls') {
  const filter = valueAfter('--filter') || '';
  const name = filter.split('=').at(-1);
  if (existsSync(file('compose', name))) process.stdout.write(name + '-resource\\n');
  process.exit(0);
} else {
  process.exit(0);
}
`;
}
