'use strict';
// The workspace: every decision about a source (exclude, move, rename, apply a
// layout, fix names, keep one copy of duplicates) is recorded as a change. Changes
// are staged, grouped into commits, reviewed, and only an export writes files.
//
// The planned state is computed from the scanned catalog plus all active
// changes, in order, and stored in `vstate` so tables can page, sort and filter
// it like the catalog itself. Nothing on disk is read or written here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tx } = require('./db');
const { buildWhere, FI_JOIN } = require('./query');
const { TARGETS, nameProblems, sanitizeName, isJunk } = require('./compat');
const { renderTarget, checkTemplate } = require('./template');

const F = { MOVED: 1, RENAMED: 2, EXCLUDED: 4, CONFLICT: 8, BADNAME: 16, CLASH: 32, STALE: 64 };
const OPS = new Set(['exclude', 'include', 'move', 'rename', 'layout', 'sanitize', 'dedupe']);
// Commits whose changes still shape the planned state. "applied" means an
// in-place move made them real, so the next scan already reflects them.
const ACTIVE = "('committed', 'reviewed', 'exported')";
const MAX_ITEMS = 2000000;

const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const join = (a, b) => (a ? `${a}/${b}` : b);

function cleanFolder(to) {
  const segs = String(to ?? '').split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
  for (const s of segs) if (s === '.' || s === '..') throw new Error('Folder may not contain "." or "..".');
  return segs.join('/');
}

function workspace(db, sourceId) {
  let w = db.prepare('SELECT * FROM workspaces WHERE source_id = ?').get(sourceId);
  if (!w) {
    db.prepare('INSERT OR IGNORE INTO workspaces (source_id) VALUES (?)').run(sourceId);
    w = db.prepare('SELECT * FROM workspaces WHERE source_id = ?').get(sourceId);
  }
  return { ...w, summary: JSON.parse(w.summary || '{}') };
}

// Turns a selection into the list of relative paths a change applies to.
function resolveSelection(db, sourceId, sel = {}) {
  if (sel.preset === 'junk') {
    return db.prepare("SELECT rel_path, name FROM entries WHERE source_id = ? AND kind = 'file'").all(sourceId).filter((e) => isJunk(e.name)).map((e) => e.rel_path);
  }
  if (sel.preset === 'stale') {
    return db.prepare('SELECT e.rel_path FROM vstate v JOIN entries e ON e.id = v.entry_id WHERE v.source_id = ? AND (v.flags & ?) != 0').all(sourceId, F.STALE).map((r) => r.rel_path);
  }
  if (sel.preset === 'all') return db.prepare('SELECT rel_path FROM entries WHERE source_id = ?').all(sourceId).map((r) => r.rel_path);
  if (Array.isArray(sel.paths)) return [...new Set(sel.paths.map(String))];
  const filter = { ...(sel.filter || {}), sourceId };
  if (Array.isArray(sel.ids)) filter.ids = sel.ids;
  else if (!sel.filter) throw new Error('Nothing selected.');
  const { where, params } = buildWhere(filter);
  return db.prepare(`SELECT e.rel_path FROM entries e ${FI_JOIN} WHERE ${where}`).all(...params).map((r) => r.rel_path);
}

function validateChange(op, params, items, db, sourceId) {
  if (!OPS.has(op)) throw new Error(`Unknown change ${op}`);
  if (!items.length) throw new Error('The selection is empty.');
  if (items.length > MAX_ITEMS) throw new Error('Selection too large.');
  const p = {};
  if (op === 'move') p.to = cleanFolder(params.to);
  if (op === 'rename') {
    if (items.length !== 1) throw new Error('Rename one item at a time.');
    const name = String(params.name ?? '').trim();
    if (!name || name === '.' || name === '..' || /[/\0]/.test(name)) throw new Error('Enter a valid name (no slashes).');
    p.name = name;
  }
  if (op === 'layout') {
    const errs = checkTemplate(params.template);
    if (errs.length) throw new Error(errs.join(' '));
    p.template = String(params.template).trim();
    p.targetFs = TARGETS[params.targetFs] ? params.targetFs : 'apfs';
  }
  if (op === 'sanitize') p.targetFs = TARGETS[params.targetFs] ? params.targetFs : 'exfat';
  if (op === 'dedupe') {
    p.keep = ['oldest', 'newest', 'shortest'].includes(params.keep) ? params.keep : 'oldest';
    const n = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE source_id = ? AND kind = 'file' AND hash IS NOT NULL").get(sourceId).n;
    if (!n) throw new Error('Run a duplicate check first.');
  }
  return p;
}

