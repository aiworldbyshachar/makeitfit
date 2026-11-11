// The size search: find the best quality that still fits, for a set of images that share one setting
// (every photo in a PDF, every image inside a PDF, or every rendered page).
//
// A setting is a ladder step (a long side in pixels for photos, a DPI for rendered pages) plus a JPEG
// quality. Larger steps are preferred while their quality stays good; the last step is the readability
// floor. To stay fast and inside a phone's memory, it estimates from a few sample items first, then
// encodes every item once at three nearby qualities, and corrects by mixing those levels.

export const PHOTO_STEPS = [3000, 2400, 2000, 1600, 1400, 1200]; // long side in px; 1200 = floor
export const PAGE_STEPS = [200, 170, 150, 130, 115, 100]; // DPI; 100 = floor
export const Q = { max: 0.92, good: 0.72, min: 0.5 };
const LEVEL_GAP = 0.07; // the full pass also encodes q - 0.07 and q - 0.14 for the correction
const SEARCH_ROUNDS = 4;

const round2 = (q) => Math.round(q * 100) / 100;

/**
 * items:  [{ pixelsAt(step) -> number, open(step, { probe }) -> Promise<raster>, close?() }]
 *         open() returns a raster already scaled for that step; the fitter releases it. `probe` is true
 *         while sampling, so an item may keep an expensive source (a rendered page) for the next steps.
 * codec:  { encodeJpeg(raster, quality) -> Promise<Uint8Array>, release(raster) }
 * opts:   { steps, samples = 3, onProgress({ phase, done, total }) }
 */
export class SetFitter {
  constructor(items, codec, { steps = PHOTO_STEPS, samples = 3, onProgress = () => {} } = {}) {
    this.items = items;
    this.codec = codec;
    this.steps = steps;
    this.onProgress = onProgress;
    const n = items.length;
    const count = Math.min(samples, n);
    // Evenly spaced samples (always all items when there are only a few).
    this.sampleIdx = [...new Set(Array.from({ length: count }, (_, i) => Math.floor((i * n) / count)))];
    this.allSampled = this.sampleIdx.length === n;
    this.cache = new Map(); // `${item}|${step}|${q}` -> { bytes, width, height }
    this.rasters = new Map(); // `${item}|${step}` -> raster kept open while the search probes that step
    this.encodes = 0;
  }

  key(i, step, q) {
    return `${i}|${step}|${round2(q)}`;
  }

  /** Releases the sample rasters kept open (all of them, or all but those of `keepStep`). */
  releaseRasters(keepStep = null) {
    for (const [k, r] of this.rasters) {
      if (keepStep !== null && k.endsWith(`|${keepStep}`)) continue;
      this.codec.release(r);
      this.rasters.delete(k);
    }
  }

  /** Releases everything: kept rasters and the items' own caches (e.g. a decoded photo). */
  dispose() {
    this.releaseRasters();
    for (const it of this.items) it.close?.();
  }

  /**
   * Encodes the given items at one step and the given qualities, opening each raster once.
   * `keep` keeps the rasters open for more probes at the same step (used for the samples).
   */
  async encodeItems(indices, step, qualities, phase, keep = false) {
    let done = 0;
    for (const i of indices) {
      const missing = qualities.filter((q) => !this.cache.has(this.key(i, step, q)));
      if (missing.length) {
        const rk = `${i}|${step}`;
        let raster = this.rasters.get(rk);
        const owned = !raster;
        if (!raster) raster = await this.items[i].open(step, { probe: keep });
        if (keep && owned) this.rasters.set(rk, raster);
        try {
          for (const q of missing) {
            const bytes = await this.codec.encodeJpeg(raster, round2(q));
            this.encodes++;
            this.cache.set(this.key(i, step, q), { bytes, width: raster.width, height: raster.height, quality: round2(q) });
          }
        } finally {
          if (!keep && owned) this.codec.release(raster);
        }
      }
      this.onProgress({ phase, done: ++done, total: indices.length });
    }
  }

  /** Estimated total bytes of every item at (step, q), from the samples' bytes per pixel. */
  async estimate(step, q) {
    this.releaseRasters(step);
    await this.encodeItems(this.sampleIdx, step, [q], 'estimate', true);
    if (this.allSampled) {
      return this.sampleIdx.reduce((s, i) => s + this.cache.get(this.key(i, step, q)).bytes.length, 0);
    }
    let sampleBytes = 0;
    let samplePixels = 0;
    for (const i of this.sampleIdx) {
      sampleBytes += this.cache.get(this.key(i, step, q)).bytes.length;
      samplePixels += this.items[i].pixelsAt(step);
    }
    const bpp = sampleBytes / samplePixels;
    let total = 0;
    for (let i = 0; i < this.items.length; i++) total += this.items[i].pixelsAt(step) * bpp;
    return Math.ceil(total);
  }

