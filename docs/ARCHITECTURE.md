# DataDeck architecture

DataDeck is a local data management cockpit. The long-term goal: point it at any
data source, understand what is in it through statistics and tables, decide
what to keep and how it should be organised, then export or restructure it
safely to any destination.

The pipeline every feature fits into:

```
 source  ──▶  scan  ──▶  analyze  ──▶  filter / select  ──▶  plan  ──▶  execute  ──▶  verify  ──▶  journal / undo
 (folder,      (catalog    (types, sizes,   (Explorer: any       (dry,      (copy/move   (SHA-256      (per-file
  later: S3,    in SQLite)  dates, dupes,    combination of       reviewable, or rsync)    read-back)    record)
  SFTP, ...)                issues)          filters, groups)     per file)
```

Nothing touches user files before the "execute" step, and execute only ever
does what a reviewed plan lists.

## Processes

```
┌──────────────────────── Electron main ───────────────────────┐
│ window, menus, dialogs, rsync runs (src/core), JSON store    │
│                                                              │
│   EngineClient ──postMessage──▶ worker thread                │
│   (method whitelist,           src/engine/worker.js          │
│    timeouts, auto-restart)     └ Engine (SQLite catalog,     │
│                                  scanner, analysis, planner, │
│                                  executor)                   │
└──────────────▲───────────────────────────────────────────────┘
               │ contextBridge (preload.js): window.deck
┌──────────────┴─────────────── Renderer (sandboxed) ──────────┐
│ plain JS views, virtual tables, no Node, strict CSP          │
└──────────────────────────────────────────────────────────────┘
```

* **The engine runs in a worker thread**, so scanning a million files or
  hashing a terabyte never blocks the window. If the worker crashes it is
  restarted, and the UI says so; plans that were running are marked
  `interrupted` and can be resumed.
* **One disk-heavy job at a time** (scan, duplicate check, plan run, undo).
  Queries stay available while a job runs.
* **The renderer can only call whitelisted engine methods** with plain data.
  Paths it sends are validated as absolute, and every SQL value is a bound
  parameter; sort columns and group keys come from fixed whitelists.

## The catalog (`src/engine/db.js`)

