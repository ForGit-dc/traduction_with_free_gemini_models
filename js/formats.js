// Reading the posts to translate, and writing them back out.

export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).slice(0, 20);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => splitLine(l, d).length);
    const first = counts[0] || 0;
    const steady = counts.filter((c) => c === first).length;
    const score = first > 1 ? steady * first : 0;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

function splitLine(line, d) {
  return parseCSV(line, d)[0] || [];
}

// RFC 4180: quoted fields, doubled quotes, line breaks inside quotes.
export function parseCSV(text, d = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quoted) {
      if (c === '"') {
        if (text[k + 1] === '"') { field += '"'; k++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[k + 1] === '\n') k++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

export function toCSV(rows, d = ',') {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /["\r\n]/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(d)).join('\r\n');
}

function stringKeys(records) {
  const keys = new Map();
  for (const r of records.slice(0, 200)) {
    if (!r || typeof r !== 'object') continue;
    for (const [k, v] of Object.entries(r)) if (typeof v === 'string') keys.set(k, (keys.get(k) || 0) + v.length);
  }
  // Longest text first: the likeliest column to translate.
  return [...keys.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function unwrapJson(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const arr = Object.values(data).find(Array.isArray);
    if (arr) return arr;
  }
  throw new Error('No list of posts found in this JSON.');
}

/**
 * Turns a file into a dataset: { kind, name, columns, column, records, header, delimiter }.
 * records are strings (txt, plain JSON lists) or rows/objects (csv, JSON objects).
 */
export function parseFile(name, text, { txtMode = 'line', hasHeader = true } = {}) {
  text = text.replace(/^﻿/, '');
  const ext = (name.split('.').pop() || '').toLowerCase();

  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') {
    const list = ext === 'json'
      ? unwrapJson(JSON.parse(text))
      : text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const columns = stringKeys(list);
    const kind = ext === 'json' ? 'json' : 'jsonl';
    if (list.every((r) => typeof r === 'string')) return { kind, name, columns: [], column: null, records: list };
    if (!columns.length) throw new Error('These JSON objects have no text field.');
    return { kind, name, columns, column: columns[0], records: list };
  }

  if (ext === 'csv' || ext === 'tsv') {
    const delimiter = ext === 'tsv' ? '\t' : detectDelimiter(text);
    const rows = parseCSV(text, delimiter);
    if (!rows.length) throw new Error('This file is empty.');
    const width = Math.max(...rows.map((r) => r.length));
    const header = hasHeader ? rows[0].map((h, k) => h.trim() || `column ${k + 1}`) : Array.from({ length: width }, (_, k) => `column ${k + 1}`);
    const records = hasHeader ? rows.slice(1) : rows;
    // Default column: the one holding the most text.
    const weight = header.map((_, k) => records.slice(0, 200).reduce((n, r) => n + (r[k] || '').length, 0));
    const column = header[weight.indexOf(Math.max(...weight))];
    return { kind: 'csv', name, columns: header, column, records, header, delimiter, hasHeader };
  }

  return { kind: 'txt', name, columns: [], column: null, records: splitText(text, txtMode), txtMode };
}

export function splitText(text, mode = 'line') {
  const parts = mode === 'blank' ? text.split(/\r?\n\s*\r?\n/) : text.split(/\r?\n/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function textsOf(ds) {
  if (!ds) return [];
  if (ds.kind === 'csv') {
    const k = ds.columns.indexOf(ds.column);
    return ds.records.map((r) => r[k] ?? '');
  }
  return ds.records.map((r) => (typeof r === 'string' ? r : String(r?.[ds.column] ?? '')));
}

/**
 * results: array aligned with records: { text, lang, error } or undefined.
 * Returns { body, mime, ext }.
 */
export function exportDataset(ds, results, format, { target, withLang }) {
  const col = `translation_${target}`;
  const sources = textsOf(ds);
  const tr = (k) => results[k]?.text ?? '';
  const lg = (k) => results[k]?.lang ?? '';

  if (format === 'csv') {
    let rows;
    if (ds.kind === 'csv') {
      const head = [...ds.header, col, ...(withLang ? ['detected_lang'] : [])];
      rows = [head, ...ds.records.map((r, k) => [...ds.header.map((_, c) => r[c] ?? ''), tr(k), ...(withLang ? [lg(k)] : [])])];
    } else {
      rows = [['n', 'source', col, ...(withLang ? ['detected_lang'] : [])],
        ...sources.map((s, k) => [k + 1, s, tr(k), ...(withLang ? [lg(k)] : [])])];
    }
    // The BOM lets Excel open UTF-8 Armenian text correctly.
    return { body: '﻿' + toCSV(rows, ds.kind === 'csv' ? ds.delimiter : ','), mime: 'text/csv', ext: 'csv' };
  }

  if (format === 'json' || format === 'jsonl') {
    const out = ds.records.map((r, k) => {
      const base = r && typeof r === 'object' && !Array.isArray(r) ? { ...r }
        : ds.kind === 'csv' ? Object.fromEntries(ds.header.map((h, c) => [h, r[c] ?? '']))
          : { source: sources[k] };
      base[col] = tr(k);
      if (withLang) base.detected_lang = lg(k);
      return base;
    });
    return format === 'json'
      ? { body: JSON.stringify(out, null, 2), mime: 'application/json', ext: 'json' }
      : { body: out.map((o) => JSON.stringify(o)).join('\n'), mime: 'application/x-ndjson', ext: 'jsonl' };
  }

  const all = sources.map((_, k) => tr(k));
  const sep = all.some((t) => t.includes('\n')) ? '\n\n' : '\n';
  return { body: all.join(sep), mime: 'text/plain', ext: 'txt' };
}

export function download(name, body, mime) {
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
