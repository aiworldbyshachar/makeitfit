// Exact sizes and the size rules. "MB" always means 1,000,000 bytes (the strict reading), so a result
// "under 3 MB" also passes sites that check 3 x 1,048,576 bytes.

export const KB = 1000;
export const MB = 1000 * 1000;

const UNITS = { b: 1, byte: 1, bytes: 1, k: KB, kb: KB, m: MB, mb: MB, g: 1000 * MB, gb: 1000 * MB };

/**
 * Reads a typed limit: "3", "3 MB", "2.5mb", "2,5 MB", "500 KB", "under 3 MB". A bare number means MB.
 * Returns whole bytes, or null when the text isn't a size.
 */
export function parseLimit(text) {
  if (typeof text === 'number') return text > 0 && Number.isFinite(text) ? Math.floor(text * MB) : null;
  if (typeof text !== 'string') return null;
  const m = text.trim().toLowerCase().match(/(-?\d+(?:[.,]\d+)?)\s*([a-z]*)/);
  if (!m) return null;
  const value = parseFloat(m[1].replace(',', '.'));
  const unit = m[2] === '' ? MB : UNITS[m[2]];
  if (!unit || !(value > 0)) return null;
  return Math.floor(value * unit);
}

function trim(n, decimals) {
  return n.toFixed(decimals).replace(/\.?0+$/, '');
}

/**
 * Human size: "940 KB", "8.4 MB". With { precise: true } it shows two decimals for MB ("2.94 MB").
 * Results round down ({ round: 'down' }, the default), so a size under a limit is never shown as equal to
 * or above it; the sizes of dropped files round to the nearest ({ round: 'nearest' }).
 */
export function formatSize(bytes, { precise = false, round = 'down' } = {}) {
  const r = round === 'nearest' ? Math.round : Math.floor;
  if (bytes < KB) return `${bytes} bytes`;
  if (bytes < MB && r(bytes / KB) < 1000) return `${r(bytes / KB)} KB`;
  const d = precise ? 2 : 1;
  const f = 10 ** d;
  return `${trim(r((bytes / MB) * f) / f, d)} MB`;
}

/** A limit as typed back to the user: 3000000 -> "3 MB", 2500000 -> "2.5 MB", 500000 -> "500 KB". */
export function formatLimit(bytes) {
  if (bytes < MB) return `${trim(bytes / KB, 1)} KB`;
  return `${trim(bytes / MB, 2)} MB`;
}

/** "2,940,112 bytes" - the exact number, for results and the dev page. */
export function exactBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes`;
}

export function fits(bytes, limit) {
  return bytes <= limit;
}

/** How a size compares with the limit: { fits, ratio, ratioText } - ratioText like "2.8" (times over). */
export function compare(bytes, limit) {
  const ratio = bytes / limit;
  return { fits: bytes <= limit, ratio, ratioText: trim(Math.ceil(ratio * 10) / 10, 1) };
}

/** Output name like "payslip (3 MB).pdf"; parts add " - part 2 of 4". */
export function outputName(original, limit, ext, part = null) {
  const base = (original || 'file').replace(/\.[^.\\/]+$/, '');
  const suffix = part ? ` - part ${part.index} of ${part.count}` : '';
  return `${base} (${formatLimit(limit)})${suffix}.${ext}`;
}
