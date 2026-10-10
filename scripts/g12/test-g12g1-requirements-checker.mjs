import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const checker = resolve(root, 'scripts/g12/check-requirements.mjs');

const mutations = [
  {
    name: 'non-numeric G12g subgate token',
    expectedMarker: 'G12C_MAPPING_INVALID',
    mutate(files) {
      files.trace = appendInsideIndex(files.trace, '、G12g-x');
    },
  },
  {
    name: 'out-of-range G12g subgate',
    expectedMarker: 'G12C_MAPPING_INVALID',
    mutate(files) {
      files.trace = appendInsideIndex(files.trace, '、G12g-8');
    },
  },
  {
    name: 'missing G12g subgate',
    expectedMarker: 'G12C_MAPPING_INVALID',
    mutate(files) {
      const [prefix, index, suffix] = splitIndex(files.trace);
      files.trace = `${prefix}${index.replaceAll('G12g-7', 'G12h')}${suffix}`;
    },
  },
  {
    name: 'sequential but non-current STOP pair',
    expectRejected: true,
    expectedMarker: 'G12C_CURRENT_STOP_INCONSISTENT',
    mutate(files) {
      files.business = replaceStopPair(files.business, 4, 5);
      files.plan = replaceStopPair(files.plan, 4, 5);
      files.trace = replaceStopPair(files.trace, 4, 5);
    },
  },
  {
    name: 'later contradictory active STOP after correct business status',
    expectRejected: true,
    expectedMarker: 'G12C_CURRENT_STOP_INCONSISTENT',
    mutate(files) {
      files.business = insertContradictoryBusinessStatus(files.business);
    },
  },
  {
    name: 'terminal G12g completion',
    expectRejected: false,
    mutate(files) {
      files.plan = setEveryG12gPlanRowPass(files.plan);
      files.business = setTerminalStatus(files.business, true);
      files.discuss = setTerminalStatus(files.discuss, true);
      files.plan = setTerminalStatus(files.plan, true);
      files.trace = setTerminalStatus(files.trace, true);
    },
  },
  {
    name: 'wrong terminal status',
    expectRejected: true,
    expectedMarker: 'G12C_CURRENT_STOP_INCONSISTENT',
    mutate(files) {
      files.plan = setEveryG12gPlanRowPass(files.plan);
      files.business = setTerminalStatus(files.business, false);
      files.discuss = setTerminalStatus(files.discuss, false);
      files.plan = setTerminalStatus(files.plan, false);
      files.trace = setTerminalStatus(files.trace, false);
    },
  },
  {
    name: 'contradictory unfinished G12g terminal status',
    expectRejected: true,
    expectedMarker: 'G12C_CURRENT_STOP_INCONSISTENT',
    mutate(files) {
      files.plan = setEveryG12gPlanRowPass(files.plan);
      files.business = setContradictoryTerminalStatus(files.business);
      files.discuss = setContradictoryTerminalStatus(files.discuss);
      files.plan = setContradictoryTerminalStatus(files.plan);
      files.trace = setContradictoryTerminalStatus(files.trace);
    },
  },
  {
    name: 'terminal G12g with G12h already PASS',
    expectRejected: true,
    expectedMarker: 'G12C_G12G_GATE_PLAN_INVALID',
    mutate(files) {
      files.plan = setEveryG12gPlanRowPass(files.plan);
      files.plan = setG12hPlanRowPass(files.plan);
      files.business = setTerminalStatus(files.business, true);
      files.discuss = setTerminalStatus(files.discuss, true);
      files.plan = setTerminalStatus(files.plan, true);
      files.trace = setTerminalStatus(files.trace, true);
    },
  },
  {
    name: 'noncontiguous G12g PASS rows',
    expectRejected: true,
    expectedMarker: 'G12C_G12G_GATE_PLAN_INVALID',
    mutate(files) {
      files.plan = makeG12gPlanNoncontiguous(files.plan);
    },
  },
];

const requested = process.argv[2];
const selectedMutations = requested === undefined
  ? mutations
  : mutations.filter(({ name }) => name === requested);
if (selectedMutations.length === 0) throw new Error('unknown checker mutation case');

