import test from 'node:test';
import assert from 'node:assert/strict';
import { MB, parseLimit, formatSize, formatLimit, exactBytes, compare, outputName } from '../docs/js/engine/sizes.js';

test('MB means 1,000,000 bytes', () => {
  assert.equal(MB, 1_000_000);
  assert.equal(parseLimit('3'), 3_000_000);
  assert.equal(parseLimit('3 MB'), 3_000_000);
  assert.equal(parseLimit('under 3 MB'), 3_000_000);
  assert.equal(parseLimit('2.5mb'), 2_500_000);
  assert.equal(parseLimit('2,5 MB'), 2_500_000);
  assert.equal(parseLimit('500 KB'), 500_000);
  assert.equal(parseLimit(1.5), 1_500_000);
});

test('bad limits are rejected', () => {
  for (const bad of ['', 'abc', '0', '-3', '3 parsecs', null, undefined, NaN]) assert.equal(parseLimit(bad), null, String(bad));
});

test('sizes round down, so a fitting result never looks like it reached the limit', () => {
  assert.equal(formatSize(2_999_999, { precise: true }), '2.99 MB');
  assert.equal(formatSize(2_940_112, { precise: true }), '2.94 MB');
  assert.equal(formatSize(8_449_000), '8.4 MB');
  assert.equal(formatSize(3_000_000), '3 MB');
  assert.equal(formatSize(940_500), '940 KB');
  assert.equal(formatSize(512), '512 bytes');
  assert.equal(formatSize(3_187_999, { round: 'nearest' }), '3.2 MB');
  assert.equal(formatSize(999_700, { round: 'nearest' }), '1 MB');
  assert.equal(formatSize(999_700), '999 KB');
});

test('limits and exact bytes read naturally', () => {
  assert.equal(formatLimit(3_000_000), '3 MB');
  assert.equal(formatLimit(2_500_000), '2.5 MB');
  assert.equal(formatLimit(500_000), '500 KB');
  assert.equal(exactBytes(2_940_112), '2,940,112 bytes');
});

test('compare says fits / how many times over', () => {
  assert.deepEqual(compare(3_000_000, 3_000_000).fits, true);
  assert.equal(compare(3_000_001, 3_000_000).fits, false);
  const c = compare(8_400_000, 3_000_000);
  assert.equal(c.ratioText, '2.8');
  assert.equal(compare(8_410_000, 3_000_000).ratioText, '2.9'); // rounds up: never understates
});

test('output names', () => {
  assert.equal(outputName('payslip.pdf', 3_000_000, 'pdf'), 'payslip (3 MB).pdf');
  assert.equal(outputName('IMG_0412.HEIC', 2_000_000, 'jpg'), 'IMG_0412 (2 MB).jpg');
  assert.equal(outputName('scan.pdf', 2_000_000, 'pdf', { index: 2, count: 4 }), 'scan (2 MB) - part 2 of 4.pdf');
});
