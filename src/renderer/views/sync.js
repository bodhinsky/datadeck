'use strict';
/* global DD, deck */
// Sync: saved rsync profiles with dry-run preview, live progress, automatic
// reconnects and a checksum verify pass (engine in src/core).
(function () {
  const { h, $ } = DD;
  const S = DD.state;
  let el;
  const U = {}; // element refs
  const Y = (S.sync = { profile: null, tab: 'setup', check: null, previewedFor: {}, run: freshRun(), log: [], tFilter: 'all', search: '' });

  function freshRun() {
    return { active: false, runId: null, profileId: null, dryRun: false, phase: null, attempt: 0, maxAttempts: 0, startedAt: 0, endedAt: 0,
      progress: null, retry: null, retries: 0, result: null, items: [], index: new Map(), mismatches: [], bytes: 0, counts: { new: 0, update: 0, delete: 0, other: 0 } };
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fingerprint = (p) => { const { name, id, ...rest } = p; return JSON.stringify(rest); };
  const isRemote = (p) => { if (!p) return false; if (/^rsync:\/\//i.test(p)) return true; const c = p.indexOf(':'); return c > 0 && !p.slice(0, c).includes('/'); };

  DD.views.sync = {
    init() {
      el = $('page-sync');
      build();
      deck.onRunEvent(onRunEvent);
      deck.onMenu((cmd) => {
        if (cmd === 'preview') { DD.go('sync'); start(true); }
        else if (cmd === 'sync') { DD.go('sync'); start(false); }
        else if (cmd === 'stop') deck.stop();
        else if (cmd === 'new-profile') { DD.go('sync'); deck.newProfile().then(async (p) => { S.profiles = await deck.saveProfile(p); selectProfile(p.id); }); }
      });
    },
    async show() {
      if (!S.profiles.length) {
        const p = await deck.newProfile();
        p.name = 'My first sync';
        S.profiles = await deck.saveProfile(p);
      }
      if (!Y.profile) selectProfile(S.profiles[0].id);
      else { renderProfiles(); renderRunbar(); }
    },
  };

  // ── Layout ──
  function build() {
    U.profiles = h('nav', { class: 'nav' });
    U.title = h('div', { style: { fontWeight: '600', fontSize: '15px' } });
    U.route = h('div', { class: 'mono hint', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } });
    U.btnPreview = h('button', { class: 'btn', id: 'btnPreview', text: 'Preview', title: 'Dry run: list every change, touch nothing (⌘⇧P)', onclick: () => start(true) });
    U.btnRun = h('button', { class: 'btn primary', id: 'btnRun', text: 'Run sync', title: '⌘R', onclick: () => start(false) });
    U.btnStop = h('button', { class: 'btn', id: 'btnStop', text: 'Stop', disabled: true, onclick: () => deck.stop() });
    U.state = h('div', { style: { fontWeight: '600' } });
    U.stats = h('div', { class: 'mono hint', id: 'syncStats' });
    U.prog = h('div', { class: 'progress' }, h('i'));
    U.runbar = h('div', { class: 'card', style: { marginBottom: '14px' } }, h('div', { class: 'card-b', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) auto minmax(0, 1fr)', gap: '18px', alignItems: 'center' } },
      h('div', { style: { minWidth: '0' } }, U.title, U.route),
      h('div', { class: 'row' }, U.btnPreview, U.btnRun, U.btnStop),
      h('div', { style: { minWidth: '0' } }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, U.state, U.pct = h('span', { class: 'mono', id: 'syncPct' })), U.prog, U.stats)));

    U.tabs = h('div', { class: 'tabs' }, [['setup', 'Setup'], ['transfers', 'Transfers'], ['log', 'Live log'], ['history', 'History']].map(([k, l]) => h('button', { 'data-tab': k, text: l, onclick: () => setTab(k) })));
    U.panes = { setup: h('div'), transfers: h('div', { style: { display: 'flex', flexDirection: 'column', height: '62vh' } }), log: h('div', { style: { display: 'flex', height: '62vh' } }), history: h('div') };
    buildSetup();
    buildTransfers();
    U.console = h('pre', { class: 'console', id: 'syncLog' });
    U.panes.log.append(U.console);

    el.replaceChildren(
      DD.pageHead('Sync', 'Mirror or back up folders with rsync. Previews first, resumes after network drops, verifies by checksum.', [
        h('button', { class: 'btn', text: 'New profile', onclick: async () => { const p = await deck.newProfile(); S.profiles = await deck.saveProfile(p); selectProfile(p.id); } }),
      ]),
      h('div', { style: { display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: '16px' } },
        DD.card('Profiles', U.profiles, {}),
        h('div', { style: { minWidth: '0' } }, U.runbar, U.tabs, ...Object.values(U.panes))));
    setTab('setup');
  }

  function setTab(t) {
    Y.tab = t;
    U.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    for (const [k, p] of Object.entries(U.panes)) p.hidden = k !== t;
    if (t === 'transfers') U.table.reload({ keepScroll: true });
    if (t === 'log') renderLog(true);
    if (t === 'history') renderHistory();
  }

  function renderProfiles() {
    U.profiles.replaceChildren(...S.profiles.map((p) => {
      const last = S.history.find((x) => x.profileId === p.id);
      const tone = Y.run.active && Y.run.profileId === p.id ? 'scanning' : last ? (last.status === 'success' ? 'ready' : 'partial') : '';
      return h('a', { class: `src-item${Y.profile && Y.profile.id === p.id ? ' on' : ''}`, title: `${p.source || '?'} → ${p.dest || '?'}`, onclick: () => selectProfile(p.id) },
        h('span', { class: `dot ${tone}` }), h('span', { class: 'sl', text: p.name || 'Untitled' }),
        h('span', { class: 'sm', text: last ? `${last.status} · ${DD.fmtDateTime(last.at)}` : 'never run' }));
    }));
  }

  function selectProfile(id) {
    const p = S.profiles.find((x) => x.id === id);
    if (!p) return;
    Y.profile = clone(p);
    renderProfiles();
    fillSetup();
    renderRunbar();
    scheduleCheck(0);
  }

  // ── Setup ──
  function buildSetup() {
    const f = (U.f = {});
    const inp = (key, attrs = {}) => (f[key] = h('input', { class: 'input', id: `p-${key}`, spellcheck: 'false', ...attrs }));
    const field = (label, input) => h('label', { class: 'field' }, h('span', { text: label }), input);
    const pick = (key) => h('button', { class: 'btn', text: 'Browse…', onclick: async () => {
      const d = await deck.pickFolder({ title: key === 'source' ? 'Choose source folder' : 'Choose destination folder', defaultPath: Y.profile[key] });
      if (d) { Y.profile[key] = d; f[key].value = d; changed(); }
    } });
    const sw = (key, label, hint) => h('label', { class: 'chk', title: hint || '' }, f[key] = h('input', { type: 'checkbox', onchange: (e) => { setVal(key, e.target.checked); changed(); } }), label);

    U.flagGrid = h('div', { class: 'flags' });
    U.checks = h('div', { id: 'syncChecks' });
    U.cmd = h('div', { class: 'cmd', id: 'syncCmd' });
    U.contentsHint = h('div', { class: 'hint' });
    U.panes.setup.append(
      h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))' } },
        DD.card('Route', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          field('Profile name', inp('name', { maxlength: 60, oninput: (e) => { Y.profile.name = e.target.value; changed(); } })),
          field('Source', h('div', { class: 'row' }, inp('source', { class: 'input mono', placeholder: '/Users/you/Photos  or  user@host:/path', oninput: (e) => { Y.profile.source = e.target.value; changed(); } }), pick('source'))),
          field('Destination', h('div', { class: 'row' }, inp('dest', { class: 'input mono', placeholder: '/Volumes/Backup/Photos', oninput: (e) => { Y.profile.dest = e.target.value; changed(); } }), pick('dest'))),
          sw('contents', "Copy the folder's contents (not the folder itself)"), U.contentsHint)),
        DD.card('Integrity & safety', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          sw('verifyAfter', 'Verify every file by checksum after the sync'),
          sw('backup', 'Keep replaced and deleted files in a backup folder'),
          field('Backup folder (inside destination)', inp('backupDir', { class: 'input mono', placeholder: '.syncdeck-old', oninput: (e) => { Y.profile.safety.backupDir = e.target.value; changed(); } })),
          field('Max deletions per run (0 = no limit)', inp('maxDelete', { type: 'number', min: 0, oninput: (e) => { Y.profile.safety.maxDelete = Math.max(0, parseInt(e.target.value, 10) || 0); changed(); } }))))),
      h('div', { style: { height: '16px' } }),
      DD.card('Flags', U.flagGrid, { hint: 'hover for details' }),
      h('div', { style: { height: '16px' } }),
      h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))' } },
        DD.card('Network & resume', h('div', { class: 'form-grid' },
          field('Auto-retries', inp('retries', { type: 'number', min: 0, max: 100, oninput: (e) => { Y.profile.network.retries = Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)); changed(); } })),
          field('Stall timeout (s)', inp('timeout', { type: 'number', min: 0, oninput: (e) => { Y.profile.network.timeout = Math.max(0, parseInt(e.target.value, 10) || 0); changed(); } })),
          field('Bandwidth limit (KB/s)', inp('bwlimit', { placeholder: 'none', oninput: (e) => { Y.profile.network.bwlimit = e.target.value.trim(); changed(); } })),
          field('SSH port', inp('sshPort', { placeholder: '22', oninput: (e) => { Y.profile.network.sshPort = e.target.value.trim(); changed(); } })),
          field('SSH key', inp('identityFile', { class: 'input mono', placeholder: '~/.ssh/id_ed25519', oninput: (e) => { Y.profile.network.identityFile = e.target.value.trim(); changed(); } })))),
        DD.card('Excludes & options', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          field('Exclude patterns, one per line', f.excludes = h('textarea', { class: 'input mono', rows: 4, spellcheck: 'false', oninput: (e) => { Y.profile.excludes = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); changed(); } })),
          field('Extra rsync options', inp('extraArgs', { class: 'input mono', placeholder: '--modify-window=2', oninput: (e) => { Y.profile.extraArgs = e.target.value; changed(); } }))))),
      h('div', { style: { height: '16px' } }),
      U.checks,
      h('div', { class: 'row' }, U.cmd, h('button', { class: 'btn', text: 'Copy', onclick: async () => { await navigator.clipboard.writeText(U.cmd.textContent); DD.toast('Command copied.'); } })),
      h('div', { class: 'row', style: { marginTop: '12px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn ghost', text: 'Duplicate profile', onclick: async () => { const p = await deck.newProfile(); Object.assign(p, clone(Y.profile), { id: p.id, name: `${Y.profile.name} copy` }); S.profiles = await deck.saveProfile(p); selectProfile(p.id); } }),
        h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, text: 'Delete profile', onclick: deleteProfile })));
    U.cmd.style.flex = '1';
    for (const fl of S.flags || []) {
      const b = h('button', { class: `flag${fl.danger ? ' danger' : ''}`, 'data-flag': fl.key, title: fl.hint }, h('span', { class: 'led' }), h('span', { text: fl.label }), h('span', { class: 'fa', text: fl.arg }));
      b.addEventListener('click', () => { Y.profile.flags[fl.key] = !Y.profile.flags[fl.key]; fillFlags(); changed(); });
      U.flagGrid.append(b);
    }
  }

  function setVal(key, v) {
    if (key === 'contents') Y.profile.contents = v;
    else if (key === 'verifyAfter' || key === 'backup') {
      Y.profile.safety[key] = v;
      if (key === 'backup' && v && !Y.profile.safety.backupDir) { Y.profile.safety.backupDir = '.syncdeck-old'; U.f.backupDir.value = '.syncdeck-old'; }
    }
  }

  function fillFlags() {
    const caps = (S.rsync && S.rsync.caps) || {};
    U.flagGrid.querySelectorAll('.flag').forEach((b) => {
      const fl = S.flags.find((x) => x.key === b.dataset.flag);
      b.classList.toggle('on', !!Y.profile.flags[fl.key]);
      b.classList.toggle('na', !!fl.cap && caps[fl.cap] === false);
    });
  }

  function fillSetup() {
    const p = Y.profile;
    const f = U.f;
    f.name.value = p.name; f.source.value = p.source; f.dest.value = p.dest;
    f.contents.checked = p.contents; f.verifyAfter.checked = p.safety.verifyAfter; f.backup.checked = p.safety.backup;
    f.backupDir.value = p.safety.backupDir || ''; f.maxDelete.value = p.safety.maxDelete;
    f.retries.value = p.network.retries; f.timeout.value = p.network.timeout; f.bwlimit.value = p.network.bwlimit || '';
    f.sshPort.value = p.network.sshPort || ''; f.identityFile.value = p.network.identityFile || '';
    f.excludes.value = (p.excludes || []).join('\n'); f.extraArgs.value = p.extraArgs || '';
    fillFlags();
    fillDerived();
  }

  function fillDerived() {
    const p = Y.profile;
    const srcName = (p.source || 'Source').replace(/\/+$/, '').split(/[/:]/).pop() || 'Source';
    const dest = (p.dest || 'Destination').replace(/\/+$/, '');
    U.contentsHint.textContent = p.contents ? `Files inside “${srcName}” go straight into ${dest}/` : `The folder itself is copied: ${dest}/${srcName}/…`;
  }

  const save = DD.debounce(async () => { S.profiles = await deck.saveProfile(Y.profile); renderProfiles(); }, 350);
  function changed() { fillDerived(); save(); scheduleCheck(); renderRunbar(); }

  let checkTimer = null;
  function scheduleCheck(ms = 250) { clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, ms); }
  async function runCheck() {
    if (!Y.profile) return;
    const pid = Y.profile.id;
    const c = await deck.check(Y.profile, false);
    if (!Y.profile || Y.profile.id !== pid) return;
    Y.check = c;
    U.cmd.textContent = `$ ${c.command || ''}`;
    U.checks.replaceChildren(
      ...c.errors.map((e) => h('div', { class: 'callout bad', text: e })),
      ...c.warnings.map((w) => h('div', { class: 'callout warn', text: w })),
      c.ok && !c.warnings.length ? h('div', { class: 'callout ok', text: 'Ready. Run a preview first to see exactly what will change.' }) : null);
    U.f.source.classList.toggle('bad', c.errors.some((e) => /source/i.test(e)));
    U.f.dest.classList.toggle('bad', c.errors.some((e) => /destination/i.test(e)));
    renderRunbar();
  }

  async function deleteProfile() {
    if (Y.run.active && Y.run.profileId === Y.profile.id) return DD.toast('Stop the running sync first.');
    const ok = await DD.confirm({ title: 'Delete profile', body: [h('p', { text: `Delete “${Y.profile.name}”? Only the saved settings go away; no files are touched.` })], okText: 'Delete', danger: true });
    if (!ok) return;
    S.profiles = await deck.deleteProfile(Y.profile.id);
    if (!S.profiles.length) { const p = await deck.newProfile(); S.profiles = await deck.saveProfile(p); }
    selectProfile(S.profiles[0].id);
  }

  // ── Running ──
  async function start(dryRun) {
    if (Y.run.active || !Y.profile) return;
    S.profiles = await deck.saveProfile(Y.profile);
    const c = await deck.check(Y.profile, dryRun);
    if (!c.ok) { setTab('setup'); scheduleCheck(0); DD.toast(c.errors[0], true); return; }
    if (!dryRun) {
      const p = Y.profile;
      const previewed = Y.previewedFor[p.id] === fingerprint(p);
      const body = [];
      if (!previewed) body.push(h('div', { class: `callout ${p.flags.delete ? 'warn' : ''}`, text: 'You have not previewed these exact settings yet. A preview lists every change before anything is touched.' }));
      for (const w of c.warnings) body.push(h('div', { class: 'callout warn', text: w }));
      body.push(h('p', {}, 'Copy ', h('b', { text: p.source }), ' → ', h('b', { text: p.dest })));
      if (p.safety.verifyAfter) body.push(h('p', { class: 'hint', text: 'Afterwards every file is compared by checksum.' }));
      body.push(h('div', { class: 'cmd', text: c.command }));
      const ok = await DD.confirm({ title: p.flags.delete ? 'Run mirror sync' : 'Run sync', body, okText: 'Run', danger: p.flags.delete,
        ack: p.flags.delete ? 'Files missing from the source will be deleted at the destination.' : null, altText: previewed ? null : 'Preview first' });
      if (ok === 'alt') return start(true);
      if (!ok) return;
    }
    const prev = Y.run;
    Y.run = freshRun();
    Object.assign(Y.run, { active: true, runId: crypto.randomUUID(), profileId: Y.profile.id, dryRun, startedAt: Date.now(), fp: fingerprint(Y.profile) });
    const r = await deck.start(Y.profile, dryRun, Y.run.runId);
    if (!r.ok) { Y.run = prev; renderRunbar(); DD.toast(r.errors.join(' '), true); return; }
    Y.log.push({ stream: 'sys', line: `── ${dryRun ? 'PREVIEW' : 'SYNC'} “${Y.profile.name}” ${new Date().toLocaleTimeString()} ──` });
    setTab('transfers');
    renderRunbar();
    renderProfiles();
    clearInterval(Y.ticker);
    Y.ticker = setInterval(() => { renderRunbar(); if (!Y.run.active) clearInterval(Y.ticker); }, 250);
  }

  function onRunEvent(ev) {
    if (ev.type === 'history') { S.history = ev.history; renderProfiles(); if (Y.tab === 'history') renderHistory(); return; }
    if (ev.runId !== Y.run.runId) return;
    const R = Y.run;
    switch (ev.type) {
      case 'phase': R.phase = ev.phase; R.progress = null; Y.log.push({ stream: 'sys', line: `── phase: ${ev.phase} ──` }); break;
      case 'attempt':
        if (ev.phase !== 'verify') { R.attempt = ev.attempt; R.maxAttempts = ev.maxAttempts; }
        R.retry = null;
        Y.log.push({ stream: 'sys', line: `$ ${ev.command}` });
        if (ev.attempt > 1) Y.log.push({ stream: 'retry', line: `↻ attempt ${ev.attempt}/${ev.maxAttempts}: resuming from partial files` });
        break;
      case 'retry':
        R.retry = { until: Date.now() + ev.delayMs, reason: ev.reason };
        if (ev.phase !== 'verify') R.retries++;
        Y.log.push({ stream: 'retry', line: `⚠ ${ev.reason}. Reconnecting in ${Math.round(ev.delayMs / 1000)}s…` });
        break;
      case 'progress': R.progress = ev; break;
      case 'items': for (const it of ev.items) addItem(it); break;
      case 'logs': for (const l of ev.logs) Y.log.push(l); break;
      case 'done':
        R.active = false; R.result = ev.result; R.endedAt = Date.now(); R.retry = null;
        if (ev.result.dryRun && ev.result.status === 'success') Y.previewedFor[R.profileId] = R.fp;
        Y.log.push({ stream: 'sys', line: `── ${ev.result.status.toUpperCase()}: ${ev.result.message} ──` });
        if (ev.result.verify && !ev.result.verify.ok && R.mismatches.length) Y.tFilter = 'verify';
        renderProfiles();
        break;
      default:
    }
    if (Y.log.length > 20000) Y.log.splice(0, Y.log.length - 15000);
    if (Y.tab === 'log') renderLog();
    if (Y.tab === 'transfers' && (ev.type === 'items' || ev.type === 'done')) U.table.reload({ keepScroll: true });
    renderTransfersHead();
    renderRunbar();
  }

  function addItem(it) {
    const R = Y.run;
    if (it.phase === 'verify') {
      if (['new', 'update', 'delete', 'mkdir'].includes(it.action)) R.mismatches.push({ ...it, action: 'mismatch', was: it.action });
      return;
    }
    const bucket = (a) => (a === 'new' || a === 'update' || a === 'delete' ? a : 'other');
    const prev = R.index.get(it.path);
    if (prev !== undefined) {
      const old = R.items[prev];
      R.counts[bucket(old.action)]--;
      if ((old.action === 'new' || old.action === 'update') && old.kind === 'file') R.bytes -= old.size;
      R.items[prev] = it;
    } else { R.index.set(it.path, R.items.length); R.items.push(it); }
    R.counts[bucket(it.action)]++;
    if ((it.action === 'new' || it.action === 'update') && it.kind === 'file') R.bytes += it.size;
  }

  function renderRunbar() {
    const p = Y.run.active ? S.profiles.find((x) => x.id === Y.run.profileId) || Y.profile : Y.profile;
    if (!p) return;
    U.title.textContent = p.name || 'Untitled';
    U.route.textContent = `${p.source || '—'}  →  ${p.dest || '—'}`;
    const R = Y.run;
    const can = !R.active && Y.check && Y.check.ok;
    U.btnPreview.disabled = !can;
    U.btnRun.disabled = !can;
    U.btnStop.disabled = !R.active;
    U.btnRun.className = `btn ${p.flags && p.flags.delete ? 'danger' : 'primary'}`;
    let state = 'Idle';
    let tone = '';
    let pct = null;
    if (R.active) {
      if (R.retry) { state = `Link lost · retry in ${Math.max(0, Math.ceil((R.retry.until - Date.now()) / 1000))}s`; tone = 'var(--warn)'; }
      else if (R.phase === 'verify') state = 'Verifying checksums';
      else if (R.phase === 'preview') state = 'Preview scan';
      else state = 'Syncing';
      if (R.progress && R.phase === 'transfer') pct = R.progress.overall;
    } else if (R.result) {
      const s = R.result.status;
      state = R.result.dryRun && s === 'success' ? 'Preview ready' : { success: 'Done', warning: 'Done with warnings', failed: 'Failed', 'verify-failed': 'Verify failed', stopped: 'Stopped' }[s] || 'Done';
      tone = s === 'success' ? 'var(--accent)' : s === 'warning' || s === 'stopped' ? 'var(--warn)' : 'var(--danger)';
      pct = s === 'success' || s === 'warning' ? 100 : R.progress ? R.progress.overall : 0;
    }
    U.state.textContent = state;
    U.state.id = 'syncState';
    U.state.style.color = tone;
    U.pct.textContent = pct === null ? '' : `${pct}%`;
    U.prog.classList.toggle('indet', R.active && pct === null);
    U.prog.firstElementChild.style.width = pct === null ? '' : `${pct}%`;
    const pg = R.progress;
    const elapsed = R.startedAt ? (R.active ? Date.now() : R.endedAt) - R.startedAt : 0;
    U.stats.textContent = R.startedAt
      ? [`${DD.fmtDur(elapsed)}`, R.maxAttempts ? `try ${R.attempt}/${R.maxAttempts}` : null, R.active && pg ? pg.rate : null, R.active && pg && R.phase === 'transfer' ? `eta ${pg.eta}` : null, `${DD.fmtNum(R.items.length)} items`, R.retries ? `${R.retries} reconnects` : null].filter(Boolean).join(' · ')
      : (Y.check && Y.check.errors.length ? Y.check.errors[0] : 'Ready');
  }

  // ── Transfers ──
  const ACT = { new: 'new', update: 'changed', delete: 'delete', mkdir: 'mkdir', meta: 'attrs', link: 'link', other: 'other', mismatch: 'mismatch' };
  function buildTransfers() {
    U.tBanner = h('div', { hidden: true });
    U.tFilters = h('div', { class: 'seg' });
    U.tSearch = h('input', { class: 'input', placeholder: 'Filter paths…', oninput: (e) => { Y.search = e.target.value.toLowerCase(); U.table.reload(); } });
    U.table = new DD.VirtualTable({
      emptyText: 'Run a Preview to see exactly what will change before anything is touched.',
      round: true,
      columns: [
        { label: '#', width: '60px', mono: true, cls: 'dim', render: (r, i) => i + 1 },
        { label: 'Action', width: '96px', render: (r) => h('span', { class: `tag ${r.action === 'new' ? 'ok' : r.action === 'delete' || r.action === 'mismatch' ? 'bad' : r.action === 'update' ? 'info' : ''}`, text: r.action === 'mismatch' ? `≠ ${ACT[r.was] || ''}` : ACT[r.action] || r.action }) },
        { label: 'Path', width: 'minmax(200px, 1fr)', render: (r) => r.path, titleOf: (r) => r.path },
        { label: 'Size', width: '90px', align: 'right', mono: true, render: (r) => (r.kind === 'file' && r.action !== 'delete' ? DD.fmtBytes(r.size) : '') },
        { label: 'Code', width: '110px', mono: true, cls: 'dim', render: (r) => r.code },
      ],
      fetch: async (offset, limit) => {
        const R = Y.run;
        let src = Y.tFilter === 'verify' ? R.mismatches : R.items;
        if (['new', 'update', 'delete'].includes(Y.tFilter)) src = src.filter((x) => x.action === Y.tFilter);
        else if (Y.tFilter === 'other') src = src.filter((x) => !['new', 'update', 'delete'].includes(x.action));
        if (Y.search) src = src.filter((x) => x.path.toLowerCase().includes(Y.search));
        return { rows: src.slice(offset, offset + limit), total: src.length };
      },
    });
    U.panes.transfers.append(U.tBanner, h('div', { class: 'row', style: { marginBottom: '10px', flexWrap: 'wrap' } }, U.tFilters, U.tSearch,
      h('span', { class: 'spacer' }), h('button', { class: 'btn', text: 'Open destination', onclick: () => { const p = S.profiles.find((x) => x.id === (Y.run.profileId || Y.profile.id)); if (p && !isRemote(p.dest)) deck.reveal(p.dest); } })), U.table.el);
    renderTransfersHead();
  }

  function renderTransfersHead() {
    const R = Y.run;
    const opts = [['all', 'All', R.items.length], ['new', 'New', R.counts.new], ['update', 'Changed', R.counts.update], ['delete', 'Delete', R.counts.delete], ['verify', 'Mismatch', R.mismatches.length], ['other', 'Other', R.counts.other]];
    U.tFilters.replaceChildren(...opts.map(([k, l, n]) => h('button', { 'data-f': k, class: Y.tFilter === k ? 'on' : '', onclick: () => { Y.tFilter = k; renderTransfersHead(); U.table.reload(); } }, `${l} `, h('span', { class: 'mono', text: DD.fmtNum(n) }))));
    const res = R.result;
    if (!res) { U.tBanner.hidden = true; return; }
    const kids = [];
    let cls = 'callout';
    if (res.dryRun && res.status === 'success') {
      const nothing = R.counts.new + R.counts.update + R.counts.delete === 0;
      kids.push(h('span', { class: 'grow', text: nothing ? 'Already in sync. Nothing would change.' : `Preview: ${R.counts.new} new · ${R.counts.update} changed · ${R.counts.delete} to delete · ${DD.fmtBytes(R.bytes)} to copy. Nothing has been changed yet.` }));
      if (!nothing) kids.push(h('button', { class: 'btn primary', text: 'Run this sync', onclick: () => { selectProfile(R.profileId); start(false); } }));
      cls += R.counts.delete ? ' warn' : ' ok';
    } else {
      cls += res.status === 'success' ? ' ok' : res.status === 'warning' || res.status === 'stopped' ? ' warn' : ' bad';
      kids.push(h('span', { class: 'grow', text: `${res.message}${res.attempts > 1 ? ` Needed ${res.attempts} attempts.` : ''}` }));
      if (res.status === 'failed' || res.status === 'stopped') kids.push(h('button', { class: 'btn', text: 'Resume', onclick: () => { selectProfile(R.profileId); start(false); } }));
    }
    U.tBanner.className = cls;
    U.tBanner.id = 'syncBanner';
    U.tBanner.replaceChildren(...kids);
    U.tBanner.hidden = false;
  }

  // ── Log & history ──
  let logRendered = 0;
  function renderLog(full = false) {
    const con = U.console;
    const atBottom = con.scrollTop + con.clientHeight >= con.scrollHeight - 30;
    if (full || logRendered > Y.log.length) { con.replaceChildren(); logRendered = 0; }
    const frag = document.createDocumentFragment();
    for (let i = logRendered; i < Y.log.length; i++) {
      const l = Y.log[i];
      frag.append(h('span', { class: l.stream === 'stderr' ? 'e' : l.stream === 'sys' ? 's' : l.stream === 'retry' ? 'r' : '', text: `${l.line}\n` }));
    }
    logRendered = Y.log.length;
    con.append(frag);
    if (atBottom || full) con.scrollTop = con.scrollHeight;
  }

  function renderHistory() {
    const rows = S.history;
    U.panes.history.replaceChildren(rows.length ? DD.card('Runs', h('table', { class: 'stat' },
      h('thead', {}, h('tr', {}, ['When', 'Profile', 'Mode', 'Items', 'Size', 'Time', 'Tries', 'Verify', 'Status'].map((t, i) => h('th', { class: i >= 3 && i <= 6 ? 'r' : '', text: t })))),
      h('tbody', {}, rows.map((x) => h('tr', { title: x.message },
        h('td', { class: 'n', text: DD.fmtDateTime(x.at) }), h('td', { text: x.profileName }), h('td', { text: x.dryRun ? 'preview' : 'sync' }),
        h('td', { class: 'r n', text: DD.fmtNum(x.itemCount ?? 0) }), h('td', { class: 'r n', text: DD.fmtBytes(x.bytes) }), h('td', { class: 'r n', text: DD.fmtDur(x.durationMs) }),
        h('td', { class: 'r n', text: String(x.attempts || 1) }),
        h('td', {}, x.verify ? h('span', { class: `tag ${x.verify.ok ? 'ok' : 'bad'}`, text: x.verify.ok ? 'ok' : x.verify.mismatchCount ? `${x.verify.mismatchCount} ≠` : 'error' }) : '–'),
        h('td', {}, h('span', { class: `tag ${x.status === 'success' ? 'ok' : x.status === 'warning' || x.status === 'stopped' ? 'warn' : 'bad'}`, text: x.status })))))), { flush: true })
      : DD.emptyState('No runs yet', 'Previews and syncs appear here.'));
  }
})();
