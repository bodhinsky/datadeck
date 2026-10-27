'use strict';
/* global deck */

// ── Helpers ───────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Builds DOM nodes. Text is always set with textContent, never innerHTML, so
// file names and paths from rsync can't inject markup.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
}
const pad = (n, w = 4) => String(Math.max(0, n | 0)).padStart(w, '0');
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
function fmtWhen(t) {
  const d = new Date(t);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const isRemote = (p) => {
  if (!p) return false;
  if (/^rsync:\/\//i.test(p)) return true;
  const c = p.indexOf(':');
  return c > 0 && !p.slice(0, c).includes('/');
};

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ── State ─────────────────────────────────────────────────────
const S = {
  profiles: [],
  history: [],
  settings: {},
  rsync: null,
  flags: [],
  profile: null,
  view: 'setup',
  check: null,
  previewedFor: {}, // profileId -> settings fingerprint of last successful preview
  run: freshRun(),
  log: [],
  logFilter: 'all',
  tFilter: 'all',
  tSearch: '',
};

function freshRun() {
  return {
    active: false, runId: null, profileId: null, dryRun: false, phase: null,
    attempt: 0, maxAttempts: 0, startedAt: 0, endedAt: 0,
    progress: null, retry: null, retries: 0, result: null,
    items: [], index: new Map(), mismatches: [], bytes: 0,
    counts: { new: 0, update: 0, delete: 0, other: 0 },
  };
}

function fingerprint(p) {
  const { name, id, ...rest } = p;
  return JSON.stringify(rest);
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  if (/Mac/.test(navigator.platform)) document.body.classList.add('mac');
  const d = await deck.init();
  Object.assign(S, { profiles: d.profiles, history: d.history, settings: d.settings, rsync: d.rsync, flags: d.flags });
  applyTheme();
  buildFlagGrid();
  bindSetup();
  bindChrome();
  deck.onRunEvent(onRunEvent);
  if (!S.profiles.length) {
    const p = await deck.newProfile();
    p.name = 'My first sync';
    S.profiles = await deck.saveProfile(p);
  }
  selectProfile(S.profiles[0].id);
  renderEngine();
  renderHistory();
  setView('setup');
  drawWave();
  window.addEventListener('resize', () => { drawWave(); renderTable(); });
}

function applyTheme() {
  const theme = S.settings.theme === 'classic' ? 'classic' : 'retro';
  document.documentElement.dataset.theme = theme;
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === theme));
  $('setRetro').classList.toggle('on', theme === 'retro');
}

// ── Views ─────────────────────────────────────────────────────
function setView(v) {
  S.view = v;
  $$('.view').forEach((el) => el.classList.toggle('on', el.id === `view-${v}`));
  $$('.nav-i[data-view]').forEach((el) => el.classList.toggle('on', el.dataset.view === v));
  if (v === 'transfers') renderTable();
  if (v === 'log') renderLog(true);
}

// ── Profiles ──────────────────────────────────────────────────
function renderProfiles() {
  const list = $('profileList');
  list.replaceChildren();
  for (const p of S.profiles) {
    const last = S.history.find((x) => x.profileId === p.id);
    const running = S.run.active && S.run.profileId === p.id;
    const dot = h('span', { class: `p-dot ${running ? 'run' : last ? last.status : ''}` });
    const item = h('a', { class: `nav-i${S.profile && S.profile.id === p.id ? ' on' : ''}`, 'data-pid': p.id, title: `${p.source || '?'} → ${p.dest || '?'}`, onclick: () => selectProfile(p.id) },
      dot, h('span', { class: 'name', text: p.name || 'Untitled' }));
    list.append(item);
  }
}

function selectProfile(id) {
  if (S.run.active && S.run.profileId !== id) {
    // Allowed: you can look at other profiles while one runs.
  }
  const p = S.profiles.find((x) => x.id === id);
  if (!p) return;
  S.profile = clone(p);
  renderProfiles();
  fillSetup();
  renderNowPlaying();
  renderLastRun();
  scheduleCheck(0);
  if (S.view !== 'setup' && !S.run.active && S.run.profileId !== id) setView('setup');
}

let saveTimer = null;
function scheduleSave() {
  $('saveState').textContent = '· EDITING';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.profile) return;
  S.profiles = await deck.saveProfile(S.profile);
  $('saveState').textContent = '· SAVED';
  renderProfiles();
  renderNowPlaying();
}

// ── Setup view ────────────────────────────────────────────────
function buildFlagGrid() {
  const grid = $('flagGrid');
  grid.replaceChildren();
  for (const f of S.flags) {
    const b = h('button', { class: `flag${f.danger ? ' danger' : ''}`, 'data-flag': f.key, title: f.hint },
      h('span', { class: 'led' }), h('span', { class: 'fl', text: f.label }), h('span', { class: 'fa', text: f.arg }));
    b.addEventListener('mouseenter', () => { $('flagHint').textContent = `${f.arg} — ${f.hint}`; });
    b.addEventListener('mouseleave', () => { $('flagHint').textContent = 'Hover a flag for details.'; });
    b.addEventListener('click', () => {
      S.profile.flags[f.key] = !S.profile.flags[f.key];
      fillFlags();
      changed();
    });
    grid.append(b);
  }
}

