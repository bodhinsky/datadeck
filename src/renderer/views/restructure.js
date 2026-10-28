'use strict';
/* global DD, deck */
// Layout: design a folder structure for a selection and stage it as a change.
// Also shows export plans: every single operation, run, and undo.
(function () {
  const { h, $ } = DD;
  const S = DD.state;
  let el;
  const R = (S.restructure = {
    filter: {}, targetFs: 'apfs', template: '{category}/{yyyy}/{name}', planId: null, opsFilter: '',
  });

  const view = DD.views.restructure = {
    init() {
      el = $('page-restructure');
      DD.bus.addEventListener('job-done', (e) => {
        if (S.page === 'restructure' && R.planId && e.detail.planId === R.planId) showPlan();
      });
      DD.bus.addEventListener('source', () => { R.planId = null; });
      DD.bus.addEventListener('job', (e) => {
        const j = e.detail;
        if (j.status !== 'running' || j.planId !== R.planId || liveTimer) return;
        liveTimer = setTimeout(() => { liveTimer = null; liveRefresh(); }, Math.max(0, 1000 - (Date.now() - lastLive)));
      });
    },
    show(params = {}) {
      if (!DD.source()) { DD.go('overview'); return; }
      if (params.filter) { R.filter = { ...params.filter }; R.planId = null; }
      if (params.template) R.template = params.template;
      if (params.planId) R.planId = params.planId;
      if (R.planId) showPlan(); else showForm();
    },
  };

  const filterFull = () => ({ ...R.filter, sourceId: S.sourceId });

  // ── Step 1: the form ──
  async function showForm() {
    const src = DD.source();
    const totals = (await DD.call('entries.query', { filter: { ...filterFull(), kinds: ['file'] }, limit: 1 })).totals;
    const tplInput = h('input', { class: 'input mono', value: R.template, spellcheck: 'false', oninput: (e) => { R.template = e.target.value; preview(); } });
    const previewBox = h('div', { class: 'preview-list' });
    const previewErr = h('div', { class: 'hint' });


    async function preview() {
      const r = await DD.call('template.preview', { filter: filterFull(), template: R.template, targetFs: R.targetFs, limit: 8 }, { quiet: true }).catch((e) => ({ errors: [e.message], rows: [] }));
      tplInput.classList.toggle('bad', r.errors.length > 0);
      previewErr.textContent = r.errors.join(' ');
      previewBox.replaceChildren(...r.rows.map((x) => h('div', {}, h('span', { text: x.from, title: x.from }), h('span', { class: 'arrow', text: '→' }), h('span', { text: x.to, title: x.to }))));
      previewBox.hidden = !r.rows.length;
    }

    const presets = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, S.meta.presets.map((p) => h('button', { class: `chip${p.template === R.template ? ' on' : ''}`, text: p.label, title: p.template, onclick: (e) => {
      R.template = p.template;
      tplInput.value = p.template;
      presets.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.target));
      preview();
    } })));
    const tokens = h('div', { class: 'tokens' }, Object.entries(S.meta.tokens).map(([k, d]) => h('button', { text: `{${k}}`, title: d, onclick: () => {
      const pos = tplInput.selectionStart ?? tplInput.value.length;
      tplInput.value = `${tplInput.value.slice(0, pos)}{${k}}${tplInput.value.slice(tplInput.selectionEnd ?? pos)}`;
      R.template = tplInput.value;
      tplInput.focus();
      preview();
    } })));

    const stageBtn = h('button', { class: 'btn primary', id: 'btnStageLayout', text: 'Stage this layout', onclick: async () => {
      stageBtn.disabled = true;
      try {
        await DD.stage('layout', { filter: { ...R.filter, kinds: ['file'] } }, { template: R.template, targetFs: R.targetFs });
        DD.go('changes', { tab: 'staged' });
      } finally { stageBtn.disabled = false; }
    } });
    const fsSelect = h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { R.targetFs = e.target.value; preview(); } },
      Object.entries(S.meta.targets).map(([k, l]) => h('option', { value: k, text: l, selected: R.targetFs === k })));

    el.replaceChildren(
      DD.pageHead('Layout', 'Design a new folder structure for a selection. Staging it records the decision only; review and export happen under Changes.', []),
      DD.card('1 · Which files', h('div', {},
        h('p', { style: { margin: '0 0 6px' } }, h('b', { text: DD.describeFilter(R.filter) })),
        h('p', { class: 'hint', style: { margin: '0 0 10px' }, text: `${DD.fmtNum(totals.count)} files · ${DD.fmtBytes(totals.bytes)} from ${src.label}` }),
        h('div', { class: 'row' },
          h('button', { class: 'btn', text: 'Refine in Explorer', onclick: () => DD.go('explorer', { filter: R.filter }) }),
          h('button', { class: 'btn ghost', text: 'Use all files', onclick: () => { R.filter = {}; showForm(); } })))),
      h('div', { style: { height: '16px' } }),
      DD.card('2 · New structure', h('div', {},
        presets,
        h('label', { class: 'field', style: { marginTop: '12px' } }, h('span', { text: 'Path template' }), tplInput),
        previewErr, tokens,
        h('div', { class: 'row', style: { margin: '10px 0 6px' } }, h('span', { class: 'hint', text: 'Clean names for' }), fsSelect),
        previewBox,
        h('p', { class: 'hint', style: { margin: '10px 0 0' }, text: 'Layouts stack with other changes: you can still exclude, rename or move single files afterwards. Collisions are shown under Changes before anything can be exported.' })),
        { hint: 'live preview of the first files' }),
      h('div', { class: 'row', style: { marginTop: '16px', justifyContent: 'flex-end' } }, stageBtn));
    preview();
  }
  function showFormKeep() { showForm(); }

  // ── Step 2: the plan ──
  async function showPlan() {
    const plan = await DD.call('plan.get', { planId: R.planId });
    if (!plan) { R.planId = null; showForm(); return; }
    const s = plan.summary;
    const ops = await DD.call('plan.ops', { planId: R.planId, limit: 1 });
    const by = Object.fromEntries(ops.byStatus.map((b) => [b.status, b]));
    const n = (k) => (by[k] ? by[k].n : 0);
    const running = plan.status === 'running';
    const finished = ['done', 'done-with-errors', 'undone', 'undo-partial'].includes(plan.status);
    const runnable = ['draft', 'cancelled', 'done-with-errors', 'interrupted', 'failed'].includes(plan.status) && (n('pending') + n('failed')) > 0;

    const actions = [
      h('button', { class: 'btn ghost', text: '← Changes', onclick: () => { R.planId = null; DD.go('changes', { tab: 'export' }); } }),
      h('button', { class: 'btn', text: 'Export plan CSV…', onclick: async () => {
        const file = await deck.saveFile({ title: 'Export plan', defaultPath: `plan-${plan.id}.csv` });
        if (file) { const r = await DD.call('export.csv', { file, planId: plan.id }); DD.toast(`Exported ${r.rows} operations`); }
      } }),
      finished && plan.status !== 'undone' && n('done') ? h('button', { class: 'btn', text: 'Undo…', onclick: () => undo(plan) }) : null,
      runnable ? h('button', { class: `btn ${plan.spec.mode === 'move' ? 'danger' : 'primary'}`, text: plan.status === 'draft' ? `Run plan (${plan.spec.mode})` : 'Resume / retry', onclick: () => execute(plan, n) }) : null,
    ];

    const statusTag = h('span', { class: `tag ${plan.status === 'done' ? 'ok' : plan.status === 'draft' ? 'info' : plan.status.includes('error') || plan.status === 'invalid' || plan.status === 'interrupted' ? 'bad' : 'warn'}`, text: plan.status });
    const kpis = makeKpis(plan, n);
    const notes = [];
    for (const e of s.errors || []) notes.push(h('div', { class: 'callout bad', text: e }));
    for (const w of s.warnings || []) notes.push(h('div', { class: 'callout warn', text: w }));
    if (plan.status === 'interrupted') notes.push(h('div', { class: 'callout bad', text: 'This plan was interrupted (app closed or crashed). Resume it: half-finished files are checked and cleaned up first.' }));
    if (plan.status === 'done') notes.push(h('div', { class: 'callout ok', text: `Finished. Every file was verified by SHA-256${plan.spec.mode === 'move' ? ' before its original was removed' : ''}.` }));

    const opsSeg = h('div', { class: 'seg' }, [['', 'All'], ['pending', 'Pending'], ['done', 'Done'], ['skipped', 'Skipped'], ['failed', 'Failed'], ['notes', 'With notes']].map(([v, l]) => h('button', { text: l, class: R.opsFilter === v ? 'on' : '', onclick: () => { R.opsFilter = v; showPlan(); } })));
    const root = s.root || plan.spec.targetRoot;
    const rel = (p) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
    const srcRoot = DD.source() ? DD.source().path : '';
    const relSrc = (p) => (p.startsWith(`${srcRoot}/`) ? p.slice(srcRoot.length + 1) : p);
    const table = new DD.VirtualTable({
      round: true,
      emptyText: 'No operations in this view.',
      columns: [
        { label: '#', width: '56px', mono: true, cls: 'dim', render: (r) => r.seq + 1 },
        { label: 'From (source)', width: 'minmax(160px, 2fr)', render: (r) => relSrc(r.src), titleOf: (r) => r.src },
        { label: 'To (target)', width: 'minmax(160px, 2fr)', render: (r) => rel(r.dst), titleOf: (r) => r.dst },
        { label: 'Size', width: '84px', align: 'right', mono: true, render: (r) => DD.fmtBytes(r.size) },
        { label: 'Status', width: '86px', render: (r) => h('span', { class: `tag ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'bad' : r.status === 'skipped' ? 'warn' : r.status === 'undone' ? 'info' : ''}`, text: r.status }) },
        { label: 'Note', width: 'minmax(120px, 1.4fr)', cls: 'dim', render: (r) => r.error || r.note || '', titleOf: (r) => r.error || r.note || '' },
      ],
      fetch: async (offset, limit) => {
        const r = await DD.call('plan.ops', { planId: R.planId, status: R.opsFilter || undefined, offset, limit });
        return { rows: r.rows, total: r.total };
      },
    });
    el.replaceChildren(
      DD.pageHead(`${plan.spec.fromWorkspace ? 'Export plan' : 'Plan'} #${plan.id}`, `${plan.spec.mode === 'move' ? 'Move' : 'Copy'} ${DD.describeFilter(plan.spec.filter || {})} → ${root} · template ${plan.spec.template}`, actions),
      h('div', { class: 'row', style: { marginBottom: '10px' } }, statusTag, running ? h('span', { class: 'hint', text: 'Running — progress is shown at the top.' }) : null),
      kpis, ...notes,
      h('div', { class: 'row', style: { margin: '6px 0 10px' } }, h('span', { class: 'hint', text: 'Operations' }), opsSeg),
      h('div', { style: { height: '52vh', display: 'flex' } }, table.el));
    table.reload();
    R.live = { plan, kpis, table };
  }

  // While a plan runs, refresh its numbers and journal about once a second.
  let lastLive = 0;
  let liveTimer = null;
  async function liveRefresh() {
    lastLive = Date.now();
    const L = R.live;
    if (S.page !== 'restructure' || !L || L.plan.id !== R.planId || !L.kpis.isConnected) return;
    const ops = await DD.call('plan.ops', { planId: R.planId, limit: 1 }, { quiet: true }).catch(() => null);
    if (!ops || R.live !== L) return;
    const by = Object.fromEntries(ops.byStatus.map((b) => [b.status, b]));
    const fresh = makeKpis(L.plan, (k) => (by[k] ? by[k].n : 0));
    L.kpis.replaceWith(fresh);
    L.kpis = fresh;
    L.table.reload({ keepScroll: true });
  }

  function makeKpis(plan, n) {
    const s = plan.summary;
    return DD.kpis([
      { k: 'Files', v: DD.fmtNum(s.files), d: `${plan.spec.mode} · ${DD.fmtBytes(s.bytes)}` },
      { k: 'Space needed', v: DD.fmtBytes(s.needBytes), d: s.freeBytes != null ? `${DD.fmtBytes(s.freeBytes)} free on target` : 'free space unknown', tone: s.freeBytes != null && s.needBytes > s.freeBytes ? 'bad' : '' },
      { k: 'Done', v: DD.fmtNum(n('done')), tone: n('done') ? 'ok' : '', d: `${DD.fmtNum(n('pending'))} pending` },
      { k: 'Skipped', v: DD.fmtNum(n('skipped')), d: `${s.junk || 0} clutter · ${s.dedupe || 0} dupes · ${s.unchanged || 0} in place` },
      { k: 'Renamed', v: DD.fmtNum(s.renamed || 0), d: `${s.existing || 0} targets already existed` },
      { k: 'Failed', v: DD.fmtNum(n('failed')), tone: n('failed') ? 'bad' : '' },
    ]);
  }

  async function execute(plan, n) {
    const isMove = plan.spec.mode === 'move';
    const body = [
      h('p', {}, `${isMove ? 'Move' : 'Copy'} `, h('b', { text: `${DD.fmtNum(n('pending') + n('failed'))} files` }), ' to ', h('b', { text: plan.spec.targetRoot }), '.'),
      h('p', { class: 'hint', text: 'Each file is written under a temporary name, fsynced, read back and compared by SHA-256, then published without ever replacing an existing file. You can cancel at any time; the plan can be resumed or undone.' }),
    ];
    const ok = await DD.confirm({ title: isMove ? 'Run move plan' : 'Run copy plan', body, okText: isMove ? 'Move files' : 'Copy files', danger: isMove, ack: isMove ? 'I understand the originals are removed after each verified copy.' : null });
    if (!ok) return;
    await DD.call('plan.execute', { planId: plan.id });
    showPlan();
  }

  async function undo(plan) {
    const ok = await DD.confirm({
      title: `Undo plan #${plan.id}`,
      body: [h('p', { text: plan.spec.mode === 'move' ? 'Moves every file back to where it was, verifying each one. Files changed since the run are left alone.' : 'Deletes the copies this plan created, but only those that are still exactly as written. Your originals are not touched.' })],
      okText: 'Undo', danger: plan.spec.mode === 'copy',
    });
    if (!ok) return;
    await DD.call('plan.undo', { planId: plan.id });
  }
})();
