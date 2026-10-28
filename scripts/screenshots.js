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
  const trips = ['Lisbon', 'Alps', 'Kyoto', 'Iceland'];
  trips.forEach((t, ti) => { for (let i = 0; i < 40; i++) put(`Photos/${2019 + ti}/${t}/IMG_${4000 + ti * 100 + i}.jpg`, 60000 + Math.floor(rnd() * 400000), 2019 + ti); });
  for (let i = 0; i < 18; i++) put(`Photos/${2023}/Phone/IMG_${7000 + i}.heic`, 90000 + Math.floor(rnd() * 200000), 2023);
  for (let i = 0; i < 8; i++) put(`Videos/Clips/clip_${i}.mov`, 900000 + Math.floor(rnd() * 2500000), 2020 + (i % 5));
  for (let i = 0; i < 30; i++) put(`Documents/Uni/Semester ${1 + (i % 6)}/notes-${i}.pdf`, 20000 + Math.floor(rnd() * 300000), 2018 + (i % 6));
  for (let i = 0; i < 12; i++) put(`Documents/Finance/statement-${2020 + (i % 4)}-${i}.xlsx`, 15000 + Math.floor(rnd() * 40000), 2020 + (i % 4));
  for (let i = 0; i < 20; i++) put(`Music/Live Sets/set-${i}.flac`, 400000 + Math.floor(rnd() * 900000), 2017 + (i % 7));
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
  await nav('dupes');
  await win.click('#page-dupes >> text=Find duplicates');
  await win.waitForFunction(() => /Export without duplicates/.test(document.querySelector('#page-dupes').textContent), null, { timeout: 60000 });
  await shot('3-duplicates');
  await nav('overview');
  await shot('1-overview', 700);
  await nav('explorer');
  await win.click('#page-explorer .seg >> text=Year');
  await win.click('#page-explorer .chip >> text=image');
  await shot('2-explorer', 700);
  await nav('issues');
  await shot('4-issues', 700);

  await win.click('#page-explorer .chip >> text=image').catch(() => {});
  await nav('explorer');
  await win.click('#page-explorer >> text=Restructure these…');
  await win.fill('#page-restructure input[placeholder="/Volumes/Archive/Sorted"]', target);
  await win.click('#page-restructure .chip >> text=By date');
  await win.selectOption('#page-restructure select', 'exfat');
  await shot('5-restructure', 700);
  await win.click('#page-restructure >> text=Build plan');
  await win.waitForSelector('#page-restructure >> text=Plan #1');
  await win.click('#page-restructure >> text=Run plan (copy)');
  await win.click('.modal-f .btn:last-child');
  for (let i = 0; i < 200 && (await win.evaluate(() => DD.call('plan.get', { planId: DD.state.restructure.planId }).then((p) => p.status))) !== 'done'; i++) await win.waitForTimeout(300);
  await win.waitForSelector('#page-restructure >> text=Undo…');
  await shot('6-plan-done', 900);

  await nav('sync');
  await win.waitForSelector('#p-source');
  await win.click('#btnPreview');
  await win.waitForSelector('#syncBanner:not([hidden])', { timeout: 60000 });
  await shot('7-sync-preview');
  await win.click('[data-tab="setup"]');
  await shot('8-sync-setup');
  await win.evaluate(() => DD.saveSettings({ theme: 'dark' }));
  await nav('overview');
  await shot('9-dark', 700);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Screenshots written to ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
