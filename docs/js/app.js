// The page: limit, drop, the file list, Make it fit, and the answers (result, step B question, split offer).
// Everything runs here and in the engine's worker - no request ever leaves this site.
import { createEngine } from './engine/client.js';
import { parseLimit, formatSize, formatLimit, compare } from './engine/sizes.js';
import { sniff, PHOTO_KINDS } from './engine/images.js';
import { openPdfRenderer } from './engine/render-pdfjs.js';
import { createTranslator } from './i18n.js';

const i18n = createTranslator((navigator.language || 'en').slice(0, 2));
const { t } = i18n;
document.documentElement.lang = i18n.code;
document.documentElement.dir = i18n.dir;
i18n.apply(document);
document.title = t('pageTitle');

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const bytesText = (n) => n.toLocaleString(i18n.code);

let engine = createEngine();
let nextId = 1;
const state = {
  items: [], // { id, file, name, size, kind, rotate, pages?, thumb?, protected?, damaged? }
  output: null, // what the user picked; null = automatic
  gen: 0, // bumps on every new run / cancel, so late answers are ignored
  pending: null, // what the step B question or the split offer needs
  outputs: [], // the last result's files: { name, bytes, size, url }
};

// ---------- the limit ----------
const LIMIT_KEY = 'makeitfit.limit';
const storage = {
  get: () => { try { return localStorage.getItem(LIMIT_KEY); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(LIMIT_KEY, v); } catch { /* private mode */ } },
};
const limitInput = $('limit');
limitInput.value = storage.get() || '3';
const limit = () => parseLimit(limitInput.value);

function onLimitChange() {
  const ok = limit();
  const empty = !limitInput.value.trim();
  limitInput.closest('.limit-field').classList.toggle('bad', !ok && !empty);
  $('limit-bad').hidden = !!ok || empty;
  if (ok) storage.set(limitInput.value.trim());
  for (const b of document.querySelectorAll('.chips button')) b.setAttribute('aria-pressed', String(ok === Number(b.dataset.limit) * 1e6));
  resetOutcome();
  renderSummary();
}
limitInput.addEventListener('input', onLimitChange);
limitInput.addEventListener('keydown', (e) => e.key === 'Enter' && state.items.length && run());
for (const b of document.querySelectorAll('.chips button')) {
  b.addEventListener('click', () => {
    limitInput.value = b.dataset.limit;
    onLimitChange();
  });
}

// ---------- adding files ----------
async function addFiles(list) {
  const refused = [];
  for (const file of list) {
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    const kind = sniff(head);
    if (!kind) {
      refused.push(file.name);
      continue;
    }
    const item = { id: nextId++, file, name: file.name, size: file.size, kind, rotate: 0 };
    state.items.push(item);
    loadFacts(item);
  }
  if (refused.length) showError(t('errUnsupported', { n: refused.length, names: refused.join(', ') }));
  else hideError();
  resetOutcome();
  render();
}

/** The thumbnail and the page count, filled in when ready (the size shows at once). */
async function loadFacts(item) {
  try {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    if (item.kind === 'pdf') {
      const r = await openPdfRenderer(bytes);
      try {
        item.pages = r.pageCount;
        const size = await r.pageSize(0);
        const raster = await r.renderPage(0, Math.max(8, Math.round((104 / Math.max(size.width, size.height)) * 72)));
        item.thumb = toVisibleCanvas(raster.src);
      } finally {
        r.close();
      }
    } else {
      const th = await engine.thumb(bytes, item.kind);
      const img = new Image();
      img.alt = '';
      img.src = URL.createObjectURL(new Blob([th.bytes], { type: 'image/jpeg' }));
      item.thumb = img;
    }
  } catch (err) {
    if (err?.name === 'PasswordException') item.protected = true;
    else item.damaged = true;
  }
  renderList();
}

function toVisibleCanvas(src) {
  if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) return src;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