function fillFlags() {
  const caps = (S.rsync && S.rsync.caps) || {};
  for (const b of $$('.flag')) {
    const f = S.flags.find((x) => x.key === b.dataset.flag);
    const na = !!f.cap && caps[f.cap] === false;
    b.classList.toggle('on', !!S.profile.flags[f.key]);
    b.classList.toggle('na', na);
    b.title = na ? `${f.hint}. Your rsync does not support ${f.arg}; it is ignored (brew install rsync).` : f.hint;
  }
}

function setSw(id, on) { $(id).classList.toggle('on', !!on); }

function fillSetup() {
  const p = S.profile;
  $('pName').value = p.name;
  $('pSource').value = p.source;
  $('pDest').value = p.dest;
  setSw('pContents', p.contents);
  setSw('sVerify', p.safety.verifyAfter);
  setSw('sBackup', p.safety.backup);
  $('sBackupDir').value = p.safety.backupDir || '';
  $('sBackupDir').disabled = !p.safety.backup;
  $('sMaxDelete').value = p.safety.maxDelete;
  $('nRetries').value = p.network.retries;
  $('nTimeout').value = p.network.timeout;
  $('nBw').value = p.network.bwlimit || '';
  $('nPort').value = p.network.sshPort || '';
  $('nKey').value = p.network.identityFile || '';
  $('pExcludes').value = (p.excludes || []).join('\n');
  $('pExtra').value = p.extraArgs || '';
  $('saveState').textContent = '';
  fillFlags();
  fillDerived();
}

// Bits of the setup view that depend on several fields.
function fillDerived() {
  const p = S.profile;
  const srcName = (p.source || 'Source').replace(/\/+$/, '').split(/[/:]/).pop() || 'Source';
  const dest = (p.dest || 'Destination').replace(/\/+$/, '');
  $('contentsHint').replaceChildren(
    p.contents
      ? h('span', {}, 'Files inside ', h('b', { text: srcName }), ' go straight into ', h('b', { text: `${dest}/` }))
      : h('span', {}, 'The folder itself is copied: ', h('b', { text: `${dest}/${srcName}/…` })));
  const remote = isRemote(p.source) || isRemote(p.dest);
  const daemon = /^rsync:\/\//i.test(p.source) || /^rsync:\/\//i.test(p.dest);
  $('chipRoute').textContent = daemon ? '▪ RSYNC DAEMON' : remote ? '▪ SSH REMOTE' : '▪ LOCAL';
  $('chipRoute').classList.toggle('lit', remote);
  $('chipVerify').textContent = p.safety.verifyAfter ? '▪ VERIFY ON' : '▪ VERIFY OFF';
  $('chipVerify').classList.toggle('lit', p.safety.verifyAfter);
  $('chipDelete').textContent = p.flags.delete ? '▪ MIRROR+DEL' : '▪ COPY ONLY';
  $('chipDelete').classList.toggle('hot', !!p.flags.delete);
  $('chipRetry').textContent = `▪ RETRY ${p.network.retries}`;
  $('chipRetry').classList.toggle('lit', p.network.retries > 0);
  $('sBackupDir').disabled = !p.safety.backup;
}

function changed() {
  fillDerived();
  scheduleSave();
  scheduleCheck();
  renderNowPlaying();
}