SQLite (Node's built-in `node:sqlite`), WAL mode, `synchronous=FULL`, foreign
keys on. It stores metadata and checksums only, never file contents.

| table | holds |
|---|---|
| `sources` | a root folder, its label, scan status (`new`, `scanning`, `ready`, `partial`) and totals |
| `entries` | one row per file, folder or link: relative path, parent, name, extension, category, size, recursive folder size and file count, mtime/ctime/birthtime, mode, uid/gid, device and inode (as text, from bigint stat), hard-link count, depth, link target, quick hash, SHA-256, read error |
| `issues` | portability and hygiene findings per entry |
| `plans` | a restructure plan: spec, summary, status, timestamps |
| `plan_ops` | the per-file journal: source, target, size and mtime at plan time, status, both checksums, note, error, time done |

Indexes cover every filter and group in the Explorer, so a 1M-row catalog is
paged and grouped in milliseconds; the UI only ever fetches the visible page.

## Scanning (`scanner.js`)

* `opendir` streaming with bounded concurrency, so huge folders don't load
  into memory at once.
* Symlinks are recorded, never followed. A `dev:ino` visited set prevents loops
  through bind mounts; an optional one-file-system mode stays on one volume.
* Unreadable folders and files are recorded with their error; the source is
  marked `partial` instead of failing the scan.
* Batched transactions keep inserts fast; recursive folder sizes and counts are
  computed after the walk.

## Analysis (`analysis.js`, `compat.js`, `dupes.js`)

* **Overview statistics:** by category, extension, size bucket, year, depth,
  largest folders (3 levels), largest files, median and range.
* **Issues:** names that collide when case is ignored or after Unicode
  normalisation (NFC/NFD, the macOS ↔ Linux trap), characters or reserved names
  invalid on Windows/exFAT/FAT32, trailing dots or spaces, names and paths over
  the target's length limits, files over 4 GB for FAT32, impossible dates, empty
  files and folders, system clutter, hard links, broken links, unreadable
  entries.
* **Duplicates:** three passes, so only real candidates are read in full: same
  size, then a quick hash of the first and last 64 KB, then a full SHA-256.

## Restructuring (`template.js`, `planner.js`, `executor.js`)

**Templates** build each target path from tokens: `{path} {parent} {top}
{name} {stem} {ext} {extdir} {category} {yyyy} {mm} {dd} {date} {sizeclass}
{source} {hash8}`. Every segment is sanitised for the chosen target file
system (APFS, ext4, NTFS, exFAT, FAT32) deterministically, and a joined path can
never escape the target root.

**Planning** is a dry run that writes only to the catalog:

* clashes inside the plan get " (2)", " (3)" … or are skipped, by choice;
* existing files at the target are never overwritten; same-size ones are
  compared by checksum at run time;
* free space is checked; same-device moves are detected;
* optional: skip clutter, keep one copy per duplicate group, prune emptied folders.

**Execution guarantees**, per file:

1. The source must still match the scan (size and mtime), else it is skipped
   with a note.
2. Data is written to a temp file next to the target (`O_EXCL`), hashed while
   copying, fsynced, then **read back and hashed again**.
3. The temp file is published with `link()`, which fails instead of replacing
   an existing file (a check-then-rename fallback covers file systems without
   hard links).
4. Moves on the same device use link + unlink and never copy data. Moves
   across devices delete the source only after the verified copy is published.
5. Each step is journaled in `plan_ops` before and after it happens. After a
   crash or power cut, `recover()` inspects half-done operations, removes stray
   temp files and continues.
6. Emptied source folders are removed with `rmdir` only. DataDeck never deletes
   a file that is not in the plan.
7. **Undo** walks the journal backwards: moved files go back (verified), copies
   are deleted only if their checksum still matches what was written.

## Sync (`src/core`)

The rsync layer from SyncDeck is kept as the "transfer" module: argument
arrays with `--` before paths (no shell), blocked dangerous options, delete
guard rails, `--partial-dir` resume with retries and backoff on network exit
codes, and a checksum verify pass after every run.

## Testing

| suite | what it proves |
|---|---|
| `test/unit` (54) | rsync arguments, parsers, safety rules, retry state machine |
| `test/engine` (32) | scan edge cases (unicode, links, loops, unreadable, 20k files), issue rules, duplicates, every restructure guarantee above including injected corruption, simulated crash and recovery, changed sources, cross-device moves and undo |
| `test/integration` (17) | real rsync: hostile names, mirror/delete limits, corruption detection, network cuts and flapping links |
| `test/e2e` (5) | the real app: add source → analyze → filter → plan → verified copy → undo, plus four sync scenarios |

All of it also passes as an unprivileged user, where permission errors are real.

## Roadmap

Next increments, in the order they add the most value:

1. **Content-aware types:** magic-byte sniffing so a `.jpg` that is really a
   HEIC, or a file with no extension, is classified correctly.
2. **Media metadata:** EXIF capture date, camera, GPS, video duration, audio
   tags. Unlocks `{taken:yyyy}` templates and "photos without a date" filters.
3. **Saved views and selections:** name a filter, pin it, compare two sources
   (what's only in A, only in B, different content).
4. **More sources and destinations:** SFTP/SSH, SMB/NAS shares, S3-compatible
   storage, and archives (zip/tar) read as virtual folders, all through one
   source interface so scan/analyze/plan work unchanged.
5. **Export formats:** CSV exists; add Excel, JSON manifests with checksums,
   and verifiable bag/manifest files for long-term archives.
6. **Rules:** reusable restructure recipes ("Camera uploads → Photos/yyyy/mm,
   skip duplicates") that can run on a schedule, always through a reviewed plan.
