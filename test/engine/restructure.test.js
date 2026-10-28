'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEngine } = require('../helpers/engine');
const { write, randomBytes, snapshot, tmpdir } = require('../helpers/fsutil');
const { Executor } = require('../../src/engine/executor');

const OTHER_DEVICE = (() => {
  try {
    const shm = '/dev/shm';
    if (fs.statSync(shm).dev !== fs.statSync(require('os').tmpdir()).dev) { fs.accessSync(shm, fs.constants.W_OK); return shm; }
  } catch { /* none */ }
  return null;
})();

const PHOTOS = {
  'Trips/Rome/IMG_1.jpg': randomBytes(200000, 1),
  'Trips/Rome/notes.txt': 'rome',
  'Trips/Oslo/IMG_1.jpg': randomBytes(150000, 2),
  'Work/report.pdf': randomBytes(50000, 3),
  'Work/report copy.pdf': randomBytes(50000, 3),
  'Misc/song.mp3': randomBytes(80000, 4),
  'Misc/.DS_Store': 'junk',
};

async function setup(files = PHOTOS, targetBase) {
  const ctx = makeEngine();
  const root = path.join(ctx.dir, 'src');
  for (const [rel, data] of Object.entries(files)) write(root, rel, data);
  const t = new Date('2022-03-04T10:00:00Z');
  for (const rel of Object.keys(files)) fs.utimesSync(path.join(root, rel), t, t);
  const src = ctx.engine.sourcesAdd({ path: root });
  await ctx.waitJob(ctx.engine.scanStart({ sourceId: src.id }));
  const target = targetBase ? fs.mkdtempSync(path.join(targetBase, 'dm-target-')) : path.join(ctx.dir, 'target');
  const plan = (over = {}) => ctx.engine.planCreate({ sourceId: src.id, filter: {}, template: '{category}/{name}', targetRoot: target, mode: 'copy', conflict: 'rename', targetFs: 'exfat', skipJunk: true, ...over });
  const run = async (planId, opts) => {
    const job = ctx.engine.planExecute({ planId });
    void opts;
    return ctx.waitJob(job);
  };
  const ops = (planId) => ctx.engine.planOps({ planId, limit: 1000 }).rows;
  const cleanup = () => { ctx.cleanup(); if (targetBase) fs.rmSync(target, { recursive: true, force: true }); };
  return { ...ctx, root, src, target, plan, run, ops, cleanup };
}

const leftovers = (dir) => {
  const out = [];
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (n.startsWith('.dmtmp')) out.push(f); if (fs.lstatSync(f).isDirectory()) walk(f); } };
  walk(dir);
  return out;
};

test('copy plan: clashes renamed, junk skipped, every file verified, source untouched', async () => {
  const s = await setup();
  try {
    const before = snapshot(s.root);
    const p = s.plan();
    assert.equal(p.ok, true, p.errors.join());
    assert.equal(p.summary.files, 6);
    assert.equal(p.summary.junk, 1);
    assert.equal(p.summary.renamed, 1, 'two IMG_1.jpg land in image/');
    const job = await s.run(p.planId);
    assert.equal(job.result.status, 'done');
    assert.deepEqual(snapshot(s.root), before, 'source unchanged');
    const out = snapshot(s.target);
    assert.equal(out['image/IMG_1.jpg'], before['Trips/Oslo/IMG_1.jpg'] === out['image/IMG_1.jpg'] ? before['Trips/Oslo/IMG_1.jpg'] : before['Trips/Rome/IMG_1.jpg']);
    assert.ok(out['image/IMG_1 (2).jpg']);
    assert.equal(out['document/report.pdf'], before['Work/report.pdf']);
    assert.equal(out['audio/song.mp3'], before['Misc/song.mp3']);
    for (const o of s.ops(p.planId).filter((x) => x.status === 'done')) {
      assert.ok(o.src_hash && o.src_hash === o.dst_hash, 'hash recorded and equal');
      assert.equal(fs.statSync(o.dst).mtimeMs, fs.statSync(o.src).mtimeMs, 'mtime preserved');
    }
    assert.deepEqual(leftovers(s.target), []);
  } finally { s.cleanup(); }
});

test('dedupe option copies one file per identical group', async () => {
  const s = await setup();
  try {
    await s.waitJob(s.engine.dupesFind({ sourceId: s.src.id }));
    const p = s.plan({ dedupe: true, template: '{path}/{name}' });
    assert.equal(p.summary.dedupe, 1);
    await s.run(p.planId);
    const files = Object.keys(snapshot(s.target)).filter((k) => k.endsWith('.pdf'));
    assert.equal(files.length, 1);
  } finally { s.cleanup(); }
});

