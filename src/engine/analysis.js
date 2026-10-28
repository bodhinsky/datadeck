'use strict';
// Post-scan analysis: issues that matter when moving data between systems,
// and the statistics behind the overview tables.
const fs = require('fs');
const path = require('path');
const { tx } = require('./db');
const { nameProblems, isJunk } = require('./compat');

const ISSUE_INFO = {
  unreadable: { severity: 'error', label: 'Unreadable', hint: 'Permission denied or I/O error. These cannot be copied until fixed.' },
  'broken-link': { severity: 'warn', label: 'Broken symlink', hint: 'The link points to something that does not exist.' },
  'case-collision': { severity: 'warn', label: 'Case collision', hint: 'Names differ only by upper/lower case. They overwrite each other on macOS, Windows and USB drives.' },
  'unicode-collision': { severity: 'warn', label: 'Unicode collision', hint: 'Names look identical but use different Unicode forms (common between macOS and Linux).' },
  'bad-char': { severity: 'warn', label: 'Invalid on Windows/USB', hint: 'Contains < > : " \\ | ? * or control characters.' },
  'reserved-name': { severity: 'warn', label: 'Reserved name', hint: 'CON, PRN, AUX, NUL, COM1… cannot exist on Windows or exFAT.' },
  'trailing-dot-space': { severity: 'warn', label: 'Trailing dot/space', hint: 'Windows and exFAT silently strip these.' },
  'name-too-long': { severity: 'warn', label: 'Name too long', hint: 'Over 255 characters.' },
  'path-too-long': { severity: 'warn', label: 'Path too long', hint: 'Over 240 characters below the source folder; breaks classic Windows paths (260).' },
  'not-nfc': { severity: 'info', label: 'Decomposed Unicode', hint: 'Name uses NFD form (typical on macOS). Fine locally, may duplicate on Linux/Windows.' },
  'too-big-fat32': { severity: 'warn', label: 'Over 4 GB', hint: 'Cannot be stored on FAT32 drives.' },
  'odd-date': { severity: 'info', label: 'Odd date', hint: 'Modified before 1980 or in the future. FAT drives cannot store dates before 1980.' },
  'empty-file': { severity: 'info', label: 'Empty file', hint: 'Zero bytes.' },
  'empty-dir': { severity: 'info', label: 'Empty folder', hint: 'Contains nothing.' },
  junk: { severity: 'info', label: 'System clutter', hint: '.DS_Store, Thumbs.db, ._ files and similar.' },
  hardlink: { severity: 'info', label: 'Hard link', hint: 'Same data appears under several names. A plain copy duplicates it.' },
  'type-mismatch': { severity: 'warn', label: 'Wrong extension', hint: 'The content is a different type than the extension says (e.g. a HEIC photo named .jpg). Apps may refuse to open it.' },
};

