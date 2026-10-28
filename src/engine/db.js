'use strict';
// The catalog: one SQLite file holding every scanned entry, analysis results,
// restructure plans and their per-file journal. Uses Node's built-in sqlite
// (no native module to compile), WAL mode, and full fsync so the journal of a
// running restructure survives a crash or power loss.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  scanned_at INTEGER,
  scan_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  files INTEGER NOT NULL DEFAULT 0,
  dirs INTEGER NOT NULL DEFAULT 0,
  links INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  fs_dev TEXT,
  options TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  parent TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  tree_bytes INTEGER,
  tree_files INTEGER,
  mtime INTEGER,
  ctime INTEGER,
  btime INTEGER,
  mode INTEGER,
  uid INTEGER,
  gid INTEGER,
  dev TEXT,
  ino TEXT,
  nlink INTEGER,
  depth INTEGER NOT NULL,
  link_target TEXT,
  hash TEXT,
  qhash TEXT,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_entries_path ON entries(source_id, rel_path);
CREATE INDEX IF NOT EXISTS ix_entries_kind ON entries(source_id, kind, size);
CREATE INDEX IF NOT EXISTS ix_entries_ext ON entries(source_id, ext);
CREATE INDEX IF NOT EXISTS ix_entries_cat ON entries(source_id, category);
CREATE INDEX IF NOT EXISTS ix_entries_mtime ON entries(source_id, mtime);
CREATE INDEX IF NOT EXISTS ix_entries_parent ON entries(source_id, parent);
CREATE INDEX IF NOT EXISTS ix_entries_hash ON entries(source_id, hash);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  entry_id INTEGER REFERENCES entries(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_issues_src ON issues(source_id, code);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS plan_ops (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  entry_id INTEGER,
  op TEXT NOT NULL,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  src_hash TEXT,
  dst_hash TEXT,
  error TEXT,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ops_plan ON plan_ops(plan_id, seq);
CREATE INDEX IF NOT EXISTS ix_ops_status ON plan_ops(plan_id, status);

-- Workspace: decisions are recorded as changes against the catalog, grouped
-- into commits, reviewed, and only then exported. Files are never touched
-- while staging or committing.
CREATE TABLE IF NOT EXISTS workspaces (
  source_id INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  target_fs TEXT NOT NULL DEFAULT 'apfs',
  version INTEGER NOT NULL DEFAULT 0,
  state_hash TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  checked_at INTEGER,
  checked_version INTEGER
);

CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'committed',
  reviewed_at INTEGER,
  plan_id INTEGER
);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  commit_id INTEGER REFERENCES commits(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  op TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  items INTEGER NOT NULL DEFAULT 0,
  affected INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_changes_src ON changes(source_id, seq);

-- What a change applies to, by path, so it survives a rescan.
CREATE TABLE IF NOT EXISTS change_items (
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_citems ON change_items(change_id);

-- The computed planned state; only entries that differ or have findings.
CREATE TABLE IF NOT EXISTS vstate (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL,
  vpath TEXT NOT NULL,
  flags INTEGER NOT NULL DEFAULT 0,
  change_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_vstate_src ON vstate(source_id, flags);

-- What is inside each file (inspect.js). Keyed by path, not entry id, so it
-- survives a rescan; size and mtime say which version of the file it describes.
CREATE TABLE IF NOT EXISTS fileinfo (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  size INTEGER, mtime INTEGER,
  type TEXT, mime TEXT, family TEXT, mismatch INTEGER NOT NULL DEFAULT 0,
  taken INTEGER, width INTEGER, height INTEGER, duration REAL,
  camera TEXT, lens TEXT, gps_lat REAL, gps_lon REAL,
  title TEXT, artist TEXT, album TEXT, author TEXT, pages INTEGER, bitrate INTEGER, created INTEGER,
  last_used INTEGER, tags TEXT, where_from TEXT,
  extra TEXT, error TEXT, inspected_at INTEGER,
  PRIMARY KEY (source_id, rel_path)
);
CREATE INDEX IF NOT EXISTS ix_fi_taken ON fileinfo(source_id, taken);
CREATE INDEX IF NOT EXISTS ix_fi_camera ON fileinfo(source_id, camera);
CREATE INDEX IF NOT EXISTS ix_fi_type ON fileinfo(source_id, type);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec(SCHEMA);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
  if (!row) db.prepare("INSERT INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  return db;
}

// Runs fn inside a transaction; rolls back on any error.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

module.exports = { openDb, tx, SCHEMA_VERSION };
