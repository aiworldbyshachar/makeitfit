import test from 'node:test';
import assert from 'node:assert/strict';
import { SetFitter, PHOTO_STEPS, Q, fitSet, pickMix } from '../docs/js/engine/search.js';
import { scaledPixels } from '../docs/js/engine/images.js';

// A fake codec whose JPEG size is a known function of pixels and quality: bytes = pixels * bpp(q) * k.
const bpp = (q) => 0.15 + 2.4 * q ** 3;
function fakeCodec() {
  return {
    encodes: 0,
    async encodeJpeg(r, q) {
      this.encodes++;
      return new Uint8Array(Math.round(r.width * r.height * bpp(q) * r.k / 8));
    },
    release() {},
  };
}
function photo(width, height, k = 1) {
  return {
    pixelsAt: (side) => scaledPixels(width, height, side),
    open: async (side) => {
      const p = scaledPixels(width, height, side);
      const s = Math.sqrt(p / (width * height));
      return { width: Math.round(width * s), height: Math.round(height * s), k };
    },
  };
}

test('a set that fits at full quality uses the largest step and q max', async () => {
  const codec = fakeCodec();
  const r = await fitSet(new SetFitter([photo(1000, 800)], codec), 10_000_000);
  assert.equal(r.ok, true);
  assert.equal(r.setting.step, PHOTO_STEPS[0]);
  assert.equal(r.setting.quality, Q.max);
});

test('three 12 MP photos into 2 MB: fits, stays readable, uses a good quality', async () => {
  const codec = fakeCodec();
  const items = [photo(4032, 3024), photo(4032, 3024), photo(3024, 4032)];
  const budget = 2_000_000;
  const r = await fitSet(new SetFitter(items, codec), budget);
  assert.equal(r.ok, true);
  assert.ok(r.total <= budget, `${r.total} > ${budget}`);
  assert.ok(r.setting.quality >= Q.good, `quality ${r.setting.quality}`);
  assert.ok(r.total > budget * 0.8, `too pessimistic: ${r.total}`);
  assert.ok(codec.encodes < 40, `${codec.encodes} encodes`);
});

test('estimates from samples for many items, then corrects with the levels', async () => {
  const codec = fakeCodec();
  // 40 pages; the unsampled ones are heavier than the samples, so the estimate is optimistic.
  const items = Array.from({ length: 40 }, (_, i) => photo(2480, 3508, i % 13 === 0 ? 1 : 1.25));
  const budget = 6_000_000;
  const r = await fitSet(new SetFitter(items, codec, { samples: 3 }), budget);
  assert.equal(r.ok, true);
  assert.ok(r.total <= budget, `${r.total} > ${budget}`);
  assert.equal(r.picks.length, 40);
});

test('below the readable floor it says so, with the smallest readable size', async () => {
  const codec = fakeCodec();
  const items = Array.from({ length: 300 }, () => photo(2480, 3508));
  const r = await fitSet(new SetFitter(items, codec), 2_000_000);
  assert.equal(r.ok, false);
  assert.ok(r.floor > 2_000_000);
});

test('pickMix lowers the item that saves the most until the total fits', () => {
  const c = (n) => ({ bytes: new Uint8Array(n) });
  const candidates = [
    [c(100), c(80), c(60)],
    [c(300), c(200), c(150)],
  ];
  const m = pickMix(candidates, 320);
  assert.ok(m.total <= 320);
  assert.equal(m.picks[0].bytes.length, 100); // the small one keeps its quality
  assert.equal(m.picks[1].bytes.length, 200);
  assert.equal(pickMix(candidates, 100), null);
});
