'use strict';
// Duplicate detection in three passes, so only real candidates are read in
// full: same size -> same quick hash (first/last 64 KB) -> same SHA-256.
const path = require('path');
const { tx } = require('./db');
const { hashFile, quickHash } = require('./hash');

async function findDuplicates(db, sourceId, { signal = { aborted: false }, onProgress, minSize = 1 } = {}) {
  const src = db.prepare('SELECT path FROM sources WHERE id = ?').get(sourceId);
  if (!src) throw new Error(`Unknown source ${sourceId}`);
  const abs = (rel) => path.join(src.path, rel);
  const t0 = Date.now();

  const sizeGroups = db.prepare(`SELECT id, rel_path, size, mtime FROM entries
    WHERE source_id = ? AND kind = 'file' AND size >= ? AND size IN (
      SELECT size FROM entries WHERE source_id = ?1 AND kind = 'file' AND size >= ?2 GROUP BY size HAVING COUNT(*) > 1)
    ORDER BY size DESC`).all(sourceId, minSize);

  const totalBytes = sizeGroups.reduce((a, r) => a + r.size, 0);
  const stats = { candidates: sizeGroups.length, quick: 0, hashed: 0, bytesHashed: 0, totalBytes, errors: 0 };
  let last = 0;
  const emit = (force) => {
    const now = Date.now();
    if (onProgress && (force || now - last > 200)) { last = now; onProgress({ ...stats, phase: stats.phase, elapsedMs: now - t0 }); }
  };

  const setQ = db.prepare('UPDATE entries SET qhash = ? WHERE id = ?');
  const setH = db.prepare('UPDATE entries SET hash = ? WHERE id = ?');
  const setErr = db.prepare('UPDATE entries SET error = ? WHERE id = ?');

  // Pass 2: quick hash.
  stats.phase = 'quick';
  const qrows = [];
  for (const r of sizeGroups) {
    if (signal.aborted) break;
    try {
      r.qhash = await quickHash(abs(r.rel_path), r.size);
      qrows.push([r.qhash, r.id]);
    } catch (e) {
      stats.errors++;
      setErr.run(`${e.code || 'ERR'}: ${e.message}`, r.id);
    }
    stats.quick++;
    emit();
  }
  tx(db, () => { for (const q of qrows) setQ.run(...q); });

  // Pass 3: full hash for rows whose (size, qhash) still collide.
  stats.phase = 'full';
  const key = (r) => `${r.size}:${r.qhash}`;
  const counts = new Map();
  for (const r of sizeGroups) if (r.qhash) counts.set(key(r), (counts.get(key(r)) || 0) + 1);
  const full = sizeGroups.filter((r) => r.qhash && counts.get(key(r)) > 1);
  stats.fullCandidates = full.length;
  const hrows = [];
  for (const r of full) {
    if (signal.aborted) break;
    try {
      const h = await hashFile(abs(r.rel_path), { signal, onBytes: (n) => { stats.bytesHashed += n; emit(); } });
      hrows.push([h, r.id]);
    } catch (e) {
      if (signal.aborted) break;
      stats.errors++;
      setErr.run(`${e.code || 'ERR'}: ${e.message}`, r.id);
    }
    stats.hashed++;
    if (hrows.length >= 500) tx(db, () => { for (const h of hrows.splice(0)) setH.run(...h); });
    emit();
  }
  tx(db, () => { for (const h of hrows) setH.run(...h); });
  emit(true);
  return { ...stats, cancelled: !!signal.aborted, ...dupeSummary(db, sourceId) };
}

function dupeSummary(db, sourceId) {
  return db.prepare(`SELECT COUNT(*) AS groups, COALESCE(SUM(n - 1), 0) AS extra, COALESCE(SUM((n - 1) * size), 0) AS wasted FROM
    (SELECT hash, size, COUNT(*) AS n FROM entries WHERE source_id = ? AND kind = 'file' AND hash IS NOT NULL GROUP BY hash, size HAVING n > 1)`).get(sourceId);
}

// Duplicate groups, biggest waste first, with their members.
function dupeGroups(db, sourceId, { offset = 0, limit = 100 } = {}) {
  const groups = db.prepare(`SELECT hash, size, COUNT(*) AS n, (COUNT(*) - 1) * size AS wasted FROM entries
    WHERE source_id = ? AND kind = 'file' AND hash IS NOT NULL GROUP BY hash, size HAVING n > 1
    ORDER BY wasted DESC, hash LIMIT ? OFFSET ?`).all(sourceId, Math.min(1000, limit), Math.max(0, offset));
  const members = db.prepare(`SELECT id, rel_path, mtime, nlink, ino FROM entries WHERE source_id = ? AND hash = ? AND size = ? ORDER BY mtime, rel_path`);
  return groups.map((g) => ({ ...g, members: members.all(sourceId, g.hash, g.size) }));
}

module.exports = { findDuplicates, dupeGroups, dupeSummary };
