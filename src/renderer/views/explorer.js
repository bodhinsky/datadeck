'use strict';
/* global DD, deck */
// Explorer: filter the whole catalog, group it by any dimension, and browse
// the matching entries in a virtual table. The current filter is what the
// Restructure page acts on.
(function () {
  const { h, $ } = DD;
  const S = DD.state;
  S.filter = {};
  S.groupDim = 'category';
  let el;
  let table;
  let groupBox;
  let statusEl;
  let subEl;
  const inputs = {};

  const GROUP_DIMS = [['', 'None'], ['category', 'Type'], ['ext', 'Extension'], ['year', 'Year'], ['month', 'Month'], ['top', 'Top folder'], ['parent', 'Folder']];
  const KIND_OPTS = [['', 'Everything'], ['file', 'Files'], ['dir', 'Folders'], ['symlink', 'Links']];

  function dateVal(ms) { return ms ? new Date(ms).toISOString().slice(0, 10) : ''; }

  function fullFilter() { return { ...S.filter, sourceId: S.sourceId }; }

  function describe(f) {
    const parts = [];
    if (f.kinds && f.kinds.length) parts.push(f.kinds.join('/'));
    if (f.categories && f.categories.length) parts.push(`type ${f.categories.join(', ')}`);
    if (f.exts && f.exts.length) parts.push(`.${f.exts.join(', .')}`);
    if (f.name) parts.push(`name ${f.name}`);
    if (f.path) parts.push(`path contains “${f.path}”`);
    if (f.under) parts.push(`under ${f.under}/`);
    if (typeof f.parent === 'string') parts.push(`in ${f.parent}/`);
    if (f.sizeMin != null || f.sizeMax != null) parts.push(`size ${f.sizeMin != null ? DD.fmtBytes(f.sizeMin) : '0'}–${f.sizeMax != null && f.sizeMax < Number.MAX_SAFE_INTEGER ? DD.fmtBytes(f.sizeMax) : '∞'}`);
    if (f.mtimeFrom || f.mtimeTo) parts.push(`modified ${f.mtimeFrom ? DD.fmtDate(f.mtimeFrom) : '…'} – ${f.mtimeTo ? DD.fmtDate(f.mtimeTo) : '…'}`);
    if (f.depthMin != null || f.depthMax != null) parts.push(`depth ${f.depthMin ?? 0}–${f.depthMax ?? '∞'}`);
    if (f.issue) parts.push(`issue: ${f.issue}`);
    if (f.anyIssue) parts.push('with issues');
    if (f.dupes) parts.push('duplicates');
    return parts.length ? parts.join(' · ') : 'All entries';
  }
  DD.describeFilter = describe;

  const view = DD.views.explorer = {
    init() {
      el = $('page-explorer');
      build();
      DD.bus.addEventListener('job-done', (e) => { if (S.page === 'explorer' && e.detail.sourceId === S.sourceId) refresh(); });
    },
    show(params = {}) {
      if (params.filter) { S.filter = { ...params.filter }; fillInputs(); }
      if (!DD.source()) { DD.go('overview'); return; }
      refresh();
    },
    async exportCsv(filter) {
      const src = DD.source();
      const file = await deck.saveFile({ title: 'Export file list', defaultPath: `${src ? src.label : 'catalog'}-files.csv` });
      if (!file) return;
      const r = await DD.call('export.csv', { file, filter: filter || fullFilter() });
      DD.toast(`Exported ${DD.fmtNum(r.rows)} rows to ${r.file}`);
    },
  };

  function field(label, input, cls) { return h('label', { class: `field ${cls || ''}` }, h('span', { text: label }), input); }

  function build() {
    const mk = (key, attrs) => (inputs[key] = h('input', { class: 'input', spellcheck: 'false', ...attrs }));
    const onChange = DD.debounce(readInputs, 250);
    const bar = h('div', { class: 'filters' },
      field('Name', mk('name', { placeholder: '*.jpg, IMG_*', oninput: onChange }), 'w-name'),
      field('Path contains', mk('path', { placeholder: 'Trips/2024', oninput: onChange }), 'w-path'),
      field('Extensions', mk('exts', { placeholder: 'jpg, png', oninput: onChange }), 'w-ext'),
      field('Min size', mk('sizeMin', { placeholder: '10 MB', oninput: onChange }), 'w-size'),
      field('Max size', mk('sizeMax', { placeholder: '', oninput: onChange }), 'w-size'),
      field('Modified from', mk('mtimeFrom', { type: 'date', onchange: readInputs }), 'w-date'),
      field('to', mk('mtimeTo', { type: 'date', onchange: readInputs }), 'w-date'),
      field('Depth', h('div', { class: 'row' }, mk('depthMin', { placeholder: 'min', class: 'input w-depth', oninput: onChange }), mk('depthMax', { placeholder: 'max', class: 'input w-depth', oninput: onChange }))),
      field('Show', inputs.kind = h('select', { class: 'input', onchange: readInputs }, KIND_OPTS.map(([v, l]) => h('option', { value: v, text: l })))),
      h('label', { class: 'chk' }, inputs.anyIssue = h('input', { type: 'checkbox', onchange: readInputs }), 'Issues only'),
      h('label', { class: 'chk' }, inputs.dupes = h('input', { type: 'checkbox', onchange: readInputs }), 'Duplicates only'),
      h('button', { class: 'btn ghost', text: 'Reset', onclick: () => { S.filter = {}; fillInputs(); refresh(); } }));
    inputs.cats = h('div', { class: 'catchips' });

    const groupSeg = h('div', { class: 'seg' }, GROUP_DIMS.map(([v, l]) => h('button', { 'data-dim': v, text: l, class: v === S.groupDim ? 'on' : '', onclick: (e) => {
      S.groupDim = v;
      groupSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target));
      refreshGroups();
    } })));

    subEl = h('div', { class: 'sub', text: '' });
    const head = h('div', { class: 'page-h' },
      h('div', {}, h('h1', { text: 'Explorer' }), subEl),
      h('div', { class: 'actions' }, h('span', { class: 'hint', text: 'Group by' }), groupSeg,
        h('button', { class: 'btn', text: 'Export CSV…', onclick: () => view.exportCsv() }),
        h('button', { class: 'btn primary', text: 'Restructure these…', onclick: () => DD.go('restructure', { filter: { ...S.filter } }) })));

    table = new DD.VirtualTable({
      sort: 'path',
      emptyText: 'No entries match this filter.',
      columns: [
        { label: 'Name', sort: 'name', width: 'minmax(140px, 2fr)', render: (r) => h('span', { class: r.kind === 'dir' ? 'kind-dir' : '' }, r.kind === 'dir' ? '▸ ' : r.kind === 'symlink' ? '↪ ' : '', r.name), titleOf: (r) => r.rel_path },
        { label: 'Folder', sort: 'path', width: 'minmax(60px, 1.5fr)', cls: 'dim', render: (r) => (r.rel_path.includes('/') ? r.rel_path.slice(0, r.rel_path.lastIndexOf('/')) : '/'), titleOf: (r) => r.rel_path },
        { label: 'Type', sort: 'category', width: '84px', render: (r) => r.category },
        { label: 'Ext', sort: 'ext', width: '64px', mono: true, render: (r) => r.ext },
        { label: 'Size', sort: 'size', width: '88px', align: 'right', mono: true, render: (r) => (r.kind === 'dir' ? DD.fmtBytes(r.tree_bytes) : r.kind === 'file' ? DD.fmtBytes(r.size) : '') },
        { label: 'Modified', sort: 'mtime', width: '96px', mono: true, render: (r) => DD.fmtDate(r.mtime) },
        { label: 'Lvl', sort: 'depth', width: '40px', align: 'right', mono: true, render: (r) => r.depth },
        { label: 'Flags', width: '96px', render: (r) => flags(r) },
      ],
      fetch: async (offset, limit, sort, dir) => {
        const r = await DD.call('entries.query', { filter: fullFilter(), sort, dir, offset, limit, totals: offset === 0 });
        if (r.totals) renderStatus(r.totals);
        return { rows: r.rows, total: r.totals ? r.totals.count : table.total };
      },
      onRowClick: (r) => details(r),
    });

    groupBox = h('div', { class: 'card groups' }, h('div', { class: 'card-h' }, h('h3', { text: 'Groups' }), h('span', { class: 'hint', text: 'click to drill in' })), h('div', { class: 'card-b' }));
    statusEl = h('div', { class: 'statusline' });
    el.replaceChildren(head, bar, inputs.cats, h('div', { class: 'split', id: 'exSplit' }, groupBox, h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '0' } }, table.el, statusEl)));
  }

  function flags(r) {
    const out = [];
    if (r.error) out.push(h('span', { class: 'tag bad', text: 'error', title: r.error }));
    if (r.issues) {
      const codes = r.issues.split(',');
      out.push(h('span', { class: 'tag warn', text: codes.length > 1 ? `${codes.length} issues` : codes[0], title: codes.join(', ') }));
    }
    if (r.hash) out.push(h('span', { class: 'tag info', text: '#', title: `SHA-256 ${r.hash}` }));
    return h('span', { class: 'row', style: { gap: '4px' } }, out);
  }

  function renderCats() {
    const cats = (S.meta.categories || []).concat(['folder', 'link']);
    const on = new Set(S.filter.categories || []);
    inputs.cats.replaceChildren(...cats.map((c) => h('button', { class: `chip${on.has(c) ? ' on' : ''}`, text: c, onclick: () => {
      if (on.has(c)) on.delete(c); else on.add(c);
      S.filter.categories = [...on];
      if (!S.filter.categories.length) delete S.filter.categories;
      renderCats();
      refresh();
    } })));
  }

  function readInputs() {
    const f = { ...S.filter };
    const set = (k, v) => { if (v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))) delete f[k]; else f[k] = v; };
    set('name', inputs.name.value.trim());
    set('path', inputs.path.value.trim());
    const exts = inputs.exts.value.split(/[\s,]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean);
    set('exts', exts.length ? exts : null);
    const mn = DD.parseSize(inputs.sizeMin.value);
    const mx = DD.parseSize(inputs.sizeMax.value);
    inputs.sizeMin.classList.toggle('bad', Number.isNaN(mn));
    inputs.sizeMax.classList.toggle('bad', Number.isNaN(mx));
    set('sizeMin', Number.isNaN(mn) ? null : mn);
    set('sizeMax', Number.isNaN(mx) ? null : mx);
    set('mtimeFrom', inputs.mtimeFrom.value ? new Date(`${inputs.mtimeFrom.value}T00:00:00`).getTime() : null);
    set('mtimeTo', inputs.mtimeTo.value ? new Date(`${inputs.mtimeTo.value}T23:59:59.999`).getTime() : null);
    const dmin = inputs.depthMin.value.trim() === '' ? null : parseInt(inputs.depthMin.value, 10);
    const dmax = inputs.depthMax.value.trim() === '' ? null : parseInt(inputs.depthMax.value, 10);
    set('depthMin', Number.isFinite(dmin) ? dmin : null);
    set('depthMax', Number.isFinite(dmax) ? dmax : null);
    set('kinds', inputs.kind.value ? [inputs.kind.value] : null);
    set('anyIssue', inputs.anyIssue.checked || null);
    set('dupes', inputs.dupes.checked || null);
    S.filter = f;
    refresh();
  }

  function fillInputs() {
    const f = S.filter;
    inputs.name.value = f.name || '';
    inputs.path.value = f.path || '';
    inputs.exts.value = (f.exts || []).join(', ');
    inputs.sizeMin.value = f.sizeMin != null ? DD.fmtBytes(f.sizeMin).replace(' ', '') : '';
    inputs.sizeMax.value = f.sizeMax != null && f.sizeMax < Number.MAX_SAFE_INTEGER ? DD.fmtBytes(f.sizeMax).replace(' ', '') : '';
    inputs.mtimeFrom.value = dateVal(f.mtimeFrom);
    inputs.mtimeTo.value = dateVal(f.mtimeTo);
    inputs.depthMin.value = f.depthMin ?? '';
    inputs.depthMax.value = f.depthMax ?? '';
    inputs.kind.value = f.kinds && f.kinds.length === 1 ? f.kinds[0] : '';
    inputs.anyIssue.checked = !!f.anyIssue;
    inputs.dupes.checked = !!f.dupes;
    for (const k of ['sizeMin', 'sizeMax']) inputs[k].classList.remove('bad');
  }

  function refresh() {
    if (!S.sourceId) return;
    renderCats();
    subEl.textContent = describe(S.filter);
    table.reload();
    refreshGroups();
  }

  async function refreshGroups() {
    $('exSplit').classList.toggle('nogroup', !S.groupDim);
    groupBox.hidden = !S.groupDim;
    if (!S.groupDim) return;
    const dim = S.groupDim;
    const rows = await DD.call('entries.group', { filter: fullFilter(), dim, limit: 300, order: dim === 'year' || dim === 'month' ? 'key' : 'bytes' });
    if (dim === 'year' || dim === 'month') rows.reverse();
    const body = groupBox.querySelector('.card-b');
    body.replaceChildren(DD.statTable({
      rows: rows.map((r) => ({ ...r, key: r.key === null ? '(undated)' : String(r.key) })),
      keyLabel: GROUP_DIMS.find((d) => d[0] === dim)[1],
      onClick: (r) => drill(dim, r.key),
    }));
  }

  function drill(dim, key) {
    const f = { ...S.filter };
    if (dim === 'category') f.categories = [key];
    else if (dim === 'ext') f.exts = [key];
    else if (dim === 'year' && /^\d{4}$/.test(key)) { f.mtimeFrom = new Date(Number(key), 0, 1).getTime(); f.mtimeTo = new Date(Number(key) + 1, 0, 1).getTime() - 1; }
    else if (dim === 'month' && /^\d{4}-\d{2}$/.test(key)) { const [y, m] = key.split('-').map(Number); f.mtimeFrom = new Date(y, m - 1, 1).getTime(); f.mtimeTo = new Date(y, m, 1).getTime() - 1; }
    else if (dim === 'top') { if (key === '(root)') f.parent = '(root)'; else f.under = key; }
    else if (dim === 'parent') f.parent = key;
    else return;
    S.filter = f;
    fillInputs();
    refresh();
  }

  function renderStatus(t) {
    statusEl.replaceChildren(
      h('span', {}, h('b', { text: DD.fmtNum(t.count) }), ' entries'),
      h('span', {}, h('b', { text: DD.fmtNum(t.files || 0) }), ' files'),
      h('span', {}, h('b', { text: DD.fmtNum(t.dirs || 0) }), ' folders'),
      h('span', {}, h('b', { text: DD.fmtBytes(t.bytes) }), ' in files'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint', text: 'Click a row for details' }));
  }

  function details(r) {
    const src = DD.source();
    const abs = `${src.path}/${r.rel_path}`;
    const kv = (k, v) => h('tr', {}, h('td', { class: 'hint', text: k, style: { paddingRight: '14px', verticalAlign: 'top' } }), h('td', { class: 'mono', text: v ?? '–', style: { userSelect: 'text', wordBreak: 'break-all' } }));
    DD.confirm({
      title: r.name,
      body: [h('table', {}, h('tbody', {},
        kv('Path', abs), kv('Kind', r.kind), kv('Type', r.category), kv('Size', r.kind === 'dir' ? `${DD.fmtBytes(r.tree_bytes)} in ${DD.fmtNum(r.tree_files)} files` : `${DD.fmtBytes(r.size)} (${DD.fmtNum(r.size)} bytes)`),
        kv('Modified', DD.fmtDateTime(r.mtime)), kv('Depth', String(r.depth)), r.link_target ? kv('Links to', r.link_target) : null,
        r.nlink > 1 ? kv('Hard links', String(r.nlink)) : null, kv('SHA-256', r.hash || 'not computed'),
        r.issues ? kv('Issues', r.issues.split(',').map((c) => (S.meta.issues[c] || {}).label || c).join(', ')) : null,
        r.error ? kv('Error', r.error) : null))],
      okText: 'Show in Finder',
      altText: r.kind === 'dir' ? 'Filter to this folder' : null,
    }).then((v) => {
      if (v === true) deck.showItem(abs);
      if (v === 'alt') { S.filter = { under: r.rel_path }; fillInputs(); refresh(); }
    });
  }
})();
