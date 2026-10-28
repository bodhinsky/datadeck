'use strict';
/* global DD, deck */
// Changes: the review-first pipeline. Decisions made anywhere in the app are
// staged here, committed with a message, reviewed commit by commit against a
// before/after table, and only then exported after a final validation.
(function () {
  const { h, $ } = DD;
  const S = DD.state;
  let el;
  const C = (S.changes = { tab: 'staged', kind: 'changed', search: '', reviewing: null, targetRoot: '', mode: 'copy' });

  DD.views.changes = {
    init() {
      el = $('page-changes');
      DD.bus.addEventListener('ws', () => { if (S.page === 'changes') render(); });
      DD.bus.addEventListener('job-done', (e) => { if (S.page === 'changes' && e.detail.sourceId === S.sourceId) render(); });
      DD.bus.addEventListener('source', () => { C.reviewing = null; });
    },
    show(params = {}) {
      if (!DD.source()) { DD.go('overview'); return; }
      if (params.tab) C.tab = params.tab;
      if (params.review) { C.reviewing = params.review; C.tab = 'review'; }
      render();
    },
  };

  const TABS = [['staged', 'Staged'], ['commits', 'Commits'], ['review', 'Review diff'], ['folders', 'Planned folders'], ['export', 'Validate & export']];

  async function render() {
    const data = await DD.call('ws.list', { sourceId: S.sourceId });
    const w = data.summary;
    DD.setWs(w);
    const problems = w.conflicts + w.clashes + w.stale;
    const head = DD.pageHead('Changes', 'Every decision is recorded here first. Nothing is written to disk until you export a reviewed, validated state.', [
      h('label', { class: 'row hint' }, 'Target file system',
        h('select', { class: 'input', style: { width: 'auto' }, onchange: async (e) => { DD.setWs(await DD.call('ws.target', { sourceId: S.sourceId, targetFs: e.target.value })); render(); } },
          Object.entries(S.meta.targets).map(([k, l]) => h('option', { value: k, text: l, selected: w.targetFs === k })))),
    ]);
    const kpis = DD.kpis([
      { k: 'Planned files', v: DD.fmtNum(w.files), d: DD.fmtBytes(w.bytes) },
      { k: 'Moved', v: DD.fmtNum(w.moved), d: 'to another folder', tone: w.moved ? 'ok' : '' },
      { k: 'Renamed', v: DD.fmtNum(w.renamed), d: 'new file name' },
      { k: 'Excluded', v: DD.fmtNum(w.excludedFiles), d: DD.fmtBytes(w.excludedBytes) },
      { k: 'Problems', v: DD.fmtNum(problems), d: `${w.conflicts + w.clashes} collisions · ${w.stale} changed on disk`, tone: problems ? 'bad' : 'ok' },
      { k: 'Names to clean', v: DD.fmtNum(w.badNames), d: 'for the target', tone: w.badNames ? 'warn' : '' },
      { k: 'Staged', v: DD.fmtNum(w.staged), d: 'not committed', tone: w.staged ? 'warn' : '' },
      { k: 'To review', v: DD.fmtNum(w.unreviewed), d: `of ${w.commits} commits`, tone: w.unreviewed ? 'warn' : '' },
    ]);
    const counts = { staged: data.staged.length, commits: data.commits.length };
    const tabs = h('div', { class: 'tabs' }, TABS.map(([k, l]) => h('button', { 'data-tab': k, class: C.tab === k ? 'on' : '', onclick: () => { C.tab = k; if (k !== 'review') C.reviewing = null; render(); } },
      l, counts[k] !== undefined ? h('span', { class: 'mono hint', text: ` ${counts[k]}` }) : null)));
    const pane = h('div');
    el.replaceChildren(head, kpis, tabs, pane);
    if (C.tab === 'staged') staged(pane, data);
    else if (C.tab === 'commits') commits(pane, data);
    else if (C.tab === 'review') review(pane, data);
    else if (C.tab === 'folders') folders(pane);
    else exportPane(pane, data);
  }

  // ── Staged ──
  function staged(pane, data) {
    if (!data.staged.length) {
      pane.append(DD.emptyState('Nothing staged', 'Select files in the Explorer and choose Exclude, Move, Rename or Fix names, or stage a folder layout. Each decision appears here.',
        h('button', { class: 'btn primary', text: 'Open Explorer', onclick: () => DD.go('explorer') })));
      return;
    }
    const msg = h('input', { class: 'input', id: 'commitMsg', placeholder: 'Describe these changes, e.g. “Sort holiday photos by year”', maxlength: 500 });
    const commitBtn = h('button', { class: 'btn primary', text: `Commit ${data.staged.length} change${data.staged.length === 1 ? '' : 's'}`, onclick: async () => {
      const r = await DD.call('ws.commit', { sourceId: S.sourceId, message: msg.value });
      DD.setWs(r.summary);
      DD.toast('Committed. Review it before exporting.');
      C.tab = 'review';
      C.reviewing = r.commitId;
      render();
    } });
    msg.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitBtn.click(); });
    pane.append(
      DD.card('Staged changes', changeTable(data.staged, true), { flush: true, hint: 'applied in this order' }),
      h('div', { class: 'row', style: { marginTop: '12px' } }, msg, commitBtn,
        h('button', { class: 'btn ghost', text: 'Preview diff', onclick: () => { C.tab = 'review'; C.reviewing = null; render(); } }),
        h('button', { class: 'btn ghost', style: { color: 'var(--danger)' }, text: 'Discard all', onclick: async () => {
          if (!(await DD.confirm({ title: 'Discard staged changes', body: [h('p', { text: `Forget ${data.staged.length} staged decision(s)? Files are not affected either way.` })], okText: 'Discard', danger: true }))) return;
          DD.setWs(await DD.call('ws.discard', { sourceId: S.sourceId }));
          DD.bus.dispatchEvent(new CustomEvent('ws'));
        } })));
  }

  function changeTable(list, removable) {
    return h('table', { class: 'stat' },
      h('thead', {}, h('tr', {}, ['#', 'Change', 'Selected', 'Affected', 'Missing', 'When', ''].map((t, i) => h('th', { class: i >= 2 && i <= 4 ? 'r' : '', text: t })))),
      h('tbody', {}, list.map((c) => h('tr', {},
        h('td', { class: 'n', text: String(c.seq) }),
        h('td', { text: c.label, title: c.label }),
        h('td', { class: 'r n', text: DD.fmtNum(c.items) }),
        h('td', { class: 'r n', text: DD.fmtNum(c.affected), title: 'entries whose planned path or inclusion this change altered' }),
        h('td', { class: 'r n', text: c.missing ? DD.fmtNum(c.missing) : '–', title: 'selected paths that no longer exist in the catalog' }),
        h('td', { class: 'n', text: DD.fmtDateTime(c.created_at) }),
        h('td', { class: 'r' },
          h('button', { class: 'btn small ghost', text: 'Diff', onclick: () => { C.tab = 'review'; C.reviewing = null; C.changeId = c.id; render(); } }),
          removable ? h('button', { class: 'btn small ghost', text: 'Remove', onclick: async () => {
            DD.setWs(await DD.call('ws.unstage', { sourceId: S.sourceId, changeId: c.id }));
            DD.bus.dispatchEvent(new CustomEvent('ws'));
          } }) : null)))));
  }

  // ── Commits ──
  const STATUS = { committed: ['to review', 'warn'], reviewed: ['reviewed', 'ok'], exported: ['exported', 'info'], applied: ['applied', ''] };
  function commits(pane, data) {
    if (!data.commits.length) { pane.append(DD.emptyState('No commits yet', 'Commit staged changes to group them for review.')); return; }
    pane.append(DD.card('Commits', h('table', { class: 'stat' },
      h('thead', {}, h('tr', {}, ['#', 'Message', 'Created', 'Changes', 'Affected', 'Status', ''].map((t, i) => h('th', { class: i === 3 || i === 4 ? 'r' : '', text: t })))),
      h('tbody', {}, data.commits.map((k) => h('tr', {},
        h('td', { class: 'n', text: `#${k.id}` }),
        h('td', { text: k.message, title: k.message }),
        h('td', { class: 'n', text: DD.fmtDateTime(k.created_at) }),
        h('td', { class: 'r n', text: DD.fmtNum(k.changes) }),
        h('td', { class: 'r n', text: DD.fmtNum(k.affected) }),
        h('td', {}, h('span', { class: `tag ${STATUS[k.status][1]}`, text: STATUS[k.status][0] }), k.plan_id ? h('span', { class: 'hint', text: ` plan #${k.plan_id}` }) : null),
        h('td', { class: 'r' },
          h('button', { class: `btn small ${k.status === 'committed' ? 'primary' : 'ghost'}`, text: k.status === 'committed' ? 'Review' : 'Show', onclick: () => { C.tab = 'review'; C.reviewing = k.id; C.changeId = null; render(); } }),
          k.status !== 'applied' ? h('button', { class: 'btn small ghost', text: 'Revert', onclick: () => revert(k) }) : null))))), { flush: true }),
      h('p', { class: 'hint', text: 'Reverting forgets a commit’s decisions. Files on disk are never touched by commits; only an export writes files.' }));
  }

  async function revert(k) {
    if (!(await DD.confirm({ title: `Revert commit #${k.id}`, body: [h('p', { text: `Forget “${k.message}” and its ${k.changes} change(s)? Later changes are re-applied on top of what remains.` })], okText: 'Revert', danger: true }))) return;
    DD.setWs(await DD.call('ws.revert', { sourceId: S.sourceId, commitId: k.id }));
    DD.bus.dispatchEvent(new CustomEvent('ws'));
  }

  // ── Review diff ──
  const KINDS = [['changed', 'Changed'], ['moved', 'Moved / renamed'], ['excluded', 'Excluded'], ['problems', 'Problems'], ['kept', 'Everything kept']];
  function review(pane, data) {
    const k = C.reviewing ? data.commits.find((x) => x.id === C.reviewing) : null;
    const ch = !k && C.changeId ? data.changes.find((x) => x.id === C.changeId) : null;
    if (!k && C.reviewing) C.reviewing = null;
    const scope = k ? { commitId: k.id } : ch ? { changeId: ch.id } : {};
    const seg = h('div', { class: 'seg' }, KINDS.map(([v, l]) => h('button', { 'data-kind': v, class: C.kind === v ? 'on' : '', text: l, onclick: () => { C.kind = v; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.kind === v)); table.reload(); } })));
    const search = h('input', { class: 'input', placeholder: 'Search before or after path…', value: C.search, style: { maxWidth: '280px' }, oninput: DD.debounce((e) => { C.search = e.target.value.trim(); table.reload(); }, 250) });
    const foot = h('div', { class: 'statusline' });
    const table = new DD.VirtualTable({
      round: false,
      sort: 'after',
      emptyText: 'No files in this view.',
      rowClass: (r) => DD.stateClass(r.flags),
      columns: [
        { label: 'State', width: '170px', render: (r) => DD.stateChips(r.flags) },
        { label: 'Before', sort: 'before', width: 'minmax(140px, 1fr)', render: (r) => r.rel_path, titleOf: (r) => r.rel_path },
        { label: '', width: '18px', cls: 'diffarrow', render: () => '→' },
        { label: 'After', sort: 'after', width: 'minmax(140px, 1fr)', render: (r) => (r.flags & DD.VF.EXCLUDED ? h('span', { class: 'dim', text: 'not exported' }) : r.vpath === r.rel_path ? h('span', { class: 'dim', text: 'unchanged' }) : h('span', { class: 'after', text: r.vpath })), titleOf: (r) => r.vpath },
        { label: 'Size', sort: 'size', width: '84px', align: 'right', mono: true, render: (r) => DD.fmtBytes(r.size) },
        { label: 'Decided by', width: 'minmax(100px, .8fr)', cls: 'dim', render: (r) => r.change_label || '', titleOf: (r) => r.change_label || '' },
      ],
      fetch: async (offset, limit, sort, dir) => {
        const r = await DD.call('ws.diff', { sourceId: S.sourceId, kind: C.kind, search: C.search || undefined, ...scope, sort, dir, offset, limit });
        if (offset === 0) foot.replaceChildren(h('span', {}, h('b', { text: DD.fmtNum(r.total) }), ' files'), h('span', {}, h('b', { text: DD.fmtBytes(r.bytes) })), h('span', { class: 'spacer' }),
          h('span', { class: 'hint', text: 'Blue edge: moved or renamed · grey: excluded · red: needs attention' }));
        return { rows: r.rows, total: r.total };
      },
    });
    let banner = null;
    if (k) {
      const done = k.status !== 'committed';
      const ack = h('input', { type: 'checkbox', id: 'reviewAck' });
      const btn = h('button', { class: 'btn primary', id: 'btnMarkReviewed', text: 'Mark as reviewed', disabled: true, onclick: async () => {
        DD.setWs(await DD.call('ws.review', { sourceId: S.sourceId, commitId: k.id }));
        DD.toast(`Commit #${k.id} reviewed.`);
        const next = data.commits.find((x) => x.status === 'committed' && x.id !== k.id);
        C.reviewing = next ? next.id : null;
        if (!next) C.tab = 'export';
        render();
      } });
      ack.addEventListener('change', () => { btn.disabled = !ack.checked; });
      banner = h('div', { class: `reviewbar${done ? ' ok' : ''}` },
        h('div', { style: { flex: '1', minWidth: '240px' } }, h('b', { text: `Commit #${k.id}: ${k.message}` }),
          h('div', { class: 'hint', text: `${k.changes} change(s) · ${DD.fmtNum(k.affected)} entries affected${k.missing ? ` · ${k.missing} selected paths no longer exist` : ''}. The table lists what this commit selected, with each file’s final planned path.` })),
        done ? h('span', { class: 'tag ok', text: STATUS[k.status][0] })
          : h('label', { class: 'chk' }, ack, 'I checked these changes'),
        done ? (k.status === 'reviewed' ? h('button', { class: 'btn ghost', text: 'Mark unreviewed', onclick: async () => { DD.setWs(await DD.call('ws.review', { sourceId: S.sourceId, commitId: k.id, reviewed: false })); render(); } }) : null) : btn,
        h('button', { class: 'btn ghost', text: 'Whole diff', onclick: () => { C.reviewing = null; C.changeId = null; render(); } }));
    } else if (ch) {
      banner = h('div', { class: 'reviewbar ok' }, h('span', { class: 'grow', text: `Showing what “${ch.label}” selected.` }), h('button', { class: 'btn ghost', text: 'Whole diff', onclick: () => { C.changeId = null; render(); } }));
    } else {
      const todo = data.commits.filter((x) => x.status === 'committed');
      if (todo.length) banner = h('div', { class: 'reviewbar' }, h('span', { style: { flex: '1' }, text: `${todo.length} commit(s) still need a review.` }), h('button', { class: 'btn primary', text: `Review #${todo[todo.length - 1].id}`, onclick: () => { C.reviewing = todo[todo.length - 1].id; render(); } }));
    }
    pane.append(banner || h('span'), h('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } }, seg, search),
      h('div', { style: { height: '52vh', display: 'flex', flexDirection: 'column' } }, table.el, foot));
    table.reload();
  }

  // ── Planned folders ──
  async function folders(pane) {
    const depth = C.depth || 1;
    const seg = h('div', { class: 'seg' }, [1, 2, 3].map((d) => h('button', { class: depth === d ? 'on' : '', text: `${d} level${d > 1 ? 's' : ''}`, onclick: () => { C.depth = d; render(); } })));
    const rows = await DD.call('ws.folders', { sourceId: S.sourceId, depth });
    pane.append(h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'hint', text: 'What the exported structure will contain' }), h('span', { class: 'spacer' }), seg),
      DD.card('Planned structure', rows.length ? DD.statTable({ rows, keyLabel: 'Folder' }) : h('div', { class: 'card-b hint', text: 'No files in the planned state.' }), { flush: true }));
  }

  // ── Validate & export ──
  async function exportPane(pane, data) {
    const chk = await DD.call('ws.check', { sourceId: S.sourceId });
    const w = chk.summary;
    const src = DD.source();
    const list = h('div', { class: 'checklist', id: 'exportChecks' }, chk.items.map((i) => h('div', { class: `ci ${i.ok ? 'ok' : 'no'}`, 'data-check': i.key },
      h('span', { class: 'mark', text: i.ok ? '✓' : '!' }),
      h('div', {}, h('div', { text: i.label }), i.ok ? null : h('div', { class: 'fix', text: i.fix })),
      fixButton(i, data))));
    const target = h('input', { class: 'input mono', id: 'exportTarget', value: C.targetRoot, placeholder: '/Volumes/Archive/Clean', spellcheck: 'false', oninput: (e) => { C.targetRoot = e.target.value.trim(); upd(); } });
    const modeSeg = h('div', { class: 'seg' }, [['copy', 'Copy to a new location'], ['move', 'Move in place']].map(([v, l]) => h('button', { 'data-mode': v, class: C.mode === v ? 'on' : '', text: l, onclick: () => {
      C.mode = v;
      if (v === 'move') { C.targetRoot = src.path; target.value = src.path; }
      modeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === v));
      upd();
    } })));
    const ack = h('input', { type: 'checkbox', id: 'finalAck' });
    const build = h('button', { class: 'btn primary', id: 'btnBuildExport', text: 'Build export plan', onclick: async () => {
      build.disabled = true;
      try {
        const r = await DD.call('ws.export', { sourceId: S.sourceId, targetRoot: C.targetRoot, mode: C.mode, conflict: 'skip', finalReview: ack.checked });
        if (!r.planId) { DD.toast(r.errors.join(' '), true); return; }
        DD.go('restructure', { planId: r.planId });
      } finally { upd(); }
    } });
    const moveNote = h('div', { class: 'callout warn', text: 'Move in place rearranges the original files. Each move is a rename on the same disk, journaled and undoable. Prefer copying to a new location unless you are sure.' });
    function upd() {
      build.disabled = !(chk.ok && ack.checked && C.targetRoot);
      moveNote.hidden = C.mode !== 'move';
    }
    ack.addEventListener('change', upd);
    upd();
    pane.append(
      h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))' } },
        DD.card('Validation', list, { flush: true, hint: chk.ok ? 'all checks pass' : 'fix the red items first' }),
        DD.card('Export', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          h('label', { class: 'field' }, h('span', { text: 'Target folder' }), h('div', { class: 'row' }, target,
            h('button', { class: 'btn', text: 'Browse…', onclick: async () => { const d = await deck.pickFolder({ title: 'Choose export folder' }); if (d) { C.targetRoot = d; target.value = d; upd(); } } }))),
          modeSeg, moveNote,
          ...chk.warnings.map((x) => h('div', { class: 'callout warn', text: x })),
          h('label', { class: 'chk' }, ack, `I reviewed the final state: ${DD.fmtNum(w.files)} files (${DD.fmtBytes(w.bytes)}), ${DD.fmtNum(w.moved + w.renamed)} moved or renamed, ${DD.fmtNum(w.excludedFiles)} excluded.`),
          h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn ghost', text: 'See the full diff', onclick: () => { C.tab = 'review'; C.reviewing = null; C.changeId = null; render(); } }), build),
          h('p', { class: 'hint', text: 'Building the plan writes nothing. You will see every file operation, then run it. Each file is copied, read back and compared by SHA-256; existing files are never overwritten.' })))));
  }

  function fixButton(i, data) {
    if (i.ok) return null;
    if (i.key === 'checked' || i.key === 'stale') {
      return h('span', { class: 'row', style: { gap: '6px' } },
        i.key === 'stale' ? h('button', { class: 'btn small', text: 'Stage: exclude changed files', onclick: async () => { await DD.stage('exclude', { preset: 'stale' }); C.tab = 'staged'; render(); } }) : null,
        h('button', { class: `btn small ${i.key === 'checked' ? 'primary' : ''}`, id: i.key === 'checked' ? 'btnRecheck' : null, text: 'Re-check sources', onclick: () => DD.call('ws.verify', { sourceId: S.sourceId }) }));
    }
    if (i.key === 'staged') return h('button', { class: 'btn small', text: 'Go to staged', onclick: () => { C.tab = 'staged'; render(); } });
    if (i.key === 'reviewed') {
      const k = data.commits.filter((x) => x.status === 'committed').pop();
      return k ? h('button', { class: 'btn small', text: `Review #${k.id}`, onclick: () => { C.tab = 'review'; C.reviewing = k.id; render(); } }) : null;
    }
    if (i.key === 'conflicts') return h('button', { class: 'btn small', text: 'Show collisions', onclick: () => { C.tab = 'review'; C.reviewing = null; C.changeId = null; C.kind = 'problems'; render(); } });
    return null;
  }
})();
