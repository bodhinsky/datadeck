'use strict';
// Runs the real rsync binary through SyncRun against temp folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SyncRun, detectRsync } = require('../../src/core/runner');
const { newProfile, PARTIAL_DIR } = require('../../src/core/args');
const { validateProfile } = require('../../src/core/safety');
const { tmpdir, snapshot, write, randomBytes, hasRsync } = require('../helpers/fsutil');

const skip = hasRsync() ? false : 'rsync not installed';
let caps = { modern: true };
const roots = [];
test.before(async () => {
  if (skip) return;
  const info = await detectRsync('rsync');
  caps = { modern: info.modern };
});
test.after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function setup() {
  const root = tmpdir('sd-int-');
  roots.push(root);
  const src = path.join(root, 'src');
  const dst = path.join(root, 'dst');
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  return { root, src, dst };
}

async function sync(profile, opts = {}) {
  const p = newProfile({ ...profile, network: { retries: 0, timeout: 30, ...(profile.network || {}) } });
  const v = validateProfile(p);
  assert.deepEqual(v.errors, [], 'profile should validate');
  const run = new SyncRun({ profile: p, caps, backoff: () => 10, ...opts });
  if (opts.onRun) opts.onRun(run);
  return run.start();
}

const NASTY = [
  'plain.txt',
  'with space.txt',
  '-leading-dash.txt',
  '--delete',
  'quote\'s "double".txt',
  '$(touch PWNED_SUBST)',
  '`touch PWNED_TICK`',
  'semi; touch PWNED_SEMI',
  'pipe | and & amp',
  'ünïcødé/ñame-日本語-🙂.txt',
  'star*and?question[1].txt',
  'back\\slash.txt',
  'deep/a/b/c/d/e/f/g/file',
  `${'long'.repeat(50)}.txt`,
  'empty-file',
  '.hidden',
];

test('copies a tree of hostile file names byte-for-byte and verifies', { skip }, async () => {
  const { root, src, dst } = setup();
  NASTY.forEach((n, i) => write(src, n, n === 'empty-file' ? '' : `content ${i} ${n}\n`));
  write(src, 'big.bin', randomBytes(6 * 1024 * 1024, 7));
  fs.symlinkSync('plain.txt', path.join(src, 'link-to-plain'));
  fs.chmodSync(path.join(src, 'plain.txt'), 0o640);

  const r = await sync({ source: src, dest: dst });
  assert.equal(r.status, 'success', r.message);
  assert.equal(r.verify.ok, true);
  assert.deepEqual(snapshot(dst), snapshot(src));
  assert.equal(fs.statSync(path.join(dst, 'plain.txt')).mode & 0o777, 0o640, 'permissions kept');
  assert.equal(fs.readlinkSync(path.join(dst, 'link-to-plain')), 'plain.txt', 'symlink kept as link');
  for (const f of ['PWNED_SUBST', 'PWNED_TICK', 'PWNED_SEMI']) {
    for (const dir of [root, src, dst, process.cwd()]) assert.equal(fs.existsSync(path.join(dir, f)), false, `${f} must not exist`);
  }
});

test('hostile source and destination folder names are used literally', { skip }, async () => {
  const { root } = setup();
  const src = path.join(root, 'src; touch PWNED_A $(touch PWNED_B)');
  const dst = path.join(root, '-dst `touch PWNED_C`');
  write(src, 'x', 'x');
  const r = await sync({ source: src, dest: dst });
  assert.equal(r.status, 'success', r.message);
  assert.equal(fs.readFileSync(path.join(dst, 'x'), 'utf8'), 'x');
  for (const f of ['PWNED_A', 'PWNED_B', 'PWNED_C']) assert.equal(fs.existsSync(path.join(root, f)) || fs.existsSync(f), false);
});

test('preview (dry run) reports changes and touches nothing', { skip }, async () => {
  const { src, dst } = setup();
  write(src, 'new.txt', 'n');
  write(src, 'changed.txt', 'version 2 longer');
  write(dst, 'changed.txt', 'v1');
  write(dst, 'extra.txt', 'e');
  const before = snapshot(dst);
  const r = await sync({ source: src, dest: dst, flags: { archive: true, delete: true } }, { dryRun: true });
  assert.equal(r.status, 'success');
  assert.deepEqual(snapshot(dst), before, 'destination unchanged');
  assert.equal(r.counts.new, 1);
  assert.equal(r.counts.update, 1);
  assert.equal(r.counts.delete, 1);
  assert.equal(fs.existsSync(path.join(dst, PARTIAL_DIR)), false);
});

test('copy-only mode never deletes, mirror mode does', { skip }, async () => {
  const { src, dst } = setup();
  write(src, 'a', 'a');
  write(dst, 'keep-me', 'k');
  let r = await sync({ source: src, dest: dst });
  assert.equal(r.status, 'success');
  assert.ok(fs.existsSync(path.join(dst, 'keep-me')));
  r = await sync({ source: src, dest: dst, flags: { archive: true, delete: true } });
  assert.equal(r.status, 'success', r.message);
  assert.equal(fs.existsSync(path.join(dst, 'keep-me')), false);
  assert.deepEqual(snapshot(dst), snapshot(src));
});

