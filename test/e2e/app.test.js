'use strict';
// Drives the real Electron app with Playwright. On Linux run under a virtual
// display: xvfb-run -a npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');
const { tmpdir, snapshot, write, randomBytes, hasRsync } = require('../helpers/fsutil');

const root = path.join(__dirname, '..', '..');
const noRsync = hasRsync() ? false : 'rsync not installed';
const work = tmpdir('dd-e2e-');
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

async function launch(dataDir) {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, '--no-sandbox'],
    env: { ...process.env, SYNCDECK_DATA_DIR: dataDir, SYNCDECK_TEST: '1' },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('#sideFoot:not(:empty)');
  return { app, win, errors };
}

// Native folder dialogs can't be clicked in a test, so answer them from main.
const answerDialog = (app, dir) => app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); }, dir);
const nav = (win, page) => win.click(`.nav a[data-page="${page}"]`);
const modalOk = (win) => win.click('.modal-f .btn:last-child');
const planStatus = (win) => win.evaluate(() => DD.call('plan.get', { planId: DD.state.restructure.planId }).then((p) => p.status));
async function waitPlan(win, re, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await planStatus(win);
    if (re.test(st)) return st;
    if (Date.now() > end) throw new Error(`plan stuck in ${st}`);
    await win.waitForTimeout(150);
  }
}

