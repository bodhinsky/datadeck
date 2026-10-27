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
const skip = hasRsync() ? false : 'rsync not installed';
const work = tmpdir('sd-e2e-');
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

async function launch(dataDir) {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, '--no-sandbox'],
    env: { ...process.env, SYNCDECK_DATA_DIR: dataDir, SYNCDECK_TEST: '1' },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#profileList .nav-i');
  return { app, win };
}

async function fill(win, sel, value) {
  await win.fill(sel, value);
  await win.waitForTimeout(450); // autosave + validation debounce
}

const lcd = (win) => win.textContent('#lcdState');
async function waitDone(win, ms = 60000) {
  await win.waitForFunction(() => /DONE|FAILED|STOPPED|READY/.test(document.querySelector('#lcdState').textContent) && !document.body.classList.contains('running'), null, { timeout: ms });
}

test('end-to-end: setup, preview, mirror sync with verify, history, persistence', { skip, timeout: 180000 }, async () => {
  const data = path.join(work, 'data1');
  const src = path.join(work, 'src');
  const dst = path.join(work, 'dst');
  write(src, 'a.txt', 'alpha');
  write(src, 'nested/b.bin', randomBytes(300000, 4));
  write(src, '<img src=x onerror="document.title=1">.txt', 'xss');
  write(dst, 'stale.txt', 'old');

  let { app, win } = await launch(data);
  try {
    // Renderer is sandboxed: no Node APIs.
    assert.equal(await win.evaluate(() => typeof window.require + typeof window.process), 'undefinedundefined');
    assert.match(await win.textContent('#sideFoot'), /rsync/);

    // Empty profile can't run.
    assert.equal(await win.isDisabled('#btnSync'), true);
    assert.match(await win.textContent('#checks'), /Choose a source/);

    await fill(win, '#pName', 'E2E Photos');
    await fill(win, '#pSource', src);
    await fill(win, '#pDest', dst);
    await win.click('.flag[data-flag="delete"]');
    await win.waitForTimeout(450);
    assert.equal(await win.isDisabled('#btnSync'), false);
    const cmd = await win.textContent('#cmdPreview');
    assert.match(cmd, /--delete/);
    assert.match(cmd, /--max-delete=500/);
    assert.match(cmd, / -- /);
    assert.match(await win.textContent('#checks'), /will be deleted/);

    // A blocked extra option disables running.
    await fill(win, '#pExtra', '--rsync-path=evil');
    assert.equal(await win.isDisabled('#btnSync'), true);
    assert.match(await win.textContent('#checks'), /not allowed/);
    await fill(win, '#pExtra', '');

    // Preview: lists changes, touches nothing.
    const before = snapshot(dst);
    await win.click('#btnPreview');
    await waitDone(win);
    assert.match(await lcd(win), /PREVIEW READY/);
    assert.deepEqual(snapshot(dst), before);
    assert.equal(await win.textContent('#cDel'), '0001');
    assert.equal(await win.textContent('#cNew'), '0003');
    assert.match(await win.textContent('#tBanner'), /Nothing has been changed yet/);
    // The hostile file name is shown as text, not parsed as HTML.
    assert.equal(await win.locator('#tBody img').count(), 0);
    assert.ok((await win.textContent('#tBody')).includes('<img src=x onerror="document.title=1">.txt'));
    assert.notEqual(await win.title(), '1');

    // Run from the banner: mirror needs the acknowledgement box.
    await win.click('#tBanner .btn.primary');
    await win.waitForSelector('#modal:not([hidden])');
    assert.equal(await win.isDisabled('#mOk'), true);
    await win.click('#mAck');
    await win.click('#mOk');
    await waitDone(win);
    assert.match(await lcd(win), /DONE/);
    assert.match(await win.textContent('#tBanner'), /Verified: every file matches by checksum/);
    assert.deepEqual(snapshot(dst), snapshot(src));

    await win.click('.nav-i[data-view="history"]');
    const rows = await win.locator('#hBody .row').allTextContents();
    assert.equal(rows.length, 2);
    assert.match(rows[0], /SYNC.*✓ OK.*SUCCESS/);
    assert.match(rows[1], /PREVIEW.*SUCCESS/);

    await win.click('.nav-i[data-view="log"]');
    assert.match(await win.textContent('#console'), /\$ .*rsync/);
  } finally {
    await app.close();
  }

  // Profiles and history survive a restart.
  ({ app, win } = await launch(data));
  try {
    assert.match(await win.textContent('#profileList'), /E2E Photos/);
    assert.equal(await win.inputValue('#pSource'), src);
    assert.match(await win.textContent('#lrStatus'), /OK\+VFY/);
  } finally {
    await app.close();
  }
});