  /**
   * Chooses the setting for a budget: the largest step whose best quality is at least Q.good, else the
   * floor step at the best quality >= Q.min. Returns { step, quality, estimate } or null if even the
   * floor at Q.min is over the budget.
   */
  async choose(budget) {
    for (let s = 0; s < this.steps.length; s++) {
      const step = this.steps[s];
      const floor = s === this.steps.length - 1;
      const low = floor ? Q.min : Q.good;
      const lowEst = await this.estimate(step, low);
      if (lowEst > budget) continue;
      const maxEst = await this.estimate(step, Q.max);
      if (maxEst <= budget) return { step, quality: Q.max, estimate: maxEst };
      let lo = low; // fits
      let loEst = lowEst;
      let hi = Q.max; // doesn't fit
      for (let r = 0; r < SEARCH_ROUNDS && hi - lo > 0.015; r++) {
        const mid = round2((lo + hi) / 2);
        if (mid <= lo || mid >= hi) break;
        const est = await this.estimate(step, mid);
        if (est <= budget) {
          lo = mid;
          loEst = est;
        } else {
          hi = mid;
        }
      }
      return { step, quality: lo, estimate: loEst };
    }
    return null;
  }

  /** The smallest the set can be while still readable (the floor at Q.min), estimated. */
  async floorEstimate() {
    return this.estimate(this.steps[this.steps.length - 1], Q.min);
  }

  /**
   * Encodes every item at the chosen setting (and two lower levels unless the estimate is exact).
   * Returns per item a list of candidates, best first.
   */
  async fullPass({ step, quality }) {
    const floorQ = step === this.steps[this.steps.length - 1] ? Q.min : Math.min(Q.good, quality);
    // When every item was sampled the estimate is exact, so one lower level is enough for the
    // container's overhead; otherwise two, to absorb estimate errors.
    const wanted = this.allSampled ? [quality, quality - LEVEL_GAP] : [quality, quality - LEVEL_GAP, quality - 2 * LEVEL_GAP];
    const levels = wanted.map(round2).filter((q, i) => i === 0 || q >= floorQ - 1e-9);
    const all = this.items.map((_, i) => i);
    await this.encodeItems(all, step, levels, 'encode');
    this.releaseRasters();
    return all.map((i) => levels.map((q) => this.cache.get(this.key(i, step, q))));
  }
}

/**
 * Picks one candidate per item so the total fits the budget, keeping quality as high as possible:
 * everyone starts at their best; while over budget, the item that saves the most moves down a level.
 * Returns { picks: [candidate], total } or null when even the lowest levels are over.
 */
export function pickMix(candidates, budget) {
  const level = candidates.map(() => 0);
  let total = candidates.reduce((s, c) => s + c[0].bytes.length, 0);
  while (total > budget) {
    let best = -1;
    let bestSave = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (level[i] + 1 >= c.length) continue;
      const save = c[level[i]].bytes.length - c[level[i] + 1].bytes.length;
      if (save > bestSave) {
        bestSave = save;
        best = i;
      }
    }
    if (best < 0) return null;
    level[best]++;
    total -= bestSave;
  }
  return { picks: candidates.map((c, i) => c[level[i]]), total };
}

/**
 * Runs the whole search for a budget: choose -> full pass -> mix; if the estimate was too optimistic,
 * corrects once with a lower setting. Returns { ok: true, picks, total, setting } or
 * { ok: false, floor } (floor = estimated smallest readable total).
 */
export async function fitSet(fitter, budget) {
  let setting = await fitter.choose(budget);
  if (!setting) return { ok: false, floor: await fitter.floorEstimate() };
  let candidates = await fitter.fullPass(setting);
  let mix = pickMix(candidates, budget);
  if (!mix) {
    // Correct once: aim lower by the measured overshoot.
    const lowest = candidates.reduce((s, c) => s + c[c.length - 1].bytes.length, 0);
    const corrected = await fitter.choose(Math.floor((budget * budget) / lowest));
    if (!corrected) return { ok: false, floor: await fitter.floorEstimate() };
    setting = corrected;
    candidates = await fitter.fullPass(setting);
    mix = pickMix(candidates, budget);
    if (!mix) return { ok: false, floor: await fitter.floorEstimate() };
  }
  return { ok: true, picks: mix.picks, total: mix.total, setting, candidates };
}
