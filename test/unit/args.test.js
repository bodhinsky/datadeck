'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { buildArgs, tokenize, sourceSpec, isRemote, newProfile, commandPreview, PARTIAL_DIR, normalizeProfile } = require('../../src/core/args');

const prof = (over = {}) => newProfile({ source: '/src', dest: '/dst', ...over });
const tail = (a) => a.slice(a.indexOf('--'));

test('paths always come last, after a literal "--"', () => {
  const a = buildArgs(prof());
  assert.deepEqual(tail(a), ['--', '/src/', '/dst']);
});

test('a path that looks like an option stays a path', () => {
  const a = buildArgs(prof({ source: '/x/--delete', dest: '-rf' }), {});
  assert.deepEqual(tail(a), ['--', '/x/--delete/', '-rf']);
  assert.equal(a.filter((x) => x === '--delete').length, 0);
});

test('shell metacharacters pass through verbatim as single argv entries', () => {
  const evil = '/tmp/a; rm -rf ~ $(whoami) `id` | cat > /etc/passwd';
  const a = buildArgs(prof({ source: evil, dest: '/d "q" \'x\'' }));
  assert.deepEqual(tail(a), ['--', `${evil}/`, '/d "q" \'x\'']);
});

test('contents toggle controls the trailing slash on the source', () => {
  assert.equal(sourceSpec('/a/b', true), '/a/b/');
  assert.equal(sourceSpec('/a/b/', true), '/a/b/');
  assert.equal(sourceSpec('/a/b///', false), '/a/b');
  assert.equal(sourceSpec('/', false), '/');
  assert.equal(sourceSpec('host:/data', true), 'host:/data/');
});

test('~ is expanded for local paths only (no shell is involved)', () => {
  const a = buildArgs(prof({ source: '~/Photos', dest: 'me@nas:~/backup' }));
  assert.deepEqual(tail(a), ['--', `${os.homedir()}/Photos/`, 'me@nas:~/backup']);
});

test('flags map to their options and archive defaults on', () => {
  const a = buildArgs(prof({ flags: { archive: true, checksum: true, compress: true, delete: true } }));
  for (const f of ['-a', '-c', '-z', '--delete']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('-r'));
  const b = buildArgs(prof({ flags: { archive: false } }));
  assert.ok(b.includes('-r'), 'recursion is always on');
});

test('modern-only flags are dropped for old rsync', () => {
  const p = prof({ flags: { archive: true, xattrs: true, acls: true } });
  assert.ok(buildArgs(p, { caps: { modern: true } }).includes('-X'));
  const old = buildArgs(p, { caps: { modern: false } });
  assert.ok(!old.includes('-X') && !old.includes('-A') && !old.includes('-s'));
  assert.ok(old.includes('--progress') && !old.some((x) => x.startsWith('--info')));
});

test('real run keeps partial files for resume, sets a stall timeout and progress', () => {
  const a = buildArgs(prof({ network: { timeout: 45, retries: 3 } }));
  assert.ok(a.includes(`--partial-dir=${PARTIAL_DIR}`));
  assert.ok(a.includes(`--exclude=${PARTIAL_DIR}/`));
  assert.ok(a.includes('--timeout=45'));
  assert.ok(a.includes('--info=progress2'));
  assert.ok(!a.includes('--dry-run'));
});

test('dry run never writes: --dry-run, no partial dir, no backup', () => {
  const a = buildArgs(prof({ safety: { backup: true, backupDir: 'old' } }), { dryRun: true });
  assert.ok(a.includes('--dry-run'));
  assert.ok(!a.some((x) => x.startsWith('--partial-dir')));
  assert.ok(!a.includes('--backup'));
});

test('verify pass is a checksum dry run that keeps the delete setting', () => {
  const a = buildArgs(prof({ flags: { archive: true, delete: true } }), { verify: true });
  assert.ok(a.includes('-c') && a.includes('--dry-run') && a.includes('--delete'));
  assert.ok(!a.some((x) => x.startsWith('--max-delete')));
  const b = buildArgs(prof({ flags: { archive: true, delete: false } }), { verify: true });
  assert.ok(!b.includes('--delete'));
});