test('end-to-end: stop mid-transfer, then resume to a verified copy', { skip, timeout: 180000 }, async () => {
  const data = path.join(work, 'data2');
  const src = path.join(work, 'src2');
  const dst = path.join(work, 'dst2');
  for (let i = 0; i < 4; i++) write(src, `f${i}.bin`, randomBytes(700 * 1024, 30 + i));
  const { app, win } = await launch(data);
  try {
    await fill(win, '#pSource', src);
    await fill(win, '#pDest', dst);
    await fill(win, '#nBw', '500');
    await win.click('#btnSync');
    await win.waitForSelector('#modal:not([hidden])');
    assert.match(await win.textContent('#mBody'), /not previewed/);
    await win.click('#mOk');
    await win.waitForFunction(() => /SYNCING/.test(document.querySelector('#lcdState').textContent));
    await win.waitForFunction(() => /\d+%/.test(document.querySelector('#lcdPct').textContent), null, { timeout: 15000 });
    await win.click('#btnStop');
    await waitDone(win);
    assert.match(await lcd(win), /STOPPED/);

    await win.click('.nav-i[data-view="setup"]');
    await fill(win, '#nBw', '');
    await win.click('.nav-i[data-view="transfers"]');
    await win.click('#tBanner >> text=RESUME');
    await win.waitForSelector('#modal:not([hidden])');
    await win.click('#mOk');
    await waitDone(win);
    assert.match(await lcd(win), /DONE/);
    assert.deepEqual(snapshot(dst), snapshot(src));
  } finally {
    await app.close();
  }
});

test('end-to-end: wiping protection blocks an empty source with delete', { skip, timeout: 60000 }, async () => {
  const data = path.join(work, 'data3');
  const src = path.join(work, 'empty-src');
  const dst = path.join(work, 'precious');
  fs.mkdirSync(src, { recursive: true });
  write(dst, 'family.jpg', 'irreplaceable');
  const { app, win } = await launch(data);
  try {
    await fill(win, '#pSource', src);
    await fill(win, '#pDest', dst);
    await win.click('.flag[data-flag="delete"]');
    await win.waitForTimeout(450);
    assert.match(await win.textContent('#checks'), /Source folder is empty/);
    assert.equal(await win.isDisabled('#btnSync'), true);
    assert.equal(await win.isDisabled('#btnPreview'), true);
    assert.equal(fs.readFileSync(path.join(dst, 'family.jpg'), 'utf8'), 'irreplaceable');
  } finally {
    await app.close();
  }
});

test('end-to-end: network drop shows LINK LOST, reconnects on its own, verifies', { skip, timeout: 180000 }, async () => {
  const { startDaemon, FlakyProxy } = require('../helpers/netlab');
  const lab = tmpdir('sd-e2e-net-');
  const daemon = await startDaemon(lab);
  const proxy = new FlakyProxy(daemon.port);
  await proxy.listen();
  const src = path.join(work, 'src-net');
  write(src, 'movie.mov', randomBytes(4 * 1024 * 1024, 77));
  let cut = false;
  proxy.onBytes = (n) => { if (!cut && n > 1.5 * 1024 * 1024) { cut = true; proxy.cut(); } };
  const { app, win } = await launch(path.join(work, 'data4'));
  try {
    await fill(win, '#pSource', src);
    await fill(win, '#pDest', `rsync://127.0.0.1:${proxy.port}/mod/`);
    await fill(win, '#nBw', '2000');
    assert.match(await win.textContent('#chipRoute'), /DAEMON/);
    await win.click('#btnSync');
    await win.click('#mOk');
    await win.waitForFunction(() => /LINK LOST · RETRY IN \d+S/.test(document.querySelector('#lcdState').textContent), null, { timeout: 30000 });
    await waitDone(win, 120000);
    assert.ok(cut);
    assert.match(await lcd(win), /DONE/);
    assert.equal(await win.textContent('#tRetries'), '01');
    assert.match(await win.textContent('#lcdAttempt'), /TRY 2\/9/);
    assert.match(await win.textContent('#checks'), /not encrypted/);
    assert.match(await win.textContent('#tBanner'), /Verified.*Needed 2 attempts/);
    assert.deepEqual(snapshot(daemon.modPath, { skip: ['.rsync-partial'] }), snapshot(src));
  } finally {
    await app.close();
    await proxy.close();
    daemon.stop();
    fs.rmSync(lab, { recursive: true, force: true });
  }
});
