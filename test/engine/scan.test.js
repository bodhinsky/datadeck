'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEngine } = require('../helpers/engine');
const { write, randomBytes } = require('../helpers/fsutil');

const asRoot = process.getuid && process.getuid() === 0;

async function scanned(build) {
  const ctx = makeEngine();
  const root = path.join(ctx.dir, 'data');
  fs.mkdirSync(root);
  build(root);
  const src = ctx.engine.sourcesAdd({ path: root });
  const job = await ctx.waitJob(ctx.engine.scanStart({ sourceId: src.id }));
  return { ...ctx, root, src, job, q: (filter, opts) => ctx.engine.entriesQuery({ filter: { sourceId: src.id, ...filter }, ...opts }) };
}

test('scans a tree with exact totals, folder sizes and metadata', async () => {
  const s = await scanned((r) => {
    write(r, 'a/b/c.txt', 'hello');
    write(r, 'a/d.jpg', randomBytes(1000, 1));
    write(r, 'top.pdf', randomBytes(300, 2));
    fs.mkdirSync(path.join(r, 'empty'));
  });
  try {
    assert.equal(s.job.status, 'done');
    const src = s.engine.sourcesList()[0];
    assert.equal(src.files, 3);
    assert.equal(src.dirs, 3);
    assert.equal(src.bytes, 1305);
    assert.equal(src.status, 'ready');
    const a = s.q({ path: 'a', kinds: ['dir'], depthMax: 1 }).rows[0];
    assert.equal(a.rel_path, 'a');
    assert.equal(a.tree_bytes, 1005);
    assert.equal(a.tree_files, 2);
    const c = s.q({ name: 'c.txt' }).rows[0];
    assert.equal(c.depth, 3);
    assert.equal(c.category, 'document');
    assert.equal(c.mtime, Math.floor(fs.statSync(path.join(s.root, 'a/b/c.txt')).mtimeMs));
    const ov = s.engine.overview({ sourceId: s.src.id });
    assert.equal(ov.categories.find((x) => x.key === 'image').bytes, 1000);
    assert.equal(ov.sizes.reduce((n, b) => n + b.count, 0), 3);
    assert.ok(ov.issues.some((i) => i.key === 'empty-dir'));
    assert.equal(ov.range.maxDepth, 3);
  } finally { s.cleanup(); }
});

test('handles 300 levels of nesting', async () => {
  let deep = '';
  const s = await scanned((r) => {
    const segs = Array.from({ length: 300 }, (_, i) => `d${i % 10}`);
    deep = segs.join('/');
    // Build stepwise to stay under PATH_MAX for each call.
    let cur = r;
    for (const seg of segs) { cur = path.join(cur, seg); fs.mkdirSync(cur); process.chdir(cur); cur = '.'; }
    fs.writeFileSync('leaf.txt', 'deep');
    process.chdir(__dirname);
  });
  try {
    const leaf = s.q({ name: 'leaf.txt' }).rows[0];
    assert.equal(leaf.depth, 301);
    assert.equal(leaf.rel_path, `${deep}/leaf.txt`);
    assert.equal(s.engine.sourcesList()[0].dirs, 300);
    assert.ok(s.engine.overview({ sourceId: s.src.id }).issues.some((i) => i.key === 'path-too-long'));
  } finally { s.cleanup(); }
});

test('symlinks are recorded, not followed: loops and broken links are safe', async () => {
  const s = await scanned((r) => {
    write(r, 'real/file.txt', 'x');
    fs.symlinkSync('..', path.join(r, 'real', 'loop'));
    fs.symlinkSync(r, path.join(r, 'abs-loop'));
    fs.symlinkSync('nowhere/at/all', path.join(r, 'broken'));
    fs.symlinkSync('real/file.txt', path.join(r, 'good'));
  });
  try {
    const src = s.engine.sourcesList()[0];
    assert.equal(src.files, 1);
    assert.equal(src.links, 4);
    const issues = s.q({ issue: 'broken-link' }).rows.map((r) => r.name);
    assert.deepEqual(issues, ['broken']);
    assert.equal(s.q({ name: 'good' }).rows[0].link_target, 'real/file.txt');
  } finally { s.cleanup(); }
});

test('flags case and unicode collisions, bad names, junk and empties', async () => {
  const s = await scanned((r) => {
    write(r, 'Photo.JPG', 'a');
    write(r, 'photo.jpg', 'b');
    write(r, 'Café.txt', 'nfd');
    write(r, 'Café.txt', 'nfc');
    write(r, 'what?.txt', 'q');
    write(r, 'aux.c', 'r');
    write(r, '.DS_Store', 'j');
    write(r, 'zero', '');
    fs.utimesSync(path.join(r, 'zero'), new Date('1970-06-01'), new Date('1970-06-01'));
  });
  try {
    const codes = (name) => (s.q({ name }).rows[0].issues || '').split(',');
    assert.ok(codes('Photo.JPG').includes('case-collision'));
    assert.ok(codes('photo.jpg').includes('case-collision'));
    assert.ok(codes('Café.txt').includes('unicode-collision'));
    assert.ok(codes('Café.txt').includes('not-nfc'));
    assert.ok(!codes('Café.txt').includes('case-collision'), 'NFC/NFD pair is not a case collision');
    assert.ok(codes('what?.txt').includes('bad-char'));
    assert.ok(codes('aux.c').includes('reserved-name'));
    assert.ok(codes('.DS_Store').includes('junk'));
    assert.ok(codes('zero').includes('empty-file'));
    assert.ok(codes('zero').includes('odd-date'));
  } finally { s.cleanup(); }
});

