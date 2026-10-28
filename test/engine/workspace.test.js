'use strict';
// The review-first workflow: stage → commit → review → re-check → export.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEngine } = require('../helpers/engine');
const { write, randomBytes, snapshot } = require('../helpers/fsutil');
const { F } = require('../../src/engine/changes');
const { API } = require('../../src/engine/engine');

const FILES = {
  'Trips/Rome/IMG_1.jpg': randomBytes(120000, 1),
  'Trips/Rome/notes.txt': 'rome',
  'Trips/Oslo/IMG_1.jpg': randomBytes(90000, 2),
  'Work/report.pdf': randomBytes(40000, 3),
  'Work/Report.PDF': randomBytes(41000, 5),
  'Inbox/report copy.pdf': randomBytes(40000, 3),
  'Misc/song.mp3': randomBytes(60000, 4),
  'Misc/.DS_Store': 'junk',
  'Misc/Bad:name?.txt': 'x',
};

async function setup(files = FILES) {
  const ctx = makeEngine();
  const root = path.join(ctx.dir, 'src');
  for (const [rel, data] of Object.entries(files)) write(root, rel, data);
  const t = new Date('2021-05-06T10:00:00Z');
  for (const rel of Object.keys(files)) fs.utimesSync(path.join(root, rel), t, t);
  const src = ctx.engine.sourcesAdd({ path: root });
  await ctx.waitJob(ctx.engine.scanStart({ sourceId: src.id }));
  const e = ctx.engine;
  const sid = src.id;
  const stage = (op, selection, params = {}) => e.wsStage({ sourceId: sid, op, params, selection });
  const paths = (...p) => ({ paths: p });
  const planned = (kind = 'all') => Object.fromEntries(e.wsDiff({ sourceId: sid, kind, limit: 5000 }).rows.map((r) => [r.rel_path, r]));
  const commitAll = (msg = 'changes') => { const c = e.wsCommit({ sourceId: sid, message: msg }); e.wsReview({ sourceId: sid, commitId: c.commitId }); return c.commitId; };
  const verify = () => ctx.waitJob(e.wsVerify({ sourceId: sid }));
  return { ...ctx, e, sid, root, stage, paths, planned, commitAll, verify };
}

test('staging and committing never touch files; the planned state follows each change', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  const before = snapshot(c.root);
  c.stage('exclude', { preset: 'junk' });
  c.stage('move', c.paths('Inbox/report copy.pdf'), { to: 'Work/Copies' });
  c.stage('rename', c.paths('Trips/Oslo/IMG_1.jpg'), { name: 'oslo-harbour.jpg' });
  c.stage('layout', { filter: { categories: ['audio'] } }, { template: 'Music/{yyyy}/{name}' });
  const p = c.planned();
  assert.equal(p['Misc/.DS_Store'].flags & F.EXCLUDED, F.EXCLUDED);
  assert.equal(p['Inbox/report copy.pdf'].vpath, 'Work/Copies/report copy.pdf');
  assert.equal(p['Inbox/report copy.pdf'].flags & F.MOVED, F.MOVED);
  assert.equal(p['Trips/Oslo/IMG_1.jpg'].vpath, 'Trips/Oslo/oslo-harbour.jpg');
  assert.equal(p['Trips/Oslo/IMG_1.jpg'].flags & (F.RENAMED | F.MOVED), F.RENAMED);
  assert.equal(p['Misc/song.mp3'].vpath, 'Music/2021/song.mp3');
  const sum = c.e.wsSummary({ sourceId: c.sid });
  assert.equal(sum.staged, 4);
  assert.equal(sum.excludedFiles, 1);
  c.e.wsCommit({ sourceId: c.sid, message: 'tidy up' });
  assert.equal(c.e.wsSummary({ sourceId: c.sid }).unreviewed, 1);
  assert.deepEqual(snapshot(c.root), before);
});

test('folders carry their content; selecting a folder and its files moves them once', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  c.stage('move', c.paths('Trips/Rome', 'Trips/Rome/IMG_1.jpg', 'Trips/Rome/notes.txt'), { to: 'Archive/2021' });
  let p = c.planned();
  assert.equal(p['Trips/Rome/IMG_1.jpg'].vpath, 'Archive/2021/Rome/IMG_1.jpg');
  assert.equal(p['Trips/Rome/notes.txt'].vpath, 'Archive/2021/Rome/notes.txt');
  // A later rename of the moved folder follows its new location.
  c.stage('rename', c.paths('Trips/Rome'), { name: 'Roma' });
  p = c.planned();
  assert.equal(p['Trips/Rome/IMG_1.jpg'].vpath, 'Archive/2021/Roma/IMG_1.jpg');
  c.stage('exclude', c.paths('Trips'));
  assert.equal(c.planned('excluded')['Trips/Oslo/IMG_1.jpg'].flags & F.EXCLUDED, F.EXCLUDED);
  assert.equal(c.planned()['Trips/Rome/notes.txt'].flags & F.EXCLUDED, 0, 'Rome already moved out of Trips, so it stays');
  c.stage('include', c.paths('Trips/Oslo/IMG_1.jpg'));
  assert.equal(c.planned()['Trips/Oslo/IMG_1.jpg'].flags & F.EXCLUDED, 0);
  // Unstaging the last change brings back the previous state.
  const last = c.e.wsList({ sourceId: c.sid }).staged.pop();
  c.e.wsUnstage({ sourceId: c.sid, changeId: last.id });
  assert.equal(c.planned()['Trips/Oslo/IMG_1.jpg'].flags & F.EXCLUDED, F.EXCLUDED);
});

