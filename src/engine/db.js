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
