'use strict';
// Turns a filter object from the UI into a parameterised SQL query. Values are
// always bound as parameters; column names come from a fixed whitelist.

const SORTS = {
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
      COALESCE(v.vpath, e.rel_path) AS vpath, COALESCE(v.flags, 0) AS vflags, c.label AS change_label
    FROM entries e LEFT JOIN vstate v ON v.entry_id = e.id LEFT JOIN changes c ON c.id = v.change_id WHERE ${where} ORDER BY ${sortCol} ${dir}, e.id ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  let totals = null;
  if (opts.totals !== false) {
    totals = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN e.kind = 'file' THEN e.size ELSE 0 END), 0) AS bytes,
      SUM(e.kind = 'file') AS files, SUM(e.kind = 'dir') AS dirs FROM entries e WHERE ${where}`).get(...params);
  }
  return { rows, totals, offset, limit };
}

// Group the current filter by one dimension, for the breakdown tables.
const GROUPS = {
  category: 'e.category', ext: "CASE e.ext WHEN '' THEN '(none)' ELSE e.ext END", year: "strftime('%Y', e.mtime / 1000, 'unixepoch')",
  month: "strftime('%Y-%m', e.mtime / 1000, 'unixepoch')", depth: 'e.depth', top: "CASE WHEN instr(e.rel_path, '/') > 0 THEN substr(e.rel_path, 1, instr(e.rel_path, '/') - 1) ELSE '(root)' END",
  parent: "CASE e.parent WHEN '' THEN '(root)' ELSE e.parent END", kind: 'e.kind',
};

function groupBy(db, filter, dim, opts = {}) {
  const expr = GROUPS[dim];
  if (!expr) throw new Error(`Unknown grouping ${dim}`);
  const { where, params } = buildWhere(filter);
  const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
  const order = opts.order === 'key' ? 'key' : 'bytes DESC, count DESC';
  return db.prepare(`SELECT ${expr} AS key, COUNT(*) AS count, COALESCE(SUM(e.size), 0) AS bytes,
      MIN(e.mtime) AS oldest, MAX(e.mtime) AS newest
    FROM entries e WHERE ${where} GROUP BY key ORDER BY ${order} LIMIT ?`).all(...params, limit);
}

module.exports = { buildWhere, queryEntries, groupBy, globToLike, SORTS, GROUPS };