function bindSetup() {
  const bindText = (id, set) => $(id).addEventListener('input', (e) => { set(e.target.value); changed(); });
  bindText('pName', (v) => (S.profile.name = v));
  bindText('pSource', (v) => (S.profile.source = v));
  bindText('pDest', (v) => (S.profile.dest = v));
  bindText('sBackupDir', (v) => (S.profile.safety.backupDir = v));
  bindText('sMaxDelete', (v) => (S.profile.safety.maxDelete = Math.max(0, parseInt(v, 10) || 0)));
  bindText('nRetries', (v) => (S.profile.network.retries = Math.min(100, Math.max(0, parseInt(v, 10) || 0))));
  bindText('nTimeout', (v) => (S.profile.network.timeout = Math.max(0, parseInt(v, 10) || 0)));
  bindText('nBw', (v) => (S.profile.network.bwlimit = v.trim()));
  bindText('nPort', (v) => (S.profile.network.sshPort = v.trim()));
  bindText('nKey', (v) => (S.profile.network.identityFile = v.trim()));
  bindText('pExcludes', (v) => (S.profile.excludes = v.split('\n').map((x) => x.trim()).filter(Boolean)));
  bindText('pExtra', (v) => (S.profile.extraArgs = v));

  const bindSw = (id, get, set) => $(id).addEventListener('click', () => { set(!get()); setSw(id, get()); changed(); });
  bindSw('pContents', () => S.profile.contents, (v) => (S.profile.contents = v));
  bindSw('sVerify', () => S.profile.safety.verifyAfter, (v) => (S.profile.safety.verifyAfter = v));
  bindSw('sBackup', () => S.profile.safety.backup, (v) => {
    S.profile.safety.backup = v;
    if (v && !S.profile.safety.backupDir) { S.profile.safety.backupDir = '.syncdeck-old'; $('sBackupDir').value = '.syncdeck-old'; }
  });

  for (const b of $$('[data-pick]')) {
    b.addEventListener('click', async () => {
      const key = b.dataset.pick;
      const picked = await deck.pickFolder({ title: key === 'source' ? 'Choose source folder' : 'Choose destination folder', defaultPath: S.profile[key] });
      if (!picked) return;
      S.profile[key] = picked;
      $(key === 'source' ? 'pSource' : 'pDest').value = picked;
      changed();
    });
  }

  $('btnCopyCmd').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('cmdPreview').textContent);
    toast('Command copied.');
  });
  $('btnDup').addEventListener('click', async () => {
    const p = await deck.newProfile();
    Object.assign(p, clone(S.profile), { id: p.id, name: `${S.profile.name} copy` });
    S.profiles = await deck.saveProfile(p);
    selectProfile(p.id);
    toast('Profile duplicated.');
  });
  $('btnDel').addEventListener('click', async () => {
    if (S.run.active && S.run.profileId === S.profile.id) return toast('Stop the running sync first.');
    const ok = await confirmBox({ title: 'DELETE PROFILE', body: [h('p', {}, 'Delete the profile ', h('b', { text: S.profile.name }), '? Your files are not touched; only the saved settings go away.')], okText: 'DELETE', danger: true });
    if (!ok) return;
    S.profiles = await deck.deleteProfile(S.profile.id);
    if (!S.profiles.length) {
      const p = await deck.newProfile();
      S.profiles = await deck.saveProfile(p);
    }
    selectProfile(S.profiles[0].id);
  });
}

let checkTimer = null;
function scheduleCheck(delay = 250) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, delay);
}
async function runCheck() {
  if (!S.profile) return;
  const pid = S.profile.id;
  const c = await deck.check(S.profile, false);
  if (!S.profile || S.profile.id !== pid) return;
  S.check = c;
  $('cmdPreview').textContent = c.command || '';
  const box = $('checks');
  box.replaceChildren(
    ...c.errors.map((e) => h('div', { class: 'check err', text: `✕ ${e}` })),
    ...c.warnings.map((w) => h('div', { class: 'check warn', text: `! ${w}` })),
  );
  if (c.ok && !c.warnings.length) box.append(h('div', { class: 'check ok', text: '✓ Ready. Run a preview first to see exactly what will change.' }));
  $('pSource').classList.toggle('bad', c.errors.some((e) => /source/i.test(e)));
  $('pDest').classList.toggle('bad', c.errors.some((e) => /destination/i.test(e)));
  updateTransport();
}

// ── Top deck ──────────────────────────────────────────────────
function renderNowPlaying() {
  const p = S.run.active ? S.profiles.find((x) => x.id === S.run.profileId) || S.profile : S.profile;
  if (!p) return;
  $('npTitle').textContent = p.name || 'Untitled';
  $('npSrc').textContent = p.source ? `◂ ${p.source}` : '◂ no source';
  $('npDst').textContent = p.dest ? `▸ ${p.dest}` : '▸ no destination';
  const fl = $('lcdFlags');
  const tag = (t, on, red) => h('b', { class: red ? 'r' : '', text: `${on ? '▪' : '·'}${t} ` });
  fl.replaceChildren(tag('CHK', p.flags.checksum), tag('VFY', p.safety.verifyAfter), tag('DEL', p.flags.delete, p.flags.delete), tag('Z', p.flags.compress));
}

