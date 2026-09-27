import assert from 'node:assert/strict';
import process from 'node:process';
import {
  createG09bDeterministicFixture,
  createG09bFixtureManifest,
  hashFixture,
} from '../dist/test/perf/g09b-deterministic-fixture.js';

function snapshot() {
  const started = process.hrtime.bigint();
  const before = process.memoryUsage().heapUsed;
  const fixture = createG09bDeterministicFixture();
  const manifest = createG09bFixtureManifest(fixture);
  const after = process.memoryUsage().heapUsed;
  return {
    fixtureHash: manifest.fixtureHash,
    rehashed: hashFixture(fixture),
    counts: manifest.counts,
    cases: manifest.cases,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    heapDeltaBytes: after - before,
  };
}

const first = snapshot();
const second = snapshot();
assert.equal(first.fixtureHash, first.rehashed);
assert.equal(second.fixtureHash, second.rehashed);
assert.equal(first.fixtureHash, second.fixtureHash);
assert.deepEqual(first.counts, second.counts);
assert.deepEqual(first.cases, second.cases);

console.log(JSON.stringify({
  seed: 'passhub-g09b-v1-20260927',
  deterministic: true,
  fixtureHash: first.fixtureHash,
  counts: first.counts,
  cases: first.cases.map((item) => ({
    id: item.id,
    expectedMatchCount: item.expectedMatchCount,
    selectivity: item.selectivity,
    first20Ids: item.first20Ids,
    firstFetch21Ids: item.firstFetch21Ids,
    after: item.after,
    next20Ids: item.next20Ids,
    nextFetch21Ids: item.nextFetch21Ids,
    nextPage: item.nextPage,
    fetch21Expected: item.fetch21Expected,
  })),
  runs: [
    { elapsedMs: first.elapsedMs, heapDeltaBytes: first.heapDeltaBytes },
    { elapsedMs: second.elapsedMs, heapDeltaBytes: second.heapDeltaBytes },
  ],
}, null, 2));
