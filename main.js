'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker, Notification, Menu } = require('electron');
const path = require('path');
const { Store } = require('./src/store');
const { SyncRun, detectRsync } = require('./src/core/runner');
const { buildArgs, commandPreview, newProfile, normalizeProfile, FLAGS, isRemote, expandHome } = require('./src/core/args');
const { validateProfile } = require('./src/core/safety');

const RSYNC_CANDIDATES = ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync', '/usr/bin/rsync', 'rsync'];

let win = null;
let store = null;
let rsync = null; // detected binary info
let active = null; // { run, runId, profile, dryRun, startedAt, psb }

async function resolveRsync(preferred) {
  const tried = [];
  const list = preferred ? [preferred] : RSYNC_CANDIDATES;
  let fallback = null;
  for (const bin of list) {
    const info = await detectRsync(bin);
    tried.push(info);
    if (info.ok && info.modern) return { ...info, tried };
    if (info.ok && !fallback) fallback = info;
  }
  return fallback ? { ...fallback, tried } : { ok: false, bin: list[0], error: 'rsync not found', tried };
}

function caps() {
  if (rsync && rsync.caps) return rsync.caps;
  return { modern: !!(rsync && rsync.modern), openrsync: !!(rsync && rsync.openrsync) };
}

// Safety features the installed rsync is missing, as warnings for this profile.
function capWarnings(p) {
  const c = caps();
  const w = [];
  if (c.openrsync) w.push('You are using macOS\'s built-in openrsync. For full progress, resume and safety features install rsync 3.x: brew install rsync');
  if (p.flags.delete && c.maxDelete === false && p.safety.maxDelete > 0) w.push('Your rsync cannot limit deletions (--max-delete); the delete limit will not apply.');
  if (c.partialDir === false) w.push('Your rsync has no --partial-dir; interrupted files resume less reliably.');
  if (c.timeout === false) w.push('Your rsync has no --timeout; a stalled network may hang instead of reconnecting.');
  if (c.outFormat === false) w.push('Your rsync has no --out-format; file sizes are not shown in the transfer list.');
  if (p.safety.backup && p.safety.backupDir && c.backupDir === false) w.push('Your rsync has no --backup-dir; old versions are kept next to the files with a ~ suffix.');
  return w;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    title: 'SyncDeck',
    backgroundColor: '#efe7d6',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  // The renderer never navigates or opens windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', (e) => {
    if (!active) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep syncing', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A sync is still running.',
      detail: 'If you quit now rsync is stopped. Partially copied files are kept and the next run resumes from them.',
    });
    if (choice === 0) e.preventDefault();
    else active.run.stop();
  });
}

