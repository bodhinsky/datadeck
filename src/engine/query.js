'use strict';
// Turns a filter object from the UI into a parameterised SQL query. Values are
// always bound as parameters; column names come from a fixed whitelist.

// Content details (fileinfo.js) are joined by path wherever entries are filtered.
const FI_JOIN = 'LEFT JOIN fileinfo f ON f.source_id = e.source_id AND f.rel_path = e.rel_path';
const FI_COLS = `f.type AS ftype, f.family AS ffamily, f.mismatch, f.taken, f.width, f.height, f.duration, f.camera, f.lens,
  f.gps_lat, f.gps_lon, f.title, f.artist, f.album, f.author, f.pages, f.created AS fcreated, f.last_used, f.tags, f.where_from`;
// Date taken, else created (documents), else modified: "the date of this file".
const WHEN = 'COALESCE(f.taken, f.created, e.mtime)';

const SORTS = {
  taken: 'f.taken', when: WHEN, camera: 'f.camera COLLATE NOCASE', duration: 'f.duration', pixels: '(f.width * f.height)', lastUsed: 'f.last_used',
  artist: 'f.artist COLLATE NOCASE', ftype: 'f.type',
  planned: 'COALESCE(v.vpath, e.rel_path)', path: 'e.rel_path', name: 'e.name', size: 'e.size', mtime: 'e.mtime', ext: 'e.ext',
  category: 'e.category', depth: 'e.depth', kind: 'e.kind', tree: 'e.tree_bytes',
};
const KINDS = new Set(['file', 'dir', 'symlink', 'other']);

function globToLike(glob) {
  // * and ? become SQL wildcards; existing % _ \ are escaped.
  return glob.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '%').replace(/\?/g, '_');
}

const toArr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const finite = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));

/**
 * filter: {
 *   sourceId, kinds[], categories[], exts[], sizeMin, sizeMax, mtimeFrom, mtimeTo,
 *   name (glob, case-insensitive), path (substring), under (folder rel path, recursive),
 *   depthMin, depthMax, issue (code), dupes (bool), hasError (bool), ids[]
 * }
 */
