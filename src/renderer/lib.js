'use strict';
/* global deck */
// Shared helpers for all views. Everything hangs off window.DD.
(function () {
  const DD = (window.DD = { views: {}, state: {}, bus: new EventTarget() });

  DD.$ = (id) => document.getElementById(id);
  DD.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // DOM builder. Text always goes through textContent, so paths and file
  // names from disk can never be interpreted as markup.
  DD.h = function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };

  DD.fmtBytes = (n) => {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '–';
    n = Number(n);
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${u[i]}`;
  };
  DD.fmtNum = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US'));
  DD.fmtDate = (t) => {
    if (!t) return '–';
    const d = new Date(t);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  DD.fmtDateTime = (t) => {
    if (!t) return '–';
    const d = new Date(t);
    const p = (x) => String(x).padStart(2, '0');
    return `${DD.fmtDate(t)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  DD.fmtDur = (ms) => {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };
  DD.pct = (a, b) => (b ? `${((a / b) * 100).toFixed(a / b < 0.1 ? 1 : 0)}%` : '–');
  DD.parseSize = (s) => {
    if (s === null || s === undefined || String(s).trim() === '') return null;
    const m = /^\s*([\d.]+)\s*([kmgt]?)b?\s*$/i.exec(String(s));
    if (!m) return NaN;
    return Math.round(Number(m[1]) * 1024 ** ' kmgt'.indexOf((m[2] || ' ').toLowerCase()));
  };
  DD.debounce = (fn, ms) => {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  let toastTimer = null;
  DD.toast = (msg, bad = false) => {
    let t = DD.$('toast');
    if (!t) { t = DD.h('div', { id: 'toast', class: 'toast' }); document.body.append(t); }
    t.textContent = msg;
    t.className = `toast${bad ? ' bad' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2800);
  };

  // Engine call; shows the error and rethrows.
  DD.call = async (method, params, { quiet = false } = {}) => {
    try {
      return await deck.engine(method, params);
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method 'engine:call': (Error: )?/, '');
      if (!quiet) DD.toast(msg, true);
      throw new Error(msg);
    }
  };

  // Modal confirmation. Resolves true / false / 'alt'.
  DD.confirm = ({ title, body = [], okText = 'OK', danger = false, ack = null, altText = null }) => new Promise((resolve) => {
    const { h } = DD;
    const ackBox = ack ? h('input', { type: 'checkbox' }) : null;
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, text: okText, disabled: !!ack });
    const cancel = h('button', { class: 'btn', text: 'Cancel' });
    const alt = altText ? h('button', { class: 'btn', text: altText }) : null;
    const back = h('div', { class: 'modal-back' },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal-h', text: title }),
        h('div', { class: 'modal-b' }, body),
        h('div', { class: 'modal-f' }, ack ? h('label', { class: 'chk' }, ackBox, ack) : null, cancel, alt, ok)));
    const close = (v) => { back.remove(); document.removeEventListener('keydown', esc); resolve(v); };
    const esc = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', esc);
    if (ackBox) ackBox.addEventListener('change', () => { ok.disabled = !ackBox.checked; });
    ok.addEventListener('click', () => close(true));
    cancel.addEventListener('click', () => close(false));
    if (alt) alt.addEventListener('click', () => close('alt'));
    document.body.append(back);
    (alt || cancel).focus();
  });

  // A table of grouped numbers with inline bars: the core "statistics" widget.
  DD.statTable = ({ rows, total, keyLabel = 'Key', fmtKey = (k) => k, onClick, showCount = true, bytesKey = 'bytes', alt = false, extra }) => {
    const { h } = DD;
    const max = Math.max(1, ...rows.map((r) => Number(r[bytesKey]) || 0));
    const sum = total || rows.reduce((a, r) => a + (Number(r[bytesKey]) || 0), 0);
    return h('table', { class: 'stat' },
      h('thead', {}, h('tr', {}, h('th', { text: keyLabel }), h('th', { text: 'Share' }), showCount ? h('th', { class: 'r', text: 'Items' }) : null, h('th', { class: 'r', text: 'Size' }), h('th', { class: 'r', text: '%' }), extra ? h('th', { class: 'r', text: extra.label }) : null)),
      h('tbody', {}, rows.map((r) => h('tr', { class: onClick ? 'click' : '', onclick: onClick ? () => onClick(r) : null, title: String(r.key ?? '') },
        h('td', { class: 'key' }, fmtKey(r.key, r)),
        h('td', { class: 'barcell' }, h('div', { class: `bar${alt ? ' alt' : ''}` }, h('i', { style: { width: `${((Number(r[bytesKey]) || 0) / max) * 100}%` } }))),
        showCount ? h('td', { class: 'r n', text: DD.fmtNum(r.count) }) : null,
        h('td', { class: 'r n', text: DD.fmtBytes(r[bytesKey]) }),
        h('td', { class: 'r n', text: DD.pct(Number(r[bytesKey]) || 0, sum) }),
        extra ? h('td', { class: 'r n', text: extra.value(r) }) : null))));
  };

  DD.kpis = (items) => DD.h('div', { class: 'kpis' }, items.filter(Boolean).map((k) =>
    DD.h('div', { class: `kpi ${k.tone || ''}`, title: k.title || '' },
      DD.h('div', { class: 'k', text: k.k }),
      DD.h('div', { class: 'v' }, k.v, k.unit ? DD.h('small', { text: k.unit }) : null),
      k.d ? DD.h('div', { class: 'd', text: k.d }) : null)));

  DD.card = (title, body, { hint, flush = false, actions } = {}) => DD.h('div', { class: `card${flush ? ' flush' : ''}` },
    DD.h('div', { class: 'card-h' }, DD.h('h3', { text: title }), hint ? DD.h('span', { class: 'hint', text: hint }) : null, actions || null),
    DD.h('div', { class: 'card-b' }, body));

  DD.pageHead = (title, sub, actions = []) => DD.h('div', { class: 'page-h' },
    DD.h('div', {}, DD.h('h1', { text: title }), sub ? DD.h('div', { class: 'sub', text: sub }) : null),
    DD.h('div', { class: 'actions' }, actions));

  // A one-field dialog. Resolves to the trimmed text, or null.
  DD.prompt = async ({ title, label, value = '', placeholder = '', hint, okText = 'OK', mono = true, extra }) => {
    const { h } = DD;
    const input = h('input', { class: `input${mono ? ' mono' : ''}`, value, placeholder, spellcheck: 'false' });
    const p = DD.confirm({ title, okText, body: [h('label', { class: 'field' }, h('span', { text: label }), input), hint ? h('p', { class: 'hint', text: hint }) : null, extra || null] });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.querySelector('.modal-f .btn:last-child').click(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
    const ok = await p;
    return ok === true ? input.value.trim() : null;
  };

  // ── Planned state (workspace) ──
  DD.VF = { MOVED: 1, RENAMED: 2, EXCLUDED: 4, CONFLICT: 8, BADNAME: 16, CLASH: 32, STALE: 64 };
  // Visual markers for a row's planned state.
  DD.stateChips = (f) => {
    const { h } = DD;
    const V = DD.VF;
    const out = [];
    if (f & V.EXCLUDED) out.push(h('span', { class: 'tag st-x', text: 'excluded', title: 'Will not be exported' }));
    else {
      if (f & V.MOVED) out.push(h('span', { class: 'tag st-m', text: 'moved', title: 'Goes to another folder' }));
      if (f & V.RENAMED) out.push(h('span', { class: 'tag st-r', text: 'renamed', title: 'Gets a new name' }));
    }
    if (f & (V.CONFLICT | V.CLASH)) out.push(h('span', { class: 'tag bad', text: 'collides', title: 'Another file lands on the same path' }));
    if (f & V.BADNAME) out.push(h('span', { class: 'tag warn', text: 'name', title: 'Not valid on the target file system; will be cleaned on export' }));
    if (f & V.STALE) out.push(h('span', { class: 'tag bad', text: 'changed on disk', title: 'The file changed or vanished since the scan' }));
    return h('span', { class: 'chips-inline' }, out);
  };
  DD.stateClass = (f) => {
    const V = DD.VF;
    if (f & (V.CONFLICT | V.CLASH | V.STALE)) return 'st-bad';
    if (f & V.EXCLUDED) return 'st-excl';
    if (f & (V.MOVED | V.RENAMED)) return 'st-chg';
    return '';
  };

  // Records a decision as a staged change. Nothing on disk is touched.
  DD.stage = async (op, selection, params = {}) => {
    const r = await DD.call('ws.stage', { sourceId: DD.state.sourceId, op, selection, params });
    DD.toast(`Staged: ${r.change.label}. Review it under Changes.`);
    DD.setWs(r.summary);
    DD.bus.dispatchEvent(new CustomEvent('ws'));
    return r;
  };

  DD.emptyState = (title, text, action) => DD.h('div', { class: 'empty-state' }, DD.h('h2', { text: title }), DD.h('p', { text: text }), action || null);
})();
