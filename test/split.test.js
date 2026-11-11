import test from 'node:test';
import assert from 'node:assert/strict';
import { partsNeeded, balancedRuns, packRuns } from '../docs/js/engine/split.js';

test('parts needed: the fewest readable parts, each floor under 80% of the limit', () => {
  assert.equal(partsNeeded(15_000_000, 2_000_000), 10);
  assert.equal(partsNeeded(6_137_861, 3_000_000), 3);
  assert.equal(partsNeeded(2_100_000, 2_000_000), 2);
});

test('balanced runs cover every page once, in order, without empty parts', () => {
  const runs = balancedRuns(Array(300).fill(1), 9);
  assert.equal(runs.length, 9);
  assert.equal(runs[0][0], 0);
  assert.equal(runs.at(-1)[1], 300);
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i][0], runs[i - 1][1]);
  for (const [a, b] of runs) assert.ok(b - a >= 33 && b - a <= 34, `${a}-${b}`);
});

test('balanced runs follow the weights', () => {
  const runs = balancedRuns([10, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 2);
  assert.deepEqual(runs, [[0, 1], [1, 11]]);
  assert.deepEqual(balancedRuns([5, 5], 4), [[0, 1], [1, 2]]);
});

test('pack runs fills each part up to the capacity', () => {
  assert.deepEqual(packRuns([4, 4, 4, 4, 4], 10), [[0, 2], [2, 4], [4, 5]]);
  assert.deepEqual(packRuns([4, 4, 4], 10, (n) => n), [[0, 2], [2, 3]]); // 4 + 4 + 2 = 10 still fits
  assert.deepEqual(packRuns([4, 4, 4], 10, (n) => 2 * n), [[0, 1], [1, 2], [2, 3]]);
  assert.equal(packRuns([4, 11], 10), null);
});

test('after step A: never offer a way that ends bigger', async () => {
  const { chooseAfterStepA } = await import('../docs/js/engine/split.js');
  const MB = 1_000_000;
  // The case found on an iPhone: a 1.6 MB text PDF, 1 MB limit. Step A got it to ~1.25 MB; as images it
  // would be 3.16 MB. The answer is two files with the text kept - not four image files.
  const user = chooseAfterStepA({ floorA: 1.25 * MB, floorB: 3.16 * MB, limit: 1 * MB });
  assert.equal(user.action, 'split-text');
  assert.equal(user.parts, 2);
  assert.equal(user.smallest, 1.25 * MB);
  // Images make one file that fits: ask first.
  assert.equal(chooseAfterStepA({ floorA: 12 * MB, floorB: 2.6 * MB, limit: 3 * MB }).action, 'ask');
  // Images need far fewer files than keeping the text: offer the image split.
  const scan = chooseAfterStepA({ floorA: 40 * MB, floorB: 6 * MB, limit: 3 * MB });
  assert.deepEqual([scan.action, scan.parts], ['split-images', 3]);
  // Step A can't open it (protected) and images are too big for one file.
  assert.equal(chooseAfterStepA({ floorA: Infinity, floorB: 6 * MB, limit: 3 * MB }).action, 'split-images');
  // Nothing works.
  assert.equal(chooseAfterStepA({ floorA: Infinity, floorB: Infinity, limit: 3 * MB }).action, 'none');
});