function describe(op, p, n) {
  const what = `${n.toLocaleString('en-US')} item${n === 1 ? '' : 's'}`;
  switch (op) {
    case 'exclude': return `Exclude ${what}`;
    case 'include': return `Include ${what} again`;
    case 'move': return `Move ${what} to ${p.to || '(top level)'}/`;
    case 'rename': return `Rename to “${p.name}”`;
    case 'layout': return `Lay out ${what} as ${p.template}`;
    case 'sanitize': return `Fix names of ${what} for ${TARGETS[p.targetFs].label}`;
    case 'dedupe': return `Keep the ${p.keep} copy of each duplicate in ${what}`;
    default: return op;
  }
}

function stage(db, { sourceId, op, params = {}, selection, label }) {
  const src = db.prepare('SELECT id FROM sources WHERE id = ?').get(sourceId);
  if (!src) throw new Error('Unknown source.');
  const items = resolveSelection(db, sourceId, selection);
  const p = validateChange(op, params, items, db, sourceId);
  const id = tx(db, () => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM changes WHERE source_id = ?').get(sourceId).s) + 1;
    const r = db.prepare('INSERT INTO changes (source_id, seq, op, params, label, created_at, items) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sourceId, seq, op, JSON.stringify(p), String(label || describe(op, p, items.length)).slice(0, 300), Date.now(), items.length);
    const cid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO change_items (change_id, rel_path) VALUES (?, ?)');
    for (const rel of items) ins.run(cid, rel);
    return cid;
  });
  const summary = evaluate(db, sourceId);
  const ch = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  return { change: { ...ch, params: JSON.parse(ch.params) }, summary };
}

function unstage(db, { sourceId, changeId }) {
  const c = db.prepare('SELECT * FROM changes WHERE id = ? AND source_id = ?').get(changeId, sourceId);
  if (!c) throw new Error('Unknown change.');
  if (c.commit_id !== null) throw new Error('This change is part of a commit. Revert the commit instead.');
  db.prepare('DELETE FROM changes WHERE id = ?').run(changeId);
  return evaluate(db, sourceId);
}

function commit(db, { sourceId, message }) {
  const msg = String(message || '').trim();
  if (!msg) throw new Error('Write a short commit message describing the changes.');
  const staged = db.prepare('SELECT COUNT(*) AS n FROM changes WHERE source_id = ? AND commit_id IS NULL').get(sourceId).n;
  if (!staged) throw new Error('Nothing is staged.');
  const id = tx(db, () => {
    const r = db.prepare("INSERT INTO commits (source_id, message, created_at, status) VALUES (?, ?, ?, 'committed')").run(sourceId, msg.slice(0, 500), Date.now());
    const cid = Number(r.lastInsertRowid);
    db.prepare('UPDATE changes SET commit_id = ? WHERE source_id = ? AND commit_id IS NULL').run(cid, sourceId);
    return cid;
  });
  return { commitId: id, summary: evaluate(db, sourceId) };
}

// Marks a commit as reviewed. A later change to the workspace does not undo
// the review, but the export asks for a final review of the whole result.
function review(db, { sourceId, commitId, reviewed = true }) {
  const c = db.prepare('SELECT * FROM commits WHERE id = ? AND source_id = ?').get(commitId, sourceId);
  if (!c) throw new Error('Unknown commit.');
  if (!['committed', 'reviewed'].includes(c.status)) throw new Error(`This commit is ${c.status}.`);
  db.prepare('UPDATE commits SET status = ?, reviewed_at = ? WHERE id = ?').run(reviewed ? 'reviewed' : 'committed', reviewed ? Date.now() : null, commitId);
  return evaluate(db, sourceId);
}

