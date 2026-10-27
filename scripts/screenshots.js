'use strict';
// Launches the real app against throwaway demo folders and saves screenshots
// of each view to docs/screenshots. Linux needs a display: run via xvfb-run.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { startDaemon, FlakyProxy } = require('../test/helpers/netlab');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'screenshots');

function makeDemo(dir) {
  const src = path.join(dir, 'Photos');
  const dst = path.join(dir, 'Backup', 'Photos');
  const albums = ['2024 Lisbon', '2024 Alps', '2025 Family', '2025 Concerts', 'Scans'];
  for (const a of albums) {
    fs.mkdirSync(path.join(src, a), { recursive: true });
    for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(src, a, `IMG_${String(1000 + i * 7).padStart(4, '0')}.jpg`), crypto.randomBytes(140000 + i * 9000));
  }
  fs.mkdirSync(path.join(dst, '2024 Lisbon'), { recursive: true });
  fs.cpSync(path.join(src, '2024 Lisbon'), path.join(dst, '2024 Lisbon'), { recursive: true, preserveTimestamps: true });
  fs.writeFileSync(path.join(dst, 'old-export.zip'), Buffer.alloc(120000, 3));
  return { src, dst };
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syncdeck-shots-'));
  const { src, dst } = makeDemo(tmp);
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const base = { flags: { archive: true, delete: true, checksum: false, compress: false }, excludes: ['.DS_Store'], safety: { verifyAfter: true, backup: false, backupDir: '', maxDelete: 500 }, network: { retries: 8, timeout: 60, sshPort: '', bwlimit: '', identityFile: '' }, contents: true, extraArgs: '' };
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify([
    { ...base, id: 'p1', name: 'Photos → Backup', source: src, dest: dst, network: { ...base.network, bwlimit: '1500' } },
    { ...base, id: 'p2', name: 'NAS Documents', source: '~/Documents', dest: 'tim@nas.local:/volume1/docs', flags: { archive: true, compress: true } },
    { ...base, id: 'p3', name: 'Music library', source: '~/Music', dest: '/Volumes/T7/Music', flags: { archive: true, checksum: true } },
  ]));

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, '--no-sandbox'],
    env: { ...process.env, SYNCDECK_DATA_DIR: dataDir, SYNCDECK_TEST: '1' },
  });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1320, height: 860 });
  await win.waitForSelector('#profileList .nav-i');
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(out, '1-setup.png') });

  await win.click('#btnPreview');
  await win.waitForSelector('#tBanner:not([hidden])');
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(out, '2-preview.png') });

  await win.click('#tBanner .btn.primary');
  await win.click('#mAck');
  await win.click('#mOk');
  await win.waitForFunction(() => /^[3-6]\d%/.test(document.querySelector('#lcdPct').textContent), null, { timeout: 30000 });
  await win.screenshot({ path: path.join(out, '3-syncing.png') });
  await win.waitForFunction(() => document.querySelector('#lcdState').textContent.includes('DONE'), null, { timeout: 60000 });
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(out, '4-verified.png') });

  // Network drop on a remote profile.
  const lab = path.join(tmp, 'lab');
  fs.mkdirSync(lab);
  const daemon = await startDaemon(lab);
  const proxy = new FlakyProxy(daemon.port);
  await proxy.listen();
  let cut = false;
  proxy.onBytes = (n) => { if (!cut && n > 2500000) { cut = true; proxy.down = true; proxy.cut(); setTimeout(() => (proxy.down = false), 9000); } };
  await win.click('#btnNewProfile');
  await win.fill('#pName', 'Photos → NAS');
  await win.fill('#pSource', src);
  await win.fill('#pDest', `rsync://127.0.0.1:${proxy.port}/mod/Photos`);
  await win.fill('#nBw', '2500');
  await win.waitForTimeout(500);
  await win.click('#btnSync');
  await win.click('#mOk');
  await win.waitForFunction(() => /LINK LOST/.test(document.querySelector('#lcdState').textContent), null, { timeout: 30000 });
  await win.waitForTimeout(1200);
  await win.screenshot({ path: path.join(out, '5-link-lost.png') });
  await win.waitForFunction(() => document.querySelector('#lcdState').textContent.includes('DONE'), null, { timeout: 120000 });
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(out, '6-recovered.png') });
  await proxy.close();
  daemon.stop();

  await win.click('.nav-i[data-view="log"]');
  await win.waitForTimeout(200);
  await win.screenshot({ path: path.join(out, '7-log.png') });
  await win.click('.nav-i[data-view="history"]');
  await win.waitForTimeout(200);
  await win.screenshot({ path: path.join(out, '8-history.png') });
  await win.click('.nav-i[data-view="settings"]');
  await win.waitForTimeout(200);
  await win.screenshot({ path: path.join(out, '9-settings.png') });
  await win.evaluate(() => document.querySelector('#themeSeg button[data-theme-set="classic"]').click());
  await win.click('.nav-i[data-view="setup"]');
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(out, '10-classic-theme.png') });
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Screenshots written to ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