$('pick').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
$('camera').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});

// Drop anywhere on the page; the drop zone lights up.
const drop = $('drop');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  drop.classList.add('over');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) drop.classList.remove('over');
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  drop.classList.remove('over');
  addFiles([...e.dataTransfer.files]);
});

// ---------- the list ----------
const ICONS = {
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  remove: '<path d="M6 6l12 12M18 6L6 18"/>',
};
function iconButton(kind, label, onClick, disabled = false) {
  const b = el('button');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

let dragId = null;
function renderList() {
  const list = $('files');
  list.replaceChildren();
  state.items.forEach((item, index) => {
    const li = el('li', 'file');
    li.draggable = true;
    li.dataset.id = item.id;

    const thumb = el('div', 'thumb');
    if (item.thumb) {
      item.thumb.style.transform = item.rotate ? `rotate(${item.rotate}deg)` : '';
      thumb.append(item.thumb);
    }
    const text = el('div', 'file-text');
    const name = el('p', 'file-name', item.name);
    name.title = item.name;
    const meta = el('p', 'file-meta');
    meta.title = t('resultExact', { bytes: bytesText(item.size) });
    const bits = [formatSize(item.size, { round: 'nearest' })];
    if (item.kind === 'pdf') bits.push(item.pages ? t('pages', { n: item.pages }) : item.protected || item.damaged ? '' : t('reading'));
    meta.textContent = bits.filter(Boolean).join(' · ');
    if (item.protected || item.damaged) {
      meta.append(' · ', el('span', 'flag', t(item.protected ? 'protectedBadge' : 'damagedBadge')));
    }
    text.append(name, meta);

    const actions = el('div', 'row-actions');
    const move = (d) => () => {
      const j = index + d;
      [state.items[index], state.items[j]] = [state.items[j], state.items[index]];
      resetOutcome();
      render();
    };
    actions.append(
      iconButton('up', t('moveUp'), move(-1), index === 0),
      iconButton('down', t('moveDown'), move(1), index === state.items.length - 1),
      iconButton('rotate', t('rotate'), () => {
        item.rotate = (item.rotate + 90) % 360;
        resetOutcome();
        render();
      }),
      iconButton('remove', t('remove'), () => {
        state.items.splice(state.items.indexOf(item), 1);
        resetOutcome();
        render();
      }),
    );
    li.append(thumb, text, actions);

    // Drag to reorder (desktop); the arrows do the same on phones.
    li.addEventListener('dragstart', (e) => {
      dragId = item.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      dragId = null;
      li.classList.remove('dragging');
      list.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    });
    li.addEventListener('dragover', (e) => {
      if (dragId === null || dragId === item.id) return;
      e.preventDefault();
      li.classList.add('drop-before');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before'));
    li.addEventListener('drop', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      e.stopPropagation();
      const from = state.items.findIndex((x) => x.id === dragId);
      const [moved] = state.items.splice(from, 1);
      state.items.splice(state.items.indexOf(item), 0, moved);
      resetOutcome();
      render();
    });
    list.append(li);
  });
}

// ---------- totals and the output choice ----------
function outputsAllowed() {
  const photos = state.items.filter((i) => PHOTO_KINDS.has(i.kind)).length;
  return {
    pdf: true,
    separate: state.items.length > 1,
    jpg: state.items.length === 1 && photos === 1,
  };
}
function chosenOutput() {
  const allowed = outputsAllowed();
  if (state.output && allowed[state.output]) return state.output;
  return allowed.jpg ? 'jpg' : 'pdf';
}

function renderSummary() {
  const has = state.items.length > 0;
  $('summary').hidden = !has || isBusyOrShowing();
  drop.classList.toggle('compact', has);
  if (!has) return;
  const total = state.items.reduce((s, i) => s + i.size, 0);
  $('total').textContent = t('total', { size: formatSize(total, { round: 'nearest' }) });
  $('total').title = t('resultExact', { bytes: bytesText(total) });
  const lim = limit();
  const cmp = $('compare');
  if (lim) {
    const c = compare(total, lim);
    cmp.className = c.fits ? 'fits' : 'over';
    cmp.textContent = c.fits ? `- ${t('fitsAlready')}` : `- ${t('timesOver', { x: c.ratioText })}`;
  } else cmp.textContent = '';
  const allowed = outputsAllowed();
  const chosen = chosenOutput();
  for (const b of document.querySelectorAll('#output button')) {
    b.hidden = !allowed[b.dataset.out];
    b.setAttribute('aria-checked', String(b.dataset.out === chosen));
  }
  $('jpg-note').hidden = !(state.output === 'jpg' && !allowed.jpg);
  $('go').disabled = !lim;
}
for (const b of document.querySelectorAll('#output button')) {
  b.addEventListener('click', () => {
    state.output = b.dataset.out;
    resetOutcome();
    renderSummary();
  });
}

function render() {
  renderList();
  renderSummary();
}

// ---------- panels ----------
const PANELS = ['working', 'ask', 'cant', 'result'];
function showPanel(name) {
  for (const p of PANELS) $(p).hidden = p !== name;
  drop.hidden = !!name;
  renderSummary();
}
const isBusyOrShowing = () => PANELS.some((p) => !$(p).hidden);
function resetOutcome() {
  if (!$('working').hidden) return; // a run is going; Cancel ends it
  for (const p of ['ask', 'cant', 'result']) $(p).hidden = true;
  drop.hidden = false;
  state.pending = null;
}
function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}
function hideError() {
  $('error').hidden = true;
}

const STAGES = { photo: 'stagePhotos', photos: 'stagePhotos', stepA: 'stagePdf', stepB: 'stagePages', split: 'stageSplit', plan: 'stagePlan' };
function progressFor(gen) {
  const bar = $('bar');
  return (p) => {
    if (gen !== state.gen) return;
    const building = p.phase === 'encode' && p.total;
    $('stage').textContent = t(building && (p.stage === 'photo' || p.stage === 'photos') ? 'stageBuild' : STAGES[p.stage] || 'stageRead');
    bar.classList.toggle('busy', !building);
    bar.firstElementChild.style.width = building ? `${Math.round((p.done / p.total) * 100)}%` : '';
  };
}
function startWorking(stageKey) {
  hideError();
  $('stage').textContent = t(stageKey);
  $('bar').classList.add('busy');
  $('bar').firstElementChild.style.width = '';
  showPanel('working');
  return ++state.gen;
}

$('cancel').addEventListener('click', () => {
  state.gen++;
  engine.terminate();
  engine = createEngine();
  showPanel(null);
});

// ---------- making it fit ----------
async function run() {
  const lim = limit();
  if (!lim) return limitInput.focus();
  if (!state.items.length) return;
  const locked = state.items.filter((i) => i.protected).map((i) => i.name);
  if (locked.length) return showError(t('errProtected', { names: locked.join(', ') }));
  const gen = startWorking('stageRead');
  try {
    const files = await Promise.all(state.items.map(async (i) => ({ name: i.name, bytes: new Uint8Array(await i.file.arrayBuffer()), rotate: i.rotate })));
    if (gen !== state.gen) return;
    const r = await engine.fit({ files, limit: lim, output: chosenOutput() }, progressFor(gen));
    if (gen === state.gen) await answer(r, lim, files);
  } catch (err) {
    if (gen === state.gen) failed(err);
  }
}
$('go').addEventListener('click', run);

function failed(err) {
  console.error(err);
  showPanel(null);
  showError(t('errGeneric', { message: err?.message || String(err) }));
}

async function answer(r, lim, files) {
  if (r.status === 'done' || r.status === 'already-fits') return showResult(r, lim);
  if (r.status === 'ask-rasterize') {
    state.pending = { ...r, limit: lim };
    $('ask-body').textContent = t('askBody', { limit: formatLimit(lim) });
    return showPanel('ask');
  }
  if (r.status === 'cannot-fit') {
    state.pending = { ...r, limit: lim, files };
    $('cant-title').textContent = t('cantTitle', { limit: formatLimit(lim) });
    const original = state.items.reduce((s, i) => s + i.size, 0);
    const smallest = r.smallestReadable ? formatSize(r.smallestReadable, { precise: true }) : '';
    const body = [!smallest ? '' : r.smallestReadable >= original * 0.95 ? t('cantAlreadySmall', { size: smallest }) : t('cantBody', { size: smallest })];
    if (r.parts) body.push(t(r.mode === 'stepA' ? 'cantSplitTextBody' : 'cantSplitBody', { n: r.parts, limit: formatLimit(lim) }));
    if (r.parts && r.mode === 'pages') body.push(t('cantPagesNote'));
    $('cant-body').textContent = body.filter(Boolean).join(' ');
    $('cant-split').hidden = !r.parts;
    $('cant-split').textContent = r.parts ? t('cantSplit', { n: r.parts }) : '';
    return showPanel('cant');
  }
  if (r.status === 'unsupported') {
    showPanel(null);
    return showError(t('errUnsupported', { n: r.names.length, names: r.names.join(', ') }));
  }
  if (r.status === 'protected') {
    showPanel(null);
    return showError(t('errProtected', { names: r.names.join(', ') }));
  }
  failed(new Error(r.status));
}

$('ask-yes').addEventListener('click', async () => {
  const p = state.pending;
  const gen = startWorking('stagePages');
  try {
    const r = await engine.rasterize(p.source, p.limit, p.name, progressFor(gen));
    if (gen === state.gen) await answer(r, p.limit);
  } catch (err) {
    if (gen === state.gen) failed(err);
  }
});

$('ask-split').addEventListener('click', () => {
  const p = state.pending;
  const parts = Math.max(2, Math.ceil((p.stepA?.smallestReadable || p.limit * 2) / (p.limit * 0.8)));
  split({ mode: 'stepA', source: p.source, name: p.name, limit: p.limit, parts });
});

$('cant-split').addEventListener('click', () => {
  const p = state.pending;
  if (p.ready) return answer(p.ready, p.limit); // the split keeping the text is already made
  const args = { mode: p.mode, name: p.name || state.items[0]?.name, limit: p.limit, parts: p.parts };
  if (p.mode === 'photos') args.files = p.files.map((f) => ({ name: f.name, bytes: f.bytes.slice(), rotate: f.rotate }));
  else args.source = p.source;
  split(args);
});

$('cant-bigger').addEventListener('click', () => {
  showPanel(null);
  limitInput.focus();
  limitInput.select();
});

async function split(args) {
  const gen = startWorking('stageSplit');
  try {
    const r = await engine.split(args, progressFor(gen));
    if (gen === state.gen) await answer(r, args.limit);
  } catch (err) {
    if (gen === state.gen) failed(err);
  }
}

// ---------- the result ----------
const mimeOf = (name) => (name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

function forget() {
  for (const o of state.outputs) URL.revokeObjectURL(o.url);
  state.outputs = [];
}

async function showResult(r, lim) {
  forget();
  state.outputs = r.outputs.map((o) => ({ ...o, url: URL.createObjectURL(new Blob([o.bytes], { type: mimeOf(o.name) })) }));
  const many = state.outputs.length > 1;
  const first = state.outputs[0];
  const total = state.outputs.reduce((s, o) => s + o.size, 0);

  if (r.status === 'already-fits') $('result-title').textContent = t('resultUnchanged', { limit: formatLimit(lim) });
  else if (many) $('result-title').textContent = t('resultParts', { n: state.outputs.length, limit: formatLimit(lim) });
  else $('result-title').textContent = t('resultFits', { size: formatSize(first.size, { precise: true }), limit: formatLimit(lim) });
  $('result-exact').textContent = many ? '' : t('resultExact', { bytes: bytesText(first.size) });
  $('result-exact').hidden = many;

  const notes = [];
  if (r.details?.textIsImage) notes.push(t('textIsImage'));
  for (const f of r.failed || []) notes.push(t('notFitted', { name: f.name, size: f.smallestReadable ? formatSize(f.smallestReadable, { precise: true }) : '?' }));
  $('result-note').textContent = notes.join(' ');
  $('result-note').hidden = !notes.length;

  const list = $('outputs');
  list.replaceChildren();
  if (many) {
    for (const o of state.outputs) {
      const li = el('li');
      const name = el('span', 'o-name', o.name);
      const range = o.pages ? ` · ${t('resultPartPages', { n: o.pages[1] - o.pages[0] + 1, from: o.pages[0], to: o.pages[1] })}` : '';
      const size = el('span', 'o-size', `${formatSize(o.size, { precise: true })} · ${t('resultExact', { bytes: bytesText(o.size) })}${range}`);
      const dl = el('a', 'btn', t('download'));
      dl.href = o.url;
      dl.download = o.name;
      li.append(name, size, dl);
      list.append(li);
    }
  }
  list.hidden = !many;
  $('download').hidden = many;
  const shareFiles = state.outputs.map((o) => new File([o.bytes], o.name, { type: mimeOf(o.name) }));
  const canShare = !!navigator.canShare?.({ files: shareFiles });
  $('share').hidden = !canShare;
  $('share').textContent = t(many ? 'shareAll' : 'share');
  showPanel('result');
  await renderPreviews(total);
}

/** Small previews: the first pages of a PDF (or the first page of each part), or the JPG itself. */
async function renderPreviews() {
  const box = $('previews');
  box.replaceChildren();
  const gen = state.gen;
  const outs = state.outputs;
  if (outs.length === 1 && !outs[0].name.toLowerCase().endsWith('.pdf')) {
    const img = new Image();
    img.alt = '';
    img.src = outs[0].url;
    box.append(img);
    return;
  }
  const jobs = outs.length > 1 ? outs.slice(0, 4).map((o) => [o, [0]]) : [[outs[0], [0, 1, 2, 3]]];
  for (const [o, pages] of jobs) {
    if (!o.name.toLowerCase().endsWith('.pdf')) continue;
    const r = await openPdfRenderer(o.bytes);
    try {
      for (const i of pages.filter((p) => p < r.pageCount)) {
        if (gen !== state.gen) return;
        const raster = await r.renderPage(i, 36);
        box.append(toVisibleCanvas(raster.src));
      }
      if (outs.length === 1 && r.pageCount > pages.length) box.append(el('span', 'more', t('morePages', { n: r.pageCount - pages.length })));
    } finally {
      r.close();
    }
  }
}

function download(o) {
  const a = el('a');
  a.href = o.url;
  a.download = o.name;
  document.body.append(a);
  a.click();
  a.remove();
}
$('download').addEventListener('click', () => state.outputs[0] && download(state.outputs[0]));
$('share').addEventListener('click', async () => {
  const files = state.outputs.map((o) => new File([o.bytes], o.name, { type: mimeOf(o.name) }));
  try {
    await navigator.share({ files });
  } catch (err) {
    if (err?.name !== 'AbortError') showError(t('errGeneric', { message: err.message }));
  }
});
$('again').addEventListener('click', () => {
  forget();
  state.items = [];
  state.output = null;
  hideError();
  showPanel(null);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------- start ----------
onLimitChange();
render();

// Offline: a service worker keeps every file of the site after the first visit. On the local dev server
// it only runs with ?sw (so edits show at once while working on the page).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || new URLSearchParams(location.search).has('sw'))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
