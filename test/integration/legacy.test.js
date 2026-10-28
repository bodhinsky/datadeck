'use strict';
// Simulates a limited rsync (like macOS openrsync or Apple's 2.6.9) by
// wrapping the real one and rejecting newer options. Checks that feature
// probing notices, and that a sync still completes and verifies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SyncRun, detectRsync } = require('../../src/core/runner');
const { newProfile } = require('../../src/core/args');
const { tmpdir, snapshot, write, randomBytes, hasRsync } = require('../helpers/fsutil');

const skip = hasRsync() ? false : 'rsync not installed';
const root = tmpdir('sd-legacy-');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeRsync() {
  const real = execFileSync('sh', ['-c', 'command -v rsync']).toString().trim();
  const f = path.join(root, 'limited-rsync');
  fs.writeFileSync(f, `#!/bin/sh
for a in "$@"; do
  case "$a" in
    --version) echo "rsync  version 2.6.9  protocol version 29"; exit 0;;
    --out-format=*|--partial-dir=*|--info=*|--max-delete=*|--backup-dir=*|-s|-X|-A) echo "rsync: $a: unknown option" >&2; exit 1;;
  esac
done
exec ${real} "$@"
`);
  fs.chmodSync(f, 0o755);
  return f;
}

test('limited rsync: probing detects missing features and the sync still verifies', { skip }, async () => {
  const bin = fakeRsync();
  const info = await detectRsync(bin);
  assert.equal(info.ok, true);
  assert.equal(info.modern, false);
  for (const k of ['outFormat', 'partialDir', 'progress2', 'maxDelete', 'protectArgs', 'xattrs']) assert.equal(info.caps[k], false, k);
  for (const k of ['progress', 'stats', 'timeout', 'endOfOptions']) assert.equal(info.caps[k], true, k);

  const src = path.join(root, 'src');
  const dst = path.join(root, 'dst');
  write(src, 'a b.txt', 'hello');
  write(src, 'big.bin', randomBytes(400000, 2));
  write(dst, 'stale', 'x');
  const p = newProfile({ source: src, dest: dst, flags: { archive: true, delete: true }, network: { retries: 0 } });

  const preview = await new SyncRun({ bin, profile: p, caps: info.caps, dryRun: true }).start();
  assert.equal(preview.status, 'success', preview.message);
  assert.equal(preview.counts.new, 2);
  assert.equal(preview.counts.delete, 1);

  const run = new SyncRun({ bin, profile: p, caps: info.caps });
  const prog = [];
  run.on('progress', (e) => prog.push(e.overall));
  const r = await run.start();
  assert.equal(r.status, 'success', r.message);
  assert.equal(r.verify.ok, true);
  assert.ok(prog.length > 0, 'per-file progress still reported');
  assert.deepEqual(snapshot(dst), snapshot(src));
});

test('a binary that is not rsync is rejected', { skip }, async () => {
  const info = await detectRsync('/bin/echo');
  assert.equal(info.ok, false);
  const missing = await detectRsync(path.join(root, 'nope'));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/);
});