test('unreadable folders are recorded and the scan continues', { skip: asRoot ? 'root ignores permissions' : false }, async () => {
  let locked;
  const s = await scanned((r) => {
    write(r, 'open/a.txt', 'a');
    write(r, 'locked/secret.txt', 's');
    locked = path.join(r, 'locked');
    fs.chmodSync(locked, 0o000);
  });
  try {
    assert.equal(s.job.status, 'done');
    const row = s.q({ name: 'locked' }).rows[0];
    assert.match(row.error, /EACCES/);
    assert.ok(row.issues.includes('unreadable'));
    assert.equal(s.q({ name: 'a.txt' }).rows.length, 1);
  } finally { fs.chmodSync(locked, 0o755); s.cleanup(); }
});

test('20,000 files scan quickly and queries stay fast', async () => {
  const t0 = Date.now();
  const s = await scanned((r) => {
    for (let d = 0; d < 100; d++) {
      fs.mkdirSync(path.join(r, `dir${d}`));
      for (let f = 0; f < 200; f++) fs.writeFileSync(path.join(r, `dir${d}`, `f${f}.${['jpg', 'txt', 'mp4', 'pdf'][f % 4]}`), String(f));
    }
  });
  try {
    const scanMs = s.engine.sourcesList()[0].scan_ms;
    assert.equal(s.engine.sourcesList()[0].files, 20000);
    assert.ok(scanMs < 30000, `scan took ${scanMs} ms`);
    const t1 = Date.now();
    const r = s.q({ exts: ['jpg'], sizeMin: 2 }, { sort: 'size', dir: 'desc', limit: 100 });
    assert.equal(r.totals.count, 4700); // f0, f4, f8 hold 1 byte in each of 100 folders
    assert.ok(Date.now() - t1 < 1000, 'filtered query under 1s');
    const g = s.engine.entriesGroup({ filter: { sourceId: s.src.id, kinds: ['file'] }, dim: 'ext' });
    assert.equal(g.length, 4);
    void t0;
  } finally { s.cleanup(); }
});

test('a scan can be cancelled and is marked partial', async () => {
  const ctx = makeEngine();
  const root = path.join(ctx.dir, 'data');
  for (let d = 0; d < 200; d++) for (let f = 0; f < 50; f++) write(root, `d${d}/f${f}`, 'x');
  const src = ctx.engine.sourcesAdd({ path: root });
  const job = ctx.engine.scanStart({ sourceId: src.id });
  setTimeout(() => ctx.engine.jobCancel({ jobId: job.id }), 5);
  try {
    const done = await ctx.waitJob(job);
    assert.equal(done.status, 'cancelled');
    assert.equal(ctx.engine.sourcesList()[0].status, 'partial');
  } finally { ctx.cleanup(); }
});

test('rescan replaces the catalog for that source', async () => {
  const s = await scanned((r) => write(r, 'one.txt', '1'));
  try {
    write(s.root, 'two.txt', '2');
    fs.unlinkSync(path.join(s.root, 'one.txt'));
    await s.waitJob(s.engine.scanStart({ sourceId: s.src.id }));
    assert.deepEqual(s.q({}).rows.map((r) => r.name), ['two.txt']);
  } finally { s.cleanup(); }
});

test('only one heavy job at a time', async () => {
  const s = await scanned((r) => write(r, 'x', 'x'));
  try {
    s.engine.scanStart({ sourceId: s.src.id });
    assert.throws(() => s.engine.dupesFind({ sourceId: s.src.id }), /Busy/);
  } finally { await new Promise((r) => setTimeout(r, 200)); s.cleanup(); }
});

test('duplicates: only byte-identical files group together', async () => {
  const big = randomBytes(300000, 9);
  const sameEnds = Buffer.from(big);
  sameEnds[150000] ^= 1; // same size, same first/last 64 KB, different middle
  const s = await scanned((r) => {
    write(r, 'a/one.bin', big);
    write(r, 'b/two.bin', big);
    write(r, 'c/three.bin', big);
    write(r, 'near.bin', sameEnds);
    write(r, 'small1', 'abc');
    write(r, 'small2', 'abd');
    write(r, 'e1', '');
    write(r, 'e2', '');
  });
  try {
    const job = await s.waitJob(s.engine.dupesFind({ sourceId: s.src.id }));
    assert.equal(job.result.groups, 1);
    assert.equal(job.result.wasted, 600000);
    const groups = s.engine.dupesGroups({ sourceId: s.src.id });
    assert.deepEqual(groups[0].members.map((m) => m.rel_path).sort(), ['a/one.bin', 'b/two.bin', 'c/three.bin']);
    assert.equal(s.q({ dupes: true }).rows.length, 3);
    assert.equal(s.engine.overview({ sourceId: s.src.id }).dupes.groups, 1);
  } finally { s.cleanup(); }
});

test('CSV export writes the filtered table', async () => {
  const s = await scanned((r) => { write(r, '=cmd.txt', 'x'); write(r, 'b.jpg', 'yy'); });
  try {
    const out = path.join(s.dir, 'out.csv');
    const r = s.engine.exportCsv({ file: out, filter: { sourceId: s.src.id, kinds: ['file'] } });
    assert.equal(r.rows, 2);
    const text = fs.readFileSync(out, 'utf8');
    assert.match(text, /^path,name,kind/);
    assert.match(text, /'=cmd\.txt/);
    assert.ok(!fs.existsSync(`${out}.part`));
  } finally { s.cleanup(); }
});
