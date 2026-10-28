'use strict';
// Target path templates for restructuring, e.g. "{category}/{yyyy}/{mm}/{name}".
// Every path segment is sanitized for the target file system, and the result
// can never escape the target folder.
const path = require('path');
const { sanitizeName } = require('./compat');

const TOKENS = {
  path: 'Original folder path (keeps the structure)',
  parent: 'Name of the folder the file is in',
  top: 'First folder below the source',
  name: 'File name with extension',
  stem: 'File name without extension',
  ext: 'Extension, lower case (empty if none)',
  extdir: 'Extension for use as a folder ("no-extension" if none)',
  category: 'Type: image, video, document, …',
  yyyy: 'Year modified', mm: 'Month modified (01–12)', dd: 'Day modified (01–31)',
  date: 'Date modified, YYYY-MM-DD', sizeclass: 'tiny / small / medium / large / huge',
  source: 'Source name', hash8: 'First 8 characters of the SHA-256 (if computed)',
};

const PRESETS = [
  { id: 'mirror', label: 'Keep structure', template: '{path}/{name}' },
  { id: 'by-type', label: 'By type', template: '{category}/{extdir}/{name}' },
  { id: 'by-date', label: 'By date', template: '{yyyy}/{mm}/{name}' },
  { id: 'type-date', label: 'By type, then year', template: '{category}/{yyyy}/{name}' },
  { id: 'flatten', label: 'Flatten', template: '{name}' },
  { id: 'by-top', label: 'By top folder and type', template: '{top}/{category}/{name}' },
];

function sizeClass(n) {
  if (n < 10 * 1024) return 'tiny';
  if (n < 1024 * 1024) return 'small';
  if (n < 100 * 1024 * 1024) return 'medium';
  if (n < 1024 * 1024 * 1024) return 'large';
  return 'huge';
}

function checkTemplate(tpl) {
  const errors = [];
  if (typeof tpl !== 'string' || !tpl.trim()) errors.push('Template is empty.');
  else {
    if (tpl.startsWith('/') || /^[a-zA-Z]:/.test(tpl)) errors.push('Template must be relative to the target folder.');
    for (const m of tpl.matchAll(/\{([^}]*)\}/g)) if (!(m[1] in TOKENS)) errors.push(`Unknown token {${m[1]}}.`);
    if (/[{}]/.test(tpl.replace(/\{[a-z0-9]+\}/gi, ''))) errors.push('Unbalanced braces in template.');
  }
  return errors;
}

/**
 * @param {string} tpl
 * @param {object} e entry row: rel_path, parent, name, ext, category, size, mtime, hash
 * @param {object} ctx { target: 'exfat'|..., source: label }
 * @returns {string} relative target path (with "/" separators)
 */
function renderTarget(tpl, e, ctx = {}) {
  const target = ctx.target || 'apfs';
  const d = e.mtime ? new Date(e.mtime) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const stem = e.ext ? e.name.slice(0, e.name.length - e.ext.length - 1) : e.name;
  const vals = {
    path: e.parent || '',
    parent: e.parent ? e.parent.split('/').pop() : '',
    top: e.parent ? e.parent.split('/')[0] : '',
    name: e.name, stem, ext: e.ext || '', extdir: e.ext || 'no-extension',
    category: e.category || 'other',
    yyyy: d ? String(d.getFullYear()) : 'undated', mm: d ? pad(d.getMonth() + 1) : 'undated', dd: d ? pad(d.getDate()) : 'undated',
    date: d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : 'undated',
    sizeclass: sizeClass(e.size || 0), source: ctx.source || 'source', hash8: e.hash ? e.hash.slice(0, 8) : 'nohash',
  };
  let t = tpl.trim();
  if (!/\{(name|stem)\}/.test(t)) t = `${t.replace(/\/+$/, '')}/{name}`;
  // Expand per segment so a token value containing "/" ({path}) becomes
  // several segments, and each segment is sanitized on its own.
  const segs = [];
  for (const raw of t.split('/')) {
    const expanded = raw.replace(/\{([a-z0-9]+)\}/gi, (_, k) => `\u0001${vals[k] ?? ''}\u0001`);
    for (const piece of expanded.replace(/\u0001/g, '').split('/')) {
      if (!piece) continue;
      segs.push(sanitizeName(piece, target));
    }
  }
  if (!segs.length) segs.push(sanitizeName(e.name, target));
  // "{stem}" alone drops the extension; put it back so file types survive.
  const last = segs[segs.length - 1];
  const lastTpl = t.split('/').pop();
  if (e.ext && /\{stem\}/.test(lastTpl) && !/\{(name|ext)\}/.test(lastTpl) && !last.toLowerCase().endsWith(`.${e.ext}`)) {
    segs[segs.length - 1] = sanitizeName(`${last}.${e.ext}`, target);
  }
  return segs.join('/');
}

// Join and confirm the result stays inside root.
function safeJoin(root, rel) {
  const r = path.resolve(root);
  const full = path.resolve(r, ...rel.split('/'));
  if (full !== r && !full.startsWith(r + path.sep)) throw new Error(`Target escapes the target folder: ${rel}`);
  return full;
}

// "photo.jpg" -> "photo (2).jpg"
function numbered(rel, n) {
  const slash = rel.lastIndexOf('/');
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${dir}${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${dir}${name} (${n})`;
}

module.exports = { TOKENS, PRESETS, checkTemplate, renderTarget, safeJoin, numbered, sizeClass };
