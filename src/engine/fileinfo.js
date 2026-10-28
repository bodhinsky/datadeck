'use strict';
// The inspect pass: after a scan, read what is inside each file (inspect.js)
// and, on a Mac, what Spotlight knows about it (last opened, Finder tags,
// where it was downloaded from). Results live in `fileinfo`, keyed by path,
// and are only recomputed for files whose size or mtime changed.
const path = require('path');
const { execFile } = require('child_process');
const { tx } = require('./db');
const { inspectFile } = require('./inspect');

const BATCH = 200;
const MDLS_BATCH = 64;

const COLS = ['size', 'mtime', 'type', 'mime', 'family', 'mismatch', 'taken', 'width', 'height', 'duration', 'camera', 'lens', 'gps_lat', 'gps_lon',
  'title', 'artist', 'album', 'author', 'pages', 'bitrate', 'created', 'last_used', 'tags', 'where_from', 'extra', 'error', 'inspected_at'];

function rowOf(e, r, err) {
  if (err) return { size: e.size, mtime: e.mtime, error: String(err.code || err.message || err).slice(0, 200), inspected_at: Date.now(), mismatch: 0 };
  return {
    size: e.size, mtime: e.mtime, type: r.type, mime: r.mime, family: r.family, mismatch: r.mismatch ? 1 : 0,
    taken: r.taken, width: r.width, height: r.height, duration: r.duration, camera: r.camera, lens: r.lens,
    gps_lat: r.gpsLat, gps_lon: r.gpsLon, title: r.title, artist: r.artist, album: r.album, author: r.author,
    pages: r.pages, bitrate: r.bitrate, created: r.created,
    extra: Object.keys(r.extra || {}).length ? JSON.stringify(r.extra) : null, error: null, inspected_at: Date.now(),
  };
}

// ── Spotlight (macOS only) ──
// `mdls -raw` prints one value per attribute and file, separated by NUL.
const MD_ATTRS = ['kMDItemLastUsedDate', 'kMDItemUserTags', 'kMDItemWhereFroms'];