test('max-delete and backup are applied on a real mirror run', () => {
  const a = buildArgs(prof({ flags: { archive: true, delete: true }, safety: { maxDelete: 25, backup: true, backupDir: '.old' } }));
  assert.ok(a.includes('--max-delete=25'));
  assert.ok(a.includes('--backup') && a.includes('--backup-dir=.old'));
});

test('remote paths get a locked-down ssh transport', () => {
  const a = buildArgs(prof({ dest: 'tim@nas:/vol', network: { sshPort: '2222', identityFile: "/k/it's key" } }));
  const e = a[a.indexOf('-e') + 1];
  assert.match(e, /^ssh /);
  assert.match(e, /BatchMode=yes/);
  assert.match(e, /ServerAliveInterval=15/);
  assert.match(e, /-p 2222/);
  assert.match(e, /-i '\/k\/it'\\''s key'/);
  assert.ok(a.includes('-s'));
});

test('local-only runs do not set a remote shell', () => {
  assert.ok(!buildArgs(prof()).includes('-e'));
  assert.ok(!buildArgs(prof({ dest: 'rsync://host/mod' })).includes('-e'));
});

test('isRemote follows rsync rules', () => {
  assert.equal(isRemote('host:/x'), true);
  assert.equal(isRemote('u@h:x'), true);
  assert.equal(isRemote('rsync://h/m'), true);
  assert.equal(isRemote('/Volumes/a:b'), false);
  assert.equal(isRemote('./a:b'), false);
  assert.equal(isRemote(':x'), false);
  assert.equal(isRemote('/plain'), false);
});

test('tokenize handles quotes and refuses unclosed ones', () => {
  assert.deepEqual(tokenize(`--a "b c" 'd "e"' f''`), ['--a', 'b c', 'd "e"', 'f']);
  assert.deepEqual(tokenize('  '), []);
  assert.deepEqual(tokenize(`--x=""`), ['--x=']);
  assert.throws(() => tokenize('--a "b'));
});

test('excludes become --exclude=, blank ones are skipped', () => {
  const a = buildArgs(prof({ excludes: ['*.tmp', '  ', 'node_modules/'] }));
  assert.ok(a.includes('--exclude=*.tmp') && a.includes('--exclude=node_modules/'));
  assert.equal(a.filter((x) => x === '--exclude=').length, 0);
});

test('commandPreview quotes for display', () => {
  assert.equal(commandPreview('rsync', ['-a', '--', '/a b/', "/it's"]), `rsync -a -- '/a b/' '/it'\\''s'`);
});

test('normalizeProfile fills defaults for older saved profiles', () => {
  const p = normalizeProfile({ id: 'x', source: '/a', dest: '/b', flags: { delete: true } });
  assert.equal(p.flags.archive, true);
  assert.equal(p.flags.delete, true);
  assert.equal(p.safety.verifyAfter, true);
  assert.equal(p.network.retries, 8);
});

test('missing features fall back safely (openrsync / old rsync)', () => {
  const caps = { modern: false, outFormat: false, partialDir: false, maxDelete: false, timeout: false, progress2: false, progress: true, stats: true, protectArgs: false, backupDir: false };
  const a = buildArgs(prof({ flags: { archive: true, delete: true }, safety: { backup: true, backupDir: '.old', maxDelete: 9 } }), { caps });
  assert.ok(a.includes('-i') && !a.some((x) => x.startsWith('--out-format')));
  assert.ok(a.includes('--partial') && !a.some((x) => x.startsWith('--partial-dir')));
  assert.ok(!a.some((x) => x.startsWith('--max-delete') || x.startsWith('--timeout') || x.startsWith('--backup-dir')));
  assert.ok(a.includes('--progress') && a.includes('--backup') && a.includes('--delete'));
  assert.deepEqual(tail(a), ['--', '/src/', '/dst']);
});

test('probed caps override the version hint', () => {
  const a = buildArgs(prof({ flags: { archive: true, xattrs: true } }), { caps: { modern: false, xattrs: true, progress2: true } });
  assert.ok(a.includes('-X') && a.includes('--info=progress2'));
});