test('existing targets: identical skipped after checksum, different renamed or skipped', async () => {
  const s = await setup();
  try {
    write(s.target, 'document/report.pdf', fs.readFileSync(path.join(s.root, 'Work/report.pdf')));
    write(s.target, 'audio/song.mp3', 'something else entirely');
    const p = s.plan({ filter: { categories: ['document', 'audio'] } });
    await s.run(p.planId);
    const ops = s.ops(p.planId);
    const byName = (n) => ops.find((o) => o.src.endsWith(n));
    assert.equal(byName('Work/report.pdf').status, 'skipped');
    assert.match(byName('Work/report.pdf').note, /identical/);
    assert.equal(fs.readFileSync(path.join(s.target, 'audio/song.mp3'), 'utf8'), 'something else entirely', 'never overwritten');
    assert.ok(fs.existsSync(path.join(s.target, 'audio/song (2).mp3')));

    const p2 = s.plan({ filter: { categories: ['audio'] }, conflict: 'skip' });
    assert.equal(p2.summary.skipped, 1);
  } finally { s.cleanup(); }
});

test('a corrupted write is caught: nothing published, op failed, others continue', async () => {
  const s = await setup();
  try {
    const p = s.plan({ filter: { categories: ['image'] } });
    let victim = null;
    const ex = new Executor(s.engine.db, p.planId, { faults: { corrupt: (op) => { if (!victim) { victim = op.dst; return true; } return false; } } });
    const r = await ex.run();
    assert.equal(r.status, 'done-with-errors');
    assert.equal(r.failed, 1);
    const failed = s.ops(p.planId).find((o) => o.status === 'failed');
    assert.match(failed.error, /checksum mismatch/);
    assert.equal(fs.existsSync(victim), false, 'corrupt copy never appears under its name');
    assert.equal(s.ops(p.planId).filter((o) => o.status === 'done').length, 1);
    assert.deepEqual(leftovers(s.target), []);
    // Retrying the plan finishes the failed op.
    const again = await new Executor(s.engine.db, p.planId).run();
    assert.equal(again.status, 'done');
    assert.equal(s.ops(p.planId).filter((o) => o.status === 'done').length, 2);
  } finally { s.cleanup(); }
});

test('crash mid-plan: restart recovers and completes, no temp files, no duplicates', async () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`f${i}.bin`] = randomBytes(100000 + i, 50 + i);
  const s = await setup(files);
  try {
    const p = s.plan({ template: '{name}', mode: 'move' });
    await assert.rejects(new Executor(s.engine.db, p.planId, { faults: { crashAfter: 5 } }).run(), /simulated crash/);
    // Simulate the half-finished op a power cut leaves: status running, temp file present.
    const next = s.ops(p.planId).find((o) => o.status === 'pending');
    s.engine.db.prepare("UPDATE plan_ops SET status = 'running' WHERE id = ?").run(next.id);
    fs.writeFileSync(path.join(s.target, `.dmtmp-${p.planId}-${next.id}`), 'half');
    // A restarted engine marks the plan interrupted; running it again resumes.
    s.engine.db.prepare("UPDATE plans SET status = 'interrupted' WHERE id = ?").run(p.planId);
    const r = await new Executor(s.engine.db, p.planId).run();
    assert.equal(r.status, 'done');
    const out = snapshot(s.target);
    assert.equal(Object.keys(out).length, 12);
    for (const [name, data] of Object.entries(files)) assert.equal(out[name], require('crypto').createHash('sha256').update(data).digest('hex'));
    assert.deepEqual(fs.readdirSync(s.root), [], 'all moved, source emptied');
    assert.deepEqual(leftovers(s.target), []);
  } finally { s.cleanup(); }
});

test('source changed after the scan: that file is refused, not copied stale', async () => {
  const s = await setup();
  try {
    const p = s.plan({ filter: { categories: ['document'] } });
    fs.appendFileSync(path.join(s.root, 'Trips/Rome/notes.txt'), ' changed');
    await s.run(p.planId);
    const o = s.ops(p.planId).find((x) => x.src.endsWith('notes.txt'));
    assert.equal(o.status, 'failed');
    assert.match(o.error, /changed since the scan/);
  } finally { s.cleanup(); }
});

test('move on the same disk keeps the same inode (no data rewritten) and prunes empty folders', async () => {
  const s = await setup();
  try {
    const inode = fs.statSync(path.join(s.root, 'Misc/song.mp3')).ino;
    const p = s.plan({ mode: 'move', filter: { categories: ['audio'] } });
    assert.equal(p.summary.sameDevice, true);
    assert.equal(p.summary.needBytes, 0);
    await s.run(p.planId);
    assert.equal(fs.statSync(path.join(s.target, 'audio/song.mp3')).ino, inode);
    assert.equal(fs.existsSync(path.join(s.root, 'Misc/song.mp3')), false);
    assert.equal(fs.existsSync(path.join(s.root, 'Misc')), true, 'Misc still holds .DS_Store (not in the plan), so it stays');
  } finally { s.cleanup(); }
});