function parseMdValue(v) {
  const s = String(v || '').trim();
  if (!s || s === '(null)') return null;
  if (s.startsWith('(')) {
    const items = s.slice(1, -1).split(/,\s*\n?/).map((x) => x.trim().replace(/^"([^]*)"$/, '$1').replace(/\\"/g, '"')).filter(Boolean);
    return items.length ? items : null;
  }
  return s;
}

function parseMdls(out, files) {
  const parts = out.split('\0');
  const res = [];
  for (let i = 0; i < files.length; i++) {
    const [used, tags, from] = MD_ATTRS.map((_, k) => parseMdValue(parts[i * MD_ATTRS.length + k]));
    const t = used ? Date.parse(String(used).replace(' +0000', 'Z').replace(' ', 'T')) : NaN;
    res.push({
      last_used: Number.isFinite(t) ? t : null,
      // Finder tags may carry a colour suffix ("Work\n6"); keep the name.
      tags: Array.isArray(tags) ? tags.map((x) => x.split('\n')[0]).join(', ').slice(0, 300) || null : null,
      where_from: Array.isArray(from) ? from.find((x) => /^https?:/i.test(x)) || from[0] : from,
    });
  }
  return res;
}

function mdls(files) {
  return new Promise((resolve) => {
    const args = ['-raw', ...MD_ATTRS.flatMap((a) => ['-name', a]), '--', ...files];
    execFile('/usr/bin/mdls', args, { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      // mdls fails the whole batch if one file vanished; then skip the batch.
      resolve(err && !stdout ? null : parseMdls(stdout, files));
    });
  });
}

/**
 * Inspects every file of a source whose content info is missing or out of date.
 * opts: { signal, onProgress, spotlight (default: on macOS), force }
 */
async function inspectSource(db, sourceId, opts = {}) {
  const { signal = { aborted: false }, onProgress } = opts;
  const spotlight = opts.spotlight ?? process.platform === 'darwin';
  const src = db.prepare('SELECT path FROM sources WHERE id = ?').get(sourceId);
  if (!src) throw new Error('Unknown source');
  // Forget files that are gone.
  db.prepare(`DELETE FROM fileinfo WHERE source_id = ? AND NOT EXISTS
    (SELECT 1 FROM entries e WHERE e.source_id = fileinfo.source_id AND e.rel_path = fileinfo.rel_path AND e.kind = 'file')`).run(sourceId);
  const todo = db.prepare(`SELECT e.rel_path, e.ext, e.size, e.mtime FROM entries e
    LEFT JOIN fileinfo f ON f.source_id = e.source_id AND f.rel_path = e.rel_path
    WHERE e.source_id = ? AND e.kind = 'file' AND e.error IS NULL
      AND (? OR f.rel_path IS NULL OR f.size IS NOT e.size OR f.mtime IS NOT e.mtime)
    ORDER BY e.rel_path`).all(sourceId, opts.force ? 1 : 0);
  const stats = { phase: 'inspect', total: todo.length, done: 0, failed: 0, mismatched: 0, withDate: 0 };
  const upsert = db.prepare(`INSERT INTO fileinfo (source_id, rel_path, ${COLS.join(', ')}) VALUES (?, ?, ${COLS.map(() => '?').join(', ')})
    ON CONFLICT(source_id, rel_path) DO UPDATE SET ${COLS.map((c) => `${c} = excluded.${c}`).join(', ')}`);
  const setMd = db.prepare('UPDATE fileinfo SET last_used = ?, tags = ?, where_from = ? WHERE source_id = ? AND rel_path = ?');
  let last = 0;
  const report = (force) => {
    const now = Date.now();
    if (onProgress && (force || now - last > 200)) { last = now; onProgress({ ...stats }); }
  };
  report(true);
  for (let i = 0; i < todo.length && !signal.aborted; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const rows = [];
    for (const e of batch) {
      if (signal.aborted) break;
      let r = null;
      let err = null;
      try { r = await inspectFile(path.join(src.path, e.rel_path), { ext: e.ext, size: e.size }); } catch (x) { err = x; }
      const row = rowOf(e, r, err);
      if (err) stats.failed++;
      if (row.mismatch) stats.mismatched++;
      if (row.taken) stats.withDate++;
      rows.push([e.rel_path, row]);
      stats.done++;
      report();
    }
    if (spotlight && rows.length) {
      for (let k = 0; k < rows.length; k += MDLS_BATCH) {
        const part = rows.slice(k, k + MDLS_BATCH);
        const md = await mdls(part.map(([rel]) => path.join(src.path, rel)));
        if (md) part.forEach(([, row], n) => Object.assign(row, md[n]));
      }
    }
    tx(db, () => { for (const [rel, row] of rows) upsert.run(sourceId, rel, ...COLS.map((c) => row[c] ?? null)); });
    await new Promise((r) => setImmediate(r));
  }
  // Spotlight fields change without the file changing (opening it, tagging
  // it), so refresh them for unchanged files too.
  if (spotlight && !signal.aborted) {
    const rest = db.prepare('SELECT rel_path FROM fileinfo WHERE source_id = ? AND (inspected_at IS NULL OR inspected_at < ?)').all(sourceId, Date.now() - 1000).map((r) => r.rel_path);
    stats.phase = 'spotlight';
    for (let k = 0; k < rest.length && !signal.aborted; k += MDLS_BATCH) {
      const part = rest.slice(k, k + MDLS_BATCH);
      const md = await mdls(part.map((rel) => path.join(src.path, rel)));
      if (md) tx(db, () => part.forEach((rel, n) => setMd.run(md[n].last_used, md[n].tags, md[n].where_from, sourceId, rel)));
      report();
    }
  }
  // Wrong extensions show up on the Issues page like any other finding.
  tx(db, () => {
    db.prepare("DELETE FROM issues WHERE source_id = ? AND code = 'type-mismatch'").run(sourceId);
    db.prepare(`INSERT INTO issues (source_id, entry_id, code, severity, detail)
      SELECT e.source_id, e.id, 'type-mismatch', 'warn', 'content is ' || f.type || ', extension .' || e.ext
      FROM entries e JOIN fileinfo f ON f.source_id = e.source_id AND f.rel_path = e.rel_path WHERE e.source_id = ? AND f.mismatch = 1`).run(sourceId);
  });
  report(true);
  return stats;
}

function fileInfo(db, sourceId, relPath) {
  const r = db.prepare('SELECT * FROM fileinfo WHERE source_id = ? AND rel_path = ?').get(sourceId, relPath);
  if (r && r.extra) { try { r.extra = JSON.parse(r.extra); } catch { r.extra = null; } }
  return r || null;
}

module.exports = { inspectSource, fileInfo, parseMdls, parseMdValue };