test('collisions are found per target file system, and block the export', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  // report.pdf and Report.PDF already differ only by case.
  let s = c.e.wsSummary({ sourceId: c.sid });
  assert.equal(s.conflicts, 2, 'APFS ignores case');
  c.e.wsTarget({ sourceId: c.sid, targetFs: 'ext4' });
  s = c.e.wsSummary({ sourceId: c.sid });
  assert.equal(s.conflicts, 0, 'ext4 is case-sensitive');
  // Two photos flattened into one folder collide.
  c.stage('layout', { filter: { exts: ['jpg'] } }, { template: 'Photos/{name}' });
  s = c.e.wsSummary({ sourceId: c.sid });
  assert.equal(s.conflicts, 2);
  // A file where another file needs a folder.
  c.stage('rename', c.paths('Misc/song.mp3'), { name: 'x' });
  c.stage('move', c.paths('Misc/Bad:name?.txt'), { to: 'Misc/x' });
  assert.equal(c.e.wsSummary({ sourceId: c.sid }).clashes, 1);
  c.commitAll();
  await c.verify();
  const check = c.e.wsCheck({ sourceId: c.sid });
  assert.equal(check.ok, false);
  assert.equal(check.items.find((i) => i.key === 'conflicts').ok, false);
  const r = c.e.wsExport({ sourceId: c.sid, targetRoot: path.join(c.dir, 'out'), finalReview: true });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(c.dir, 'out')));
});

test('export gate: staged, unreviewed and unchecked states are refused; renderer cannot bypass it', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  c.e.wsTarget({ sourceId: c.sid, targetFs: 'ext4' });
  const out = path.join(c.dir, 'out');
  const exp = () => c.e.wsExport({ sourceId: c.sid, targetRoot: out, finalReview: true });
  c.stage('exclude', { preset: 'junk' });
  assert.match(exp().errors.join(), /not committed/);
  const { commitId } = c.e.wsCommit({ sourceId: c.sid, message: 'drop clutter' });
  assert.match(exp().errors.join(), /not reviewed/);
  c.e.wsReview({ sourceId: c.sid, commitId });
  assert.match(exp().errors.join(), /not re-checked/);
  await c.verify();
  assert.throws(() => c.e.wsExport({ sourceId: c.sid, targetRoot: out }), /reviewed the final state/);
  assert.equal(exp().ok, true);
  assert.equal(API['plan.create'], undefined, 'no direct plan building from the UI');
});

test('re-check finds files changed or deleted since the scan', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  c.e.wsTarget({ sourceId: c.sid, targetFs: 'ext4' });
  c.stage('exclude', { preset: 'junk' });
  c.commitAll();
  fs.appendFileSync(path.join(c.root, 'Trips/Rome/notes.txt'), ' edited');
  fs.rmSync(path.join(c.root, 'Misc/song.mp3'));
  const r = await c.verify();
  assert.equal(r.result.changed, 1);
  assert.equal(r.result.missing, 1);
  const check = c.e.wsCheck({ sourceId: c.sid });
  assert.equal(check.items.find((i) => i.key === 'stale').ok, false);
  assert.equal(c.planned('stale')['Misc/song.mp3'].flags & F.STALE, F.STALE);
  // Excluding them is itself a reviewed change.
  c.stage('exclude', { preset: 'stale' });
  c.commitAll('skip changed files');
  await c.verify();
  assert.equal(c.e.wsCheck({ sourceId: c.sid }).ok, true);
});

test('export writes exactly the reviewed state, verified; the source is untouched; undo restores', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  c.e.wsTarget({ sourceId: c.sid, targetFs: 'exfat' });
  c.stage('exclude', { preset: 'junk' });
  c.stage('exclude', c.paths('Work/Report.PDF'));
  c.stage('layout', { filter: { categories: ['image'] } }, { template: 'Photos/{parent}/{name}' });
  c.stage('sanitize', c.paths('Misc/Bad:name?.txt'), { targetFs: 'exfat' });
  const id = c.commitAll('sort photos');
  await c.verify();
  const before = snapshot(c.root);
  const out = path.join(c.dir, 'out');
  const plan = c.e.wsExport({ sourceId: c.sid, targetRoot: out, finalReview: true });
  assert.equal(plan.ok, true, plan.errors.join());
  const job = await c.waitJob(c.e.planExecute({ planId: plan.planId }));
  assert.equal(job.result.status, 'done');
  const got = Object.keys(snapshot(out)).filter((k) => /\./.test(k)).sort();
  assert.deepEqual(got, ['Inbox/report copy.pdf', 'Misc/Bad_name_.txt', 'Misc/song.mp3', 'Photos/Oslo/IMG_1.jpg', 'Photos/Rome/IMG_1.jpg', 'Trips/Rome/notes.txt', 'Work/report.pdf'].sort());
  assert.ok(fs.readFileSync(path.join(out, 'Photos/Rome/IMG_1.jpg')).equals(FILES['Trips/Rome/IMG_1.jpg']));
  assert.deepEqual(snapshot(c.root), before);
  const k = c.e.wsList({ sourceId: c.sid }).commits.find((x) => x.id === id);
  assert.equal(k.status, 'exported');
  assert.equal(k.plan_id, plan.planId);
  await c.waitJob(c.e.planUndo({ planId: plan.planId }));
  assert.equal(c.e.wsList({ sourceId: c.sid }).commits[0].status, 'reviewed');
  assert.deepEqual(Object.keys(snapshot(out)).filter((k2) => /\./.test(k2)), []);
});

