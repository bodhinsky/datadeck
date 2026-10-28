'use strict';
/* global DD */
// Issues: what will break when this data moves to another system.
(function () {
  const { h, $ } = DD;
  const S = DD.state;
  let el;
  let current = null;
  let table;

  DD.views.issues = {
    init() { el = $('page-issues'); },
    async show(params = {}) {
      const src = DD.source();
      if (!src) { DD.go('overview'); return; }
      if (params.code) current = params.code;
      const o = await DD.call('overview', { sourceId: src.id });
      if (!current || !o.issues.some((i) => i.key === current)) current = o.issues.length ? o.issues[0].key : null;
      render(o);
    },
  };

  function render(o) {
    const head = DD.pageHead('Issues', 'Names, paths and files that cause trouble on Windows, USB drives, Linux, or when copied. Restructuring can fix most of them automatically.', [
      h('button', { class: 'btn', text: 'Stage name fixes', title: 'Record cleaned names for the target file system; review them under Changes', onclick: async () => {
        await DD.stage('sanitize', { filter: { anyIssue: true } }, { targetFs: (S.ws && S.ws.targetFs) || 'exfat' });
        DD.go('changes', { tab: 'staged' });
      } }),
    ]);
    if (!o.issues.length) { el.replaceChildren(head, DD.emptyState('No issues', 'Every name and path here works on macOS, Windows, Linux and USB drives.')); return; }
    const list = h('table', { class: 'stat' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Issue' }), h('th', { text: 'Level' }), h('th', { class: 'r', text: 'Items' }))),
      h('tbody', {}, o.issues.map((i) => h('tr', { class: 'click', style: i.key === current ? { background: 'var(--sel)' } : {}, onclick: () => { current = i.key; render(o); } },
        h('td', { class: 'key', text: i.label, title: i.hint }),
        h('td', {}, h('span', { class: `tag ${i.severity === 'error' ? 'bad' : i.severity}`, text: i.severity })),
        h('td', { class: 'r n', text: DD.fmtNum(i.count) })))));
    const info = S.meta.issues[current] || {};
    table = new DD.VirtualTable({
      sort: 'path',
      emptyText: 'Nothing here.',
      columns: [
        { label: 'Path', sort: 'path', width: 'minmax(240px, 3fr)', render: (r) => r.rel_path, titleOf: (r) => r.rel_path },
        { label: 'Kind', width: '70px', render: (r) => r.kind },
        { label: 'Size', sort: 'size', width: '90px', align: 'right', mono: true, render: (r) => (r.kind === 'file' ? DD.fmtBytes(r.size) : '') },
        { label: 'Modified', sort: 'mtime', width: '100px', mono: true, render: (r) => DD.fmtDate(r.mtime) },
        { label: 'Detail', width: 'minmax(120px, 1fr)', cls: 'dim', render: (r) => r.error || r.link_target || '' },
      ],
      fetch: async (offset, limit, sort, dir) => {
        const r = await DD.call('entries.query', { filter: { sourceId: S.sourceId, issue: current }, sort, dir, offset, limit, totals: offset === 0 });
        return { rows: r.rows, total: r.totals ? r.totals.count : table.total };
      },
      onRowClick: (r) => DD.go('explorer', { filter: { path: r.rel_path } }),
    });
    el.replaceChildren(head,
      h('div', { class: 'split', style: { gridTemplateColumns: '340px 1fr' } },
        h('div', { class: 'card groups' }, h('div', { class: 'card-h' }, h('h3', { text: 'Issue types' })), h('div', { class: 'card-b' }, list)),
        h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '0' } },
          h('div', { class: 'callout' }, h('div', { class: 'grow' }, h('b', { text: info.label || current }), ' — ', info.hint || ''),
            h('button', { class: 'btn sm', text: 'Open in Explorer', onclick: () => DD.go('explorer', { filter: { issue: current } }) })),
          table.el)));
    table.reload();
  }
})();
