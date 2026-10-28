'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nameProblems, sanitizeName, isJunk } = require('../../src/engine/compat');
const { renderTarget, checkTemplate, safeJoin, numbered } = require('../../src/engine/template');
const { buildWhere, globToLike } = require('../../src/engine/query');
const { extOf, categoryOf } = require('../../src/engine/categories');
const { csvCell } = require('../../src/engine/engine');

test('extensions and categories', () => {
  assert.equal(extOf('a.JPG'), 'jpg');
  assert.equal(extOf('.bashrc'), '');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf('trailing.'), '');
  assert.equal(categoryOf('heic'), 'image');
  assert.equal(categoryOf('xyz'), 'other');
  assert.equal(categoryOf('', 'dir'), 'folder');
});

test('name problems per target file system', () => {
  assert.deepEqual(nameProblems('ok.txt', 'exfat'), []);
  assert.ok(nameProblems('a:b?.txt', 'exfat').includes('bad-char'));
  assert.deepEqual(nameProblems('a:b?.txt', 'apfs'), []);
  assert.ok(nameProblems('CON.txt', 'ntfs').includes('reserved-name'));
  assert.ok(nameProblems('lpt1', 'fat32').includes('reserved-name'));
  assert.ok(nameProblems('dots...', 'exfat').includes('trailing-dot-space'));
  assert.ok(nameProblems('x'.repeat(256), 'apfs').includes('name-too-long'));
  assert.ok(nameProblems('Café.txt', 'apfs').includes('not-nfc'));
  assert.ok(isJunk('.DS_Store') && isJunk('._photo.jpg') && isJunk('Thumbs.db') && !isJunk('notes.txt'));
});

test('sanitizing makes any name valid and is stable', () => {
  const nasty = ['a:b|c?.txt', 'CON', 'nul.txt', 'trail. ', '..', '.', '', 'x/y', 'tab\there', 'Café', '🙂'.repeat(200) + '.jpg'];
  for (const n of nasty) {
    for (const fs of ['exfat', 'ntfs', 'fat32', 'apfs', 'ext4']) {
      const s = sanitizeName(n, fs);
      assert.ok(s.length > 0, `${n} -> empty`);
      assert.deepEqual(nameProblems(s, fs).filter((p) => p !== 'edge-whitespace'), [], `${JSON.stringify(n)} on ${fs} -> ${JSON.stringify(s)}`);
      assert.equal(sanitizeName(s, fs), s, 'idempotent');
      assert.ok(!s.includes('/'));
    }
  }
  assert.ok(sanitizeName('🙂'.repeat(200) + '.jpg', 'apfs').endsWith('.jpg'), 'extension kept when shortening');
});

const E = { rel_path: 'Trips/2024/Rome/IMG 1.JPG', parent: 'Trips/2024/Rome', name: 'IMG 1.JPG', ext: 'jpg', category: 'image', size: 5e6, mtime: new Date(2023, 6, 9, 12).getTime(), hash: 'abcdef0123' };

test('templates render paths', () => {
  assert.equal(renderTarget('{path}/{name}', E), 'Trips/2024/Rome/IMG 1.JPG');
  assert.equal(renderTarget('{category}/{yyyy}/{mm}/{name}', E), 'image/2023/07/IMG 1.JPG');
  assert.equal(renderTarget('{top}/{extdir}', E), 'Trips/jpg/IMG 1.JPG', 'name appended when missing');
  assert.equal(renderTarget('{date} {stem}', E), '2023-07-09 IMG 1.jpg', 'stem gets its extension back');
  assert.equal(renderTarget('{name}', { ...E, parent: '', rel_path: 'x' }), 'IMG 1.JPG');
  assert.equal(renderTarget('{yyyy}/{name}', { ...E, mtime: null }), 'undated/IMG 1.JPG');
  assert.equal(renderTarget('{category}/{name}', { ...E, name: 'a:b.jpg' }, { target: 'exfat' }), 'image/a_b.jpg');
  assert.equal(renderTarget('{hash8}/{name}', E), 'abcdef01/IMG 1.JPG');
});

test('templates can never escape the target', () => {
  assert.ok(checkTemplate('/abs/{name}').length);
  assert.ok(checkTemplate('{nope}/{name}').length);
  assert.ok(checkTemplate('{name').length);
  assert.deepEqual(checkTemplate('{category}/{name}'), []);
  const evil = { ...E, parent: '../../etc', name: '..' };
  const rel = renderTarget('{path}/../../{name}', evil);
  assert.ok(!rel.split('/').some((s) => s === '..' || s === '.'), rel);
  assert.throws(() => safeJoin('/t', '../x'));
  assert.equal(safeJoin('/t', 'a/b'), '/t/a/b');
});

test('numbered names', () => {
  assert.equal(numbered('a/b/photo.jpg', 2), 'a/b/photo (2).jpg');
  assert.equal(numbered('README', 3), 'README (3)');
  assert.equal(numbered('.env', 2), '.env (2)');
});

test('filters are bound as parameters, never spliced into SQL', () => {
  const evil = "x' OR 1=1; DROP TABLE entries; --";
  const { where, params } = buildWhere({ sourceId: 1, name: evil, path: evil, exts: [evil], categories: [evil], kinds: ['file', evil], issue: evil, sizeMin: '5', sizeMax: 'abc' });
  assert.ok(!where.includes('DROP'));
  assert.ok(params.includes(evil));
  assert.ok(!params.includes('abc'), 'non-numeric bounds ignored');
  assert.equal(globToLike('a_b%c*?'), 'a\\_b\\%c%_');
});

test('CSV export cells are safe for spreadsheets', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(12), '12');
});