test('a plan built before the state changed is refused at run time', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  c.e.wsTarget({ sourceId: c.sid, targetFs: 'ext4' });
  c.stage('exclude', { preset: 'junk' });
  c.commitAll();
  await c.verify();
  const plan = c.e.wsExport({ sourceId: c.sid, targetRoot: path.join(c.dir, 'out'), finalReview: true });
  assert.equal(plan.ok, true);
  c.stage('exclude', c.paths('Misc/song.mp3'));
  assert.throws(() => c.e.planExecute({ planId: plan.planId }), /changed after this export plan was built/);
  assert.ok(!fs.existsSync(path.join(c.dir, 'out')));
});

test('in-place move applies the commits; after a rescan the workspace is clean', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  c.e.wsTarget({ sourceId: c.sid, targetFs: 'ext4' });
  c.stage('move', c.paths('Inbox/report copy.pdf'), { to: 'Work' });
  c.commitAll('file the copy');
  await c.verify();
  const plan = c.e.wsExport({ sourceId: c.sid, targetRoot: c.root, mode: 'move', finalReview: true });
  assert.equal(plan.ok, true, plan.errors.join());
  const job = await c.waitJob(c.e.planExecute({ planId: plan.planId }));
  assert.equal(job.result.status, 'done');
  assert.ok(fs.existsSync(path.join(c.root, 'Work/report copy.pdf')));
  assert.ok(!fs.existsSync(path.join(c.root, 'Inbox/report copy.pdf')));
  assert.equal(c.e.wsList({ sourceId: c.sid }).commits[0].status, 'applied');
  await c.waitJob(c.e.scanStart({ sourceId: c.sid }));
  const s = c.e.wsSummary({ sourceId: c.sid });
  assert.equal(s.changedFiles, 0);
  assert.equal(s.commits, 0);
});

test('changes survive a rescan by path; vanished items are counted, not guessed', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  c.stage('exclude', c.paths('Misc/song.mp3', 'Work/report.pdf'));
  fs.rmSync(path.join(c.root, 'Misc/song.mp3'));
  await c.waitJob(c.e.scanStart({ sourceId: c.sid }));
  const ch = c.e.wsList({ sourceId: c.sid }).staged[0];
  assert.equal(ch.missing, 1);
  assert.equal(c.planned('excluded')['Work/report.pdf'].flags & F.EXCLUDED, F.EXCLUDED);
});

test('keep one copy of each duplicate, by rule', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  assert.throws(() => c.stage('dedupe', { preset: 'all' }), /duplicate check first/);
  fs.utimesSync(path.join(c.root, 'Inbox/report copy.pdf'), new Date('2019-01-01'), new Date('2019-01-01'));
  await c.waitJob(c.e.scanStart({ sourceId: c.sid }));
  await c.waitJob(c.e.dupesFind({ sourceId: c.sid }));
  c.stage('dedupe', { preset: 'all' }, { keep: 'oldest' });
  const x = c.planned('excluded');
  assert.ok(x['Work/report.pdf'], 'newer copy dropped');
  assert.equal(x['Inbox/report copy.pdf'], undefined, 'oldest kept');
});

test('invalid changes are refused before anything is recorded', async (t) => {
  const c = await setup();
  t.after(c.cleanup);
  assert.throws(() => c.stage('move', c.paths('Misc/song.mp3'), { to: '../outside' }), /"\.\."/);
  assert.throws(() => c.stage('rename', c.paths('Misc/song.mp3'), { name: 'a/b' }), /valid name/);
  assert.throws(() => c.stage('rename', c.paths('Misc/song.mp3', 'Work/report.pdf'), { name: 'x' }), /one item/);
  assert.throws(() => c.stage('layout', { preset: 'all' }, { template: '{nope}' }), /Unknown token/);
  assert.throws(() => c.stage('explode', { preset: 'all' }), /Unknown change/);
  assert.throws(() => c.stage('exclude', { filter: { name: 'nothing-matches-*' } }), /empty/);
  assert.throws(() => c.e.wsCommit({ sourceId: c.sid, message: '  ' }), /commit message/);
  assert.equal(c.e.wsList({ sourceId: c.sid }).changes.length, 0);
});