const results = [];
for (const mutation of selectedMutations) {
  const workspace = await mkdtemp(join(tmpdir(), 'passhub-g12g1-checker-'));
  try {
    await cp(resolve(root, 'docs'), resolve(workspace, 'docs'), { recursive: true });
    for (const name of ['src', 'test', 'scripts', 'infra', 'dist']) {
      await symlink(resolve(root, name), resolve(workspace, name), 'dir');
    }
    await symlink(resolve(root, 'package.json'), resolve(workspace, 'package.json'), 'file');
    await symlink(resolve(root, '.git'), resolve(workspace, '.git'), 'dir');
    const paths = {
      business: resolve(workspace, 'docs/business-scope.md'),
      discuss: resolve(workspace, 'docs/discuss.md'),
      plan: resolve(workspace, 'docs/implementation-plan.md'),
      trace: resolve(workspace, 'docs/requirements-traceability.md'),
    };
    const files = {
      business: await readFile(paths.business, 'utf8'),
      discuss: await readFile(paths.discuss, 'utf8'),
      plan: await readFile(paths.plan, 'utf8'),
      trace: await readFile(paths.trace, 'utf8'),
    };
    mutation.mutate(files);
    await Promise.all([
      writeFile(paths.business, files.business),
      writeFile(paths.discuss, files.discuss),
      writeFile(paths.plan, files.plan),
      writeFile(paths.trace, files.trace),
    ]);
    let rejected = false;
    let output = '';
    try {
      const completed = await execFileAsync(process.execPath, [checker], {
        cwd: workspace,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      output = `${completed.stdout}${completed.stderr}`;
    } catch (error) {
      rejected = true;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    if (mutation.expectRejected !== false) {
      if (!rejected || !output.includes(mutation.expectedMarker)) {
        throw new Error(`G12G1_CHECKER_MUTATION_NOT_REJECTED:${mutation.name}:${output.slice(0, 500)}`);
      }
      results.push({ name: mutation.name, outcome: 'REJECTED', marker: mutation.expectedMarker });
    } else {
      if (rejected) {
        throw new Error(`G12G1_CHECKER_TERMINAL_POSITIVE_REJECTED:${mutation.name}:${output.slice(0, 500)}`);
      }
      const result = lastJsonLine(output);
      if (result.status !== 'PASS' || result.completedSubgate !== 'G12g-7' || result.nextSubgate !== null) {
        throw new Error(`G12G1_CHECKER_TERMINAL_RESULT_INVALID:${mutation.name}:${JSON.stringify(result)}`);
      }
      results.push({ name: mutation.name, outcome: 'ACCEPTED', completedSubgate: 'G12g-7', nextSubgate: null });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({
  gate: 'G12g-1-requirements-checker-regression',
  originGate: 'G12g-1',
  status: 'PASS',
  checkerMutationsRejected: results.filter(({ outcome }) => outcome === 'REJECTED').length,
  checkerPositiveCasesAccepted: results.filter(({ outcome }) => outcome === 'ACCEPTED').length,
  mutations: results,
})}\n`);

function splitIndex(text) {
  const marker = '### 10.1 ';
  const next = '### 10.2 ';
  const start = text.indexOf(marker);
  const end = text.indexOf(next, start + marker.length);
  if (start < 0 || end < 0) throw new Error('requirements index section unavailable');
  return [text.slice(0, start), text.slice(start, end), text.slice(end)];
}

function appendInsideIndex(text, suffix) {
  const [prefix, index, tail] = splitIndex(text);
  const mutated = index.replace(/^(\|\s*[A-Z][0-9]{2}\s*\|[^\n]*)$/mu, `$1${suffix}`);
  if (mutated === index) throw new Error('requirements mapping row unavailable');
  return `${prefix}${mutated}${tail}`;
}

function replaceStopPair(text, current, next) {
  const lines = text.split('\n');
  let changed = 0;
  const replaced = lines.map((line) => {
    if (!line.includes('G12g內部') || !/g-[0-7]/u.test(line)) return line;
    changed += 1;
    return line.replace(
      /(G12g內部[^\n]{0,100}?)(g-[0-7])([^\n]{0,100}?(?:下一|next)[^\n]{0,50}?)(g-[0-7])/u,
      (_match, prefix, _oldCurrent, separator) => `${prefix}g-${current}${separator}g-${next}`,
    );
  }).join('\n');
  if (changed === 0) throw new Error('canonical STOP line unavailable');
  return replaced;
}

function insertContradictoryBusinessStatus(text) {
  const lines = text.split('\n');
  const firstActive = lines.findIndex((line) => line.includes('G12g內部'));
  if (firstActive < 0) throw new Error('current business STOP line unavailable');
  const currentLine = lines[firstActive] ?? '';
  const activePair = /G12g內部[^\n]{0,100}?g-([0-7])[^\n]{0,100}?(?:下一|next)[^\n]{0,50}?g-([0-7])/u.exec(currentLine);
  const terminal = /G12g內部\s*已完成\s*g-7\s*[／/]\s*無下一子關/u.test(currentLine);
  if (activePair === null && !terminal) throw new Error('current business STOP line unavailable');
  const current = terminal ? 7 : Number(activePair?.[1]);
  const next = terminal ? null : Number(activePair?.[2]);
  if (!Number.isSafeInteger(current) || (!terminal && next !== current + 1)) {
    throw new Error('current business STOP pair is invalid');
  }
  const contradictoryCurrent = current === 0 ? 1 : current - 1;
  const contradictoryNext = contradictoryCurrent + 1;
  lines.splice(
    firstActive + 1,
    0,
    `- 矛盾狀態fixture：頂層仍停止於G12f／下一頂層G12g，G12g內部停止於g-${contradictoryCurrent}／下一子關g-${contradictoryNext}。`,
  );
  return lines.join('\n');
}

function setEveryG12gPlanRowPass(text) {
  let rows = 0;
  const result = text.replace(/^(\|\s*G12g-[0-7]\s*\|)\s*[^|]*(\|)/gmu, (_line, prefix, suffix) => {
    rows += 1;
    return `${prefix} PASS：terminal mutation fixture ${suffix}`;
  });
  if (rows !== 8) throw new Error(`expected eight G12g plan rows, received ${rows}`);
  return result;
}

function setTerminalStatus(text, valid) {
  const canonical = valid
    ? '頂層已完成G12g／下一合法頂層G12h；G12g內部已完成 g-7／無下一子關。'
    : '頂層已完成G12g／下一合法頂層G12h；G12g內部已完成 g-6／無下一子關。';
  const lines = text.split('\n');
  let changed = 0;
  const result = lines.map((line) => {
    if (!line.includes('G12g內部') || !/g-[0-7]/u.test(line)) return line;
    changed += 1;
    return canonical;
  }).join('\n');
  if (changed === 0) throw new Error('canonical G12g status line unavailable');
  return result;
}

function setContradictoryTerminalStatus(text) {
  const contradictory = '頂層尚未完成G12g／下一合法頂層G12h；G12g內部已完成 g-7／無下一子關。';
  const lines = text.split('\n');
  let changed = 0;
  const result = lines.map((line) => {
    if (!line.includes('G12g內部') || !/g-[0-7]/u.test(line)) return line;
    changed += 1;
    return contradictory;
  }).join('\n');
  if (changed === 0) throw new Error('canonical G12g status line unavailable');
  return result;
}

function makeG12gPlanNoncontiguous(text) {
  const rows = [...text.matchAll(/^(\|\s*G12g-([0-7])\s*\|)\s*([^|]*)(\|)/gmu)];
  if (rows.length !== 8) throw new Error(`expected eight G12g plan rows, received ${rows.length}`);
  const firstPending = rows.findIndex((match) => !/^\s*PASS(?:：|$)/u.test(match[3] ?? ''));
  if (firstPending < 0 || firstPending >= 7) throw new Error('noncontiguous fixture needs a pending row followed by another row');
  const target = `G12g-${firstPending + 1}`;
  return text.replace(
    new RegExp(`^(\\|\\s*${target}\\s*\\|)\\s*[^|]*(\\|)`, 'mu'),
    '$1 PASS：noncontiguous mutation fixture $2',
  );
}

function setG12hPlanRowPass(text) {
  let rows = 0;
  const result = text.replace(/^(\|\s*G12h\s*\|)\s*[^|]*(\|)/gmu, (_line, prefix, suffix) => {
    rows += 1;
    return `${prefix} PASS：premature terminal mutation fixture ${suffix}`;
  });
  if (rows !== 1) throw new Error(`expected one G12h plan row, received ${rows}`);
  return result;
}

function lastJsonLine(output) {
  const candidates = output.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  if (candidates.length === 0) throw new Error('requirements checker emitted no JSON result');
  return JSON.parse(candidates.at(-1));
}
