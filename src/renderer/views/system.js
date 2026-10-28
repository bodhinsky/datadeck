'use strict';
/* global DD, deck */
// Jobs (engine background work) and Settings.
(function () {
  const { h, $ } = DD;
  const S = DD.state;

  DD.views.jobs = {
    init() {
      this.el = $('page-jobs');
      DD.bus.addEventListener('job', DD.debounce(() => { if (S.page === 'jobs') this.show(); }, 300));
    },
    async show() {
      const jobs = await DD.call('jobs.list');
      const head = DD.pageHead('Jobs', 'Scans, duplicate checks, plan runs and undos. One disk-heavy job runs at a time so they never compete for the same files.');
      if (!jobs.length) { this.el.replaceChildren(head, DD.emptyState('No jobs yet', 'Scanning a source or running a plan shows up here.')); return; }
      const tone = (st) => (st === 'done' ? 'ok' : st === 'running' ? 'info' : st === 'cancelled' ? 'warn' : 'bad');
      const srcName = (id) => { const s = S.sources.find((x) => x.id === id); return s ? s.label : ''; };
      const summary = (j) => {
        const r = j.result || {};
        if (j.error) return j.error;
        if (j.kind === 'scan') return r.files !== undefined ? `${DD.fmtNum(r.files)} files · ${DD.fmtNum(r.errors || 0)} errors` : '';
        if (j.kind === 'execute') return r.done !== undefined ? `${DD.fmtNum(r.done)} done · ${DD.fmtNum(r.skipped || 0)} skipped · ${DD.fmtNum(r.failed || 0)} failed` : '';
        if (j.kind === 'dupes') return r.groups !== undefined ? `${DD.fmtNum(r.groups)} groups` : '';
        if (j.kind === 'undo') return r.undone !== undefined ? `${DD.fmtNum(r.undone)} undone · ${DD.fmtNum(r.kept || 0)} kept` : '';
        return '';
      };
      this.el.replaceChildren(head, DD.card('Recent jobs', h('table', { class: 'stat' },
        h('thead', {}, h('tr', {}, ['#', 'Job', 'Source', 'Started', 'Time', 'Result', 'Status', ''].map((t, i) => h('th', { class: i === 4 ? 'r' : '', text: t })))),
        h('tbody', {}, jobs.map((j) => h('tr', {},
          h('td', { class: 'n', text: `#${j.id}` }),
          h('td', { text: j.label }),
          h('td', { text: srcName(j.sourceId) }),
          h('td', { class: 'n', text: DD.fmtDateTime(j.startedAt) }),
          h('td', { class: 'r n', text: DD.fmtDur((j.finishedAt || Date.now()) - j.startedAt) }),
          h('td', { class: 'hint', text: summary(j), title: summary(j) }),
          h('td', {}, h('span', { class: `tag ${tone(j.status)}`, text: j.status })),
          h('td', {}, j.status === 'running' ? h('button', { class: 'btn small', text: 'Cancel', onclick: () => DD.call('job.cancel', { jobId: j.id }) })
            : j.planId ? h('button', { class: 'btn small ghost', text: 'Open plan', onclick: () => DD.go('restructure', { planId: j.planId }) }) : null))))), { flush: true }));
    },
  };

  DD.views.settings = {
    init() { this.el = $('page-settings'); },
    show() {
      const st = S.settings;
      const rs = S.rsync || {};
      const rsPath = h('input', { class: 'input mono', id: 'setRsync', value: st.rsyncPath || '', placeholder: 'auto-detect (Homebrew rsync preferred)', spellcheck: 'false' });
      const rsInfo = h('div', { class: `callout ${rs.ok ? (rs.modern ? 'ok' : 'warn') : 'bad'}` });
      const paint = (r) => {
        rsInfo.className = `callout ${r.ok ? (r.modern ? 'ok' : 'warn') : 'bad'}`;
        rsInfo.textContent = r.ok
          ? `${r.path} · version ${r.version || '?'}${r.modern ? '' : ' · this is an old rsync (macOS ships 2.6.9). Install a current one with “brew install rsync” for resumable partial files, checksum choice and better progress.'}`
          : `rsync not found${r.error ? `: ${r.error}` : ''}. Sync needs it; everything else works without it.`;
      };
      paint(rs);
      const toggle = (key, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => DD.saveSettings({ [key]: e.target.checked }) }), label);
      const m = S.meta || {};
      this.el.replaceChildren(
        DD.pageHead('Settings'),
        h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))' } },
          DD.card('rsync', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('label', { class: 'field' }, h('span', { text: 'rsync binary' }), h('div', { class: 'row' }, rsPath,
              h('button', { class: 'btn', text: 'Save & test', onclick: async () => { const r = await DD.saveSettings({ rsyncPath: rsPath.value.trim() }); paint(r.rsync || (await deck.detectRsync())); } }),
              h('button', { class: 'btn ghost', text: 'Detect', onclick: async () => { S.rsync = await deck.detectRsync(); paint(S.rsync); } }))),
            rsInfo)),
          DD.card('Behaviour', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            toggle('notifications', 'Notify when a sync or job finishes'),
            toggle('preventSleep', 'Keep the Mac awake while a sync or job runs'),
            h('div', { class: 'row' }, h('span', { text: 'Theme' }), h('span', { class: 'spacer' }),
              h('div', { class: 'seg' }, ['system', 'light', 'dark'].map((t) => h('button', { class: st.theme === t ? 'on' : '', text: t === 'system' ? 'Auto' : t[0].toUpperCase() + t.slice(1), onclick: async () => { await DD.saveSettings({ theme: t }); this.show(); } })))))),
          DD.card('Data', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('p', { class: 'hint', text: 'The catalog only stores file metadata and checksums, never file contents. It lives in your user data folder and is readable only by you.' }),
            m.dbFile ? h('div', { class: 'cmd', text: m.dbFile }) : null,
            h('div', { class: 'row' },
              h('button', { class: 'btn', text: 'Clear sync history', onclick: async () => {
                if (!(await DD.confirm({ title: 'Clear sync history', body: [h('p', { text: 'Removes the list of past runs. Files are not touched.' })], okText: 'Clear' }))) return;
                S.history = await deck.clearHistory(); DD.toast('History cleared.');
              } })))),
          DD.card('About', h('table', { class: 'stat' }, h('tbody', {},
            [['App', `DataDeck ${m.version || ''}`], ['Engine', `SQLite ${m.sqlite || ''} · Node ${m.node || ''}`], ['Sources', DD.fmtNum(S.sources.length)], ['Sync profiles', DD.fmtNum(S.profiles.length)]]
              .map(([k, v]) => h('tr', {}, h('td', { class: 'key', text: k }), h('td', { class: 'n', text: v }))))), { flush: true })));
    },
  };
})();
