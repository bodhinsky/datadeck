'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseItem, parseProgress, parseStats, parseVersion, LineSplitter, classifyItem, describeExit } = require('../../src/core/parse');

test('itemized lines are classified', () => {
  assert.deepEqual(parseItem('::SD::>f+++++++++|300000|sub/big.bin'), { code: '>f+++++++++', action: 'new', kind: 'file', size: 300000, path: 'sub/big.bin' });
  assert.equal(parseItem('::SD::>f.st......|11|x.txt').action, 'update');
  assert.equal(parseItem('::SD::*deleting  |0|gone.txt').action, 'delete');
  assert.equal(parseItem('::SD::*deleting  |0|gone.txt').code, '*deleting');
  assert.equal(parseItem('::SD::cd+++++++++|4096|dir/').action, 'mkdir');
  assert.equal(parseItem('::SD::.d..t......|4096|dir/').action, 'meta');
  assert.equal(parseItem('::SD::cL+++++++++|5|link -> target').action, 'new');
  assert.equal(parseItem('::SD::hf+++++++++|5|hard => other').action, 'link');
  assert.equal(parseItem('::SD::<f+++++++++|5|up').action, 'new');
  assert.equal(classifyItem('?x'), 'other');
});

test('item paths may contain the separator and odd characters', () => {
  const it = parseItem('::SD::>f+++++++++|1,234|a|b c/ünï cødé ✓.txt');
  assert.equal(it.path, 'a|b c/ünï cødé ✓.txt');
  assert.equal(it.size, 1234);
});

test('non-item lines are ignored', () => {
  assert.equal(parseItem('sending incremental file list'), null);
  assert.equal(parseItem('::SD::broken'), null);
});

test('progress2 and legacy progress lines parse', () => {
  assert.deepEqual(parseProgress('        300,005 100%  286.10MB/s    0:00:00 (xfr#3, to-chk=0/5)'),
    { bytes: 300005, percent: 100, rate: '286.10MB/s', eta: '0:00:00', xfr: 3, toCheck: 0, total: 5 });
  const legacy = parseProgress('      32768  45%   31.25kB/s    0:01:02 (xfer#1, to-check=3/5)');
  assert.equal(legacy.percent, 45);
  assert.equal(legacy.toCheck, 3);
  assert.equal(parseProgress('   1.234.567  12%   1,00MB/s    0:00:10').bytes, 1234567);
  assert.equal(parseProgress('    1,048,576  37%    1.00MB/s    0:00:02  ').percent, 37);
  assert.equal(parseProgress('  12%  ir-chk=1/2 something'), null);
  assert.equal(parseProgress('Number of files: 5'), null);
});

test('stats block parses', () => {
  const s = parseStats(`Number of files: 5 (reg: 3, dir: 2)
Number of created files: 4
Number of deleted files: 1
Number of regular files transferred: 3
Total file size: 300,013 bytes
Total transferred file size: 300,013 bytes
Total bytes sent: 300,368
Total bytes received: 119
total size is 300,013  speedup is 1.00`);
  assert.deepEqual(s, { files: 5, created: 4, deleted: 1, transferred: 3, totalSize: 300013, transferredSize: 300013, sent: 300368, received: 119, speedup: 1 });
});

test('rsync versions are recognised', () => {
  assert.equal(parseVersion('rsync  version 3.2.7  protocol version 31').modern, true);
  assert.equal(parseVersion('rsync  version 3.4.1  protocol version 32').version, '3.4.1');
  assert.equal(parseVersion('rsync  version 2.6.9  protocol version 29').modern, false);
  assert.equal(parseVersion('rsync  version 3.0.9  protocol version 30').modern, false);
  assert.equal(parseVersion('openrsync: protocol version 29\nrsync version 2.6.9 compatible').openrsync, true);
  assert.equal(parseVersion('garbage'), null);
});

test('line splitter handles \\r redraws and split chunks', () => {
  const lines = [];
  const sp = new LineSplitter((l, cr) => lines.push([l, cr]));
  sp.push('a\r  10%\r  2');
  sp.push('0%\nb\nc');
  sp.flush();
  assert.deepEqual(lines, [['a', true], ['  10%', true], ['  20%', false], ['b', false], ['c', false]]);
});

test('exit codes are described', () => {
  assert.match(describeExit(30), /Timeout/);
  assert.match(describeExit(255), /SSH/);
  assert.match(describeExit(99), /99/);
});

test('plain -i itemize lines parse when --out-format is unavailable', () => {
  const { parseItemize } = require('../../src/core/parse');
  assert.deepEqual(parseItemize('>f+++++++++ dir/a file.txt'), { code: '>f+++++++++', action: 'new', kind: 'file', size: 0, path: 'dir/a file.txt' });
  assert.equal(parseItemize('*deleting   old.txt').action, 'delete');
  assert.equal(parseItemize('*deleting   old.txt').path, 'old.txt');
  assert.equal(parseItemize('cd+++++++++ sub/').action, 'mkdir');
  assert.equal(parseItemize('sending incremental file list'), null);
  assert.equal(parseItemize('Number of files: 3'), null);
});
