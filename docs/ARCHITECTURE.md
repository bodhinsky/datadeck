# DataDeck architecture

DataDeck is a local data management cockpit. The long-term goal: point it at any
data source, understand what is in it through statistics and tables, decide
what to keep and how it should be organised, then export or restructure it
safely to any destination.

The pipeline every feature fits into:

```
 source ─▶ scan ─▶ inspect ─▶ analyze ─▶ decide ──────────────▶ commit ─▶ review ─▶ validate ─▶ export ─▶ verify ─▶ journal / undo
 (folder)  (catalog) (types,    (stats,   (stage changes on a     (group,   (per-commit (collisions,  (plan from  (SHA-256  (per-file
                     EXIF,      dupes,     metadata copy of the     message)  before/after, re-check     the planned read-back) record)
                     issues)    tree: exclude, move,               explicit ack) against disk, state only)
                                rename, layout, fix                              final ack)
                                names, keep one copy)
```

Everything left of "export" works on metadata only. Files are written by
exactly one path: an export plan built from a reviewed, validated planned
state, which the user inspects operation by operation and then runs.

## The workspace (review-first changes)

`src/engine/changes.js`. Each source has a workspace:

* **Changes** are decisions: `exclude`, `include`, `move` (to a folder),
  `rename`, `layout` (a path template), `sanitize` (fix names for a target file
  system) and `dedupe` (keep one copy by rule). A change stores what it applies
  to as relative paths (`change_items`), so it survives a rescan; paths that no
  longer exist are counted as missing, never guessed.
* **Staged** changes are uncommitted. **Commits** group them with a message.
  A commit is `committed` until the user reviews its before/after table and
  acknowledges it (`reviewed`). After a copy export it is `exported`; after an
  in-place move it is `applied` and stops shaping the planned state, because
  the next scan already shows it.
* **The planned state** (`vstate`) is recomputed from the catalog plus every
  active change, in order. Folders carry their content; a folder and its files
  selected together move once. Each entry gets flags: moved, renamed, excluded,
  collides (same target path, case-insensitive where the target is), clash (a
  file where a folder must be), bad name (invalid on the target file system),
  changed on disk. The table views page, sort and filter it like the catalog.
* **A version** identifies the planned state (a hash of all paths and flags).
  It only moves when the state really changes.
* **Validation before export**, enforced in the engine, not only in the UI:
  nothing staged, every commit reviewed, no collisions, the sources re-checked
  against the disk *for this exact version*, no file changed since the scan,
  and an explicit final acknowledgement. The export plan records the version
  it was built from; running it is refused if the state changed afterwards.
* The renderer cannot build a plan any other way: `plan.create` is not part of
  the IPC whitelist.

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
| `workspaces` | per source: target file system, planned-state version and hash, last re-check |
| `changes`, `change_items` | staged or committed decisions and the paths they apply to |
| `commits` | message, status (committed, reviewed, exported, applied), export plan |
| `vstate` | the computed planned path and flags of every entry that differs |
| `fileinfo` | per path: real type, extension mismatch, date taken, size in pixels, duration, camera, lens, GPS, title, artist, album, author, pages, last opened, Finder tags, where from, extras as JSON |

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

## Inside the files (`inspect.js`, `fileinfo.js`, `src/preview.js`)

After every scan an inspect pass reads new and changed files:

* **Type sniffing** from the first 4 KB (JPEG, PNG, GIF, WebP, HEIC/AVIF, TIFF
  and RAW, MP4/MOV/M4A, Matroska, MP3, FLAC, WAV, Ogg, PDF, Office/OpenDocument/
  EPUB inside zip, archives, SQLite, executables, fonts, text/HTML/XML). A file
  whose extension belongs to a different type is flagged `type-mismatch`.
* **Metadata**, pure JavaScript with bounds checks: EXIF/TIFF (date taken with
  time zone, camera, lens, exposure, GPS, orientation) in JPEG, PNG, WebP,
  TIFF and HEIC (via `iinf`/`iloc`); ISO-BMFF `moov` (duration, size, codec,
  creation date, QuickTime keys: iPhone model and location); ID3v2, FLAC Vorbis
  comments, iTunes `ilst`; WAV; PDF pages/title/author; Office `docProps`,
  ODF `meta.xml`, EPUB OPF.
* **Spotlight** on macOS: `mdls` in batches for last opened, Finder tags and
  "Where from". These change without the file changing, so they are refreshed
  on every pass.
* Stored in `fileinfo`, keyed by (source, relative path) with the size and
  mtime it describes, so it survives rescans and goes stale visibly.
* Every query joins it (`FI_JOIN`), so filters, groups, sorts, CSV export,
  layout templates and the planned state can all use it.
* **Previews** run in the main process: the renderer sends an entry id, the
  engine resolves the path from the catalog, links and changed files are
  refused. Small images are sent as they are (EXIF rotation applies); on macOS
  and Windows other files get an OS thumbnail (Quick Look); text gets its first
  6 KB.

## Export execution (`template.js`, `planner.js`, `executor.js`)

**Templates** build each target path from tokens: `{path} {parent} {top}
{name} {stem} {ext} {extdir} {category} {yyyy} {mm} {dd} {date} {sizeclass}
{source} {hash8}`, and from the file contents `{taken_yyyy} {taken_mm}
{taken_dd} {taken_date}` (date taken, else created, else modified) `{camera}
{artist} {album} {shape} {realext}`. Every segment is sanitised for the chosen target file
system (APFS, ext4, NTFS, exFAT, FAT32) deterministically, and a joined path can
never escape the target root.

**Planning** an export is a dry run that writes only to the catalog:

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
| `test/engine` (55) | file details from real fixtures, HEIC, misnamed files, fuzzed corrupt files, previews, content filters and tokens, re-read only changed files;  scan edge cases (unicode, links, loops, unreadable, 20k files), issue rules, duplicates, every restructure guarantee above including injected corruption, simulated crash and recovery, changed sources, cross-device moves and undo; and the workspace: staging never touches files, folder carry, collisions per file system, the export gate, re-check, stale plans refused, in-place apply, rescan survival, dedupe rules |
| `test/integration` (17) | real rsync: hostile names, mirror/delete limits, corruption detection, network cuts and flapping links |
| `test/e2e` (6) | file details panel, compare, keyboard triage; the real app: add source → analyze → stage (dedupe, exclude, rename, layout) → commit → review → re-check → export → undo, plus four sync scenarios |

All of it also passes as an unprivileged user, where permission errors are real.

## Roadmap

Next increments, in the order they add the most value:

1. ~~Content-aware types~~ and ~~media metadata~~: done (see *Inside the files*).
2. **Similar files:** perceptual hashes for near-duplicate photos (resized,
   re-encoded), versions of the same document, same name with different content.
3. **Suggestions and bulk review:** one-click proposals ("14 photos without a
   date taken", "3 misnamed files") and per-row approve/reject inside a commit.
4. **Saved views and selections:** name a filter, pin it, compare two sources
   (what's only in A, only in B, different content).
5. **More sources and destinations:** SFTP/SSH, SMB/NAS shares, S3-compatible
   storage, and archives (zip/tar) read as virtual folders, all through one
   source interface so scan/analyze/plan work unchanged.
6. **Export formats:** CSV exists; add Excel, JSON manifests with checksums,
   and verifiable bag/manifest files for long-term archives.
7. **Change review extras:** per-row approve/reject inside a commit, side-by-side tree view of before/after, and comments on commits.
8. **Rules:** reusable restructure recipes ("Camera uploads → Photos/yyyy/mm,
   skip duplicates") that can run on a schedule, always through a reviewed plan.
