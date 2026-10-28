'use strict';
/* global DD */
// Overview: the statistical summary of one source. Every row is a doorway
// into the Explorer with that slice already filtered.
(function () {
  const { h, $ } = DD;
  const S = DD.state;
  let el;

  const view = DD.views.overview = {
    init() {
      el = $('page-overview');
      DD.bus.addEventListener('job-done', (e) => { if (S.page === 'overview' && e.detail.sourceId === S.sourceId) view.show(); });
    },
    async show() {
      const src = DD.source();
      if (!src) {
        el.replaceChildren(DD.emptyState('Pick a source to analyze', 'Add any folder: a drive, a photo library, a project, a download pile. DataDeck catalogs every file at any depth, then shows you what is there, what is duplicated, what will cause trouble elsewhere, and helps you restructure it safely.',
          h('button', { class: 'btn primary', text: 'Add a folder…', onclick: DD.addSource })));
        return;
      }
      if (src.status === 'new' || (src.status === 'scanning' && !src.files)) {
        el.replaceChildren(DD.pageHead(src.label, src.path), DD.emptyState(src.status === 'scanning' ? 'Scanning…' : 'Not scanned yet', src.status === 'scanning' ? 'Progress is shown at the top. The overview fills in when the scan finishes.' : 'Scan this folder to build its catalog.',
          src.status === 'scanning' ? null : h('button', { class: 'btn primary', text: 'Scan now', onclick: () => DD.scan(src.id) })));
        return;
      }
      const o = await DD.call('overview', { sourceId: src.id });
      render(o);
    },
  };

  function explore(filter) { DD.go('explorer', { filter }); }

  function render(o) {
    const s = o.source;
    const issueCount = o.issues.reduce((a, i) => a + i.count, 0);
    const errCount = o.issues.filter((i) => i.severity === 'error').reduce((a, i) => a + i.count, 0);
    const warnCount = o.issues.filter((i) => i.severity === 'warn').reduce((a, i) => a + i.count, 0);
    DD.$('navIssues').textContent = issueCount ? DD.fmtNum(warnCount + errCount) : '';
    DD.$('navDupes').textContent = o.dupes.groups ? DD.fmtNum(o.dupes.groups) : '';

    const head = DD.pageHead(s.label, `${s.path} · scanned ${DD.fmtDateTime(s.scanned_at)} in ${DD.fmtDur(s.scan_ms)}${s.status === 'partial' ? ' · PARTIAL (scan was interrupted)' : ''}`, [
      h('button', { class: 'btn', text: 'Rescan', onclick: () => DD.scan(s.id) }),
      h('button', { class: 'btn', text: 'Export CSV…', onclick: () => DD.views.explorer.exportCsv({ sourceId: s.id }) }),
      h('button', { class: 'btn primary', text: 'Explore files', onclick: () => explore({}) }),
      h('button', { class: 'btn ghost', text: 'Forget', title: 'Remove this source from DataDeck. Files on disk are not touched.', onclick: forget }),
    ]);

    const kpis = DD.kpis([
      { k: 'Files', v: DD.fmtNum(s.files), d: `${DD.fmtNum(s.dirs)} folders · ${DD.fmtNum(s.links)} links` },
      { k: 'Total size', v: DD.fmtBytes(s.bytes), d: `avg ${DD.fmtBytes(Math.round(o.range.avgSize || 0))} · median ${DD.fmtBytes(o.range.medianSize)}` },
      { k: 'Deepest level', v: String(o.range.maxDepth ?? 0), d: 'folders below the source' },
      { k: 'Modified', v: o.range.newest ? new Date(o.range.newest).getFullYear().toString() : '–', d: `oldest ${DD.fmtDate(o.range.oldest)}` },
      { k: 'Duplicates', v: o.dupes.hashedFiles ? DD.fmtBytes(o.dupes.wasted) : 'not checked', d: o.dupes.hashedFiles ? `${DD.fmtNum(o.dupes.groups)} groups, ${DD.fmtNum(o.dupes.extra)} extra copies` : 'run a duplicate check', tone: o.dupes.wasted ? 'warn' : '' },
      { k: 'Issues', v: DD.fmtNum(errCount + warnCount), d: `${DD.fmtNum(errCount)} errors · ${DD.fmtNum(issueCount - errCount - warnCount)} notes`, tone: errCount ? 'bad' : warnCount ? 'warn' : 'ok' },
    ]);

    const filesTotal = s.bytes;
    const cards = [
      DD.card('By type', DD.statTable({ rows: o.categories, total: filesTotal, keyLabel: 'Category', onClick: (r) => explore({ categories: [r.key] }) }), { flush: true, hint: 'click to filter' }),
      DD.card('Size distribution', DD.statTable({ rows: o.sizes, total: filesTotal, keyLabel: 'File size', alt: true, onClick: (r) => explore({ sizeMin: r.lo, sizeMax: r.hi, kinds: ['file'] }), bytesKey: 'bytes' }), { flush: true }),
      DD.card('Largest folders', DD.statTable({ rows: o.topFolders, total: filesTotal, keyLabel: 'Folder (3 levels)', fmtKey: (k, r) => h('span', {}, h('span', { class: 'path-dim', text: k.includes('/') ? `${k.slice(0, k.lastIndexOf('/') + 1)}` : '' }), k.split('/').pop()), onClick: (r) => explore({ under: r.key }) }), { flush: true, hint: 'recursive size' }),
      DD.card('Last modified', DD.statTable({ rows: o.years, total: filesTotal, keyLabel: 'Year', alt: true, onClick: (r) => explore({ mtimeFrom: new Date(Number(r.key), 0, 1).getTime(), mtimeTo: new Date(Number(r.key) + 1, 0, 1).getTime() - 1, kinds: ['file'] }) }), { flush: true }),
      DD.card('Top extensions', DD.statTable({ rows: o.extensions.slice(0, 15), total: filesTotal, keyLabel: 'Extension', fmtKey: (k) => h('code', { text: k === '(none)' ? k : `.${k}` }), onClick: (r) => explore({ exts: [r.key], kinds: ['file'] }) }), { flush: true }),
      DD.card('Issues', issuesTable(o.issues), { flush: true, hint: 'things that break on other systems' }),
      DD.card('Folder depth', DD.statTable({ rows: o.depths.map((d) => ({ ...d, key: String(d.key) })), total: filesTotal, keyLabel: 'Level', alt: true, onClick: (r) => explore({ depthMin: Number(r.key), depthMax: Number(r.key) }) }), { flush: true }),
      DD.card('Largest files', largestTable(o.largest), { flush: true }),
    ];
    el.replaceChildren(head, kpis, h('div', { class: 'grid' }, cards));
  }

  function issuesTable(issues) {
    if (!issues.length) return h('div', { class: 'card-b hint', text: 'No issues found. Everything here is portable.' });
    return h('table', { class: 'stat' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Issue' }), h('th', { text: 'Level' }), h('th', { class: 'r', text: 'Items' }))),
      h('tbody', {}, issues.map((i) => h('tr', { class: 'click', title: i.hint, onclick: () => DD.go('issues', { code: i.key }) },
        h('td', { class: 'key', text: i.label }),
        h('td', {}, h('span', { class: `tag ${i.severity === 'error' ? 'bad' : i.severity}`, text: i.severity })),
        h('td', { class: 'r n', text: DD.fmtNum(i.count) })))));
  }

  function largestTable(rows) {
    return h('table', { class: 'stat' },
      h('thead', {}, h('tr', {}, h('th', { text: 'File' }), h('th', { text: 'Type' }), h('th', { class: 'r', text: 'Modified' }), h('th', { class: 'r', text: 'Size' }))),
      h('tbody', {}, rows.slice(0, 12).map((r) => h('tr', { class: 'click', title: r.rel_path, onclick: () => explore({ path: r.rel_path }) },
        h('td', { class: 'key', text: r.rel_path }), h('td', { text: r.category }), h('td', { class: 'r n', text: DD.fmtDate(r.mtime) }), h('td', { class: 'r n', text: DD.fmtBytes(r.size) })))));
  }

  async function forget() {
    const src = DD.source();
    const ok = await DD.confirm({ title: `Forget “${src.label}”?`, body: [h('p', { text: 'This removes the catalog, analysis and plans for this source from DataDeck. Nothing on disk is touched.' })], okText: 'Forget source', danger: true });
    if (!ok) return;
    await DD.call('sources.remove', { id: src.id });
    await DD.refreshSources();
    DD.selectSource(S.sourceId);
  }
})();