function bindChrome() {
  $$('.nav-i[data-view]').forEach((el) => el.addEventListener('click', () => setView(el.dataset.view)));
  $('btnNewProfile').addEventListener('click', async () => {
    const p = await deck.newProfile();
    S.profiles = await deck.saveProfile(p);
    selectProfile(p.id);
    setView('setup');
    $('pName').select();
  });
  $('btnPreview').addEventListener('click', () => startRun(true));
  $('btnSync').addEventListener('click', () => startRun(false));
  $('btnStop').addEventListener('click', () => deck.stop());

  $$('#themeSeg button').forEach((b) => b.addEventListener('click', () => saveSettings({ theme: b.dataset.themeSet })));
  $('setRetro').addEventListener('click', () => saveSettings({ theme: S.settings.theme === 'retro' ? 'classic' : 'retro' }));
  $('setNotify').addEventListener('click', () => saveSettings({ notifications: !S.settings.notifications }));
  $('setSleep').addEventListener('click', () => saveSettings({ preventSleep: !S.settings.preventSleep }));
  $('setRsync').addEventListener('change', (e) => saveSettings({ rsyncPath: e.target.value.trim() }));
  $('btnDetect').addEventListener('click', async () => {
    S.rsync = await deck.detectRsync();
    renderEngine();
    fillFlags();
    scheduleCheck(0);
    toast(S.rsync.ok ? `Found ${S.rsync.name} ${S.rsync.version || ''} at ${S.rsync.bin}` : 'rsync not found.');
  });

  $$('#tFilters .chip').forEach((b) => b.addEventListener('click', () => {
    S.tFilter = b.dataset.f;
    $$('#tFilters .chip').forEach((x) => x.classList.toggle('on', x === b));
    renderTable(true);
  }));
  $('tSearch').addEventListener('input', (e) => { S.tSearch = e.target.value.toLowerCase(); renderTable(true); });
  $('tBody').addEventListener('scroll', () => renderTable(false));
  $('btnRevealDest').addEventListener('click', () => {
    const p = S.profiles.find((x) => x.id === (S.run.profileId || (S.profile && S.profile.id)));
    if (p && !isRemote(p.dest)) deck.reveal(p.dest);
    else toast('The destination is on a remote host.');
  });

  $$('#logSeg button').forEach((b) => b.addEventListener('click', () => {
    S.logFilter = b.dataset.log;
    $$('#logSeg button').forEach((x) => x.classList.toggle('on', x === b));
    renderLog(true);
  }));
  $('btnClearLog').addEventListener('click', () => { S.log = []; renderLog(true); });
  $('btnClearHistory').addEventListener('click', async () => {
    const ok = await confirmBox({ title: 'CLEAR HISTORY', body: [h('p', { text: 'Remove all run history? Profiles and files are not affected.' })], okText: 'CLEAR', danger: true });
    if (!ok) return;
    S.history = await deck.clearHistory();
    renderHistory();
    renderProfiles();
    renderLastRun();
  });

  deck.onMenu((cmd) => {
    if (cmd === 'preview') startRun(true);
    else if (cmd === 'sync') startRun(false);
    else if (cmd === 'stop') deck.stop();
    else if (cmd === 'new-profile') $('btnNewProfile').click();
  });
}

async function saveSettings(patch) {
  const r = await deck.saveSettings({ ...S.settings, ...patch });
  S.settings = r.settings;
  if (r.rsync) S.rsync = r.rsync;
  applyTheme();
  renderEngine();
  fillFlags();
  scheduleCheck(0);
}

function renderEngine() {
  const r = S.rsync;
  $('setRsync').value = S.settings.rsyncPath || '';
  setSw('setNotify', S.settings.notifications !== false);
  setSw('setSleep', S.settings.preventSleep !== false);
  const foot = $('sideFoot');
  const info = $('engineInfo');
  if (!r || !r.ok) {
    foot.textContent = 'rsync: NOT FOUND';
    foot.className = 'side-foot err';
    info.replaceChildren(h('div', { class: 'check err', text: 'rsync was not found. Install it with "brew install rsync", or enter its path above.' }));
    return;
  }
  foot.textContent = `${r.name} ${r.version || ''} · ${r.modern ? 'full features' : 'limited'}`;
  foot.className = `side-foot${r.modern ? '' : ' warn'}`;
  const kv = h('div', { class: 'kv' },
    h('span', { class: 'k', text: 'BINARY' }), h('span', { text: r.bin }),
    h('span', { class: 'k', text: 'VERSION' }), h('span', { text: r.raw || r.version }),
    h('span', { class: 'k', text: 'PROGRESS' }), h('span', { text: r.modern ? 'Whole-transfer progress (--info=progress2)' : 'Per-file progress only' }),
    h('span', { class: 'k', text: 'FEATURES' }), h('span', {}, ...featureList(r.caps || {})));
  const note = r.modern
    ? h('div', { class: 'check ok note', text: '✓ Modern rsync detected. Every feature is available.' })
    : h('div', { class: 'check warn note', text: `! ${r.openrsync ? 'This is macOS openrsync' : `rsync ${r.version} is very old`}. For overall progress, extended attributes, ACLs and safer remote paths, install a current rsync: brew install rsync (SyncDeck picks it up automatically).` });
  info.replaceChildren(kv, note);
}

const FEATURE_NAMES = { partialDir: 'resume dir', timeout: 'stall timeout', maxDelete: 'delete limit', progress2: 'total progress', outFormat: 'sizes', protectArgs: 'safe remote paths', backupDir: 'backup dir', xattrs: 'xattrs', acls: 'ACLs' };
function featureList(caps) {
  return Object.entries(FEATURE_NAMES).map(([k, label]) => h('span', { class: `st ${caps[k] === false ? 'bad' : 'ok'}`, text: `${caps[k] === false ? '✕' : '✓'} ${label}  ` }));
}

function updateTransport() {
  const running = S.run.active;
  const okToRun = !running && S.check && S.check.ok;
  $('btnPreview').disabled = !okToRun;
  $('btnSync').disabled = !okToRun;
  $('btnStop').disabled = !running;
  $('btnSync').classList.toggle('armed', !!(S.profile && S.profile.flags.delete));
  document.body.classList.toggle('running', running);
}

