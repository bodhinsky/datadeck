# DataDeck

A local data management cockpit for macOS. Point it at a folder of any depth,
see what is in it as statistics and sortable tables, look inside the files
(real type, date taken, camera, location, length, tags, pages, last opened),
find duplicates and names
that will break on other systems, and decide what the clean result should look
like. Decisions are staged and committed against a metadata copy of the tree,
reviewed commit by commit with before/after tables, validated, and only then
exported. Every written file is verified by SHA-256, journaled and can be
undone. Folder-to-folder or folder-to-server sync with rsync is built in.

![Overview](docs/screenshots/1-overview.png)

## Quick start (on your Mac)

```bash
brew install node rsync     # rsync 3.x is only needed for the Sync page
cd syncdeck
npm install
npm start                   # run the app
npm run dist                # optional: build dist/DataDeck-1.0.0-arm64.dmg
```

The app is not code-signed. If macOS refuses to open a built `.app`, right-click
it and choose **Open**, or run `xattr -cr /Applications/DataDeck.app`.

## Pages

| | |
|---|---|
| **Sources** | Any folder, any depth. Scanned into a local catalog (metadata only, never file contents). Symlinks are recorded but not followed; unreadable parts are listed instead of stopping the scan. |
| **Overview** | Files, size, depth, date range, duplicates and issues at a glance, plus tables by type, size class, year, extension, depth, largest folders and largest files. *Inside the files*: real types (and how many are misnamed), date taken by year, cameras and phones, artists, last opened. Every row opens the Explorer filtered to it. |
| **Explorer** | One virtual table for millions of entries. Filter by name pattern, path, extension, type, size, date, depth, issues or duplicates, and by content: real type, wrong extension, date taken, camera, location, artist, Finder tag, not opened for N years. Group by any of these; sort any column; export the result as CSV with all details. |
| **Details panel** | Click a row: a preview (images, text; on a Mac also HEIC, RAW, video, PDF and Office through Quick Look) and everything known about the file: planned path and the change behind it, real type, EXIF (date taken, camera, lens, exposure, GPS), video length and codec, audio tags, document title/author/pages, last opened, Finder tags, download source, identical copies. Walk with ↑↓, select with Space, exclude with E. |
| **Duplicates** | Byte-identical files: size, then a quick fingerprint, then a full SHA-256. Shows reclaimable space per group. Click a group to compare the copies side by side (differences highlighted) and keep one. Never deletes anything; “Keep one of each” stages leaving the extra copies out. |
| **Issues** | Case and Unicode collisions, names invalid on Windows/exFAT/FAT32, trailing dots, too-long names and paths, >4 GB files for FAT32, odd dates, empty files and folders, clutter, broken links, unreadable entries. |
| **Explorer actions** | Select rows (or everything matching the filter) and stage Exclude, Include, Move to…, Rename… or Fix names. Every row shows its planned path and a marker: moved, renamed, excluded, collides, bad name, changed on disk. |
| **Layout** | Stage a folder structure for a selection from presets or a template such as `{category}/{yyyy}/{mm}/{name}` or `Photos/{taken_yyyy}/{taken_date}/{name}`, with a live preview. Content tokens: `{taken_yyyy}` `{taken_mm}` `{taken_dd}` `{taken_date}` `{camera}` `{artist}` `{album}` `{shape}`, and `{stem}.{realext}` repairs wrong extensions. |
| **Changes** | The review-first pipeline: staged changes, commits, a before/after diff per commit with an explicit “I checked these changes”, a statistics view of the planned folders, and *Validate & export*: a checklist (all committed, all reviewed, no collisions, sources re-checked against the disk, nothing changed since the scan) plus a final acknowledgement before an export plan can be built. |
| **Exports & undo** | Every export with its per-file journal: what went where, both checksums, the result. Resume interrupted exports, save the journal as CSV, undo finished ones. |
| **Sync** | Saved rsync profiles: preview, mirror or copy, automatic reconnects after network drops, checksum verification afterwards, live log and history. |
| **Jobs / Settings** | Background work with progress and cancel; rsync path, notifications, keep-awake, light/dark/auto theme. |

Shortcuts: `⌘O` add source, `⌘N` new sync profile, `⌘⇧P` sync preview, `⌘R` run sync, `⌘.` stop.

| | |
|---|---|
| ![Explorer with staged changes](docs/screenshots/2-explorer.png) | ![Details panel](docs/screenshots/2b-details.png) |
| ![Inside the files](docs/screenshots/1b-inside-files.png) | ![Compare copies](docs/screenshots/3b-compare.png) |
| ![Staged changes](docs/screenshots/6-staged.png) | ![Layout by date taken](docs/screenshots/5-layout.png) |
| ![Reviewing a commit](docs/screenshots/7-review.png) | ![Export gate](docs/screenshots/8-export-gate.png) |
| ![Collisions](docs/screenshots/8b-collisions.png) | ![Export done](docs/screenshots/9-export-done.png) |
| ![Duplicates](docs/screenshots/3-duplicates.png) | ![Sync](docs/screenshots/10-sync-preview.png) |