test('data flow: add source, analyze, filter, plan, verified copy, undo', { timeout: 180000 }, async () => {
  const src = path.join(work, 'library');
  const out = path.join(work, 'sorted');
  const jpg = randomBytes(200000, 1);
  write(src, 'Trips/2024/IMG_0001.jpg', jpg);
  write(src, 'Backup/IMG_0001 copy.jpg', jpg); // duplicate
  write(src, 'Trips/2024/IMG_0002.jpg', randomBytes(150000, 2));
  write(src, 'docs/report.pdf', randomBytes(50000, 3));
  write(src, 'deep/a/b/c/d/e/f/g/notes.txt', 'deep');
  write(src, 'docs/Bad:name?.txt', 'not portable');
  write(src, '<img src=x onerror="document.title=1">.txt', 'xss');
  write(src, '.DS_Store', 'junk');
  const before = snapshot(src);

  const { app, win, errors } = await launch(path.join(work, 'data-flow'));
  try {
    // Renderer is sandboxed: no Node APIs.
    assert.equal(await win.evaluate(() => typeof window.require + typeof window.process), 'undefinedundefined');

    await answerDialog(app, src);
    await win.click('#btnAddSource');
    await win.waitForFunction(() => /8 files/.test(document.querySelector('#sourceList').textContent), null, { timeout: 30000 });

    // Overview: statistics tables.
    await win.waitForSelector('#page-overview .kpis');
    assert.match(await win.textContent('#page-overview'), /library/);
    assert.match(await win.textContent('#page-overview .kpis'), /FILES\s*8|Files\s*8/i);
    assert.match(await win.textContent('#page-overview'), /image/);

    // Duplicates: the content check finds the copy.
    await nav(win, 'dupes');
    await win.click('#page-dupes >> text=Find duplicates');
    await win.waitForFunction(() => /Export without duplicates/.test(document.querySelector('#page-dupes').textContent), null, { timeout: 30000 });
    assert.match(await win.textContent('#page-dupes'), /IMG_0001 copy\.jpg/);

    // Issues: names that break on Windows/exFAT are flagged.
    await nav(win, 'issues');
    await win.waitForFunction(() => /Bad:name\?\.txt/.test(document.querySelector('#page-issues').textContent) || document.querySelector('#page-issues .vt-r'), null, { timeout: 10000 });
    assert.ok(Number(await win.textContent('#navIssues')) > 0);

    // Explorer: hostile names are text, never HTML.
    await nav(win, 'explorer');
    await win.waitForSelector('#page-explorer .vt-r');
    assert.equal(await win.locator('#page-explorer .vt-b img').count(), 0);
    assert.notEqual(await win.title(), '1');
    await win.fill('#page-explorer input[placeholder="*.jpg, IMG_*"]', '*.jpg');
    await win.waitForFunction(() => /^3 entries/.test(document.querySelector('#page-explorer .statusline').textContent.trim()), null, { timeout: 5000 });

    // Restructure only those, by type then year, into a new folder.
    await win.click('#page-explorer >> text=Restructure these…');
    await win.waitForSelector('#page-restructure >> text=3 files');
    await win.fill('#page-restructure input[placeholder="/Volumes/Archive/Sorted"]', out);
    await win.click('#page-restructure >> text=By type');
    await win.waitForFunction(() => /image\//.test(document.querySelector('#page-restructure .preview-list').textContent));
    await win.click('#page-restructure >> text=Build plan');
    await win.waitForSelector('#page-restructure >> text=Plan #1');
    assert.equal(fs.existsSync(out), false, 'building a plan writes nothing');
    await win.click('#page-restructure >> text=Run plan (copy)');
    await modalOk(win);
    assert.equal(await waitPlan(win, /^done/), 'done');
    const got = snapshot(out);
    assert.deepEqual(Object.keys(got).sort(), ['image', 'image/jpg', 'image/jpg/IMG_0001 copy.jpg', 'image/jpg/IMG_0001.jpg', 'image/jpg/IMG_0002.jpg'].sort());
    assert.equal(fs.readFileSync(path.join(out, 'image/jpg/IMG_0001.jpg')).equals(jpg), true);
    assert.deepEqual(snapshot(src), before, 'copy never touches the source');
    await win.waitForSelector('#page-restructure >> text=Undo…');

    // Undo removes exactly what the plan wrote.
    await win.click('#page-restructure >> text=Undo…');
    await modalOk(win);
    await waitPlan(win, /^undone/);
    assert.deepEqual(snapshot(out), {});
    assert.deepEqual(snapshot(src), before);

    // Plans list keeps the journal.
    await nav(win, 'plans');
    await win.waitForSelector('#page-plans >> text=#1');
    assert.match(await win.textContent('#page-plans'), /undone/);
    await nav(win, 'jobs');
    await win.waitForSelector('#page-jobs table');
    assert.match(await win.textContent('#page-jobs'), /done/);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

// ── Sync (rsync) ──
async function fill(win, sel, value) {
  await win.fill(sel, value);
  await win.waitForTimeout(450); // autosave + validation debounce
}
const state = (win) => win.textContent('#syncState');
async function waitDone(win, ms = 60000) {
  await win.waitForFunction(() => document.querySelector('#btnStop').disabled && !/Idle/.test(document.querySelector('#syncState').textContent), null, { timeout: ms });
}
async function openSync(win) {
  await nav(win, 'sync');
  await win.waitForSelector('#p-source');
}

test('sync: setup, preview, mirror with verify, history, persistence', { skip: noRsync, timeout: 180000 }, async () => {
  const data = path.join(work, 'data1');
  const src = path.join(work, 'src');
  const dst = path.join(work, 'dst');
  write(src, 'a.txt', 'alpha');
  write(src, 'nested/b.bin', randomBytes(300000, 4));
  write(src, '<img src=x onerror="document.title=1">.txt', 'xss');
  write(dst, 'stale.txt', 'old');

  let { app, win } = await launch(data);
  try {
    assert.match(await win.textContent('#sideFoot'), /rsync/);
    await openSync(win);
    // Empty profile can't run.
    assert.equal(await win.isDisabled('#btnRun'), true);
    assert.match(await win.textContent('#syncChecks'), /Choose a source/);

    await fill(win, '#p-name', 'E2E Photos');
    await fill(win, '#p-source', src);
    await fill(win, '#p-dest', dst);
    await win.click('.flag[data-flag="delete"]');
    await win.waitForTimeout(450);
    assert.equal(await win.isDisabled('#btnRun'), false);
    const cmd = await win.textContent('#syncCmd');
    assert.match(cmd, /--delete/);
    assert.match(cmd, /--max-delete=500/);
    assert.match(cmd, / -- /);
    assert.match(await win.textContent('#syncChecks'), /will be deleted/);

    // A blocked extra option disables running.
    await fill(win, '#p-extraArgs', '--rsync-path=evil');
    assert.equal(await win.isDisabled('#btnRun'), true);
    assert.match(await win.textContent('#syncChecks'), /not allowed/);
    await fill(win, '#p-extraArgs', '');

    // Preview: lists changes, touches nothing.
    const before = snapshot(dst);
    await win.click('#btnPreview');
    await waitDone(win);
    assert.match(await state(win), /Preview ready/);
    assert.deepEqual(snapshot(dst), before);
    assert.equal(await win.textContent('[data-f="delete"] .mono'), '1');
    assert.equal(await win.textContent('[data-f="new"] .mono'), '3');
    assert.match(await win.textContent('#syncBanner'), /Nothing has been changed yet/);
    // The hostile file name is shown as text, not parsed as HTML.
    assert.equal(await win.locator('#page-sync .vt-b img').count(), 0);
    assert.ok((await win.textContent('#page-sync .vt-b')).includes('<img src=x onerror="document.title=1">.txt'));
    assert.notEqual(await win.title(), '1');

    // Run from the banner: mirror needs the acknowledgement box.
    await win.click('#syncBanner .btn.primary');
    await win.waitForSelector('.modal');
    assert.equal(await win.isDisabled('.modal-f .btn:last-child'), true);
    await win.click('.modal-f input[type=checkbox]');
    await modalOk(win);
    await waitDone(win);
    assert.match(await state(win), /^Done$/);
    assert.match(await win.textContent('#syncBanner'), /Verified: every file matches by checksum/);
    assert.deepEqual(snapshot(dst), snapshot(src));

    await win.click('[data-tab="history"]');
    const rows = await win.locator('#page-sync table.stat tbody tr').allTextContents();
    assert.equal(rows.length, 2);
    assert.match(rows[0], /sync.*ok.*success/);
    assert.match(rows[1], /preview.*success/);

    await win.click('[data-tab="log"]');
    assert.match(await win.textContent('#syncLog'), /\$ .*rsync/);
  } finally {
    await app.close();
  }

  // Profiles and history survive a restart.
  ({ app, win } = await launch(data));
  try {
    await openSync(win);
    assert.match(await win.textContent('#page-sync .nav'), /E2E Photos[\s\S]*success/);
    assert.equal(await win.inputValue('#p-source'), src);
  } finally {
    await app.close();
  }
});

test('sync: stop mid-transfer, then resume to a verified copy', { skip: noRsync, timeout: 180000 }, async () => {
  const src = path.join(work, 'src2');
  const dst = path.join(work, 'dst2');
  for (let i = 0; i < 4; i++) write(src, `f${i}.bin`, randomBytes(700 * 1024, 30 + i));
  const { app, win } = await launch(path.join(work, 'data2'));
  try {
    await openSync(win);
    await fill(win, '#p-source', src);
    await fill(win, '#p-dest', dst);
    await fill(win, '#p-bwlimit', '500');
    await win.click('#btnRun');
    await win.waitForSelector('.modal');
    assert.match(await win.textContent('.modal-b'), /not previewed/);
    await modalOk(win);
    await win.waitForFunction(() => /Syncing/.test(document.querySelector('#syncState').textContent));
    await win.waitForFunction(() => /\d+%/.test(document.querySelector('#syncPct').textContent), null, { timeout: 15000 });
    await win.click('#btnStop');
    await waitDone(win);
    assert.match(await state(win), /Stopped/);

    await win.click('[data-tab="setup"]');
    await fill(win, '#p-bwlimit', '');
    await win.click('[data-tab="transfers"]');
    await win.click('#syncBanner >> text=Resume');
    await win.waitForSelector('.modal');
    await modalOk(win);
    await waitDone(win);
    assert.match(await state(win), /^Done$/);
    assert.deepEqual(snapshot(dst), snapshot(src));
  } finally {
    await app.close();
  }
});

test('sync: wiping protection blocks an empty source with delete', { skip: noRsync, timeout: 60000 }, async () => {
  const src = path.join(work, 'empty-src');
  const dst = path.join(work, 'precious');
  fs.mkdirSync(src, { recursive: true });
  write(dst, 'family.jpg', 'irreplaceable');
  const { app, win } = await launch(path.join(work, 'data3'));
  try {
    await openSync(win);
    await fill(win, '#p-source', src);
    await fill(win, '#p-dest', dst);
    await win.click('.flag[data-flag="delete"]');
    await win.waitForTimeout(450);
    assert.match(await win.textContent('#syncChecks'), /Source folder is empty/);
    assert.equal(await win.isDisabled('#btnRun'), true);
    assert.equal(await win.isDisabled('#btnPreview'), true);
    assert.equal(fs.readFileSync(path.join(dst, 'family.jpg'), 'utf8'), 'irreplaceable');
  } finally {
    await app.close();
  }
});

test('sync: network drop shows link lost, reconnects on its own, verifies', { skip: noRsync, timeout: 180000 }, async () => {
  const { startDaemon, FlakyProxy } = require('../helpers/netlab');
  const lab = tmpdir('dd-e2e-net-');
  const daemon = await startDaemon(lab);
  const proxy = new FlakyProxy(daemon.port);
  await proxy.listen();
  const src = path.join(work, 'src-net');
  write(src, 'movie.mov', randomBytes(4 * 1024 * 1024, 77));
  let cut = false;
  proxy.onBytes = (n) => { if (!cut && n > 1.5 * 1024 * 1024) { cut = true; proxy.cut(); } };
  const { app, win } = await launch(path.join(work, 'data4'));
  try {
    await openSync(win);
    await fill(win, '#p-source', src);
    await fill(win, '#p-dest', `rsync://127.0.0.1:${proxy.port}/mod/`);
    await fill(win, '#p-bwlimit', '2000');
    assert.match(await win.textContent('#syncChecks'), /not encrypted/);
    await win.click('#btnRun');
    await modalOk(win);
    await win.waitForFunction(() => /Link lost · retry in \d+s/.test(document.querySelector('#syncState').textContent), null, { timeout: 30000 });
    await waitDone(win, 120000);
    assert.ok(cut);
    assert.match(await state(win), /^Done$/);
    const stats = await win.textContent('#syncStats');
    assert.match(stats, /try 2\/9/);
    assert.match(stats, /1 reconnects/);
    assert.match(await win.textContent('#syncBanner'), /Verified.*Needed 2 attempts/);
    assert.deepEqual(snapshot(daemon.modPath, { skip: ['.rsync-partial'] }), snapshot(src));
  } finally {
    await app.close();
    await proxy.close();
    daemon.stop();
    fs.rmSync(lab, { recursive: true, force: true });
  }
});
