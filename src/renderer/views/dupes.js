'use strict';
/* global DD, deck */
// Duplicates: run the three-pass check, then review groups by wasted space.
(function () {
  const { h, $ } = DD;
  const S = DD.state;
  let el;
  let table;

  DD.views.dupes = {
    init() {
      el = $('page-dupes');
      DD.bus.addEventListener('job-done', (e) => { if (S.page === 'dupes' && e.detail.sourceId === S.sourceId) this.show(); });
    },
    async show() {
      const src = DD.source();
      if (!src) { DD.go('overview'); return; }
      const o = await DD.call('overview', { sourceId: src.id });
      const groups = o.dupes.groups ? await DD.call('dupes.groups', { sourceId: src.id, limit: 500 }) : [];
      render(src, o, groups);
    },
  };

  function render(src, o, groups) {
    const checked = o.dupes.hashedFiles > 0;
    const head = DD.pageHead('Duplicates', 'Byte-identical files: same size, same quick fingerprint, then confirmed with a full SHA-256.', [
      h('button', { class: `btn ${checked ? '' : 'primary'}`, text: checked ? 'Check again' : 'Find duplicates', onclick: () => DD.call('dupes.find', { sourceId: src.id }) }),
      checked && o.dupes.groups ? h('button', { class: 'btn', text: 'List all duplicates', onclick: () => DD.go('explorer', { filter: { dupes: true } }) }) : null,
      checked && o.dupes.groups ? h('button', { class: 'btn primary', text: 'Keep one of each…', title: 'Stage a change that excludes the extra copies from the export', onclick: async () => {
        const v = await DD.confirm({ title: 'Keep one copy of each duplicate', body: [h('p', { text: `Stage a change that leaves ${DD.fmtNum(o.dupes.extra)} extra copies out of the export (${DD.fmtBytes(o.dupes.wasted)}). Nothing is deleted; you review it under Changes.` }), h('p', { class: 'hint', text: 'Which copy stays: the oldest one (ties: the shortest path), or the one with the shortest path.' })], okText: 'Keep oldest', altText: 'Keep shortest path' });
        if (!v) return;
        await DD.stage('dedupe', { preset: 'all' }, { keep: v === 'alt' ? 'shortest' : 'oldest' });
        DD.go('changes', { tab: 'staged' });
      } }) : null,
    ]);
    if (!checked) {
      el.replaceChildren(head, DD.emptyState('Not checked yet', 'The check only reads files that share a size with another file, and only fully hashes those whose first and last 64 KB also match. Nothing is changed.', null));
      return;
    }
    const linked = groups.filter((g) => new Set(g.members.map((m) => m.ino)).size === 1).length;
    const kpis = DD.kpis([
      { k: 'Duplicate groups', v: DD.fmtNum(o.dupes.groups) },
      { k: 'Extra copies', v: DD.fmtNum(o.dupes.extra) },
      { k: 'Reclaimable', v: DD.fmtBytes(o.dupes.wasted), tone: o.dupes.wasted ? 'warn' : 'ok', d: `${DD.pct(o.dupes.wasted, src.bytes)} of this source` },
      { k: 'Files hashed', v: DD.fmtNum(o.dupes.hashedFiles) },
      linked ? { k: 'Hard-linked groups', v: DD.fmtNum(linked), d: 'already share storage' } : null,
    ]);
    const rows = [];
    groups.forEach((g, gi) => {
      g.members.forEach((m, mi) => rows.push({ g, gi, m, mi }));
    });
    table = new DD.VirtualTable({
      round: true,
      emptyText: 'No duplicates. Every file is unique.',
      columns: [
        { label: 'Group', width: '64px', mono: true, render: (r) => (r.mi === 0 ? `#${r.gi + 1}` : '') },
        { label: 'File', width: 'minmax(200px, 3fr)', render: (r) => h('span', {}, r.mi === 0 ? h('span', { class: 'tag ok', text: 'oldest' }) : null, ' ', r.m.rel_path), titleOf: (r) => r.m.rel_path },
        { label: 'Modified', width: '100px', mono: true, render: (r) => DD.fmtDate(r.m.mtime) },
        { label: 'Size', width: '90px', align: 'right', mono: true, render: (r) => DD.fmtBytes(r.g.size) },
        { label: 'Copies', width: '64px', align: 'right', mono: true, render: (r) => (r.mi === 0 ? r.g.n : '') },
        { label: 'Wasted', width: '90px', align: 'right', mono: true, render: (r) => (r.mi === 0 ? DD.fmtBytes(r.g.wasted) : '') },
        { label: 'SHA-256', width: '110px', mono: true, cls: 'dim', render: (r) => (r.mi === 0 ? r.g.hash.slice(0, 12) : '') },
      ],
      fetch: async (offset, limit) => ({ rows: rows.slice(offset, offset + limit), total: rows.length }),
      onRowClick: (r) => deck.showItem(`${src.path}/${r.m.rel_path}`),
    });
    const wrap = h('div', { style: { height: '60vh', display: 'flex' } }, table.el);
    el.replaceChildren(head, kpis,
      h('div', { class: 'callout' }, h('span', { class: 'grow', text: 'DataDeck never deletes duplicates on its own. Use “Keep one of each” to stage leaving the extra copies out of an export, or click a row to show the file in Finder.' })),
      wrap);
    table.reload();
  }
})();
