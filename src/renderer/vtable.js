'use strict';
/* global DD */
// Virtual table with server-side paging and sorting. Only the visible rows
// exist in the DOM and only the visible pages are fetched, so a catalog with
// millions of entries scrolls as smoothly as one with ten.
(function () {
  const { h } = DD;

  class VirtualTable {
    constructor({ columns, fetch, onRowClick, rowClass, rowHeight = 30, pageSize = 200, emptyText = 'Nothing to show.', sort = null, dir = 'asc', round = false, onLoaded }) {
      this.columns = columns;
      this.fetchPage = fetch;
      this.onRowClick = onRowClick;
      this.onLoaded = onLoaded;
      this.rowClass = rowClass;
      this.rowHeight = rowHeight;
      this.pageSize = pageSize;
      this.emptyText = emptyText;
      this.sort = sort;
      this.dir = dir;
      this.total = 0;
      this.pages = new Map();
      this.gen = 0;
      this.raf = 0;
      const tpl = columns.map((c) => c.width || '1fr').join(' ');
      this.head = h('div', { class: 'vt-h', style: { gridTemplateColumns: tpl } }, columns.map((c) => {
        const el = h('span', { class: `${c.align === 'right' ? 'r' : ''} ${c.sort ? 'sortable' : ''}`, text: c.label, title: c.title || c.label });
        if (c.sort) el.addEventListener('click', () => this.setSort(c.sort));
        c.headEl = el;
        return el;
      }));
      this.spacer = h('div', { style: { width: '1px', height: '0px' } });
      this.empty = h('div', { class: 'vt-empty', text: emptyText, hidden: true });
      this.body = h('div', { class: 'vt-b' }, this.spacer, this.empty);
      this.el = h('div', { class: `vt${round ? ' round' : ''}` }, this.head, this.body);
      this.tpl = tpl;
      this.body.addEventListener('scroll', () => this.schedule());
      new ResizeObserver(() => this.schedule()).observe(this.body);
      this.markSort();
    }

    markSort() {
      for (const c of this.columns) {
        if (!c.headEl) continue;
        const on = c.sort && c.sort === this.sort;
        c.headEl.classList.toggle('sorted', !!on);
        c.headEl.textContent = on ? `${c.label} ${this.dir === 'asc' ? '↑' : '↓'}` : c.label;
      }
    }

    setSort(key) {
      if (this.sort === key) this.dir = this.dir === 'asc' ? 'desc' : 'asc';
      else { this.sort = key; this.dir = ['size', 'mtime', 'tree', 'count', 'bytes'].includes(key) ? 'desc' : 'asc'; }
      this.markSort();
      this.reload();
    }

    async reload({ keepScroll = false } = {}) {
      const gen = ++this.gen;
      this.pages.clear();
      if (!keepScroll) this.body.scrollTop = 0;
      try {
        const first = await this.fetchPage(0, this.pageSize, this.sort, this.dir);
        if (gen !== this.gen) return;
        this.total = first.total;
        this.pages.set(0, first.rows);
        if (this.onLoaded) this.onLoaded(first);
      } catch {
        if (gen !== this.gen) return;
        this.total = 0;
      }
      this.render();
    }

    schedule() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
    }

    ensurePage(p) {
      if (this.pages.has(p) || p * this.pageSize >= this.total) return;
      const gen = this.gen;
      this.pages.set(p, null); // in flight
      this.fetchPage(p * this.pageSize, this.pageSize, this.sort, this.dir).then((r) => {
        if (gen !== this.gen) return;
        this.pages.set(p, r.rows);
        this.schedule();
      }, () => { if (gen === this.gen) this.pages.delete(p); });
    }

    rowAt(i) {
      const rows = this.pages.get(Math.floor(i / this.pageSize));
      return rows ? rows[i % this.pageSize] : undefined;
    }

    render() {
      const rh = this.rowHeight;
      this.spacer.style.height = `${this.total * rh}px`;
      this.empty.hidden = this.total > 0;
      const top = this.body.scrollTop;
      const first = Math.max(0, Math.floor(top / rh) - 4);
      const last = Math.min(this.total, first + Math.ceil((this.body.clientHeight || 600) / rh) + 8);
      for (let p = Math.floor(first / this.pageSize); p <= Math.floor(Math.max(first, last - 1) / this.pageSize); p++) this.ensurePage(p);
      const rows = [];
      for (let i = first; i < last; i++) {
        const r = this.rowAt(i);
        const el = h('div', { class: `vt-r${i % 2 ? ' alt' : ''}${r ? '' : ' loading'}${r && this.rowClass ? ` ${this.rowClass(r) || ''}` : ''}`, style: { top: `${i * rh}px`, gridTemplateColumns: this.tpl, height: `${rh}px` } },
          this.columns.map((c) => {
            if (!r) return h('span', { text: '·' });
            const v = c.render ? c.render(r, i) : r[c.key];
            const cell = v instanceof Node ? h('span', {}, v) : h('span', { text: v === null || v === undefined ? '' : String(v) });
            cell.className = `${c.align === 'right' ? 'r ' : ''}${c.mono ? 'm ' : ''}${c.cls || ''}`;
            if (c.titleOf && r) cell.title = c.titleOf(r);
            return cell;
          }));
        if (r && this.onRowClick) { el.style.cursor = 'pointer'; el.addEventListener('click', (ev) => { if (!ev.target.closest('input, button, label')) this.onRowClick(r, i); }); }
        rows.push(el);
      }
      this.body.replaceChildren(this.spacer, this.empty, ...rows);
      this.body.scrollTop = top;
    }
  }

  DD.VirtualTable = VirtualTable;
})();