test('in-place restructure: target is the source folder itself', async () => {
  const s = await setup();
  try {
    const before = snapshot(s.root);
    const p = s.plan({ mode: 'move', targetRoot: s.root, template: '{category}/{name}' });
    assert.equal(p.ok, true, p.errors.join());
    const job = await s.run(p.planId);
    assert.equal(job.result.status, 'done');
    const after = snapshot(s.root);
    const hashes = (o) => Object.entries(o).filter(([, v]) => v !== 'dir').map(([, v]) => v).sort();
    assert.deepEqual(hashes(after), hashes(before), 'same set of file contents, nothing lost');
    assert.ok(after['image/IMG_1.jpg'] && after['image/IMG_1 (2).jpg']);
    assert.equal(after.Trips, undefined, 'emptied folders pruned');
  } finally { s.cleanup(); }
});

test('cross-device move: verified copy first, original removed after', { skip: OTHER_DEVICE ? false : 'no second file system' }, async () => {
  const s = await setup(PHOTOS, OTHER_DEVICE);
  try {
    const before = snapshot(s.root);
    const p = s.plan({ mode: 'move', filter: { categories: ['image'] } });
    assert.equal(p.summary.sameDevice, false);
    await s.run(p.planId);
    const out = snapshot(s.target);
    assert.equal(out['image/IMG_1.jpg'] && out['image/IMG_1 (2).jpg'] ? 2 : 0, 2);
    assert.deepEqual([out['image/IMG_1.jpg'], out['image/IMG_1 (2).jpg']].sort(), [before['Trips/Rome/IMG_1.jpg'], before['Trips/Oslo/IMG_1.jpg']].sort());
    assert.equal(fs.existsSync(path.join(s.root, 'Trips/Rome/IMG_1.jpg')), false);
  } finally { s.cleanup(); }
});

test('undo of a copy removes exactly what was written; undo of a move restores the originals', async () => {
  const s = await setup();
  try {
    const before = snapshot(s.root);
    const p = s.plan();
    await s.run(p.planId);
    write(s.target, 'mine.txt', 'user file added later');
    await s.waitJob(s.engine.planUndo({ planId: p.planId }));
    assert.deepEqual(Object.keys(snapshot(s.target)), ['mine.txt'], 'only plan files and empty plan folders removed');

    const m = s.plan({ mode: 'move', template: '{yyyy}/{name}' });
    await s.run(m.planId);
    assert.notDeepEqual(snapshot(s.root), before);
    const u = await s.waitJob(s.engine.planUndo({ planId: m.planId }));
    assert.equal(u.result.failed, 0);
    const restored = snapshot(s.root);
    for (const [k, v] of Object.entries(before)) if (v !== 'dir' && !k.endsWith('.DS_Store')) assert.equal(restored[k], v, k);
  } finally { s.cleanup(); }
});

test('undo leaves files that were edited after the run', async () => {
  const s = await setup();
  try {
    const p = s.plan({ filter: { categories: ['audio'] } });
    await s.run(p.planId);
    fs.appendFileSync(path.join(s.target, 'audio/song.mp3'), 'edited');
    const u = await s.waitJob(s.engine.planUndo({ planId: p.planId }));
    assert.equal(u.result.kept, 1);
    assert.ok(fs.existsSync(path.join(s.target, 'audio/song.mp3')));
  } finally { s.cleanup(); }
});

test('invalid plans are refused before touching anything', async () => {
  const s = await setup();
  try {
    assert.equal(s.plan({ template: '/etc/{name}' }).ok, false);
    assert.equal(s.plan({ template: '{bogus}' }).ok, false);
    assert.equal(s.plan({ targetRoot: 'relative/path' }).ok, false);
    assert.equal(s.plan({ mode: 'delete' }).ok, false);
    assert.equal(s.plan({ targetRoot: path.dirname(s.root) }).ok, false, 'source inside target');
    const bad = s.plan({ template: '{bogus}' });
    assert.equal(bad.planId, undefined);
    assert.equal(fs.existsSync(s.target), false);
  } finally { s.cleanup(); }
});

test('the engine works through its worker thread', async () => {
  const { EngineClient } = require('../../src/engine/client');
  const dir = tmpdir('dm-worker-');
  const events = [];
  const c = new EngineClient(path.join(dir, 'c.sqlite'), { onEvent: (e, d) => events.push([e, d]) });
  try {
    write(dir, 'data/a.txt', 'a');
    const src = await c.call('sources.add', { path: path.join(dir, 'data') });
    const job = await c.call('scan.start', { sourceId: src.id });
    for (let i = 0; i < 200 && !events.some(([e, d]) => e === 'job' && d.id === job.id && d.status === 'done'); i++) await new Promise((r) => setTimeout(r, 20));
    const q = await c.call('entries.query', { filter: { sourceId: src.id } });
    assert.equal(q.totals.count, 1);
    await assert.rejects(c.call('constructor', {}), /Unknown method/);
    await assert.rejects(c.call('sources.add', { path: 'relative' }), /absolute/);
  } finally {
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