function buildWhere(filter) {
  const w = ['e.source_id = ?'];
  const p = [Number(filter.sourceId)];
  const kinds = toArr(filter.kinds).filter((k) => KINDS.has(k));
  if (kinds.length) { w.push(`e.kind IN (${kinds.map(() => '?').join(',')})`); p.push(...kinds); }
  const cats = toArr(filter.categories).map(String);
  if (cats.length) { w.push(`e.category IN (${cats.map(() => '?').join(',')})`); p.push(...cats); }
  const exts = toArr(filter.exts).map((x) => String(x).toLowerCase().replace(/^\./, '')).map((x) => (x === '(none)' ? '' : x));
  if (exts.length) { w.push(`e.ext IN (${exts.map(() => '?').join(',')})`); p.push(...exts); }
  if (finite(filter.sizeMin)) { w.push('e.size >= ?'); p.push(Number(filter.sizeMin)); }
  if (finite(filter.sizeMax)) { w.push('e.size <= ?'); p.push(Number(filter.sizeMax)); }
  if (finite(filter.mtimeFrom)) { w.push('e.mtime >= ?'); p.push(Number(filter.mtimeFrom)); }
  if (finite(filter.mtimeTo)) { w.push('e.mtime <= ?'); p.push(Number(filter.mtimeTo)); }
  if (finite(filter.depthMin)) { w.push('e.depth >= ?'); p.push(Number(filter.depthMin)); }
  if (finite(filter.depthMax)) { w.push('e.depth <= ?'); p.push(Number(filter.depthMax)); }
  if (filter.name) { w.push("e.name LIKE ? ESCAPE '\\'"); p.push(globToLike(String(filter.name))); }
  if (filter.path) { w.push("e.rel_path LIKE ? ESCAPE '\\'"); p.push(`%${globToLike(String(filter.path)).replace(/^%|%$/g, '')}%`); }
  if (filter.under !== undefined && filter.under !== null && filter.under !== '') {
    const u = String(filter.under).replace(/\/+$/, '');
    w.push("(e.rel_path = ? OR e.rel_path LIKE ? ESCAPE '\\')");
    p.push(u, `${globToLike(u)}/%`);
  }
  if (typeof filter.parent === 'string') { w.push('e.parent = ?'); p.push(filter.parent === '(root)' ? '' : filter.parent); }
  if (filter.issue) { w.push('EXISTS (SELECT 1 FROM issues i WHERE i.entry_id = e.id AND i.code = ?)'); p.push(String(filter.issue)); }
  if (filter.anyIssue) w.push('EXISTS (SELECT 1 FROM issues i WHERE i.entry_id = e.id)');
  if (filter.hasError) w.push('e.error IS NOT NULL');
  if (filter.dupes) {
    w.push(`e.kind = 'file' AND e.hash IS NOT NULL AND EXISTS (SELECT 1 FROM entries d WHERE d.source_id = e.source_id
      AND d.hash = e.hash AND d.size = e.size AND d.id <> e.id)`);
  }
  // The planned state (see changes.js): 1 moved, 2 renamed, 4 excluded, 8/32 collisions, 16 bad name, 64 changed on disk.
  const VS = { changed: 7, excluded: 4, kept: -4, problems: 8 | 16 | 32 | 64 };
  if (VS[filter.planned] !== undefined) {
    const m = VS[filter.planned];
    w.push(m < 0 ? 'COALESCE((SELECT v.flags FROM vstate v WHERE v.entry_id = e.id), 0) & ? = 0' : 'COALESCE((SELECT v.flags FROM vstate v WHERE v.entry_id = e.id), 0) & ? != 0');
    p.push(Math.abs(m));
  }
  // Content details.
  const ftypes = toArr(filter.ftypes).map(String);
  if (ftypes.length) { w.push(`COALESCE(f.type, '(unknown)') IN (${ftypes.map(() => '?').join(',')})`); p.push(...ftypes); }
  if (filter.mismatch) w.push('f.mismatch = 1');
  if (filter.taken === 'yes') w.push('f.taken IS NOT NULL');
  if (filter.taken === 'no') w.push("e.kind = 'file' AND f.taken IS NULL AND (e.category IN ('image', 'video') OR f.family IN ('image', 'video'))");
  if (finite(filter.takenFrom)) { w.push(`${WHEN} >= ?`); p.push(Number(filter.takenFrom)); }
  if (finite(filter.takenTo)) { w.push(`${WHEN} <= ?`); p.push(Number(filter.takenTo)); }
  if (filter.gps === 'yes') w.push('f.gps_lat IS NOT NULL');
  if (filter.gps === 'no') w.push("f.gps_lat IS NULL AND f.family IN ('image', 'video')");
  for (const [k, col] of [['camera', 'f.camera'], ['artist', 'f.artist'], ['album', 'f.album'], ['author', 'f.author']]) {
    if (typeof filter[k] === 'string' && filter[k]) {
      if (filter[k] === '(none)') w.push(`${col} IS NULL`);
      else { w.push(`${col} LIKE ? ESCAPE '\\'`); p.push(`%${globToLike(filter[k]).replace(/^%|%$/g, '')}%`); }
    }
  }
  if (typeof filter.tag === 'string' && filter.tag) { w.push("f.tags LIKE ? ESCAPE '\\'"); p.push(`%${globToLike(filter.tag)}%`); }
  if (filter.hasTags) w.push('f.tags IS NOT NULL');
  if (finite(filter.durationMin)) { w.push('f.duration >= ?'); p.push(Number(filter.durationMin)); }
  if (finite(filter.durationMax)) { w.push('f.duration <= ?'); p.push(Number(filter.durationMax)); }
  if (finite(filter.pixelsMin)) { w.push('f.width * f.height >= ?'); p.push(Number(filter.pixelsMin)); }
  if (finite(filter.pixelsMax)) { w.push('f.width * f.height <= ?'); p.push(Number(filter.pixelsMax)); }
  if (finite(filter.unusedSince)) { w.push("e.kind = 'file' AND COALESCE(f.last_used, e.mtime) < ?"); p.push(Number(filter.unusedSince)); }
  if (filter.downloaded) w.push('f.where_from IS NOT NULL');
  const ids = toArr(filter.ids).map(Number).filter(Number.isInteger);
  if (ids.length) { w.push(`e.id IN (${ids.map(() => '?').join(',')})`); p.push(...ids); }
  return { where: w.join(' AND '), params: p };
}

