'use strict';
/* global DD */
// Plans & undo: every restructure plan for the current source, with status.
(function () {
  const { h, $ } = DD;
  const S = DD.state;
  let el;

  DD.views.plans = {
    init() {
      el = $('page-plans');
      DD.bus.addEventListener('job-done', () => { if (S.page === 'plans') this.show(); });
    },
    async show() {
      if (!DD.source()) { DD.go('overview'); return; }
      const plans = await DD.call('plan.list', { sourceId: S.sourceId });
      const head = DD.pageHead('Plans & undo', 'Every plan is kept with its full per-file journal: what moved where, both checksums, and the result. Open one to resume, export or undo it.', [
        h('button', { class: 'btn primary', text: 'New plan', onclick: () => DD.go('restructure', { filter: {} }) }),
      ]);
      if (!plans.length) { el.replaceChildren(head, DD.emptyState('No plans yet', 'Build one from the Restructure page.')); return; }
      const tone = (st) => (st === 'done' ? 'ok' : st === 'draft' ? 'info' : /error|invalid|interrupted|failed/.test(st) ? 'bad' : 'warn');
      el.replaceChildren(head, DD.card('Plans', h('table', { class: 'stat' },
        h('thead', {}, h('tr', {}, ['#', 'Created', 'Mode', 'Target', 'Files', 'Size', 'Status', 'Finished'].map((t, i) => h('th', { class: i >= 4 && i <= 5 ? 'r' : '', text: t })))),
        h('tbody', {}, plans.map((p) => h('tr', { class: 'click', onclick: () => DD.go('restructure', { planId: p.id }) },
          h('td', { class: 'n', text: `#${p.id}` }),
          h('td', { class: 'n', text: DD.fmtDateTime(p.created_at) }),
          h('td', { text: p.summary.mode || '' }),
          h('td', { class: 'key', text: p.summary.root || '', title: p.summary.root || '' }),
          h('td', { class: 'r n', text: DD.fmtNum(p.summary.files) }),
          h('td', { class: 'r n', text: DD.fmtBytes(p.summary.bytes) }),
          h('td', {}, h('span', { class: `tag ${tone(p.status)}`, text: p.status })),
          h('td', { class: 'n', text: DD.fmtDateTime(p.finished_at) }))))), { flush: true }));
    },
  };
})();
