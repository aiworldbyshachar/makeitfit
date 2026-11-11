// Splitting into several files, each under the limit, when one file can't fit readably.
// Pages stay in order; each part is a run of consecutive pages.

/**
 * How many parts to offer: the fewest whose readable floor fits, with room to spare.
 * `floorTotal` is the smallest readable size of the whole set; each part's share of it stays under
 * `fill` of the limit, so every part can still be a little better than the floor. Fewer files beat
 * higher quality here: upload forms often take only a few files.
 */
export function partsNeeded(floorTotal, limit, fill = 0.8) {
  return Math.max(2, Math.ceil(floorTotal / (limit * fill)));
}

/**
 * Cuts `weights` (estimated bytes per page, in order) into `count` runs of consecutive pages with
 * totals as even as possible. Returns [[start, end)...] (end exclusive). Never returns an empty run.
 */
export function balancedRuns(weights, count) {
  const n = weights.length;
  count = Math.min(count, n);
  const total = weights.reduce((s, w) => s + w, 0);
  const runs = [];
  let start = 0;
  let acc = 0;
  for (let part = 1; part < count; part++) {
    const target = (total * part) / count;
    let end = start + 1;
    acc += weights[start];
    // Leave at least one page for each remaining part.
    while (end < n - (count - part) && Math.abs(acc + weights[end] - target) <= Math.abs(acc - target)) {
      acc += weights[end];
      end++;
    }
    runs.push([start, end]);
    start = end;
  }
  runs.push([start, n]);
  return runs;
}

/**
 * Greedy packing of known sizes (bytes per page at a fixed setting) into the fewest runs whose totals,
 * plus `overhead(pagesInRun)`, stay within `capacity`. Returns runs or null if one page alone is too big.
 */
export function packRuns(sizes, capacity, overhead = () => 0) {
  const runs = [];
  let start = 0;
  let acc = 0;
  for (let i = 0; i < sizes.length; i++) {
    const count = i - start + 1;
    if (acc + sizes[i] + overhead(count) <= capacity) {
      acc += sizes[i];
      continue;
    }
    if (count === 1) return null;
    runs.push([start, i]);
    start = i;
    acc = sizes[i];
    if (acc + overhead(1) > capacity) return null;
  }
  if (sizes.length) runs.push([start, sizes.length]);
  return runs;
}
