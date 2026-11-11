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

/**
 * What to offer when step A (the text kept) can't reach the limit. Never offers a way that ends bigger
 * than another one.
 *   floorA: the smallest size with the text kept (Infinity when step A can't work on the file)
 *   floorB: the smallest size with the pages as images (estimated; Infinity when they can't be rendered)
 * Returns { action, parts?, maxParts?, smallest }:
 *   'ask'          one file is possible with the pages as images - ask first (the user may split instead)
 *   'split-text'   split keeping the text, into `parts` files (tried up to `maxParts`)
 *   'split-images' split with the pages as images, into `parts` files
 *   'none'         neither way can work
 */
export function chooseAfterStepA({ floorA, floorB, limit }) {
  const smallest = Math.min(floorA, floorB);
  if (floorB <= limit) return { action: 'ask', smallest };
  const partsB = Number.isFinite(floorB) ? partsNeeded(floorB, limit) : Infinity;
  if (Number.isFinite(floorA)) {
    // Start from the fewest parts that could hold it; the split adds a part when one comes out too big.
    const partsA = Math.max(2, Math.ceil(floorA / limit));
    if (partsA <= partsB) return { action: 'split-text', parts: partsA, maxParts: Number.isFinite(partsB) ? Math.max(partsB, partsA + 2) : partsA + 3, smallest };
  }
  if (Number.isFinite(partsB)) return { action: 'split-images', parts: partsB, smallest };
  return { action: 'none', smallest: Number.isFinite(smallest) ? smallest : null };
}