function queryEntries(db, filter, opts = {}) {
  const { where, params } = buildWhere(filter);
  const sortCol = SORTS[opts.sort] || SORTS.path;
  const dir = opts.dir === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 200));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const rows = db.prepare(`SELECT e.id, e.rel_path, e.name, e.ext, e.kind, e.category, e.size, e.tree_bytes, e.tree_files,
      e.mtime, e.depth, e.hash, e.error, e.link_target, e.nlink,
      (SELECT GROUP_CONCAT(code) FROM issues i WHERE i.entry_id = e.id) AS issues,
      COALESCE(v.vpath, e.rel_path) AS vpath, COALESCE(v.flags, 0) AS vflags, c.label AS change_label, ${FI_COLS}
    FROM entries e ${FI_JOIN} LEFT JOIN vstate v ON v.entry_id = e.id LEFT JOIN changes c ON c.id = v.change_id WHERE ${where} ORDER BY ${sortCol} ${dir}, e.id ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  let totals = null;
  if (opts.totals !== false) {
    totals = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN e.kind = 'file' THEN e.size ELSE 0 END), 0) AS bytes,
      SUM(e.kind = 'file') AS files, SUM(e.kind = 'dir') AS dirs FROM entries e ${FI_JOIN} WHERE ${where}`).get(...params);
  }
  return { rows, totals, offset, limit };
}

// Group the current filter by one dimension, for the breakdown tables.
const GROUPS = {
  category: 'e.category', ext: "CASE e.ext WHEN '' THEN '(none)' ELSE e.ext END", year: "strftime('%Y', e.mtime / 1000, 'unixepoch')",
  month: "strftime('%Y-%m', e.mtime / 1000, 'unixepoch')", depth: 'e.depth', top: "CASE WHEN instr(e.rel_path, '/') > 0 THEN substr(e.rel_path, 1, instr(e.rel_path, '/') - 1) ELSE '(root)' END",
  parent: "CASE e.parent WHEN '' THEN '(root)' ELSE e.parent END", kind: 'e.kind',
  ftype: "COALESCE(f.type, '(not read)')", camera: "COALESCE(f.camera, '(none)')", artist: "COALESCE(f.artist, '(none)')", album: "COALESCE(f.album, '(none)')",
  author: "COALESCE(f.author, '(none)')",
  takenYear: "COALESCE(strftime('%Y', f.taken / 1000, 'unixepoch', 'localtime'), '(no date taken)')",
  takenMonth: "COALESCE(strftime('%Y-%m', f.taken / 1000, 'unixepoch', 'localtime'), '(no date taken)')",
  usedYear: "COALESCE(strftime('%Y', f.last_used / 1000, 'unixepoch', 'localtime'), '(never / unknown)')",
  resolution: `CASE WHEN f.width IS NULL THEN '(none)' WHEN f.width * f.height >= 33000000 THEN '8K+ (33 MP+)' WHEN f.width * f.height >= 8000000 THEN '4K–8K (8–33 MP)'
    WHEN f.width * f.height >= 2000000 THEN 'Full HD–4K (2–8 MP)' WHEN f.width * f.height >= 300000 THEN 'small (0.3–2 MP)' ELSE 'tiny (< 0.3 MP)' END`,
  length: `CASE WHEN f.duration IS NULL THEN '(none)' WHEN f.duration < 10 THEN '< 10 s' WHEN f.duration < 60 THEN '10 s – 1 min'
    WHEN f.duration < 600 THEN '1–10 min' WHEN f.duration < 3600 THEN '10–60 min' ELSE '> 1 h' END`,
  mismatch: "CASE f.mismatch WHEN 1 THEN 'extension does not match content' ELSE 'ok' END",
};

function groupBy(db, filter, dim, opts = {}) {
  const expr = GROUPS[dim];
  if (!expr) throw new Error(`Unknown grouping ${dim}`);
  const { where, params } = buildWhere(filter);
  const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
  const order = opts.order === 'key' ? 'key' : 'bytes DESC, count DESC';
  return db.prepare(`SELECT ${expr} AS key, COUNT(*) AS count, COALESCE(SUM(e.size), 0) AS bytes,
      MIN(e.mtime) AS oldest, MAX(e.mtime) AS newest
    FROM entries e ${FI_JOIN} WHERE ${where} GROUP BY key ORDER BY ${order} LIMIT ?`).all(...params, limit);
}

module.exports = { FI_JOIN, FI_COLS, WHEN, buildWhere, queryEntries, groupBy, globToLike, SORTS, GROUPS };
