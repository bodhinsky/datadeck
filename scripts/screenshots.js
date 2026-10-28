'use strict';
// Launches the real app against a throwaway demo library and saves screenshots
// of each page to docs/screenshots. Linux needs a display: run via xvfb-run.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'screenshots');

// A messy home-folder-like library: mixed types, years, depths, duplicates and
// names that won't survive a trip to a Windows or exFAT drive.
function makeDemo(dir) {
  const lib = path.join(dir, 'Archive');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const put = (rel, size, year, content) => {
    const f = path.join(lib, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content || crypto.randomBytes(size));
    const t = new Date(Date.UTC(year, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27))) / 1000;
    fs.utimesSync(f, t, t);
  };
  // Real JPEGs with EXIF: the date taken and camera are patched into a
  // template per file, and the file dates are the (later) copy dates.
  const scenes = fs.readdirSync(path.join(root, 'test/fixtures/demo')).sort().map((f) => fs.readFileSync(path.join(root, 'test/fixtures/demo', f)));
  const photo = (sceneNo, taken, model) => {
    const b = Buffer.from(scenes[sceneNo % scenes.length]);
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = taken ? `${taken.getFullYear()}:${p2(taken.getMonth() + 1)}:${p2(taken.getDate())} ${p2(taken.getHours())}:${p2(taken.getMinutes())}:${p2(taken.getSeconds())}` : '0000:00:00 00:00:00';
    b.write(stamp, b.indexOf('2000:01:01 00:00:00'), 'latin1');
    b.write(model.padEnd(17, ' ').slice(0, 17), b.indexOf('MODEL_SLOT_______'), 'latin1');
    b.write(model.startsWith('Canon') ? 'Canon' : 'Apple', b.indexOf('MAKE_'), 'latin1');
    return b;
  };
  const trips = [['Lisbon', 'iPhone 11'], ['Alps', 'iPhone 12 Pro'], ['Kyoto', 'iPhone 13 Pro'], ['Iceland', 'iPhone 14 Pro']];
  trips.forEach(([t, cam], ti) => {
    for (let i = 0; i < 40; i++) {
      const taken = new Date(2019 + ti, 3 + ti * 2, 3 + Math.floor(i / 8), 9 + (i % 8), i, (i * 7) % 60);
      put(`Photos/${2019 + ti}/${t}/IMG_${4000 + ti * 100 + i}.jpg`, 0, 2021 + (ti % 3), photo(i + ti, i % 13 === 5 ? null : taken, i % 9 === 4 ? 'Canon EOS R6' : cam));
    }
  });
  for (let i = 0; i < 18; i++) put(`Photos/${2023}/Phone/IMG_${7000 + i}.jpg`, 0, 2024, photo(i, new Date(2023, 6, 1 + i, 12, i), 'iPhone 15 Pro'));
  // Misnamed: JPEG data with a .png name, as some messengers do.
  for (let i = 0; i < 3; i++) put(`Downloads/WhatsApp Image ${i + 1}.png`, 0, 2024, photo(i + 2, new Date(2024, 1, 10 + i, 18), 'iPhone 15 Pro'));
  for (let i = 0; i < 8; i++) put(`Videos/Clips/clip_${i}.mov`, 900000 + Math.floor(rnd() * 2500000), 2020 + (i % 5));
  for (let i = 0; i < 30; i++) put(`Documents/Uni/Semester ${1 + (i % 6)}/notes-${i}.pdf`, 20000 + Math.floor(rnd() * 300000), 2018 + (i % 6));
  for (let i = 0; i < 12; i++) put(`Documents/Finance/statement-${2020 + (i % 4)}-${i}.xlsx`, 15000 + Math.floor(rnd() * 40000), 2020 + (i % 4));
  const songs = ['song.mp3', 'track.flac', 'voice.m4a'].map((f) => fs.readFileSync(path.join(root, 'test/fixtures/media', f)));
  for (let i = 0; i < 20; i++) put(`Music/Live Sets/set-${i}.${['mp3', 'flac', 'm4a'][i % 3]}`, 0, 2017 + (i % 7), Buffer.concat([songs[i % 3], Buffer.from([i])]));
  put('Documents/Uni/Thesis draft.docx', 0, 2023, fs.readFileSync(path.join(root, 'test/fixtures/media/report.docx')));
  put('Documents/Uni/Reading list.txt', 0, 2023, 'Reading list\n\n1. Designing Data-Intensive Applications\n2. The Pragmatic Programmer\n3. Thinking, Fast and Slow\n');
  for (let i = 0; i < 25; i++) put(`Code/projects/app/src/module${i}/index.js`, 800 + Math.floor(rnd() * 9000), 2024);
  put('Code/projects/app/assets/a/b/c/d/e/f/g/h/deep.json', 400, 2024);
  put('Downloads/setup.dmg', 3200000, 2025);
  put('Downloads/archive.zip', 1800000, 2025);
  // Duplicates: the same photos copied into "Backup" and "To sort".
  const src = path.join(lib, 'Photos/2019/Lisbon');
  fs.readdirSync(src).slice(0, 14).forEach((n, i) => {
    for (const d of ['Backup/Phone 2019', i < 6 ? 'To sort' : null].filter(Boolean)) {
      fs.mkdirSync(path.join(lib, d), { recursive: true });
      const to = path.join(lib, d, i % 3 ? n : `${n.replace('.jpg', '')} copy.jpg`);
      fs.copyFileSync(path.join(src, n), to);
      const st = fs.statSync(path.join(src, n));
      fs.utimesSync(to, st.atime, st.mtime);
    }
  });
  // Portability problems.
  put('Documents/Uni/Q&A: exam?.txt', 900, 2022);
  put('Documents/Uni/Report.PDF', 1200, 2022);
  put('Documents/Uni/report.pdf', 1300, 2022);
  put('Documents/Notes/todo. ', 50, 2023);
  put('To sort/.DS_Store', 6148, 2024);
  put('To sort/empty.txt', 0, 2024, Buffer.alloc(0));
  fs.mkdirSync(path.join(lib, 'To sort/Empty folder'), { recursive: true });
  return lib;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'datadeck-shots-'));
  const lib = makeDemo(tmp);
  const target = path.join(tmp, 'Sorted');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const syncSrc = path.join(lib, 'Photos');
  const syncDst = path.join(tmp, 'Backup', 'Photos');
  fs.mkdirSync(syncDst, { recursive: true });
  fs.writeFileSync(path.join(syncDst, 'old-export.zip'), Buffer.alloc(120000, 3));
  const base = { flags: { archive: true, delete: true }, excludes: ['.DS_Store'], safety: { verifyAfter: true, backup: false, backupDir: '', maxDelete: 500 }, network: { retries: 8, timeout: 60, sshPort: '', bwlimit: '', identityFile: '' }, contents: true, extraArgs: '' };
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify([
    { ...base, id: 'p1', name: 'Photos → Backup', source: syncSrc, dest: syncDst },
    { ...base, id: 'p2', name: 'NAS Documents', source: '~/Documents', dest: 'tim@nas.local:/volume1/docs', flags: { archive: true, compress: true } },
  ]));

  const app = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], env: { ...process.env, SYNCDECK_DATA_DIR: dataDir, SYNCDECK_TEST: '1' } });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1360, height: 880 });
  await win.waitForSelector('#sideFoot:not(:empty)');
  const shot = async (name, ms = 400) => { await win.waitForTimeout(ms); await win.screenshot({ path: path.join(out, `${name}.png`) }); };
  const nav = (p) => win.click(`.nav a[data-page="${p}"]`);

  await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); }, lib);
  await win.click('#btnAddSource');
  await win.waitForFunction(() => /files/.test(document.querySelector('#sourceList').textContent), null, { timeout: 60000 });
  const ok = () => win.click('.modal-f .btn:last-child');
  const name = '#page-explorer input[placeholder="*.jpg, IMG_*"]';
  const entries = (n) => win.waitForFunction((x) => document.querySelector('#page-explorer .statusline').textContent.trim().startsWith(`${x} entries`), n, { timeout: 10000 });

  await nav('dupes');
  await win.click('#page-dupes >> text=Find duplicates');
  await win.waitForSelector('#page-dupes >> text=Keep one of each…', { timeout: 60000 });
  await shot('3-duplicates');
  await win.waitForSelector('#page-dupes .vt-r:nth-of-type(3):not(.loading)');
  await win.click('#page-dupes .vt-r:nth-of-type(3)');
  await win.waitForSelector('.cmp-col img', { timeout: 10000 });
  await win.click('.cmp-col:nth-child(1) >> text=Keep this one');
  await shot('3b-compare', 600);
  await win.click('.modal-f >> text=Cancel');
  await nav('overview');
  await shot('1-overview', 700);
  await win.evaluate(() => document.querySelector('#page-overview .sec-h').scrollIntoView());
  await shot('1b-inside-files', 500);
  await nav('issues');
  await shot('4-issues', 700);

  // Stage decisions: keep one copy of each duplicate, drop clutter and
  // empty files, lay photos out by date, fix names for an exFAT drive.
  await nav('dupes');
  await win.click('#page-dupes >> text=Keep one of each…');
  await ok();
  await nav('explorer');
  await win.fill(name, '.DS_Store');
  await entries(1);
  await win.click('.selbar >> text=Select all 1 matching');
  await win.click('.selbar >> text=Exclude');
  await win.fill(name, '');
  await win.click('#page-explorer .chip >> text=image');
  await win.waitForTimeout(500);
  await win.click('#page-explorer >> text=Lay out these…');
  await win.click('#page-restructure .chip >> text=Photos by date taken');
  await win.waitForTimeout(400);
  await shot('5-layout', 300);
  await win.click('#btnStageLayout');
  await win.waitForSelector('#commitMsg');
  await win.selectOption('#page-changes .page-h select', 'exfat');
  await win.waitForSelector('#commitMsg');
  await shot('6-staged', 600);
  await nav('explorer');
  await win.click('#page-explorer .seg >> text=Year');
  await win.waitForTimeout(400);
  await win.click('#page-explorer .vt-r:nth-of-type(4) .rowchk');
  await win.click('#page-explorer .vt-r:nth-of-type(6) .rowchk');
  await shot('2-explorer', 600);
  await win.click('.selbar >> text=Clear');
  // The details panel: click a photo, then walk with the arrow keys.
  await win.click('#page-explorer .seg >> text=None');
  await win.click('#page-explorer >> text=Content filters ▾');
  await win.fill('#page-explorer input[placeholder="iPhone"]', 'iPhone 12');
  await entries(36);
  await win.waitForSelector('#page-explorer .vt-r:nth-of-type(5):not(.loading)');
  await win.click('#page-explorer .vt-r:nth-of-type(5) > span:nth-child(2)');
  await win.waitForSelector('.dpanel .dp-prev img', { timeout: 10000 });
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(300);
  await win.waitForSelector('.dpanel .dp-prev img', { timeout: 10000 });
  await shot('2b-details', 500);
  await win.click('#page-explorer >> text=Reset');
  await win.keyboard.press('Escape');
  await nav('changes');
  await win.fill('#commitMsg', 'Sort photos by date, drop duplicates and clutter');
  await win.click('#page-changes >> text=/Commit \\d+ changes/');
  await win.waitForSelector('#page-changes .reviewbar');
  await win.check('#reviewAck');
  await shot('7-review', 700);
  await win.click('#btnMarkReviewed');
  await win.waitForSelector('#exportChecks');
  await win.click('#btnRecheck');
  await win.waitForSelector('#exportChecks .ci.ok[data-check="checked"]', { timeout: 60000 });
  await win.fill('#exportTarget', target);
  await win.check('#finalAck');
  await shot('8-export-gate', 500);
  // exFAT ignores case, so Report.PDF and report.pdf collide. Show them, then
  // leave one out through the normal stage → commit → review loop.
  await win.click('#exportChecks >> text=Show collisions');
  await win.waitForSelector('#page-changes .vt-r.st-bad');
  await shot('8b-collisions', 500);
  await win.evaluate(async () => {
    await DD.stage('exclude', { paths: ['Documents/Uni/Report.PDF'] });
    const c = await DD.call('ws.commit', { sourceId: DD.state.sourceId, message: 'Leave out the duplicate report' });
    await DD.call('ws.review', { sourceId: DD.state.sourceId, commitId: c.commitId });
    DD.go('changes', { tab: 'export' });
  });
  await win.waitForSelector('#btnRecheck');
  await win.click('#btnRecheck');
  await win.waitForSelector('#exportChecks .ci.ok[data-check="checked"]', { timeout: 60000 });
  await win.fill('#exportTarget', target);
  await win.check('#finalAck');
  await win.click('#btnBuildExport');
  await win.waitForSelector('#page-restructure >> text=Export plan #1');
  await win.click('#page-restructure >> text=Run plan (copy)');
  await ok();
  for (let i = 0; i < 200 && (await win.evaluate(() => DD.call('plan.get', { planId: DD.state.restructure.planId }).then((p) => p.status))) !== 'done'; i++) await win.waitForTimeout(300);
  await win.waitForSelector('#page-restructure >> text=Undo…');
  await shot('9-export-done', 900);

  await nav('sync');
  await win.waitForSelector('#p-source');
  await win.click('#btnPreview');
  await win.waitForSelector('#syncBanner:not([hidden])', { timeout: 60000 });
  await shot('10-sync-preview');
  await win.click('[data-tab="setup"]');
  await shot('11-sync-setup');
  await win.evaluate(() => DD.saveSettings({ theme: 'dark' }));
  await nav('overview');
  await shot('12-dark', 700);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Screenshots written to ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