test('max-delete limit stops mass deletion', { skip }, async () => {
  const { src, dst } = setup();
  write(src, 'only', 'o');
  for (let i = 0; i < 10; i++) write(dst, `old-${i}`, 'x');
  const r = await sync({ source: src, dest: dst, flags: { archive: true, delete: true }, safety: { maxDelete: 3, verifyAfter: false } });
  assert.equal(r.status, 'warning', r.message);
  const left = fs.readdirSync(dst).filter((n) => n.startsWith('old-')).length;
  assert.ok(left >= 7, `at most 3 deleted, ${10 - left} were`);
});

test('backup mode keeps the replaced and deleted versions', { skip }, async () => {
  const { src, dst } = setup();
  write(src, 'doc.txt', 'new text');
  write(dst, 'doc.txt', 'old text!');
  write(dst, 'removed.txt', 'bye');
  const r = await sync({ source: src, dest: dst, flags: { archive: true, delete: true }, safety: { backup: true, backupDir: '.syncdeck-old', maxDelete: 10 }, excludes: ['.syncdeck-old/'] });
  assert.equal(r.status, 'success', r.message);
  assert.equal(fs.readFileSync(path.join(dst, 'doc.txt'), 'utf8'), 'new text');
  assert.equal(fs.readFileSync(path.join(dst, '.syncdeck-old', 'doc.txt'), 'utf8'), 'old text!');
  assert.equal(fs.readFileSync(path.join(dst, '.syncdeck-old', 'removed.txt'), 'utf8'), 'bye');
});

test('silent corruption (same size and mtime) is caught by the verify pass', { skip }, async () => {
  const { src, dst } = setup();
  write(src, 'photo.raw', randomBytes(200000, 3));
  write(src, 'ok.txt', 'fine');
  let r = await sync({ source: src, dest: dst });
  assert.equal(r.status, 'success');

  // Flip bytes on the destination but keep size and modification time, the
  // way a bad disk or cable would. rsync's quick check cannot see this.
  const f = path.join(dst, 'photo.raw');
  const st = fs.statSync(f);
  const buf = fs.readFileSync(f);
  buf[1000] ^= 0xff;
  buf[150000] ^= 0x55;
  fs.writeFileSync(f, buf);
  fs.utimesSync(f, st.atime, st.mtime);

  r = await sync({ source: src, dest: dst });
  assert.equal(r.status, 'verify-failed', 'quick-check sync misses it, verify catches it');
  assert.deepEqual(r.verify.mismatches.map((m) => m.path), ['photo.raw']);

  r = await sync({ source: src, dest: dst, flags: { archive: true, checksum: true } });
  assert.equal(r.status, 'success', 'checksum mode repairs it');
  assert.equal(r.verify.ok, true);
  assert.deepEqual(snapshot(dst), snapshot(src));
});

test('excludes are honoured and the partial folder is never copied', { skip }, async () => {
  const { src, dst } = setup();
  write(src, 'keep.txt', 'k');
  write(src, 'skip.tmp', 's');
  write(src, 'node_modules/x.js', 'x');
  write(src, `${PARTIAL_DIR}/leftover`, 'l');
  const r = await sync({ source: src, dest: dst, excludes: ['*.tmp', 'node_modules/'] });
  assert.equal(r.status, 'success', r.message);
  assert.deepEqual(fs.readdirSync(dst).sort(), ['keep.txt']);
});

test('copy folder itself vs. its contents', { skip }, async () => {
  const { src, dst } = setup();
  write(src, 'f', 'f');
  await sync({ source: src, dest: dst, contents: false });
  assert.ok(fs.existsSync(path.join(dst, 'src', 'f')));
  const d2 = path.join(path.dirname(dst), 'dst2');
  await sync({ source: src, dest: d2, contents: true });
  assert.ok(fs.existsSync(path.join(d2, 'f')));
});

test('a stopped transfer can be run again and completes intact', { skip }, async () => {
  const { src, dst } = setup();
  for (let i = 0; i < 4; i++) write(src, `chunk-${i}.bin`, randomBytes(512 * 1024, i + 11));
  let started = false;
  const r1 = await sync({ source: src, dest: dst, network: { bwlimit: '400' } }, {
    onRun: (run) => run.on('progress', () => { if (!started) { started = true; setTimeout(() => run.stop(), 300); } }),
  });
  assert.equal(r1.status, 'stopped');
  assert.notDeepEqual(snapshot(dst, { skip: [PARTIAL_DIR] }), snapshot(src));
  const r2 = await sync({ source: src, dest: dst });
  assert.equal(r2.status, 'success', r2.message);
  assert.equal(r2.verify.ok, true);
  assert.deepEqual(snapshot(dst), snapshot(src));
});

test('unreadable source files are reported as a failure, not as success', { skip: skip || (process.getuid && process.getuid() === 0 ? 'running as root, permissions are not enforced' : false) }, async () => {
  const { src, dst } = setup();
  write(src, 'ok', 'ok');
  const f = write(src, 'secret', 's');
  fs.chmodSync(f, 0o000);
  const r = await sync({ source: src, dest: dst });
  fs.chmodSync(f, 0o600);
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 23);
});