// ── Running ───────────────────────────────────────────────────
async function startRun(dryRun) {
  if (S.run.active || !S.profile) return;
  await saveNow();
  const c = await deck.check(S.profile, dryRun);
  if (!c.ok) {
    setView('setup');
    scheduleCheck(0);
    return toast(c.errors[0]);
  }
  if (!dryRun) {
    const previewed = S.previewedFor[S.profile.id] === fingerprint(S.profile);
    const body = [];
    if (!previewed) body.push(h('div', { class: `check ${S.profile.flags.delete ? 'warn' : 'ok'}`, text: `${S.profile.flags.delete ? '!' : 'i'} You have not previewed these exact settings yet. A preview shows every change before anything is touched.` }));
    for (const w of c.warnings) body.push(h('div', { class: 'check warn', text: `! ${w}` }));
    body.push(h('p', {}, 'Copy ', h('b', { text: S.profile.source }), ' → ', h('b', { text: S.profile.dest })));
    if (S.profile.safety.verifyAfter) body.push(h('p', { text: 'Afterwards every file is compared by checksum to confirm the copy is intact.' }));
    body.push(h('div', { class: 'cmd', text: c.command }));
    const ok = await confirmBox({
      title: S.profile.flags.delete ? 'RUN MIRROR SYNC' : 'RUN SYNC',
      body,
      okText: '▶ RUN',
      ack: S.profile.flags.delete ? 'I understand files missing from the source will be deleted at the destination.' : null,
      danger: S.profile.flags.delete,
      altText: previewed ? null : 'PREVIEW FIRST',
    });
    if (ok === 'alt') return startRun(true);
    if (!ok) return;
  }

  // The run id is chosen here so events that arrive before start() resolves
  // are already recognised as ours.
  const prevRun = S.run;
  S.run = freshRun();
  Object.assign(S.run, { active: true, runId: crypto.randomUUID(), profileId: S.profile.id, dryRun, startedAt: Date.now(), fp: fingerprint(S.profile) });
  const r = await deck.start(S.profile, dryRun, S.run.runId);
  if (!r.ok) {
    S.run = prevRun;
    updateTransport();
    return toast(r.errors.join(' '));
  }
  S.log.push({ stream: 'sys', line: `── ${dryRun ? 'PREVIEW' : 'SYNC'} "${S.profile.name}" started ${new Date().toLocaleTimeString()} ──` });
  $('tBanner').hidden = true;
  $('tMode').textContent = dryRun ? 'DRY RUN · NOTHING IS CHANGED' : 'LIVE SYNC';
  setView('transfers');
  renderTable(true);
  updateTransport();
  renderProfiles();
  tick();
}

let tickTimer = null;
function tick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    renderLcd();
    if (!S.run.active) clearInterval(tickTimer);
  }, 250);
  renderLcd();
}

function onRunEvent(ev) {
  if (ev.type === 'history') {
    S.history = ev.history;
    renderHistory();
    renderProfiles();
    renderLastRun();
    return;
  }
  if (ev.runId !== S.run.runId) return;
  const R = S.run;
  switch (ev.type) {
    case 'phase':
      R.phase = ev.phase;
      R.progress = null;
      S.log.push({ stream: 'sys', line: `── phase: ${ev.phase.toUpperCase()} ──` });
      break;
    case 'attempt':
      if (ev.phase !== 'verify') {
        R.attempt = ev.attempt;
        R.maxAttempts = ev.maxAttempts;
      }
      R.retry = null;
      S.log.push({ stream: 'sys', line: `$ ${ev.command}` });
      if (ev.attempt > 1) S.log.push({ stream: 'retry', line: `↻ attempt ${ev.attempt}/${ev.maxAttempts}: resuming from partial files` });
      break;
    case 'retry':
      R.retry = { until: Date.now() + ev.delayMs, reason: ev.reason, code: ev.code };
      if (ev.phase !== 'verify') R.retries++;
      S.log.push({ stream: 'retry', line: `⚠ ${ev.reason}. Reconnecting in ${Math.round(ev.delayMs / 1000)}s…` });
      break;
    case 'progress':
      R.progress = ev;
      break;
    case 'items':
      for (const it of ev.items) addItem(it);
      break;
    case 'logs':
      for (const l of ev.logs) S.log.push(l);
      break;
    case 'done':
      R.active = false;
      R.result = ev.result;
      R.endedAt = Date.now();
      R.retry = null;
      if (ev.result.dryRun && ev.result.status === 'success') S.previewedFor[R.profileId] = R.fp;
      S.log.push({ stream: 'sys', line: `── ${ev.result.status.toUpperCase()}: ${ev.result.message} ──` });
      renderBanner();
      updateTransport();
      renderProfiles();
      if (ev.result.verify && !ev.result.verify.ok && R.mismatches.length) {
        S.tFilter = 'verify';
        $$('#tFilters .chip').forEach((x) => x.classList.toggle('on', x.dataset.f === 'verify'));
      }
      break;
    default:
  }
  if (S.log.length > 20000) S.log.splice(0, S.log.length - 15000);
  if (S.view === 'log') renderLog();
  renderCounts();
  if (S.view === 'transfers') renderTable(ev.type === 'done');
  renderLcd();
}

