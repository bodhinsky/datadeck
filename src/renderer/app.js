'use strict';
/* global deck, DD */
// Shell: sources sidebar, page routing, the job indicator and theme.
(function () {
  const { h, $, $$ } = DD;
  const S = DD.state;
  const PAGE_TITLES = { overview: 'Overview', explorer: 'Explorer', dupes: 'Duplicates', issues: 'Issues', restructure: 'Restructure', plans: 'Plans & undo', sync: 'Sync', jobs: 'Jobs', settings: 'Settings' };

  DD.source = () => S.sources.find((s) => s.id === S.sourceId) || null;

  DD.refreshSources = async () => {
    S.sources = await DD.call('sources.list');
    if (!S.sources.some((s) => s.id === S.sourceId)) S.sourceId = S.sources.length ? S.sources[0].id : null;
    renderSources();
    renderCrumbs();
  };

  function renderSources() {
    const list = $('sourceList');
    list.replaceChildren(...S.sources.map((s) => h('a', { class: `src-item${s.id === S.sourceId ? ' on' : ''}`, title: s.path, 'data-source': s.id, onclick: () => DD.selectSource(s.id) },
      h('span', { class: `dot ${s.status}` }),
      h('span', { class: 'sl', text: s.label }),
      h('span', { class: 'sm', text: s.status === 'new' ? 'not scanned' : `${DD.fmtNum(s.files)} files · ${DD.fmtBytes(s.bytes)}` }))));
    if (!S.sources.length) list.append(h('div', { class: 'hint', style: { padding: '2px 8px' }, text: 'Add a folder to start.' }));
  }

  DD.selectSource = (id) => {
    S.sourceId = id;
    renderSources();
    renderCrumbs();
    DD.bus.dispatchEvent(new CustomEvent('source'));
    const v = DD.views[S.page];
    if (v && v.show) v.show({ sourceChanged: true });
  };

  function renderCrumbs() {
    $('crumbPage').textContent = PAGE_TITLES[S.page] || '';
    const src = DD.source();
    const perSource = !['sync', 'jobs', 'settings'].includes(S.page);
    $('crumbSource').textContent = src && perSource ? `· ${src.label}` : '';
    $('crumbPath').textContent = src && perSource ? src.path : '';
  }

  DD.go = (page, params = {}) => {
    S.page = page;
    $$('.page').forEach((el) => el.classList.toggle('on', el.id === `page-${page}`));
    $$('.nav a[data-page]').forEach((el) => el.classList.toggle('on', el.dataset.page === page));
    renderCrumbs();
    const v = DD.views[page];
    if (v && v.show) v.show(params);
  };

  DD.addSource = async () => {
    const dir = await deck.pickFolder({ title: 'Choose a folder to analyze' });
    if (!dir) return;
    const src = await DD.call('sources.add', { path: dir });
    await DD.refreshSources();
    DD.selectSource(src.id);
    if (src.status === 'new') await DD.scan(src.id);
    DD.go('overview');
  };

  DD.scan = async (id = S.sourceId) => {
    if (!id) return;
    await DD.call('scan.start', { sourceId: id });
    await DD.refreshSources();
  };

  // ── Jobs ──
  S.jobs = new Map();
  function onJob(job) {
    S.jobs.set(job.id, job);
    const bar = $('jobbar');
    const running = job.status === 'running';
    if (running) S.activeJob = job;
    else if (S.activeJob && S.activeJob.id === job.id) S.activeJob = null;
    bar.hidden = !S.activeJob;
    if (S.activeJob) {
      const p = job.progress || {};
      $('jobTitle').textContent = job.label;
      let sub = '';
      let frac = null;
      if (job.kind === 'scan') sub = `${DD.fmtNum(p.files || 0)} files · ${DD.fmtNum(p.dirs || 0)} folders · ${DD.fmtBytes(p.bytes || 0)}${p.current ? ` · ${p.current}` : ''}`;
      else if (job.kind === 'dupes') { sub = `${p.phase === 'full' ? 'Comparing contents' : 'Pre-checking'} · ${DD.fmtBytes(p.bytesHashed || 0)} read`; frac = p.phase === 'full' && p.fullCandidates ? p.hashed / p.fullCandidates : p.candidates ? (p.quick || 0) / p.candidates * 0.3 : null; }
      else if (job.kind === 'execute') { sub = `${DD.fmtNum((p.done || 0) + (p.skipped || 0))} / ${DD.fmtNum(p.total || 0)} files · ${DD.fmtBytes(p.bytesDone || 0)} of ${DD.fmtBytes(p.bytesTotal || 0)}${p.failed ? ` · ${p.failed} failed` : ''}`; frac = p.bytesTotal ? p.bytesDone / p.bytesTotal : p.total ? (p.done + p.skipped) / p.total : null; }
      else if (job.kind === 'undo') { sub = `${p.undone || 0} / ${p.total || 0}`; frac = p.total ? (p.undone + p.kept + p.failed) / p.total : null; }
      $('jobSub').textContent = sub;
      const prog = $('jobProg');
      prog.classList.toggle('indet', frac === null);
      prog.firstElementChild.style.width = frac === null ? '' : `${Math.min(100, frac * 100).toFixed(1)}%`;
    }
    if (!running) {
      if (job.status === 'failed') DD.toast(`${job.label}: ${job.error}`, true);
      else if (job.status === 'cancelled') DD.toast(`${job.label}: cancelled`);
      else DD.toast(`${job.label}: done`);
      DD.refreshSources().then(() => DD.bus.dispatchEvent(new CustomEvent('job-done', { detail: job })));
    }
    DD.bus.dispatchEvent(new CustomEvent('job', { detail: job }));
  }

  const throttledSources = DD.debounce(() => DD.refreshSources(), 400);

  function applyTheme() {
    const t = ['light', 'dark'].includes(S.settings.theme) ? S.settings.theme : 'system';
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === t));
  }
  DD.saveSettings = async (patch) => {
    const r = await deck.saveSettings({ ...S.settings, ...patch });
    S.settings = r.settings;
    if (r.rsync) S.rsync = r.rsync;
    applyTheme();
    return r;
  };

  async function init() {
    if (/Mac/.test(navigator.platform)) document.body.classList.add('mac');
    const d = await deck.init();
    Object.assign(S, { settings: d.settings, rsync: d.rsync, flags: d.flags, profiles: d.profiles, history: d.history, running: d.running });
    S.meta = { ...(await DD.call('meta')), version: d.version };
    applyTheme();
    $$('#themeSeg button').forEach((b) => b.addEventListener('click', () => DD.saveSettings({ theme: b.dataset.themeSet })));
    $$('.nav a[data-page]').forEach((a) => a.addEventListener('click', () => DD.go(a.dataset.page)));
    $('btnAddSource').addEventListener('click', DD.addSource);
    deck.onMenu((cmd) => { if (cmd === 'add-source') DD.addSource(); });
    $('jobCancel').addEventListener('click', () => { if (S.activeJob) DD.call('job.cancel', { jobId: S.activeJob.id }); });
    deck.onEngineEvent((event, data) => {
      if (event === 'job') { onJob(data); if (data.kind === 'scan' && data.status === 'running') throttledSources(); }
      else if (event === 'engine-restart') DD.toast('The engine restarted after an error. Running jobs were stopped safely.', true);
    });
    $('sideFoot').textContent = d.rsync && d.rsync.ok ? `rsync ${d.rsync.version || ''} · catalog ready` : 'catalog ready · rsync not found';
    for (const v of Object.values(DD.views)) if (v.init) v.init();
    await DD.refreshSources();
    DD.go(S.sources.length ? 'overview' : 'overview');
  }

  init().catch((e) => {
    document.body.prepend(h('div', { class: 'callout bad', text: `DataDeck failed to start: ${e.message}` }));
  });
})();