function registerIpc() {
  ipcMain.handle('app:init', async () => ({
    profiles: store.profiles(),
    history: store.history(),
    settings: store.settings(),
    rsync,
    flags: FLAGS,
    platform: process.platform,
    running: active ? { runId: active.runId, profileId: active.profile.id, dryRun: active.dryRun } : null,
  }));

  ipcMain.handle('profiles:new', () => newProfile());
  ipcMain.handle('profiles:save', (_e, profile) => store.saveProfile(normalizeProfile(profile)));
  ipcMain.handle('profiles:delete', (_e, id) => store.deleteProfile(String(id)));

  ipcMain.handle('settings:save', async (_e, s) => {
    const prev = store.settings();
    const next = store.saveSettings(s);
    if ((next.rsyncPath || '') !== (prev.rsyncPath || '')) rsync = await resolveRsync(next.rsyncPath || null);
    return { settings: next, rsync };
  });
  ipcMain.handle('rsync:detect', async () => {
    rsync = await resolveRsync(store.settings().rsyncPath || null);
    return rsync;
  });

  ipcMain.handle('history:clear', () => store.clearHistory());

  ipcMain.handle('dialog:pick', async (_e, { title, defaultPath } = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: title || 'Choose folder',
      defaultPath: defaultPath && !isRemote(defaultPath) ? expandHome(defaultPath) : undefined,
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:reveal', (_e, p) => {
    if (typeof p === 'string' && p && !isRemote(p)) shell.openPath(expandHome(p));
  });

  ipcMain.handle('run:check', (_e, { profile, dryRun }) => {
    const p = normalizeProfile(profile);
    const v = validateProfile(p, { dryRun });
    v.warnings.push(...capWarnings(p));
    let command = '';
    try {
      command = commandPreview(rsync && rsync.bin ? rsync.bin : 'rsync', buildArgs(p, { dryRun, caps: caps() }));
    } catch (e) {
      v.errors.push(e.message);
      v.ok = false;
    }
    if (!rsync || !rsync.ok) {
      v.errors.push('rsync was not found. Set its path in Settings.');
      v.ok = false;
    }
    return { ...v, command };
  });

  ipcMain.handle('run:start', async (_e, { profile, dryRun, runId: wanted }) => {
    if (active) return { ok: false, errors: ['A sync is already running.'] };
    const p = normalizeProfile(profile);
    const v = validateProfile(p, { dryRun });
    if (!rsync || !rsync.ok) v.errors.push('rsync was not found. Set its path in Settings.');
    if (v.errors.length) return { ok: false, errors: v.errors };
    v.warnings.push(...capWarnings(p));

    const runId = typeof wanted === 'string' && /^[\w-]{1,64}$/.test(wanted) ? wanted : `${Date.now()}`;
    const run = new SyncRun({ bin: rsync.bin, profile: p, caps: caps(), dryRun });
    const settings = store.settings();
    const psb = settings.preventSleep !== false ? powerSaveBlocker.start('prevent-app-suspension') : null;
    active = { run, runId, profile: p, dryRun, startedAt: Date.now(), psb };
    wireRun(run, runId);

    run.start().then((result) => {
      if (psb !== null && powerSaveBlocker.isStarted(psb)) powerSaveBlocker.stop(psb);
      const entry = {
        id: runId,
        at: active.startedAt,
        profileId: p.id,
        profileName: p.name,
        source: p.source,
        dest: p.dest,
        ...result,
        verify: result.verify ? { ok: result.verify.ok, code: result.verify.code, mismatchCount: result.verify.mismatches.length, error: result.verify.error } : null,
      };
      store.addHistory(entry);
      active = null;
      send('run:event', { runId, type: 'history', history: store.history() });
      if (settings.notifications !== false && Notification.isSupported() && !(win && win.isFocused())) {
        new Notification({ title: `${p.name}: ${result.status.toUpperCase()}`, body: result.message, silent: false }).show();
      }
    });
    return { ok: true, runId, warnings: v.warnings };
  });

  ipcMain.handle('run:stop', () => {
    if (active) active.run.stop();
    return true;
  });
}

// Forward run events to the renderer, batching high-volume ones so a sync of
// a million files does not flood IPC.
function wireRun(run, runId) {
  let items = [];
  let lastProgress = null;
  let logs = [];
  const flush = () => {
    if (items.length) send('run:event', { runId, type: 'items', items: items.splice(0) });
    if (logs.length) send('run:event', { runId, type: 'logs', logs: logs.splice(0) });
    if (lastProgress) {
      send('run:event', { runId, type: 'progress', ...lastProgress });
      lastProgress = null;
    }
  };
  const timer = setInterval(flush, 120);
  run.on('phase', (e) => { flush(); send('run:event', { runId, type: 'phase', ...e }); });
  run.on('attempt', (e) => { flush(); send('run:event', { runId, type: 'attempt', phase: e.phase, attempt: e.attempt, maxAttempts: e.maxAttempts, command: commandPreview(run.bin, e.args) }); });
  run.on('retry', (e) => { flush(); send('run:event', { runId, type: 'retry', ...e }); });
  run.on('item', (e) => items.push({ phase: e.phase, ...e.item }));
  run.on('progress', (e) => { lastProgress = e; });
  run.on('log', (e) => logs.push({ ...e, t: Date.now() }));
  run.on('done', (result) => {
    clearInterval(timer);
    flush();
    send('run:event', { runId, type: 'done', result });
  });
}

// Replaces Electron's default menu, whose Cmd+R would reload the window.
function buildMenu() {
  const cmd = (c) => () => send('menu', c);
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ label: 'New Profile', accelerator: 'CmdOrCtrl+N', click: cmd('new-profile') }, { type: 'separator' }, { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
    { role: 'editMenu' },
    {
      label: 'Sync',
      submenu: [
        { label: 'Preview (Dry Run)', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('preview') },
        { label: 'Run Sync…', accelerator: 'CmdOrCtrl+R', click: cmd('sync') },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: cmd('stop') },
      ],
    },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  app.setName('SyncDeck');
  store = new Store(process.env.SYNCDECK_DATA_DIR || app.getPath('userData'));
  rsync = await resolveRsync(process.env.SYNCDECK_RSYNC || store.settings().rsyncPath || null);
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.SYNCDECK_TEST) app.quit();
});