function addItem(it) {
  const R = S.run;
  if (it.phase === 'verify') {
    if (['new', 'update', 'delete', 'mkdir'].includes(it.action)) R.mismatches.push({ ...it, action: 'mismatch', was: it.action });
    return;
  }
  const bucket = (a) => (a === 'new' || a === 'update' || a === 'delete' ? a : 'other');
  const prev = R.index.get(it.path);
  if (prev !== undefined) {
    // Same path seen in an earlier attempt: replace it rather than double count.
    const old = R.items[prev];
    R.counts[bucket(old.action)]--;
    if ((old.action === 'new' || old.action === 'update') && old.kind === 'file') R.bytes -= old.size;
    R.items[prev] = it;
  } else {
    R.index.set(it.path, R.items.length);
    R.items.push(it);
  }
  R.counts[bucket(it.action)]++;
  if ((it.action === 'new' || it.action === 'update') && it.kind === 'file') R.bytes += it.size;
}

function renderCounts() {
  const R = S.run;
  $('cAll').textContent = pad(R.items.length);
  $('cNew').textContent = pad(R.counts.new);
  $('cUpd').textContent = pad(R.counts.update);
  $('cDel').textContent = pad(R.counts.delete);
  $('cMis').textContent = pad(R.mismatches.length);
  $('cOth').textContent = pad(R.counts.other);
  $$('#tFilters .chip').forEach((b) => b.classList.toggle('hot', b.dataset.f === 'verify' && R.mismatches.length > 0));
  $('tItems').textContent = pad(R.items.length);
  $('tBytes').textContent = fmtBytes(R.bytes);
  $('tRetries').textContent = pad(R.retries, 2);
  $('tRetries').className = `sb-v${R.retries ? ' warn' : ''}`;
  $('tPhase').textContent = 'PHASE';
  $('tPhaseVal').textContent = R.active ? (R.phase || '').toUpperCase() : R.result ? R.result.status.toUpperCase() : '-';
  $('badgeTransfers').textContent = R.active ? '●' : '';
}

function renderBanner() {
  const R = S.run;
  const res = R.result;
  const b = $('tBanner');
  if (!res) { b.hidden = true; return; }
  const kids = [];
  let cls = 'banner';
  if (res.dryRun && res.status === 'success') {
    const nothing = R.counts.new + R.counts.update + R.counts.delete === 0;
    kids.push(h('span', { class: 'grow' }, nothing
      ? 'Already in sync. Nothing would change.'
      : `Preview ready: ${R.counts.new} new · ${R.counts.update} changed · ${R.counts.delete} to delete · ${fmtBytes(R.bytes)} to copy. Nothing has been changed yet.`));
    if (!nothing) kids.push(h('button', { class: 'btn primary', text: '▶ RUN THIS SYNC', onclick: () => { selectProfile(R.profileId); startRun(false); } }));
    if (R.counts.delete) cls += ' warn';
  } else {
    if (res.status === 'failed' || res.status === 'verify-failed') cls += ' err';
    else if (res.status === 'warning' || res.status === 'stopped') cls += ' warn';
    const tries = res.attempts > 1 ? ` Needed ${res.attempts} attempts.` : '';
    kids.push(h('span', { class: 'grow', text: `${res.status.toUpperCase()} · ${res.message}${tries}` }));
    if (res.status === 'failed' || res.status === 'stopped') kids.push(h('button', { class: 'btn', text: '↻ RESUME', onclick: () => { selectProfile(R.profileId); startRun(false); } }));
    if (res.status === 'failed') kids.push(h('button', { class: 'btn', text: 'SHOW LOG', onclick: () => setView('log') }));
  }
  b.className = cls;
  b.replaceChildren(...kids);
  b.hidden = false;
}