## Data integrity and safety

**Review-first changes**

* Staging and committing only change metadata. Files are written by one path
  only: an export built from reviewed commits after the validation checklist
  passes, which the engine enforces itself (the window cannot bypass it).
* The export plan remembers the exact planned state it was built from and is
  refused if anything changed after the review.
* Sources are re-checked against the disk before export; files that changed
  since the scan block the export until you rescan or exclude them.

**Writing files**

* Nothing is touched until you run an export plan you have inspected.
* Each file is written under a temporary name, fsynced, **read back and
  compared by SHA-256**, and published with an operation that fails rather than
  replace an existing file. Existing files are never overwritten.
* A file that changed since the scan is skipped, not copied in a half-known state.
* Moves on the same disk are renames (no data copied). Moves across disks
  delete the original only after the verified copy exists.
* Every step is journaled in SQLite (WAL, full sync). After a crash or power
  cut the plan shows as interrupted; resuming cleans up and continues.
* Undo moves files back (verified) or deletes copies only if they are still
  exactly what was written. Files you edited afterwards are left alone.
* Emptied folders are removed with `rmdir` only: DataDeck never deletes a file
  that is not part of the plan.

**Sync (rsync)**

* Dry-run preview first; delete is off by default, needs confirmation, is capped
  by `--max-delete`, and is refused for an empty source (an unmounted drive),
  system folders, or nested source/destination.
* Resume after network trouble with `--partial-dir`, stall timeouts, and
  automatic retries with backoff on network exit codes.
* A checksum verify pass after the copy catches silent corruption.
* rsync is spawned without a shell, paths come after `--`, dangerous extra
  options are refused, SSH runs in batch mode with host-key checking.

**Reading file contents**

* File details are read after each scan, only for new or changed files, and
  only as much as each format needs (4 KB to tell the type, up to 256 KB for
  metadata; MP4/MOV boxes and zip directories are read by offset).
* The parsers are plain JavaScript with bounds checks on every offset and are
  fuzzed with truncated and corrupted files in the tests. Nothing is executed,
  decompressed beyond 2 MB, or sent anywhere.
* Previews take a catalog id, never a path, refuse links and files that
  changed since the scan, and are rendered as images or text only.

**App**

* The heavy work runs in a worker thread, so the window stays responsive; one
  disk-heavy job at a time; the worker restarts itself after a crash.
* Sandboxed renderer with context isolation, no Node access, strict
  Content-Security-Policy, navigation blocked, file names always rendered as
  text, whitelisted engine calls with bound SQL parameters.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.

## Tests

```bash
npm test             # unit + engine + integration (126 tests; rsync needed for integration)
npm run test:e2e     # drives the real app with Playwright (Linux: xvfb-run -a npm run test:e2e)
npm run screenshots  # regenerates docs/screenshots
```

* **Unit** (54): rsync arguments, parsers, safety rules, retry state machine.
* **Engine** (55): file details from real photo, video, audio, PDF and Office
  fixtures (EXIF with time zones and GPS, HEIC via iloc, QuickTime keys,
  ID3/FLAC/MP4 tags), misnamed files, a fuzz pass over corrupted files,
  previews, the content filters/groups/tokens, and rescans that re-read only
  changed files; the review-first workspace (staging never touches files, folder moves carry content, collisions per file system, the export gate, re-check, stale plans refused, in-place apply, rescan survival); scanning odd trees (300 levels deep, Unicode, symlink loops,
  unreadable folders, 20k files), issue rules, duplicates, CSV export, and every
  restructure guarantee with injected corruption, simulated crashes, changed
  sources, cross-device moves and undo.
* **Integration** (17): real rsync with hostile file names, delete limits,
  corruption detection, and network drills with a proxy that cuts, freezes and
  flaps the link.
* **End-to-end** (6): file details (overview, wrong-extension drill-down,
  preview panel, keyboard triage, path-free previews, side-by-side compare);
  the real app, from adding a source through analysis,
  staging (dedupe, exclude, rename, layout), commit, review, re-check, a
  verified export and undo; plus preview/mirror/verify,
  stop and resume, the empty-source guard and a network drop.

A GitHub Actions workflow runs all of it on macOS and Linux.

## Layout

```
main.js                 Electron main: window, IPC, menus, rsync runs, previews (src/preview.js)
preload.js              the small API the UI is allowed to use
src/engine/             catalog + analysis + restructure (runs in a worker thread)
  db.js                 SQLite schema
  scanner.js            streaming folder scan
  analysis.js query.js  statistics, filters, grouping
  compat.js             file-system rules and name sanitising
  dupes.js hash.js      duplicate detection
  inspect.js fileinfo.js   what is inside files: type sniffing, EXIF/video/audio/document metadata, Spotlight
  changes.js            staged changes, commits, planned state, export gate
  template.js planner.js executor.js   export plans, verified execution, recovery, undo
  engine.js worker.js client.js        job control and the worker bridge
src/core/               rsync: arguments, safety, runner, parsers
src/renderer/           the UI (plain HTML/CSS/JS, bundled fonts)
test/                   unit, engine, integration, e2e
```
