import { LANGUAGES, AUTO, findLanguage, isRtl } from './languages.js';
import { DEFAULT_ENGINES, buildLanes } from './engines.js';
import { buildSystemPrompt } from './prompt.js';
import { Scheduler } from './scheduler.js';
import { translateBatch } from './live.js';
import { parseFile, splitText, textsOf, exportDataset, download } from './formats.js';
import { setLang, getLang, t, num } from './i18n.js';
import { RELAY, relayReady } from './config.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- storage (every access may throw in private windows) ----------

const STORE = 'targmanich.v1';
const KEY_STORE = 'targmanich.keys';
const read = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; } };
const write = (store, key, value) => { try { store.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };
const forget = (store, key) => { try { store.removeItem(key); } catch { /* storage unavailable */ } };
const local = (() => { try { return window.localStorage; } catch { return null; } })();
const session = (() => { try { return window.sessionStorage; } catch { return null; } })();

const saved = (local && read(local, STORE)) || {};
const TUNABLE = ['enabled', 'model', 'tpm', 'batchSize', 'thinkingLevel'];

const state = {
  src: saved.src || 'hy',
  tgt: saved.tgt || 'en',
  ui: saved.ui || ((navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en'),
  theme: saved.theme || '',
  tab: saved.tab || 'desk',
  remember: Boolean(saved.remember),
  glossary: saved.glossary || '',
  style: saved.style || '',
  engines: DEFAULT_ENGINES.map((d) => {
    const s = (saved.engines || []).find((e) => e.id === d.id) || {};
    const picked = Object.fromEntries(TUNABLE.filter((k) => k in s).map((k) => [k, s[k]]));
    return { ...d, ...picked };
  }),
  keys: (local && read(local, KEY_STORE)) || (session && read(session, KEY_STORE)) || [],
  relay: false, // the shared-key relay answered "ready"
};

function persist() {
  if (!local) return;
  write(local, STORE, {
    src: state.src, tgt: state.tgt, ui: state.ui, theme: state.theme, tab: state.tab,
    remember: state.remember, glossary: state.glossary, style: state.style,
    engines: state.engines.map((e) => Object.fromEntries(['id', ...TUNABLE].map((k) => [k, e[k]]))),
  });
}

function persistKeys() {
  if (state.remember) {
    if (local) write(local, KEY_STORE, state.keys);
    if (session) forget(session, KEY_STORE);
  } else {
    if (session) write(session, KEY_STORE, state.keys);
    if (local) forget(local, KEY_STORE);
  }
}

// ---------- scheduler ----------

const scheduler = new Scheduler();
const applyLanes = () => scheduler.setLanes(buildLanes(state.keys, state.engines, state.relay ? RELAY : null));

function promptsFor(src, tgt) {
  const base = { source: src, target: tgt, glossary: state.glossary, instructions: state.style };
  return {
    silent: buildSystemPrompt({ ...base, speaks: false }),
    speaking: buildSystemPrompt({ ...base, speaks: true }),
  };
}

for (const type of ['result', 'failed', 'jobdone']) {
  scheduler.addEventListener(type, (e) => e.detail.job.on?.[type]?.(e.detail));
}
scheduler.addEventListener('fatal', (e) => {
  deskFatal(e.detail.message);
  batchFatal(e.detail.message);
});

// ---------- languages ----------

const COMMON = ['hy', 'hyw', 'en', 'fr', 'ru', 'es', 'de', 'ar', 'fa', 'ka', 'tr'];

function langName(code) {
  const ui = getLang();
  if (code === 'hy' || code === 'hyw') return t(`lang.${code}`);
  try {
    const name = new Intl.DisplayNames([ui], { type: 'language' }).of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch { /* unknown code */ }
  return findLanguage(code)?.en ?? code;
}

function optionLabel(code) {
  const native = findLanguage(code)?.native;
  const name = langName(code);
  return native && native.toLowerCase() !== name.toLowerCase() ? `${name} — ${native}` : name;
}

let detected = null;

function fillSelect(select, withAuto, value) {
  const collator = new Intl.Collator(getLang());
  const all = LANGUAGES.map(([code]) => code).sort((a, b) => collator.compare(langName(a), langName(b)));
  const group = (label, codes) => {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const code of codes) g.append(new Option(optionLabel(code), code));
    return g;
  };
  select.replaceChildren();
  if (withAuto) {
    const autoLabel = detected ? t('auto.found', { lang: langName(detected) }) : t('auto');
    select.append(new Option(autoLabel, AUTO));
  }
  select.append(group(t('grp.common'), COMMON), group(t('grp.all'), all));
  select.value = value;
}

function renderLangSelects() {
  for (const s of [$('#srcLang'), $('#srcLang2')]) fillSelect(s, true, state.src);
  for (const s of [$('#tgtLang'), $('#tgtLang2')]) fillSelect(s, false, state.tgt);
  applyScriptHints();
}

function applyScriptHints() {
  const src = $('#srcText');
  const srcCode = state.src === AUTO ? detected : state.src;
  src.lang = srcCode || '';
  src.dir = isRtl(srcCode) ? 'rtl' : 'auto';
  const out = $('#tgtText');
  out.lang = state.tgt;
  out.classList.toggle('rtl', isRtl(state.tgt));
}

function setLangs(src, tgt) {
  state.src = src;
  state.tgt = tgt;
  if (src !== AUTO) detected = null;
  persist();
  renderLangSelects();
}

// ---------- desk ----------

const desk = { job: null, output: '', t0: 0 };

function deskStatus(text, isError = false) {
  const el = $('#deskStatus');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function writing(on) {
  $$('#desk .bay')[1].classList.toggle('writing', on);
}

function engineLabel() {
  const e = state.engines.find((x) => x.enabled && !x.speaks) || state.engines.find((x) => x.enabled);
  return e ? e.label : 'Gemini';
}

function translateDesk() {
  const text = $('#srcText').value;
  if (!text.trim()) return;
  if (!scheduler.lanes.length) {
    deskStatus(t('need.key'), true);
    openKeys();
    return;
  }
  if (desk.job) scheduler.cancelJob(desk.job);

  // Paragraphs travel as separate segments; the blank lines between them stay ours.
  const parts = text.split(/(\n[ \t]*\n+)/);
  const segments = [];
  parts.forEach((p, k) => { if (k % 2 === 0 && p.trim()) segments.push({ id: k, text: p }); });

  const job = scheduler.createJob({ prompts: promptsFor(state.src, state.tgt), detect: state.src === AUTO, priority: true });
  desk.job = job;
  desk.t0 = performance.now();
  const got = new Map();
  const langs = new Map();
  const engines = new Set();
  const batches = new Map();
  const errors = [];

  const render = () => {
    desk.output = parts.map((p, k) => (k % 2 ? p : p.trim() ? (got.get(k) ?? '…') : p)).join('').trim();
    showOutput(desk.output);
  };

  job.on = {
    result({ id, text: tr, lang, lane, ms, tokens }) {
      if (desk.job !== job) return;
      got.set(id, tr);
      if (lang) langs.set(lang, (langs.get(lang) || 0) + 1);
      engines.add(lane.engine.label);
      batches.set(`${lane.id}:${ms}`, tokens);
      render();
    },
    failed({ error }) { errors.push(error); },
    jobdone() {
      if (desk.job !== job) return;
      writing(false);
      desk.job = null;
      const secs = ((performance.now() - desk.t0) / 1000).toFixed(1);
      const tokens = [...batches.values()].reduce((a, b) => a + b, 0);
      let line = got.size ? t('colophon', { engine: [...engines].join(' + '), s: secs, tokens: num(tokens) }) : '';
      if (langs.size) {
        detected = [...langs.entries()].sort((a, b) => b[1] - a[1])[0][0];
        line += ` · ${t('detected', { lang: langName(detected) })}`;
        renderLangSelects();
      }
      $('#colophon').textContent = line;
      if (errors.length) deskStatus(t('err.some', { n: errors.length, msg: errors[0] }), true);
      else deskStatus('');
    },
  };

  showOutput('');
  $('#colophon').textContent = '';
  deskStatus(t('working', { engine: engineLabel() }));
  writing(true);
  scheduler.add(job, segments);
}

function deskFatal(message) {
  if (!desk.job) return;
  scheduler.cancelJob(desk.job);
  desk.job = null;
  writing(false);
  deskStatus(t('err.all', { msg: message }), true);
}

function showOutput(text) {
  const out = $('#tgtText');
  out.textContent = text;
  out.classList.toggle('has-text', Boolean(text));
}

function swapLangs() {
  const src = state.src === AUTO ? detected : state.src;
  if (!src) return;
  if (desk.output) {
    $('#srcText').value = desk.output;
    showOutput('');
    desk.output = '';
    $('#colophon').textContent = '';
    updateCount();
  }
  setLangs(state.tgt, src);
}

function updateCount() {
  $('#srcCount').textContent = t('chars', { n: num($('#srcText').value.length) });
}

// ---------- batch ----------

const PAGE = 50;
const batch = { ds: null, raw: null, texts: [], results: [], job: null, filter: 'all', page: 0, t0: 0, avg: 0 };

function batchRunning() {
  return Boolean(batch.job && !batch.job.paused && (batch.job.inFlight || scheduler.queuedFor(batch.job)));
}

async function loadFile(file) {
  try {
    batch.raw = { name: file.name, text: await file.text() };
    reparse();
  } catch (err) {
    alert(err.message);
  }
}

function reparse() {
  if (!batch.raw) return;
  const ds = parseFile(batch.raw.name, batch.raw.text, {
    txtMode: $('#dsMode').value,
    hasHeader: $('#dsHeader').checked,
  });
  setDataset(ds);
}

function setDataset(ds) {
  if (batch.job) scheduler.cancelJob(batch.job);
  batch.job = null;
  batch.ds = ds;
  batch.texts = textsOf(ds);
  batch.results = new Array(batch.texts.length);
  batch.page = 0;
  if (!batch.texts.some((s) => s.trim())) alert(t('empty.file'));

  $('#dsInfo').hidden = false;
  $('#dsName').textContent = t('ds.loaded', { n: num(batch.texts.length), name: ds.name });
  const col = $('#dsColumn');
  $('#dsColumnRow').hidden = !ds.columns.length;
  col.replaceChildren(...ds.columns.map((c) => new Option(c, c)));
  if (ds.column) col.value = ds.column;
  $('#dsHeaderRow').hidden = ds.kind !== 'csv';
  $('#dsModeRow').hidden = ds.kind !== 'txt' || ds.name === 'paste';
  renderBatch();
}

function startBatch() {
  if (!batch.ds) return;
  if (!scheduler.lanes.length) { openKeys(); return; }
  if (batch.job && batch.job.paused && scheduler.queuedFor(batch.job)) {
    scheduler.resumeJob(batch.job);
    renderBatch();
    return;
  }
  if (batch.job && !batch.job.paused) {
    scheduler.pauseJob(batch.job);
    renderBatch();
    return;
  }
  const segments = [];
  batch.texts.forEach((text, k) => {
    if (batch.results[k]?.text != null) return;
    if (!text.trim()) { batch.results[k] = { text: '' }; return; }
    segments.push({ id: k, text });
  });
  if (!segments.length) { renderBatch(); return; }
  for (const s of segments) batch.results[s.id] = undefined;

  const job = scheduler.createJob({ prompts: promptsFor(state.src, state.tgt), detect: state.src === AUTO });
  batch.job = job;
  batch.t0 = performance.now();
  batch.avg = 0;
  let count = 0;
  job.on = {
    result({ id, text, lang, lane }) {
      if (batch.job !== job) return;
      batch.results[id] = { text, lang, engine: lane.engine.id };
      count += 1;
      queueRender();
    },
    failed({ id, error }) { if (batch.job === job) { batch.results[id] = { error }; queueRender(); } },
    jobdone() {
      // Average over the whole run, shown once the engines are idle again.
      if (batch.job === job) batch.avg = count / ((performance.now() - batch.t0) / 1000);
      queueRender();
    },
  };
  scheduler.add(job, segments);
  renderBatch();
}

function stopBatch() {
  if (!batch.job) return;
  scheduler.cancelJob(batch.job);
  batch.job = null;
  renderBatch();
}

function retryBatch() {
  batch.results.forEach((r, k) => { if (r?.error) batch.results[k] = undefined; });
  if (batch.job) {
    scheduler.cancelJob(batch.job);
    batch.job = null;
  }
  startBatch();
}

function batchFatal(message) {
  if (!batch.job) return;
  scheduler.pauseJob(batch.job);
  const lanes = $('#lanes');
  lanes.dataset.fatal = message;
  renderBatch();
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; renderBatch(); }, 200);
}

function fmtEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

function renderBatch() {
  const total = batch.texts.length;
  let done = 0;
  let failed = 0;
  for (const r of batch.results) {
    if (r?.text != null) done++;
    else if (r?.error) failed++;
  }
  const stats = batch.job ? scheduler.jobStats(batch.job) : { perSecond: 0 };
  const running = batchRunning();
  const left = total - done - failed;

  $('#tDone').textContent = num(done);
  $('#tTotal').textContent = total ? t('t.of', { n: num(total) }) : '';
  $('#tRate').textContent = (running ? stats.perSecond : batch.avg).toFixed(1);
  $('#tEta').textContent = running ? fmtEta(left / stats.perSecond) : '—';
  $('#tFail').textContent = num(failed);
  $('#progressBar').style.width = total ? `${((done + failed) / total) * 100}%` : '0';

  const run = $('#runBtn');
  run.disabled = !batch.ds || (!left && !running);
  run.textContent = running ? t('pause') : batch.job?.paused && scheduler.queuedFor(batch.job) ? t('resume') : t('begin');
  $('#stopBtn').disabled = !batch.job;
  $('#retryBtn').hidden = !failed || running;
  renderLedger();
}

function renderLanes() {
  const box = $('#lanes');
  const lanes = scheduler.laneStats();
  if (!lanes.length) {
    box.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'lane-empty';
    p.textContent = t('lane.none');
    box.append(p);
    return;
  }
  if (box.childElementCount !== lanes.length || box.querySelector('.lane-empty')) {
    box.replaceChildren(...lanes.map((l) => {
      const el = document.createElement('div');
      el.className = 'lane';
      el.dataset.engine = l.engine.id;
      el.innerHTML = `
        <div class="lane-top">
          <span class="lane-glyph" lang="hy"></span>
          <span class="lane-name"></span>
          <span class="lane-status"></span>
        </div>
        <div class="gauge"><span></span></div>
        <div class="lane-meta"><span class="m-min"></span><span class="m-total"></span></div>
        <div class="lane-err" hidden></div>`;
      return el;
    }));
  }
  lanes.forEach((l, k) => {
    const el = box.children[k];
    el.dataset.engine = l.engine.id;
    el.querySelector('.lane-glyph').textContent = l.engine.glyph;
    const name = el.querySelector('.lane-name');
    name.textContent = l.engine.label;
    if (l.keyLabel) { const s = document.createElement('small'); s.textContent = l.keyLabel; name.append(s); }
    const st = el.querySelector('.lane-status');
    st.dataset.s = l.status;
    st.textContent = t(`st.${l.status}`) + (l.inFlight ? ` · ${t('lane.flight', { n: l.inFlight })}` : '');
    el.querySelector('.gauge span').style.width = `${Math.min(100, (l.used / l.limit) * 100)}%`;
    el.querySelector('.m-min').textContent = `${num(l.used)} / ${num(l.limit)} ${t('lane.min')}`;
    el.querySelector('.m-total').textContent = t('lane.total', { n: num(l.done), t: num(l.tokens) });
    const err = el.querySelector('.lane-err');
    err.hidden = !l.lastError;
    err.textContent = l.lastError || '';
  });
}

function filtered() {
  const keep = {
    all: () => true,
    done: (r) => r?.text != null,
    failed: (r) => Boolean(r?.error),
    pending: (r) => r?.text == null && !r?.error,
  }[batch.filter];
  const idx = [];
  for (let k = 0; k < batch.texts.length; k++) if (keep(batch.results[k])) idx.push(k);
  return idx;
}

function renderLedger() {
  const body = $('#ledgerBody');
  const idx = filtered();
  const pages = Math.max(1, Math.ceil(idx.length / PAGE));
  batch.page = Math.min(batch.page, pages - 1);
  const slice = idx.slice(batch.page * PAGE, (batch.page + 1) * PAGE);

  if (!batch.texts.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty';
    td.textContent = t('ledger.empty');
    tr.append(td);
    body.replaceChildren(tr);
  } else {
    body.replaceChildren(...slice.map((k) => {
      const r = batch.results[k];
      const tr = document.createElement('tr');
      const cell = (text, cls, lang) => {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        if (lang) td.lang = lang;
        td.textContent = text;
        tr.append(td);
        return td;
      };
      cell(String(k + 1), 'c-n');
      cell(batch.texts[k], '', state.src === AUTO ? (r?.lang || '') : state.src);
      if (r?.text != null) cell(r.text, '', state.tgt);
      else if (r?.error) cell(r.error, 'failed');
      else cell('…', 'pending');
      cell(r?.lang || '', 'c-l');
      const eng = state.engines.find((e) => e.id === r?.engine);
      const e = cell(eng ? eng.glyph : '', `c-e ${r?.engine || ''}`, 'hy');
      if (eng) e.title = eng.label;
      return tr;
    }));
  }
  $('#pageInfo').textContent = t('ledger.page', { p: batch.page + 1, n: pages });
  $('#prevPage').disabled = batch.page === 0;
  $('#nextPage').disabled = batch.page >= pages - 1;
}

function exportAs(format) {
  if (!batch.ds) return;
  const { body, mime, ext } = exportDataset(batch.ds, batch.results, format, { target: state.tgt, withLang: state.src === AUTO });
  const base = batch.ds.name.replace(/\.[^.]+$/, '') || 'posts';
  download(`${base}.${state.tgt}.${ext}`, body, mime);
}

// ---------- keys & engines dialog ----------

function renderKeychip() {
  const chip = $('#keysBtn');
  const k = state.keys.length;
  const l = scheduler.lanes.length;
  chip.classList.toggle('has-keys', k > 0);
  chip.classList.toggle('shared', !k && state.relay);
  $('#keysState').textContent = k ? t(k === 1 ? 'keys.some' : 'keys.many', { k, l })
    : state.relay ? t('keys.shared', { l }) : t('keys.none');
}

function engineRows() {
  const box = $('#engineRows');
  box.replaceChildren(...state.engines.map((e) => {
    const row = document.createElement('div');
    row.className = 'engine-row';
    row.dataset.engine = e.id;
    row.innerHTML = `
      <label class="check"><input type="checkbox" data-k="enabled"> <b lang="hy"></b> <span class="e-label"></span></label>
      <div class="engine-fields">
        <label class="field"><span data-i18n="dlg.model"></span><input data-k="model" spellcheck="false"></label>
        <label class="field"><span data-i18n="dlg.tpm"></span><input data-k="tpm" type="number" min="1000" step="1000" inputmode="numeric"></label>
        <label class="field"><span data-i18n="dlg.batch"></span><input data-k="batchSize" type="number" min="1" max="100" inputmode="numeric"></label>
        <label class="field"><span data-i18n="dlg.think"></span><select data-k="thinkingLevel"></select></label>
      </div>`;
    row.querySelector('b').textContent = e.glyph;
    row.querySelector('.e-label').textContent = e.label;
    row.querySelector('[data-k="enabled"]').checked = e.enabled;
    row.querySelector('[data-k="model"]').value = e.model;
    row.querySelector('[data-k="tpm"]').value = e.tpm;
    row.querySelector('[data-k="batchSize"]').value = e.batchSize;
    const think = row.querySelector('[data-k="thinkingLevel"]');
    if (e.speaks) {
      for (const lvl of ['low', 'medium', 'high']) think.append(new Option(lvl, lvl));
      think.value = e.thinkingLevel || 'low';
    } else {
      think.append(new Option('—', ''));
      think.disabled = true;
    }
    for (const el of row.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    return row;
  }));
}

function openKeys() {
  $('#keysInput').value = state.keys.join('\n');
  $('#rememberKeys').checked = state.remember;
  $('#glossaryInput').value = state.glossary;
  $('#styleInput').value = state.style;
  engineRows();
  $('#testOut').replaceChildren();
  $('#keysDialog').showModal();
}

function readKeysDialog() {
  state.keys = [...new Set($('#keysInput').value.split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean))];
  state.remember = $('#rememberKeys').checked;
  state.glossary = $('#glossaryInput').value;
  state.style = $('#styleInput').value;
  for (const row of $$('.engine-row')) {
    const e = state.engines.find((x) => x.id === row.dataset.engine);
    e.enabled = row.querySelector('[data-k="enabled"]').checked;
    e.model = row.querySelector('[data-k="model"]').value.trim().replace(/^models\//, '') || e.model;
    e.tpm = Math.max(1000, Number(row.querySelector('[data-k="tpm"]').value) || e.tpm);
    e.batchSize = Math.min(100, Math.max(1, Number(row.querySelector('[data-k="batchSize"]').value) || e.batchSize));
    if (e.speaks) e.thinkingLevel = row.querySelector('[data-k="thinkingLevel"]').value;
  }
  persist();
  persistKeys();
  applyLanes();
  renderKeychip();
  renderLanes();
}

async function testKeys() {
  readKeysDialog();
  const out = $('#testOut');
  out.replaceChildren();
  const prompts = promptsFor('hy', state.tgt === 'hy' ? 'en' : state.tgt);
  const tasks = [];
  const keys = state.keys.length ? state.keys : state.relay ? [RELAY] : [];
  keys.forEach((key, k) => {
    for (const engine of state.engines.filter((e) => e.enabled)) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      const who = key === RELAY ? `${t('shared')} · ` : keys.length > 1 ? `key ${k + 1} · ` : '';
      b.textContent = `${who}${engine.label}`;
      li.append(b, document.createTextNode(` — ${t('test.run')}`));
      out.append(li);
      const t0 = performance.now();
      tasks.push(translateBatch({
        apiKey: key,
        engine,
        items: [{ i: 0, text: 'Բարև, աշխարհ։ Այսօր եղանակը հիանալի է։' }],
        systemPrompt: engine.speaks ? prompts.speaking : prompts.silent,
        detect: false,
      }).then((res) => {
        li.className = 'ok';
        li.lastChild.textContent = ` — ${t('test.ok', { s: ((performance.now() - t0) / 1000).toFixed(1), text: res.items[0]?.t ?? '' })}`;
      }).catch((err) => {
        li.className = 'bad';
        li.lastChild.textContent = ` — ${err.message}`;
      }));
    }
  });
  await Promise.allSettled(tasks);
}

// ---------- tabs, theme, interface language ----------

function showTab(name) {
  state.tab = ['desk', 'batch', 'notes'].includes(name) ? name : 'desk';
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  for (const id of ['desk', 'batch', 'notes']) $(`#${id}`).hidden = id !== state.tab;
  persist();
}

function applyTheme() {
  if (state.theme) document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
}

function toggleTheme() {
  const dark = state.theme ? state.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  state.theme = dark ? 'light' : 'dark';
  applyTheme();
  persist();
}

function applyUiLang() {
  setLang(state.ui);
  const other = state.ui === 'fr' ? 'en' : 'fr';
  const btn = $('#uiLangBtn');
  btn.textContent = other.toUpperCase();
  btn.lang = other;
  btn.title = other === 'fr' ? 'Interface en français' : 'English interface';
  $('#tgtText').dataset.placeholder = t('out.empty');
  renderLangSelects();
  renderKeychip();
  updateCount();
  renderLanes();
  renderBatch();
}

// ---------- wiring ----------

function wire() {
  for (const b of $$('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = $$('.tabs button');
    const k = tabs.findIndex((b) => b.dataset.tab === state.tab);
    const next = tabs[(k + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.tab);
    next.focus();
  });
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#uiLangBtn').addEventListener('click', () => { state.ui = state.ui === 'fr' ? 'en' : 'fr'; persist(); applyUiLang(); });

  for (const s of [$('#srcLang'), $('#srcLang2')]) s.addEventListener('change', () => setLangs(s.value, state.tgt));
  for (const s of [$('#tgtLang'), $('#tgtLang2')]) s.addEventListener('change', () => setLangs(state.src, s.value));

  const src = $('#srcText');
  src.addEventListener('input', updateCount);
  src.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); translateDesk(); }
  });
  $('#translateBtn').addEventListener('click', translateDesk);
  $('#swapBtn').addEventListener('click', swapLangs);
  $('#clearBtn').addEventListener('click', () => {
    src.value = '';
    showOutput('');
    desk.output = '';
    $('#colophon').textContent = '';
    deskStatus('');
    updateCount();
    src.focus();
  });
  $('#copyBtn').addEventListener('click', async () => {
    if (!desk.output) return;
    try {
      await navigator.clipboard.writeText(desk.output);
      $('#copyBtn').textContent = t('copied');
      setTimeout(() => { $('#copyBtn').textContent = t('copy'); }, 1600);
    } catch { /* clipboard refused */ }
  });

  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });
  $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  $('#pasteUse').addEventListener('click', () => {
    const lines = splitText($('#pasteBox').value, 'line');
    if (!lines.length) return;
    batch.raw = null;
    setDataset({ kind: 'txt', name: 'paste', columns: [], column: null, records: lines });
  });
  $('#dsColumn').addEventListener('change', (e) => {
    if (!batch.ds) return;
    batch.ds.column = e.target.value;
    setDataset(batch.ds);
  });
  $('#dsHeader').addEventListener('change', reparse);
  $('#dsMode').addEventListener('change', reparse);

  $('#runBtn').addEventListener('click', startBatch);
  $('#stopBtn').addEventListener('click', stopBatch);
  $('#retryBtn').addEventListener('click', retryBatch);
  for (const f of $$('.filter')) {
    f.addEventListener('click', () => {
      batch.filter = f.dataset.filter;
      batch.page = 0;
      for (const g of $$('.filter')) g.setAttribute('aria-pressed', String(g === f));
      renderLedger();
    });
  }
  $('#prevPage').addEventListener('click', () => { batch.page -= 1; renderLedger(); });
  $('#nextPage').addEventListener('click', () => { batch.page += 1; renderLedger(); });
  for (const b of $$('[data-export]')) b.addEventListener('click', () => exportAs(b.dataset.export));

  $('#keysBtn').addEventListener('click', openKeys);
  $('#keysDialog').addEventListener('close', readKeysDialog);
  $('#testBtn').addEventListener('click', testKeys);

  let lastLanes = 0;
  scheduler.addEventListener('tick', () => {
    const now = performance.now();
    if (now - lastLanes < 250) return;
    lastLanes = now;
    renderLanes();
    if (batch.job) queueRender();
  });
  setInterval(() => { renderLanes(); if (batch.job) renderBatch(); }, 1000);

  addEventListener('beforeunload', (e) => {
    if (batchRunning()) { e.preventDefault(); e.returnValue = t('leave'); }
  });
}

applyTheme();
applyLanes();
wire();
applyUiLang();
showTab(state.tab);
relayReady().then((ready) => {
  state.relay = ready;
  applyLanes();
  renderKeychip();
  renderLanes();
});
