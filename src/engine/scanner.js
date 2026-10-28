'use strict';
// Walks a folder tree of any depth and writes every entry into the catalog.
// Async with a bounded number of folders open at once, so it stays
// responsive and never runs out of file handles. Symlinks are recorded, not
// followed, so link loops cannot trap it. Unreadable folders and files are
// recorded as errors and the walk continues.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { tx } = require('./db');
const { extOf, categoryOf } = require('./categories');
const { computeIssues } = require('./analysis');

const BATCH = 1000;

function kindOf(st) {
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  if (st.isSymbolicLink()) return 'symlink';
  return 'other';
}

const num = (v) => (v === undefined || v === null ? null : Number(v));

/**
 * @param {DatabaseSync} db
 * @param {number} sourceId
 * @param {object} opts { concurrency, oneFileSystem, signal, onProgress(stats) }
 */
async function scanSource(db, sourceId, opts = {}) {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!src) throw new Error(`Unknown source ${sourceId}`);
  const root = src.path;
  const concurrency = Math.max(1, Math.min(64, opts.concurrency || 8));
  const signal = opts.signal || { aborted: false };
  const t0 = Date.now();

  const rootSt = await fsp.stat(root, { bigint: true });
  if (!rootSt.isDirectory()) throw new Error(`${root} is not a folder`);

  db.prepare("UPDATE sources SET status = 'scanning' WHERE id = ?").run(sourceId);
  tx(db, () => {
    db.prepare('DELETE FROM issues WHERE source_id = ?').run(sourceId);
    db.prepare('DELETE FROM entries WHERE source_id = ?').run(sourceId);
  });

  const insert = db.prepare(`INSERT INTO entries
    (source_id, rel_path, parent, name, ext, kind, category, size, mtime, ctime, btime, mode, uid, gid, dev, ino, nlink, depth, link_target, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const stats = { files: 0, dirs: 0, links: 0, other: 0, bytes: 0, errors: 0, queued: 0, current: '' };
  const tree = new Map(); // dir rel path -> { bytes, files }
  tree.set('', { bytes: 0, files: 0 });
  const visited = new Set([`${rootSt.dev}:${rootSt.ino}`]);
  let pending = [];

  const flush = () => {
    if (!pending.length) return;
    const rows = pending;
    pending = [];
    tx(db, () => { for (const r of rows) insert.run(...r); });
  };
  const push = (row) => {
    pending.push(row);
    if (pending.length >= BATCH) flush();
  };

  let lastEmit = 0;
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    if (opts.onProgress) opts.onProgress({ ...stats, elapsedMs: now - t0 });
  };

  const addToTree = (parentRel, size) => {
    let p = parentRel;
    for (;;) {
      const t = tree.get(p);
      if (t) { t.bytes += size; t.files += 1; }
      if (p === '') break;
      const i = p.lastIndexOf('/');
      p = i < 0 ? '' : p.slice(0, i);
    }
  };

  const record = (rel, name, st, extra = {}) => {
    const kind = st ? kindOf(st) : 'other';
    const ext = kind === 'file' ? extOf(name) : '';
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const size = st && kind === 'file' ? Number(st.size) : 0;
    push([
      sourceId, rel, parent, name, ext, kind, categoryOf(ext, kind), size,
      st ? Math.floor(Number(st.mtimeMs)) : null,
      st ? Math.floor(Number(st.ctimeMs)) : null,
      st && st.birthtimeMs ? Math.floor(Number(st.birthtimeMs)) : null,
      st ? num(st.mode) : null, st ? num(st.uid) : null, st ? num(st.gid) : null,
      st ? String(st.dev) : null, st ? String(st.ino) : null, st ? num(st.nlink) : null,
      rel ? rel.split('/').length : 0,
      extra.linkTarget ?? null, extra.error ?? null,
    ]);
    if (kind === 'file') { stats.files++; stats.bytes += size; addToTree(parent, size); }
    else if (kind === 'dir') stats.dirs++;
    else if (kind === 'symlink') stats.links++;
    else stats.other++;
    if (extra.error) stats.errors++;
  };

  // Work queue of folders (relative paths). '' is the root.
  const queue = [''];
  let active = 0;

  async function readDir(rel) {
    const abs = rel ? path.join(root, rel) : root;
    stats.current = rel;
    let dir;
    try {
      dir = await fsp.opendir(abs, { bufferSize: 256 });
    } catch (e) {
      // Record the folder itself as unreadable (root is recorded below).
      if (rel) markError(rel, e);
      else throw e;
      return;
    }
    try {
      for await (const d of dir) {
        if (signal.aborted) break;
        const name = d.name;
        const childRel = rel ? `${rel}/${name}` : name;
        const childAbs = path.join(abs, name);
        let st;
        try {
          st = await fsp.lstat(childAbs, { bigint: true });
        } catch (e) {
          record(childRel, name, null, { error: `${e.code || 'ERR'}: ${e.message}` });
          continue;
        }
        if (st.isSymbolicLink()) {
          let target = null;
          let error = null;
          try { target = await fsp.readlink(childAbs); } catch (e) { error = `${e.code}: ${e.message}`; }
          record(childRel, name, st, { linkTarget: target, error });
        } else if (st.isDirectory()) {
          const key = `${st.dev}:${st.ino}`;
          const crossesFs = st.dev !== rootSt.dev;
          record(childRel, name, st);
          if (visited.has(key)) continue; // hard-linked folder (e.g. Time Machine) seen before
          visited.add(key);
          if (opts.oneFileSystem && crossesFs) continue;
          tree.set(childRel, { bytes: 0, files: 0 });
          queue.push(childRel);
          stats.queued++;
        } else {
          record(childRel, name, st);
        }
        emit(false);
      }
    } catch (e) {
      markError(rel, e);
    }
  }

  const errorRows = [];
  function markError(rel, e) {
    stats.errors++;
    errorRows.push([`${e.code || 'ERR'}: ${e.message}`, sourceId, rel]);
  }

  await new Promise((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (signal.aborted && active === 0) { resolve(); return; }
      while (!signal.aborted && active < concurrency && queue.length) {
        const rel = queue.shift();
        active++;
        readDir(rel).then(() => {
          active--;
          stats.queued = queue.length;
          if (!queue.length && active === 0) resolve();
          else pump();
        }, (e) => { failed = true; reject(e); });
      }
      if (!queue.length && active === 0) resolve();
    };
    pump();
  });
  flush();

  // Unreadable folders: attach the error to their entry row.
  if (errorRows.length) {
    const upd = db.prepare('UPDATE entries SET error = ? WHERE source_id = ? AND rel_path = ?');
    tx(db, () => { for (const r of errorRows) upd.run(...r); });
  }

  // Recursive folder sizes, used for "largest folders" and tree views.
  const upd = db.prepare('UPDATE entries SET tree_bytes = ?, tree_files = ? WHERE source_id = ? AND rel_path = ?');
  const rows = [...tree.entries()].filter(([rel]) => rel !== '');
  for (let i = 0; i < rows.length; i += BATCH) {
    tx(db, () => { for (const [rel, t] of rows.slice(i, i + BATCH)) upd.run(t.bytes, t.files, sourceId, rel); });
  }

  const cancelled = !!signal.aborted;
  if (!cancelled) computeIssues(db, sourceId);
  const scanMs = Date.now() - t0;
  db.prepare(`UPDATE sources SET status = ?, scanned_at = ?, scan_ms = ?, files = ?, dirs = ?, links = ?, bytes = ?, errors = ?, fs_dev = ? WHERE id = ?`)
    .run(cancelled ? 'partial' : 'ready', Date.now(), scanMs, stats.files, stats.dirs, stats.links, stats.bytes, stats.errors, String(rootSt.dev), sourceId);
  emit(true);
  return { ...stats, cancelled, scanMs };
}

module.exports = { scanSource };