function renderLcd() {
  const R = S.run;
  const st = $('lcdState');
  let pct = null;
  let state = '▪ IDLE';
  let cls = '';
  if (R.active) {
    cls = 'run';
    if (R.retry) {
      const left = Math.max(0, Math.ceil((R.retry.until - Date.now()) / 1000));
      state = `▪ LINK LOST · RETRY IN ${left}S`;
      cls = 'warn';
    } else if (R.phase === 'verify') state = '▪ VERIFYING CHECKSUMS';
    else if (R.phase === 'preview') state = '▪ PREVIEW SCAN';
    else state = '▶ SYNCING';
    if (R.progress && R.phase === 'transfer') pct = R.progress.overall;
  } else if (R.result) {
    const s = R.result.status;
    state = { success: '■ DONE', warning: '■ DONE W/ WARNINGS', failed: '■ FAILED', 'verify-failed': '■ VERIFY FAILED', stopped: '■ STOPPED' }[s] || '■ DONE';
    cls = s === 'success' ? '' : s === 'warning' || s === 'stopped' ? 'warn' : 'err';
    if (R.result.dryRun) state = s === 'success' ? '■ PREVIEW READY' : state;
    pct = s === 'success' || s === 'warning' ? 100 : R.progress ? R.progress.overall : 0;
  }
  st.textContent = state;
  st.className = `lcd-state ${cls}`;
  $('lcdAttempt').textContent = R.maxAttempts ? `TRY ${R.attempt}/${R.maxAttempts}` : 'TRY -/-';
  $('lcdFile').textContent = R.active && R.progress && R.progress.file ? R.progress.file : R.active && R.items.length ? R.items[R.items.length - 1].path : '';
  const elapsed = R.startedAt ? (R.active ? Date.now() : R.endedAt) - R.startedAt : 0;
  $('lcdElapsed').textContent = fmtDur(elapsed);
  $('tTime').textContent = fmtDur(elapsed);
  $('lcdPct').textContent = pct === null ? (R.active ? '··%' : '--%') : `${pct}%`;
  const pg = R.progress;
  $('mSpeed').textContent = R.active && pg ? pg.rate : '-';
  $('mEta').textContent = R.active && pg && R.phase === 'transfer' ? pg.eta : '-';
  $('mXfr').textContent = pg && pg.total ? `${pg.total - pg.toCheck}/${pg.total}` : R.items.length ? String(R.items.length) : '-';
  drawWave(pct, R.active && (pct === null || R.phase !== 'transfer'), !!R.retry);
}

// The "waveform": a field of bars that fills teal as the transfer runs.
let scanPos = 0;
function drawWave(pct = null, scanning = false, stalled = false) {
  const c = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const hgt = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const css = getComputedStyle(document.documentElement);
  const teal = css.getPropertyValue('--teal').trim();
  const off = '#bdb4a2';
  const red = css.getPropertyValue('--red').trim();
  const amber = css.getPropertyValue('--amber').trim();
  const step = 3;
  const n = Math.floor(w / step);
  const seed = S.profile ? [...S.profile.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) : 7;
  const head = pct === null ? -1 : Math.round((pct / 100) * n);
  if (scanning) scanPos = (scanPos + 2) % (n + 30);
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const v = Math.abs(Math.sin(i * 0.37 + seed) * 0.55 + Math.sin(i * 0.11 + seed * 0.3) * 0.35 + Math.sin(i * 1.7) * 0.1);
    const bh = Math.max(2, Math.round(v * (hgt - 6)));
    let col = off;
    if (i < head) col = stalled ? amber : teal;
    if (scanning && Math.abs(i - scanPos) < 14) col = stalled ? amber : teal;
    ctx.fillStyle = col;
    ctx.globalAlpha = col === off ? 0.75 : 1;
    ctx.fillRect(x, (hgt - bh) / 2, 2, bh);
  }
  ctx.globalAlpha = 1;
  // center line + playhead
  ctx.fillStyle = off;
  ctx.fillRect(0, Math.round(hgt / 2), w, 1);
  if (head >= 0) {
    ctx.fillStyle = red;
    ctx.fillRect(Math.min(w - 2, head * step), 0, 2, hgt);
  }
}

// ── Transfers table (virtualised) ─────────────────────────────
const ROW_H = 28;
const ACT_LABEL = { new: 'NEW', update: 'CHANGED', delete: 'DELETE', mkdir: 'MKDIR', meta: 'ATTRS', link: 'LINK', other: 'OTHER', mismatch: 'MISMATCH' };
let filtered = [];
function computeFiltered() {
  const R = S.run;
  const f = S.tFilter;
  let src = f === 'verify' ? R.mismatches : R.items;
  if (f === 'new' || f === 'update' || f === 'delete') src = src.filter((x) => x.action === f);
  else if (f === 'meta') src = src.filter((x) => !['new', 'update', 'delete'].includes(x.action));
  if (S.tSearch) src = src.filter((x) => x.path.toLowerCase().includes(S.tSearch));
  filtered = src;
}
function renderTable(recompute = true) {
  if (S.view !== 'transfers') return;
  if (recompute) computeFiltered();
  const body = $('tBody');
  const spacer = $('tSpacer');
  spacer.style.height = `${filtered.length * ROW_H}px`;
  const top = body.scrollTop;
  const first = Math.max(0, Math.floor(top / ROW_H) - 5);
  const last = Math.min(filtered.length, first + Math.ceil(body.clientHeight / ROW_H) + 10);
  const rows = [];
  for (let i = first; i < last; i++) {
    const it = filtered[i];
    const row = h('div', { class: 'row' },
      h('span', { class: 'c-n', text: pad(i + 1) }),
      h('span', { class: `act ${it.action}`, text: it.action === 'mismatch' ? `≠ ${ACT_LABEL[it.was] || ''}`.trim() : ACT_LABEL[it.action] || it.action }),
      h('span', { class: 'c-p', text: it.path, title: it.path }),
      h('span', { class: 'c-s', text: it.kind === 'file' && it.action !== 'delete' ? fmtBytes(it.size) : '-' }),
      h('span', { class: 'c-c', text: it.code }));
    row.style.top = `${i * ROW_H}px`;
    if (i % 2) row.style.background = 'var(--row-alt)';
    rows.push(row);
  }
  body.replaceChildren(spacer, ...rows);
  body.scrollTop = top;
  const empty = $('tEmpty');
  empty.hidden = filtered.length > 0;
  if (!filtered.length && S.run.result) {
    empty.firstElementChild.textContent = S.tFilter === 'verify' ? (S.run.result.verify ? 'No mismatches. Every file verified by checksum.' : 'Verification was not run for this sync.') : 'Nothing here.';
  }
}

