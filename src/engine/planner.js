'use strict';
// Builds a restructure plan: for every selected file, where it goes and what
// happens if something is already there. Nothing on disk is touched here; the
// plan is stored and shown for review first.
const fs = require('fs');
const path = require('path');
const { tx } = require('./db');
const { buildWhere } = require('./query');
const { checkTemplate, renderTarget, safeJoin, numbered } = require('./template');
const { TARGETS, isJunk } = require('./compat');

const MODES = new Set(['copy', 'move']);
const CONFLICTS = new Set(['rename', 'skip']);

function nearestExisting(p) {
  let cur = path.resolve(p);
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

function freeBytes(p) {
  try {
    const s = fs.statfsSync(nearestExisting(p));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function devOf(p) {
  try { return String(fs.statSync(nearestExisting(p), { bigint: true }).dev); } catch { return null; }
}

/**
 * spec: { sourceId, filter, template, targetRoot, mode, conflict, targetFs,
 *         skipJunk, dedupe }
 */
function validateSpec(db, spec) {
  const errors = [];
  const warnings = [];
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(Number(spec.sourceId));
  if (!src) errors.push('Unknown source.');
  if (!MODES.has(spec.mode)) errors.push('Mode must be copy or move.');
  if (!CONFLICTS.has(spec.conflict)) errors.push('Conflict handling must be rename or skip.');
  if (!TARGETS[spec.targetFs]) errors.push('Unknown target file system.');
  errors.push(...checkTemplate(spec.template));
  const root = String(spec.targetRoot || '').trim();
  if (!root) errors.push('Choose a target folder.');
  else if (!path.isAbsolute(root)) errors.push('Target folder must be an absolute path.');
  else if (/[\0\n\r]/.test(root)) errors.push('Target folder contains invalid characters.');
  if (src && src.status !== 'ready') warnings.push('This source was not fully scanned. Rescan for a complete plan.');
  if (src && root && path.isAbsolute(root)) {
    const s = path.resolve(src.path);
    const t = path.resolve(root);
    if (spec.mode === 'copy' && (t === s || t.startsWith(s + path.sep))) warnings.push('The target is inside the source. The copies will show up in the next scan of this source.');
    if (s.startsWith(t + path.sep)) errors.push('The source is inside the target folder. Choose a separate target.');
  }
  if (spec.mode === 'move') warnings.push('Move mode removes each original only after its copy is verified, or renames it in place on the same disk.');
  return { errors, warnings, src };
}

function createPlan(db, spec) {
  const { errors, warnings, src } = validateSpec(db, spec);
  if (errors.length) return { ok: false, errors, warnings };

  const target = TARGETS[spec.targetFs];
  const root = path.resolve(String(spec.targetRoot).trim());
  const filter = { ...(spec.filter || {}), sourceId: src.id };
  const { where, params } = buildWhere(filter);
  const rows = db.prepare(`SELECT e.id, e.rel_path, e.parent, e.name, e.ext, e.kind, e.category, e.size, e.mtime, e.hash, e.error
    FROM entries e WHERE ${where} AND e.kind = 'file' ORDER BY e.rel_path`).all(...params);

  const ops = [];
  const taken = new Map(); // normalized target -> index in ops
  const norm = (rel) => (target.caseInsensitive ? rel.normalize('NFC').toLowerCase() : rel.normalize('NFC'));
  const counts = { files: 0, bytes: 0, renamed: 0, skipped: 0, sanitized: 0, existing: 0, unchanged: 0, junk: 0, unreadable: 0, dedupe: 0 };
  const seenHash = new Map();

  for (const e of rows) {
    if (spec.skipJunk && isJunk(e.name)) { counts.junk++; continue; }
    const srcAbs = path.join(src.path, e.rel_path);
    let rel = renderTarget(spec.template, e, { target: spec.targetFs, source: src.label });
    const plainName = e.name;
    if (rel.split('/').pop() !== plainName && !spec.template.includes('{stem}')) counts.sanitized++;
    let status = 'pending';
    let note = null;

    if (e.error) { status = 'skipped'; note = `unreadable at scan: ${e.error}`; counts.unreadable++; }

    if (status === 'pending' && spec.dedupe && e.hash) {
      const k = `${e.hash}:${e.size}`;
      if (seenHash.has(k)) { status = 'skipped'; note = `duplicate of ${seenHash.get(k)}`; counts.dedupe++; }
      else seenHash.set(k, e.rel_path);
    }

    let dstAbs = safeJoin(root, rel);
    if (status === 'pending' && path.resolve(srcAbs) === dstAbs) { status = 'skipped'; note = 'already in place'; counts.unchanged++; }

    // Two selected files that land on the same target name.
    if (status === 'pending' && taken.has(norm(rel))) {
      if (spec.conflict === 'skip') { status = 'skipped'; note = `target used by ${ops[taken.get(norm(rel))].srcRel}`; counts.skipped++; }
      else {
        let n = 2;
        while (taken.has(norm(numbered(rel, n)))) n++;
        rel = numbered(rel, n);
        dstAbs = safeJoin(root, rel);
        note = 'renamed: name clash in plan';
        counts.renamed++;
      }
    }

    // Something already on disk at the target.
    if (status === 'pending') {
      let st = null;
      try { st = fs.lstatSync(dstAbs); } catch { /* free */ }
      if (st) {
        counts.existing++;
        if (st.isFile() && st.size === e.size) note = 'target exists, same size: will compare checksums';
        else if (spec.conflict === 'skip') { status = 'skipped'; note = 'target exists'; counts.skipped++; }
        else {
          let n = 2;
          while (taken.has(norm(numbered(rel, n))) || fs.existsSync(safeJoin(root, numbered(rel, n)))) n++;
          rel = numbered(rel, n);
          dstAbs = safeJoin(root, rel);
          note = 'renamed: target exists';
          counts.renamed++;
        }
      }
    }

    if (status === 'pending') { taken.set(norm(rel), ops.length); counts.files++; counts.bytes += e.size; }
    ops.push({ entryId: e.id, srcRel: e.rel_path, src: srcAbs, dst: dstAbs, size: e.size, mtime: e.mtime, status, note });
  }

  // Room on the target. A same-disk move needs none.
  const sameDevice = devOf(root) !== null && devOf(root) === src.fs_dev;
  const needBytes = spec.mode === 'move' && sameDevice ? 0 : counts.bytes;
  const free = freeBytes(root);
  if (free !== null && needBytes > free * 0.98) errors.push(`Not enough space on the target: need ${needBytes} bytes, ${free} free.`);
  if (!ops.length) warnings.push('The filter matches no files.');
  if (counts.existing) warnings.push(`${counts.existing} target file(s) already exist; identical ones are skipped after a checksum check.`);
  if (counts.unreadable) warnings.push(`${counts.unreadable} file(s) were unreadable during the scan and are skipped.`);

  const summary = { ...counts, ops: ops.length, needBytes, freeBytes: free, sameDevice, warnings, errors, root, mode: spec.mode };
  const planId = tx(db, () => {
    const r = db.prepare('INSERT INTO plans (source_id, created_at, spec, status, summary) VALUES (?, ?, ?, ?, ?)')
      .run(src.id, Date.now(), JSON.stringify({ ...spec, targetRoot: root, filter }), errors.length ? 'invalid' : 'draft', JSON.stringify(summary));
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO plan_ops (plan_id, seq, entry_id, op, src, dst, size, mtime, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ops.forEach((o, i) => ins.run(id, i, o.entryId, spec.mode, o.src, o.dst, o.size, o.mtime, o.status, o.note));
    return id;
  });
  return { ok: errors.length === 0, planId, summary, errors, warnings };
}

function planOps(db, planId, { status, offset = 0, limit = 200, search } = {}) {
  const w = ['plan_id = ?'];
  const p = [Number(planId)];
  if (status === 'notes') w.push('note IS NOT NULL');
  else if (status) { w.push('status = ?'); p.push(String(status)); }
  if (search) { w.push('(src LIKE ? OR dst LIKE ?)'); p.push(`%${search}%`, `%${search}%`); }
  const rows = db.prepare(`SELECT * FROM plan_ops WHERE ${w.join(' AND ')} ORDER BY seq LIMIT ? OFFSET ?`).all(...p, Math.min(5000, limit), Math.max(0, offset));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM plan_ops WHERE ${w.join(' AND ')}`).get(...p).n;
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n, SUM(size) AS bytes FROM plan_ops WHERE plan_id = ? GROUP BY status').all(Number(planId));
  return { rows, total, byStatus };
}

function getPlan(db, planId) {
  const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(planId));
  if (!p) return null;
  return { ...p, spec: JSON.parse(p.spec), summary: JSON.parse(p.summary) };
}

module.exports = { createPlan, validateSpec, planOps, getPlan };