// Drops a commit and its changes. Only allowed before its changes were made real.
function revert(db, { sourceId, commitId }) {
  const c = db.prepare('SELECT * FROM commits WHERE id = ? AND source_id = ?').get(commitId, sourceId);
  if (!c) throw new Error('Unknown commit.');
  if (c.status === 'applied') throw new Error('This commit was applied to the files. Undo its plan instead.');
  db.prepare('DELETE FROM commits WHERE id = ?').run(commitId);
  return evaluate(db, sourceId);
}

function setTarget(db, { sourceId, targetFs }) {
  if (!TARGETS[targetFs]) throw new Error('Unknown target file system.');
  workspace(db, sourceId);
  db.prepare('UPDATE workspaces SET target_fs = ? WHERE source_id = ?').run(targetFs, sourceId);
  return evaluate(db, sourceId);
}

/** Recomputes the planned state of a source. Returns the summary. */
function evaluate(db, sourceId) {
  const ws = workspace(db, sourceId);
  const target = TARGETS[ws.target_fs] || TARGETS.apfs;
  const entries = db.prepare(`SELECT e.id, e.rel_path, e.parent, e.name, e.ext, e.kind, e.category, e.size, e.mtime, e.hash, e.error,
    f.type AS ftype, f.taken, f.created AS fcreated, f.camera, f.artist, f.album, f.width, f.height
    FROM entries e ${FI_JOIN} WHERE e.source_id = ? ORDER BY e.rel_path`).all(sourceId);
  const n = entries.length;
  const idx = new Map();
  for (let i = 0; i < n; i++) idx.set(entries[i].rel_path, i);
  const vpath = entries.map((e) => e.rel_path);
  const excl = new Uint8Array(n);
  const lastChange = new Array(n).fill(null);
  const changes = db.prepare(`SELECT c.* FROM changes c LEFT JOIN commits k ON k.id = c.commit_id
    WHERE c.source_id = ? AND (c.commit_id IS NULL OR k.status IN ${ACTIVE}) ORDER BY c.seq`).all(sourceId);
  const itemsOf = db.prepare('SELECT rel_path FROM change_items WHERE change_id = ?');
  const updChange = db.prepare('UPDATE changes SET affected = ?, missing = ? WHERE id = ?');
  const changeStats = [];

  for (const c of changes) {
    const p = JSON.parse(c.params);
    const matched = [];
    let missing = 0;
    for (const r of itemsOf.iterate(c.id)) {
      const i = idx.get(r.rel_path);
      if (i === undefined) missing++;
      else matched.push(i);
    }
    const touched = new Set();
    const setV = (i, v) => { if (vpath[i] !== v) { touched.add(i); vpath[i] = v; lastChange[i] = c.id; } };
    const setX = (i, x) => { if (excl[i] !== x) { touched.add(i); excl[i] = x; lastChange[i] = c.id; } };

    // Folder moves and exclusions carry everything currently inside them.
    const prefixes = new Map(); // old vpath of a folder -> new vpath | {x}
    const carry = () => {
      if (!prefixes.size) return;
      for (let i = 0; i < n; i++) {
        let d = dirOf(vpath[i]);
        const rest = [];
        while (d) {
          const hit = prefixes.get(d);
          if (hit !== undefined) {
            if (typeof hit === 'string') setV(i, [hit, ...rest.reverse(), baseOf(vpath[i])].filter(Boolean).join('/'));
            else setX(i, hit.x);
            break;
          }
          rest.push(baseOf(d));
          d = dirOf(d);
        }
      }
    };

    if (c.op === 'exclude' || c.op === 'include') {
      const x = c.op === 'exclude' ? 1 : 0;
      for (const i of matched) { setX(i, x); if (entries[i].kind === 'dir') prefixes.set(vpath[i], { x }); }
      carry();
    } else if (c.op === 'move' || c.op === 'rename') {
      const sel = new Set(matched.map((i) => vpath[i]));
      for (const i of matched) {
        // Moving a folder and something inside it: the inner item rides along.
        let d = dirOf(vpath[i]);
        let inner = false;
        while (d) { if (sel.has(d)) { inner = true; break; } d = dirOf(d); }
        if (inner) continue;
        const old = vpath[i];
        const nv = c.op === 'move' ? join(p.to, baseOf(old)) : join(dirOf(old), p.name);
        if (entries[i].kind === 'dir' && nv !== old) prefixes.set(old, nv);
        setV(i, nv);
      }
      carry();
    } else if (c.op === 'layout') {
      for (const i of matched) {
        const e = entries[i];
        if (e.kind !== 'file') continue;
        const cur = vpath[i];
        const name = baseOf(cur);
        const dot = name.lastIndexOf('.');
        setV(i, renderTarget(p.template, { ...e, parent: dirOf(cur), name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' }, { target: p.targetFs, source: 'source' }));
      }
    } else if (c.op === 'sanitize') {
      for (const i of matched) {
        const old = vpath[i];
        const nv = old.split('/').map((seg) => sanitizeName(seg, p.targetFs)).join('/');
        if (entries[i].kind === 'dir' && nv !== old) prefixes.set(old, nv);
        setV(i, nv);
      }
      carry(); // a folder with a fixed name carries its content
    } else if (c.op === 'dedupe') {
      const groups = new Map();
      for (const i of matched) {
        const e = entries[i];
        if (e.kind !== 'file' || !e.hash || excl[i]) continue;
        const k = `${e.hash}:${e.size}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(i);
      }
      const better = {
        oldest: (a, b) => (entries[a].mtime - entries[b].mtime) || vpath[a].length - vpath[b].length || (vpath[a] < vpath[b] ? -1 : 1),
        newest: (a, b) => (entries[b].mtime - entries[a].mtime) || vpath[a].length - vpath[b].length || (vpath[a] < vpath[b] ? -1 : 1),
        shortest: (a, b) => vpath[a].length - vpath[b].length || (vpath[a] < vpath[b] ? -1 : 1),
      }[p.keep];
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        g.sort(better);
        for (const i of g.slice(1)) setX(i, 1);
      }
    }
    changeStats.push([touched.size, missing, c.id]);
  }

  // Findings on the planned state, for the files an export would write.
  const flags = new Uint8Array(n);
  const norm = (p) => (target.caseInsensitive ? p.normalize('NFC').toLowerCase() : p.normalize('NFC'));
  const byTarget = new Map();
  const folders = new Set();
  let maxPath = 0;
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    if (vpath[i] !== e.rel_path) {
      if (dirOf(vpath[i]) !== dirOf(e.rel_path)) flags[i] |= F.MOVED;
      if (baseOf(vpath[i]) !== e.name) flags[i] |= F.RENAMED;
    }
    if (excl[i]) { flags[i] |= F.EXCLUDED; continue; }
    if (e.kind !== 'file') continue;
    const k = norm(vpath[i]);
    if (byTarget.has(k)) { flags[i] |= F.CONFLICT; flags[byTarget.get(k)] |= F.CONFLICT; } else byTarget.set(k, i);
    let d = dirOf(k);
    while (d && !folders.has(d)) { folders.add(d); d = dirOf(d); }
    if (vpath[i].split('/').some((s) => nameProblems(s, ws.target_fs).length) || vpath[i].length > target.maxPath - 40) flags[i] |= F.BADNAME;
    if (e.size > target.maxFile) flags[i] |= F.BADNAME;
    maxPath = Math.max(maxPath, vpath[i].length);
  }
  for (const [k, i] of byTarget) if (folders.has(k)) flags[i] |= F.CLASH;

  const stale = new Set(db.prepare('SELECT entry_id FROM vstate WHERE source_id = ? AND (flags & ?) != 0').all(sourceId, F.STALE).map((r) => r.entry_id));
  const s = { files: 0, bytes: 0, excludedFiles: 0, excludedBytes: 0, moved: 0, renamed: 0, conflicts: 0, clashes: 0, badNames: 0, stale: 0, changedFiles: 0, maxPath };
  const hash = crypto.createHash('sha256').update(`${ws.target_fs}\n`);
  tx(db, () => {
    db.prepare('DELETE FROM vstate WHERE source_id = ?').run(sourceId);
    const ins = db.prepare('INSERT INTO vstate (entry_id, source_id, vpath, flags, change_id) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      let f = flags[i];
      if (stale.has(e.id) && !(f & F.EXCLUDED)) f |= F.STALE;
      if (e.kind === 'file') {
        if (f & F.EXCLUDED) { s.excludedFiles++; s.excludedBytes += e.size; } else { s.files++; s.bytes += e.size; }
        if (f & F.MOVED) s.moved++;
        if (f & F.RENAMED) s.renamed++;
        if (f & F.CONFLICT) s.conflicts++;
        if (f & F.CLASH) s.clashes++;
        if (f & F.BADNAME) s.badNames++;
        if (f & F.STALE) s.stale++;
        if (f & (F.MOVED | F.RENAMED | F.EXCLUDED)) s.changedFiles++;
      }
      if (f || vpath[i] !== e.rel_path) {
        ins.run(e.id, sourceId, vpath[i], f, lastChange[i]);
        hash.update(`${e.id}\0${vpath[i]}\0${f & ~F.STALE}\n`);
      }
    }
    for (const [aff, miss, id] of changeStats) updChange.run(aff, miss, id);
    const counts = db.prepare(`SELECT
        SUM(c.commit_id IS NULL) AS staged,
        COUNT(DISTINCT CASE WHEN k.status = 'committed' THEN k.id END) AS unreviewed
      FROM changes c LEFT JOIN commits k ON k.id = c.commit_id WHERE c.source_id = ?`).get(sourceId);
    s.staged = counts.staged || 0;
    s.unreviewed = counts.unreviewed || 0;
    s.commits = db.prepare(`SELECT COUNT(*) AS n FROM commits WHERE source_id = ? AND status IN ${ACTIVE}`).get(sourceId).n;
    s.targetFs = ws.target_fs;
    s.evaluatedAt = Date.now();
    // The version only moves when the planned state itself changes, so a
    // review or a no-op does not invalidate an export check.
    const h = hash.update(String(n)).digest('hex');
    db.prepare('UPDATE workspaces SET version = version + (CASE WHEN state_hash IS ? THEN 0 ELSE 1 END), state_hash = ?, summary = ? WHERE source_id = ?').run(h, h, JSON.stringify(s), sourceId);
  });
  const w = workspace(db, sourceId);
  return { ...s, version: w.version, checkedAt: w.checked_at, checkedVersion: w.checked_version };
}

function summary(db, sourceId) {
  const w = workspace(db, sourceId);
  if (!w.summary.evaluatedAt) return evaluate(db, sourceId);
  return { ...w.summary, version: w.version, checkedAt: w.checked_at, checkedVersion: w.checked_version };
}

function listChanges(db, { sourceId }) {
  const changes = db.prepare('SELECT * FROM changes WHERE source_id = ? ORDER BY seq').all(sourceId).map((c) => ({ ...c, params: JSON.parse(c.params) }));
  const commits = db.prepare('SELECT * FROM commits WHERE source_id = ? ORDER BY id DESC').all(sourceId);
  for (const k of commits) {
    const cs = changes.filter((c) => c.commit_id === k.id);
    k.changes = cs.length;
    k.affected = cs.reduce((a, c) => a + c.affected, 0);
    k.missing = cs.reduce((a, c) => a + c.missing, 0);
  }
  return { staged: changes.filter((c) => c.commit_id === null), changes, commits, summary: summary(db, sourceId) };
}

const DIFF_KINDS = {
  changed: `(COALESCE(v.flags, 0) & ${F.MOVED | F.RENAMED | F.EXCLUDED}) != 0`,
  moved: `(COALESCE(v.flags, 0) & ${F.MOVED | F.RENAMED}) != 0 AND (COALESCE(v.flags, 0) & ${F.EXCLUDED}) = 0`,
  excluded: `(COALESCE(v.flags, 0) & ${F.EXCLUDED}) != 0`,
  problems: `(COALESCE(v.flags, 0) & ${F.CONFLICT | F.CLASH | F.BADNAME | F.STALE}) != 0`,
  conflicts: `(COALESCE(v.flags, 0) & ${F.CONFLICT | F.CLASH}) != 0`,
  badnames: `(COALESCE(v.flags, 0) & ${F.BADNAME}) != 0`,
  stale: `(COALESCE(v.flags, 0) & ${F.STALE}) != 0`,
  kept: `(COALESCE(v.flags, 0) & ${F.EXCLUDED}) = 0`,
  all: '1 = 1',
};
const DIFF_SORTS = { before: 'e.rel_path', after: 'COALESCE(v.vpath, e.rel_path)', size: 'e.size', mtime: 'e.mtime' };

// The before/after table. Optionally limited to what one commit or change targeted.
function diff(db, { sourceId, kind = 'changed', files = true, commitId, changeId, search, sort = 'after', dir = 'asc', offset = 0, limit = 200 }) {
  const w = ['e.source_id = ?'];
  const p = [Number(sourceId)];
  w.push(DIFF_KINDS[kind] || DIFF_KINDS.changed);
  if (files) w.push("e.kind = 'file'");
  if (commitId || changeId) {
    w.push(`e.rel_path IN (SELECT ci.rel_path FROM change_items ci JOIN changes c ON c.id = ci.change_id WHERE c.source_id = ? AND ${commitId ? 'c.commit_id = ?' : 'c.id = ?'})`);
    p.push(Number(sourceId), Number(commitId || changeId));
  }
  if (search) { w.push("(e.rel_path LIKE ? ESCAPE '\\' OR v.vpath LIKE ? ESCAPE '\\')"); const s = `%${String(search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`; p.push(s, s); }
  const where = w.join(' AND ');
  const order = `${DIFF_SORTS[sort] || DIFF_SORTS.after} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
  const rows = db.prepare(`SELECT e.id, e.rel_path, e.name, e.kind, e.category, e.size, e.mtime, e.tree_files,
      COALESCE(v.vpath, e.rel_path) AS vpath, COALESCE(v.flags, 0) AS flags, v.change_id, c.label AS change_label
    FROM entries e LEFT JOIN vstate v ON v.entry_id = e.id LEFT JOIN changes c ON c.id = v.change_id
    WHERE ${where} ORDER BY ${order}, e.id LIMIT ? OFFSET ?`).all(...p, Math.min(5000, Math.max(1, Number(limit) || 200)), Math.max(0, Number(offset) || 0));
  const totals = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(e.size), 0) AS bytes FROM entries e LEFT JOIN vstate v ON v.entry_id = e.id WHERE ${where}`).get(...p);
  return { rows, total: totals.count, bytes: totals.bytes };
}

// The planned folder tree, as a statistics table: what each top folder will hold.
function plannedFolders(db, { sourceId, depth = 1 }) {
  const d = Math.max(1, Math.min(4, Number(depth) || 1));
  const rows = db.prepare(`SELECT COALESCE(v.vpath, e.rel_path) AS vpath, e.size FROM entries e LEFT JOIN vstate v ON v.entry_id = e.id
    WHERE e.source_id = ? AND e.kind = 'file' AND (COALESCE(v.flags, 0) & ${F.EXCLUDED}) = 0`).all(sourceId);
  const m = new Map();
  for (const r of rows) {
    const segs = r.vpath.split('/');
    const key = segs.length > 1 ? segs.slice(0, Math.min(d, segs.length - 1)).join('/') : '(top level)';
    const g = m.get(key) || { key, count: 0, bytes: 0 };
    g.count++; g.bytes += r.size;
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 500);
}

// Compares every file the export would read with the disk right now. Files
// that changed or vanished since the scan are flagged STALE.
async function verifySources(db, sourceId, { signal = { aborted: false }, onProgress = () => {} } = {}) {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!src) throw new Error('Unknown source.');
  const before = workspace(db, sourceId).version;
  const rows = db.prepare(`SELECT e.id, e.rel_path, e.size, e.mtime, v.flags, v.vpath FROM entries e LEFT JOIN vstate v ON v.entry_id = e.id
    WHERE e.source_id = ? AND e.kind = 'file' AND (COALESCE(v.flags, 0) & ${F.EXCLUDED}) = 0`).all(sourceId);
  const stale = [];
  const st = { checked: 0, total: rows.length, changed: 0, missing: 0 };
  for (const r of rows) {
    if (signal.aborted) break;
    let s = null;
    try { s = await fs.promises.lstat(path.join(src.path, r.rel_path)); } catch { /* gone */ }
    if (!s || !s.isFile()) { st.missing++; stale.push(r); }
    else if (s.size !== r.size || Math.abs(Math.floor(s.mtimeMs) - r.mtime) > 1) { st.changed++; stale.push(r); }
    if (++st.checked % 500 === 0) onProgress({ ...st });
  }
  onProgress({ ...st });
  if (signal.aborted) return { ...st, cancelled: true };
  tx(db, () => {
    db.prepare('UPDATE vstate SET flags = flags & ? WHERE source_id = ?').run(~F.STALE, sourceId);
    const up = db.prepare('INSERT INTO vstate (entry_id, source_id, vpath, flags) VALUES (?, ?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET flags = flags | excluded.flags');
    for (const r of stale) up.run(r.id, sourceId, r.vpath || r.rel_path, F.STALE);
  });
  const sum = evaluate(db, sourceId);
  // Only counts as a check of this exact planned state.
  if (sum.version === before) db.prepare('UPDATE workspaces SET checked_at = ?, checked_version = ? WHERE source_id = ?').run(Date.now(), before, sourceId);
  return { ...st, stale: stale.length };
}

/** Everything that must be true before files may be written. */
function exportCheck(db, sourceId) {
  const s = summary(db, sourceId);
  const w = workspace(db, sourceId);
  const fresh = w.checked_version === w.version && w.checked_at;
  const items = [
    { key: 'staged', ok: s.staged === 0, label: s.staged ? `${s.staged} staged change(s) are not committed` : 'All changes are committed', fix: 'Commit or discard the staged changes.' },
    { key: 'reviewed', ok: s.unreviewed === 0, label: s.unreviewed ? `${s.unreviewed} commit(s) not reviewed yet` : 'Every commit is reviewed', fix: 'Open each commit and review its changes.' },
    { key: 'files', ok: s.files > 0, label: s.files ? `${s.files.toLocaleString('en-US')} files in the planned state` : 'The planned state has no files', fix: 'Include some files.' },
    { key: 'conflicts', ok: s.conflicts === 0 && s.clashes === 0, label: s.conflicts || s.clashes ? `${s.conflicts + s.clashes} file(s) would collide at the target` : 'No two files land on the same path', fix: 'Rename, move or exclude the colliding files.' },
    { key: 'checked', ok: !!fresh, label: fresh ? `Sources re-checked ${new Date(w.checked_at).toLocaleString('en-GB')}` : 'Sources not re-checked against the disk for this state', fix: 'Run “Re-check sources”.' },
    { key: 'stale', ok: s.stale === 0, label: s.stale ? `${s.stale} file(s) changed on disk since the scan` : 'No file changed since the scan', fix: 'Rescan the source, or exclude the changed files.' },
  ];
  const warnings = [];
  if (s.badNames) warnings.push(`${s.badNames} name(s) are not valid on ${TARGETS[w.target_fs].label}; the export cleans them automatically. Stage “Fix names” to review the new names first.`);
  return { ok: items.every((i) => i.ok), items, warnings, summary: s, version: w.version, targetFs: w.target_fs };
}

module.exports = { verifySources, exportCheck, F, OPS, stage, unstage, commit, review, revert, setTarget, evaluate, summary, listChanges, diff, plannedFolders, workspace, resolveSelection, cleanFolder, ACTIVE };