// ── Log ───────────────────────────────────────────────────────
let logRendered = 0;
function renderLog(full = false) {
  const con = $('console');
  const atBottom = con.scrollTop + con.clientHeight >= con.scrollHeight - 30;
  if (full || logRendered > S.log.length) { con.replaceChildren(); logRendered = 0; }
  const frag = document.createDocumentFragment();
  for (let i = logRendered; i < S.log.length; i++) {
    const l = S.log[i];
    if (S.logFilter === 'stderr' && l.stream !== 'stderr' && l.stream !== 'retry') continue;
    frag.append(h('span', { class: l.stream === 'stderr' ? 'e' : l.stream === 'sys' ? 's' : l.stream === 'retry' ? 'r' : '', text: `${l.line}\n` }));
  }
  logRendered = S.log.length;
  con.append(frag);
  if (atBottom || full) con.scrollTop = con.scrollHeight;
}

// ── History ───────────────────────────────────────────────────
function renderHistory() {
  const body = $('hBody');
  $('hSub').textContent = `${S.history.length} RUNS`;
  body.replaceChildren(...S.history.map((x, i) => {
    const v = x.verify ? (x.verify.ok ? h('span', { class: 'st ok', text: '✓ OK' }) : h('span', { class: 'st bad', text: x.verify.mismatchCount ? `≠ ${x.verify.mismatchCount}` : '✕ ERR' })) : h('span', { class: 'st stopped', text: '-' });
    return h('div', { class: 'row', title: x.message },
      h('span', { class: 'c-n', text: pad(S.history.length - i) }),
      h('span', { text: fmtWhen(x.at) }),
      h('span', { text: x.profileName }),
      h('span', { class: 'act', text: x.dryRun ? 'PREVIEW' : 'SYNC' }),
      h('span', { text: String(x.itemCount ?? 0) }),
      h('span', { text: fmtBytes(x.bytes) }),
      h('span', { text: fmtDur(x.durationMs) }),
      h('span', { text: String(x.attempts || 1) }),
      v,
      h('span', { class: `st ${x.status}`, text: x.status.toUpperCase() }));
  }));
  if (!S.history.length) body.append(h('div', { class: 'empty', text: 'No runs yet.' }));
}

function renderLastRun() {
  const last = S.profile && S.history.find((x) => x.profileId === S.profile.id && !x.dryRun);
  $('lastRunWhen').textContent = last ? fmtWhen(last.at) : 'never';
  $('lrFiles').textContent = pad(last ? last.itemCount : 0);
  $('lrSize').textContent = fmtBytes(last ? last.bytes : 0);
  const st = $('lrStatus');
  st.textContent = last ? (last.status === 'success' ? (last.verify && last.verify.ok ? 'OK+VFY' : 'OK') : last.status === 'verify-failed' ? 'VFY!' : last.status.slice(0, 6).toUpperCase()) : '----';
  st.className = `sb-v ${last ? (last.status === 'success' ? 'ok' : last.status === 'warning' ? 'warn' : 'bad') : ''}`;
}

// ── Modal ─────────────────────────────────────────────────────
function confirmBox({ title, body, okText = 'OK', ack = null, danger = false, altText = null }) {
  return new Promise((resolve) => {
    const m = $('modal');
    $('mTitle').textContent = title;
    $('mBody').replaceChildren(...body);
    const ok = $('mOk');
    ok.textContent = okText;
    ok.className = `btn ${danger ? 'danger' : 'primary'}`;
    $('mAckRow').hidden = !ack;
    $('mAck').checked = false;
    $('mAckText').textContent = ack || '';
    ok.disabled = !!ack;
    const foot = ok.parentElement;
    const oldAlt = foot.querySelector('.alt');
    if (oldAlt) oldAlt.remove();
    let alt = null;
    if (altText) {
      alt = h('button', { class: 'btn alt', text: altText });
      foot.insertBefore(alt, ok);
    }
    m.hidden = false;
    const close = (v) => {
      m.hidden = true;
      ok.onclick = null;
      $('mCancel').onclick = null;
      $('mAck').onchange = null;
      document.removeEventListener('keydown', esc);
      resolve(v);
    };
    const esc = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', esc);
    $('mAck').onchange = (e) => { ok.disabled = !e.target.checked; };
    ok.onclick = () => close(true);
    $('mCancel').onclick = () => close(false);
    if (alt) alt.onclick = () => close('alt');
    (alt || $('mCancel')).focus();
  });
}

init().catch((e) => {
  document.body.prepend(h('div', { class: 'check err', text: `Failed to start: ${e.message}` }));
});
