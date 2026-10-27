'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateProfile, isRetryable, backoffMs } = require('../../src/core/safety');
const { newProfile } = require('../../src/core/args');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-safety-'));
const src = path.join(tmp, 'src');
const empty = path.join(tmp, 'empty');
const dst = path.join(tmp, 'dst');
fs.mkdirSync(src);
fs.mkdirSync(empty);
fs.mkdirSync(dst);
fs.writeFileSync(path.join(src, 'f'), 'x');
fs.writeFileSync(path.join(empty, '.DS_Store'), 'x');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const v = (over) => validateProfile(newProfile({ source: src, dest: dst, ...over }));
const has = (list, re) => list.some((e) => re.test(e));

test('a normal profile passes', () => {
  const r = v({});
  assert.equal(r.ok, true, r.errors.join());
});

test('missing source / dest are errors', () => {
  assert.ok(has(v({ source: '' }).errors, /source/i));
  assert.ok(has(v({ dest: '' }).errors, /destination/i));
  assert.ok(has(v({ source: path.join(tmp, 'nope') }).errors, /does not exist/));
});

test('empty source with delete is refused (unmounted drive protection)', () => {
  const r = v({ source: empty, flags: { archive: true, delete: true } });
  assert.ok(has(r.errors, /empty/i));
  assert.equal(v({ source: empty }).ok, true, 'fine without delete');
});

test('same folder and nested folders are refused', () => {
  assert.ok(has(v({ dest: src }).errors, /same folder/));
  assert.ok(has(v({ dest: `${src}/` }).errors, /same folder/));
  assert.ok(has(v({ dest: path.join(src, 'backup') }).errors, /inside the source/));
  assert.ok(has(v({ source: src, dest: tmp, flags: { delete: true } }).errors, /Source is inside the destination/));
});

test('delete into home or system folders is refused', () => {
  for (const d of ['/', os.homedir(), '/Users', '/System', '~']) {
    assert.ok(has(v({ dest: d, flags: { archive: true, delete: true } }).errors, /Refusing/), d);
  }
});

test('delete raises warnings, including a missing max-delete', () => {
  const r = v({ flags: { archive: true, delete: true }, safety: { maxDelete: 0 } });
  assert.ok(r.ok);
  assert.ok(has(r.warnings, /will be deleted/));
  assert.ok(has(r.warnings, /delete limit/));
});

test('remote to remote is refused, newline paths refused', () => {
  assert.ok(has(v({ source: 'a:/x', dest: 'b:/y' }).errors, /two remote/));
  assert.ok(has(v({ dest: '/tmp/a\nb' }).errors, /line break/));
});

test('dangerous extra options are blocked', () => {
  for (const bad of ['-e "sh -c evil"', '--rsh=evil', '--rsync-path="rm -rf /;rsync"', '-ave ssh', '--delete-excluded', '--log-file=/etc/x', '--partial-dir=/', '--read-batch=x', '-T /tmp', '/etc/passwd']) {
    assert.equal(v({ extraArgs: bad }).ok, false, bad);
  }
  assert.equal(v({ extraArgs: '--modify-window=2 --no-perms' }).ok, true);
  assert.ok(has(v({ extraArgs: '--remove-source-files' }).warnings, /SOURCE/));
  assert.ok(has(v({ extraArgs: '--inplace' }).warnings, /half written/));
  assert.ok(has(v({ extraArgs: '--delete-after' }).warnings, /toggle/));
  assert.ok(has(v({ extraArgs: '--a "b' }).errors, /quote/));
});

test('network fields are validated', () => {
  assert.equal(v({ network: { sshPort: '22; rm' } }).ok, false);
  assert.equal(v({ network: { sshPort: '70000' } }).ok, false);
  assert.equal(v({ network: { sshPort: '2222' } }).ok, true);
  assert.equal(v({ network: { bwlimit: '5M' } }).ok, true);
  assert.equal(v({ network: { bwlimit: '5M --delete' } }).ok, false);
  assert.equal(v({ network: { retries: 1000 } }).ok, false);
});

test('only network-type exit codes are retried', () => {
  for (const c of [5, 10, 12, 30, 35, 255]) assert.equal(isRetryable(c), true, String(c));
  for (const c of [0, 1, 2, 3, 11, 20, 23, 24, 25]) assert.equal(isRetryable(c), false, String(c));
});

test('backoff doubles, caps at 5 minutes, jitters within 20%', () => {
  const mid = () => 0.5;
  assert.equal(backoffMs(1, { rand: mid }), 5000);
  assert.equal(backoffMs(2, { rand: mid }), 10000);
  assert.equal(backoffMs(4, { rand: mid }), 40000);
  assert.equal(backoffMs(20, { rand: mid }), 300000);
  assert.equal(backoffMs(1, { rand: () => 0 }), 4000);
  assert.equal(backoffMs(1, { rand: () => 1 }), 6000);
});

test('unencrypted rsync daemon transport is flagged', () => {
  assert.ok(has(v({ dest: 'rsync://nas/backup' }).warnings, /not encrypted/));
  assert.ok(has(v({ dest: 'nas::backup' }).warnings, /not encrypted/));
  assert.ok(!has(v({ dest: 'me@nas:/backup' }).warnings, /not encrypted/));
});