function computeIssues(db, sourceId) {
  const src = db.prepare('SELECT path FROM sources WHERE id = ?').get(sourceId);
  const ins = db.prepare('INSERT INTO issues (source_id, entry_id, code, severity, detail) VALUES (?, ?, ?, ?, ?)');
  const rows = [];
  const add = (entryId, code, detail = null) => rows.push([sourceId, entryId, code, ISSUE_INFO[code].severity, detail]);
  const now = Date.now();
  const y1980 = Date.UTC(1980, 0, 1);

  let curParent = null;
  let groupCase = new Map();
  let groupNfc = new Map();
  const closeGroup = () => {
    for (const ids of groupCase.values()) if (ids.length > 1) for (const [id, name] of ids) add(id, 'case-collision', ids.map((x) => x[1]).join(' | '));
    for (const ids of groupNfc.values()) if (ids.length > 1) for (const [id] of ids) add(id, 'unicode-collision', ids.map((x) => x[1]).join(' | '));
    groupCase = new Map();
    groupNfc = new Map();
  };

  const it = db.prepare(`SELECT id, rel_path, parent, name, kind, size, mtime, nlink, link_target, error,
      (kind = 'dir' AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.source_id = e.source_id AND c.parent = e.rel_path)) AS is_empty_dir
    FROM entries e WHERE source_id = ? ORDER BY parent`).iterate(sourceId);
  for (const e of it) {
    if (e.parent !== curParent) { closeGroup(); curParent = e.parent; }
    const nfc = e.name.normalize('NFC');
    const lower = nfc.toLowerCase();
    if (!groupCase.has(lower)) groupCase.set(lower, []);
    // Only a case collision if the NFC forms differ by case, not by encoding.
    const sameCase = groupCase.get(lower);
    if (!sameCase.some(([, n]) => n.normalize('NFC') === nfc)) sameCase.push([e.id, e.name]);
    if (!groupNfc.has(nfc)) groupNfc.set(nfc, []);
    groupNfc.get(nfc).push([e.id, e.name]);

    if (e.error) add(e.id, 'unreadable', e.error);
    if (e.kind === 'symlink' && e.link_target !== null) {
      const target = path.resolve(src.path, e.parent, e.link_target);
      if (!fs.existsSync(target)) add(e.id, 'broken-link', e.link_target);
    }
    for (const p of nameProblems(e.name, 'exfat')) if (ISSUE_INFO[p]) add(e.id, p);
    if (e.rel_path.length > 240) add(e.id, 'path-too-long', String(e.rel_path.length));
    if (e.kind === 'file') {
      if (e.size === 0) add(e.id, 'empty-file');
      if (e.size > 4294967295) add(e.id, 'too-big-fat32');
      if (e.nlink > 1) add(e.id, 'hardlink', String(e.nlink));
    }
    if (e.is_empty_dir) add(e.id, 'empty-dir');
    if (isJunk(e.name)) add(e.id, 'junk');
    if (e.mtime !== null && (e.mtime < y1980 || e.mtime > now + 86400000)) add(e.id, 'odd-date', new Date(e.mtime).toISOString());
  }
  closeGroup();
  // Collisions are reported per group; drop accidental duplicates.
  const seen = new Set();
  const unique = rows.filter((r) => { const k = `${r[1]}:${r[2]}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (let i = 0; i < unique.length; i += 2000) tx(db, () => { for (const r of unique.slice(i, i + 2000)) ins.run(...r); });
  return unique.length;
}

const SIZE_BUCKETS = [
  ['0 B', 0, 0], ['< 1 KB', 1, 1023], ['1 KB – 1 MB', 1024, 1048575], ['1 – 10 MB', 1048576, 10485759],
  ['10 – 100 MB', 10485760, 104857599], ['100 MB – 1 GB', 104857600, 1073741823], ['≥ 1 GB', 1073741824, Number.MAX_SAFE_INTEGER],
];

function overview(db, sourceId) {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error(`Unknown source ${sourceId}`);
  const q = (sql, ...p) => db.prepare(sql).all(sourceId, ...p);
  const one = (sql, ...p) => db.prepare(sql).get(sourceId, ...p);

  const categories = q(`SELECT category AS key, COUNT(*) AS count, SUM(size) AS bytes FROM entries
    WHERE source_id = ? AND kind = 'file' GROUP BY category ORDER BY bytes DESC`);
  const extensions = q(`SELECT CASE ext WHEN '' THEN '(none)' ELSE ext END AS key, COUNT(*) AS count, SUM(size) AS bytes FROM entries
    WHERE source_id = ? AND kind = 'file' GROUP BY ext ORDER BY bytes DESC LIMIT 40`);
  const sizes = SIZE_BUCKETS.map(([key, lo, hi]) => ({ key, lo, hi, ...one(`SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM entries
    WHERE source_id = ? AND kind = 'file' AND size BETWEEN ? AND ?`, lo, hi) }));
  const years = q(`SELECT strftime('%Y', mtime / 1000, 'unixepoch') AS key, COUNT(*) AS count, SUM(size) AS bytes FROM entries
    WHERE source_id = ? AND kind = 'file' AND mtime IS NOT NULL GROUP BY key ORDER BY key DESC`);
  const depths = q(`SELECT depth AS key, COUNT(*) AS count, SUM(size) AS bytes FROM entries
    WHERE source_id = ? GROUP BY depth ORDER BY depth`);
  const topFolders = q(`SELECT rel_path AS key, tree_files AS count, tree_bytes AS bytes, depth FROM entries
    WHERE source_id = ? AND kind = 'dir' AND tree_bytes IS NOT NULL AND depth <= 3 ORDER BY tree_bytes DESC LIMIT 25`);
  const largest = q(`SELECT id, rel_path, size, mtime, category FROM entries
    WHERE source_id = ? AND kind = 'file' ORDER BY size DESC LIMIT 25`);
  const issues = q(`SELECT code AS key, severity, COUNT(*) AS count FROM issues WHERE source_id = ? GROUP BY code ORDER BY count DESC`)
    .map((r) => ({ ...r, label: (ISSUE_INFO[r.key] || {}).label || r.key, hint: (ISSUE_INFO[r.key] || {}).hint || '' }));
  const range = one(`SELECT MIN(mtime) AS oldest, MAX(mtime) AS newest, MAX(depth) AS maxDepth, AVG(size) AS avgSize FROM entries WHERE source_id = ? AND kind = 'file'`);
  const median = one(`SELECT size FROM entries WHERE source_id = ? AND kind = 'file' ORDER BY size LIMIT 1 OFFSET (SELECT COUNT(*) FROM entries WHERE source_id = ?1 AND kind = 'file') / 2`);
  const hashed = one(`SELECT COUNT(*) AS n FROM entries WHERE source_id = ? AND hash IS NOT NULL`);
  const dupes = one(`SELECT COUNT(*) AS groups, COALESCE(SUM(n - 1), 0) AS extra, COALESCE(SUM((n - 1) * size), 0) AS wasted FROM
    (SELECT hash, size, COUNT(*) AS n FROM entries WHERE source_id = ? AND kind = 'file' AND hash IS NOT NULL GROUP BY hash, size HAVING n > 1)`);

  // What is inside the files (filled by the inspect pass after a scan).
  const FJ = 'FROM entries e JOIN fileinfo f ON f.source_id = e.source_id AND f.rel_path = e.rel_path WHERE e.source_id = ?';
  const content = one(`SELECT COUNT(*) AS inspected, SUM(f.mismatch) AS mismatched, SUM(f.taken IS NOT NULL) AS withTaken,
      SUM(f.gps_lat IS NOT NULL) AS withGps, SUM(f.duration IS NOT NULL) AS withDuration, COALESCE(SUM(f.duration), 0) AS totalDuration,
      SUM(f.family IN ('image', 'video') AND f.taken IS NULL) AS mediaUndated, SUM(f.last_used IS NOT NULL) AS withLastUsed,
      SUM(f.tags IS NOT NULL) AS tagged, SUM(f.where_from IS NOT NULL) AS downloaded, SUM(f.error IS NOT NULL) AS failed,
      MIN(f.taken) AS takenFirst, MAX(f.taken) AS takenLast ${FJ}`);
  content.files = one(`SELECT COUNT(*) AS n FROM entries WHERE source_id = ? AND kind = 'file'`).n;
  const realTypes = q(`SELECT COALESCE(f.type, '(not recognised)') AS key, f.family AS family, COUNT(*) AS count, SUM(e.size) AS bytes, SUM(f.mismatch) AS mismatched ${FJ}
    GROUP BY key ORDER BY bytes DESC LIMIT 40`);
  const cameras = q(`SELECT f.camera AS key, COUNT(*) AS count, SUM(e.size) AS bytes, MIN(f.taken) AS oldest, MAX(f.taken) AS newest ${FJ} AND f.camera IS NOT NULL
    GROUP BY f.camera ORDER BY count DESC LIMIT 30`);
  const takenYears = q(`SELECT strftime('%Y', f.taken / 1000, 'unixepoch', 'localtime') AS key, COUNT(*) AS count, SUM(e.size) AS bytes ${FJ} AND f.taken IS NOT NULL
    GROUP BY key ORDER BY key DESC`);
  const artists = q(`SELECT f.artist AS key, COUNT(*) AS count, SUM(e.size) AS bytes, COALESCE(SUM(f.duration), 0) AS duration ${FJ} AND f.artist IS NOT NULL
    GROUP BY f.artist ORDER BY count DESC LIMIT 30`);
  const now = Date.now();
  const YEAR = 365.25 * 864e5;
  const lastUsed = [['Last 30 days', now - 30 * 864e5, now + 864e5], ['1–12 months', now - YEAR, now - 30 * 864e5], ['1–3 years', now - 3 * YEAR, now - YEAR],
    ['Over 3 years', 0, now - 3 * YEAR]].map(([key, lo, hi]) => ({ key, lo, hi, ...one(`SELECT COUNT(*) AS count, COALESCE(SUM(e.size), 0) AS bytes ${FJ}
      AND COALESCE(f.last_used, e.mtime) >= ? AND COALESCE(f.last_used, e.mtime) < ?`, lo, hi) }));

  return {
    content, realTypes, cameras, takenYears, artists, lastUsed,
    source, categories, extensions, sizes, years, depths, topFolders, largest, issues,
    range: { ...range, medianSize: median ? median.size : 0 },
    dupes: { ...dupes, hashedFiles: hashed.n },
  };
}

module.exports = { computeIssues, overview, ISSUE_INFO, SIZE_BUCKETS };
