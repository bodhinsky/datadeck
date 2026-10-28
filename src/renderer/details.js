'use strict';
/* global DD, deck */
// What a file is, at a glance: the details panel beside the Explorer table,
// the one-line content summary in table rows, and the side-by-side compare
// for duplicates and look-alikes. Everything here only reads; decisions go
// through DD.stage like everywhere else.
(function () {
  const { h } = DD;
  const S = DD.state;

  DD.fmtLen = (sec) => {
    if (sec === null || sec === undefined) return '–';
    const s = Math.round(sec);
    const p = (x) => String(x).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
  };
  DD.fmtMP = (w, hh) => (w && hh ? `${w}×${hh}${w * hh >= 1e6 ? ` · ${(w * hh / 1e6).toFixed(w * hh >= 1e7 ? 0 : 1)} MP` : ''}` : '–');
  DD.fmtAgo = (t) => {
    if (!t) return '–';
    const d = (Date.now() - t) / 864e5;
    if (d < 1) return 'today';
    if (d < 45) return `${Math.round(d)} days ago`;
    if (d < 540) return `${Math.round(d / 30.4)} months ago`;
    return `${(d / 365.25).toFixed(1)} years ago`;
  };
  const TYPE_LABEL = { jpeg: 'JPEG', png: 'PNG', heic: 'HEIC', tiff: 'TIFF/RAW', mp4: 'MP4', mov: 'QuickTime', m4a: 'AAC/M4A', mp3: 'MP3', pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint' };
  DD.typeLabel = (t) => (t ? TYPE_LABEL[t] || t.toUpperCase() : '–');

  // One line about the content, for table rows: what you'd want to know
  // before opening the file.
  DD.contentSummary = (r) => {
    const parts = [];
    if (r.taken) parts.push(DD.fmtDate(r.taken));
    if (r.camera) parts.push(r.camera);
    if (r.duration !== null && r.duration !== undefined) parts.push(DD.fmtLen(r.duration));
    if (r.width && r.height) parts.push(r.width * r.height >= 1e6 ? `${(r.width * r.height / 1e6).toFixed(r.width * r.height >= 1e7 ? 0 : 1)} MP` : `${r.width}×${r.height}`);
    if (r.artist) parts.push(r.album ? `${r.artist} – ${r.album}` : r.artist);
    else if (r.title && !r.camera) parts.push(r.title);
    if (r.pages) parts.push(`${r.pages} p.`);
    if (r.author && !r.artist) parts.push(r.author);
    return parts.join(' · ');
  };

  // A details table: rows of [label, value]; empty values are skipped.
  function kv(rows) {
    const live = rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '' && r[1] !== '–');
    if (!live.length) return null;
    return h('table', { class: 'kv' }, h('tbody', {}, live.map(([k, v, cls]) => h('tr', {}, h('th', { text: k }), h('td', { class: cls || '' }, v)))));
  }
  const section = (title, body) => (body ? h('div', { class: 'dp-sec' }, h('h4', { text: title }), body) : null);

  function previewBox(p, entry) {
    if (p && p.kind === 'image') {
      const img = h('img', { src: p.src, alt: entry.name, draggable: 'false' });
      return h('div', { class: 'dp-prev' }, img);
    }
    if (p && p.kind === 'text') return h('pre', { class: 'dp-text', text: p.text + (p.truncated ? '\n…' : '') });
    const fam = entry.info && entry.info.family;
    return h('div', { class: `dp-prev none${p && p.stale ? ' stale' : ''}` }, h('span', { class: 'dp-icon', text: { audio: '♪', video: '▶', archive: '▤', document: '¶' }[fam] || '◇' }), h('span', { text: p ? p.reason : 'Loading…' }));
  }

  // Everything known about one entry, as panel sections.
  function sections(e) {
    const i = e.info || {};
    const x = i.extra || {};
    const V = DD.VF;
    const planned = e.vflags & V.EXCLUDED ? 'excluded from export' : e.vpath !== e.rel_path ? e.vpath : null;
    const out = [];
    out.push(section('Decision', kv([
      ['Planned', planned || 'unchanged', planned && !(e.vflags & V.EXCLUDED) ? 'after' : ''],
      ['Decided by', e.change_label],
      ['State', e.vflags ? DD.stateChips(e.vflags) : null],
    ])));
    const realType = i.type ? h('span', {}, DD.typeLabel(i.type), i.mismatch ? h('span', { class: 'tag warn', text: `not .${e.ext}`, title: 'The content does not match the extension' }) : null) : null;
    out.push(section('File', kv([
      ['Folder', e.parent || '/', 'mono'],
      ['Size', e.kind === 'dir' ? `${DD.fmtBytes(e.tree_bytes)} in ${DD.fmtNum(e.tree_files)} files` : `${DD.fmtBytes(e.size)} (${DD.fmtNum(e.size)} B)`],
      ['Real type', realType],
      ['Modified', DD.fmtDateTime(e.mtime)],
      ['Created', e.btime ? DD.fmtDateTime(e.btime) : null],
      ['Links to', e.link_target, 'mono'],
      ['Hard links', e.nlink > 1 ? String(e.nlink) : null],
      ['SHA-256', e.hash ? e.hash.slice(0, 16) + '…' : null, 'mono'],
    ])));
    const gps = i.gps_lat !== null && i.gps_lat !== undefined ? `${i.gps_lat.toFixed(5)}, ${i.gps_lon.toFixed(5)}` : null;
    const shot = [x.exposure ? `${x.exposure} s` : null, x.fnumber, x.iso ? `ISO ${x.iso}` : null, x.focal].filter(Boolean).join(' · ');
    if (i.family === 'image' || i.family === 'video') {
      out.push(section(i.family === 'video' ? 'Video' : 'Photo', kv([
        ['Taken', i.taken ? `${DD.fmtDateTime(i.taken)}` : h('span', { class: 'dim', text: 'no date in the file' })],
        ['Camera', i.camera], ['Lens', i.lens], ['Exposure', shot],
        ['Size', i.width ? DD.fmtMP(i.width, i.height) : null],
        ['Length', i.duration !== null && i.duration !== undefined ? DD.fmtLen(i.duration) : null],
        ['Codec', x.codec], ['Location', gps, 'mono'], ['Software', x.software],
        ['Rotation', x.orientation && x.orientation !== 1 ? { 3: '180°', 6: '90° right', 8: '90° left' }[x.orientation] || `EXIF ${x.orientation}` : null],
      ])));
    }
    if (i.family === 'audio') {
      out.push(section('Audio', kv([
        ['Title', i.title], ['Artist', i.artist], ['Album', i.album], ['Track', x.track], ['Year', x.year ? String(x.year) : null], ['Genre', x.genre],
        ['Length', i.duration !== null && i.duration !== undefined ? DD.fmtLen(i.duration) : null],
        ['Quality', [i.bitrate ? `${Math.round(i.bitrate / 1000)} kbit/s` : null, x.sampleRate ? `${(x.sampleRate / 1000).toFixed(1)} kHz` : null].filter(Boolean).join(' · ')],
      ])));
    }
    if (['document', 'spreadsheet', 'presentation'].includes(i.family)) {
      out.push(section('Document', kv([
        ['Title', i.title], ['Author', i.author], ['Last edited by', x.lastAuthor],
        [i.family === 'presentation' ? 'Slides' : 'Pages', i.pages ? DD.fmtNum(i.pages) : null], ['Sheets', x.sheets ? String(x.sheets) : null],
        ['Words', x.words ? DD.fmtNum(x.words) : null], ['Created', i.created ? DD.fmtDate(i.created) : null],
        ['Made with', x.application], ['Encrypted', x.encrypted ? 'yes' : null], ['PDF version', x.version],
      ])));
    }
    if (['text', 'code', 'data'].includes(i.family)) out.push(section('Text', kv([['Lines', x.lines ? `≈ ${DD.fmtNum(x.lines)}` : null], ['Line endings', x.eol]])));
    if (i.family === 'archive') out.push(section('Archive', kv([['Entries', x.entries ? DD.fmtNum(x.entries) : null]])));
    out.push(section('On this Mac', kv([
      ['Last opened', i.last_used ? `${DD.fmtDate(i.last_used)} (${DD.fmtAgo(i.last_used)})` : null],
      ['Finder tags', i.tags], ['Downloaded from', i.where_from, 'mono'],
    ])));
    if (e.issues && e.issues.length) {
      out.push(section('Issues', h('ul', { class: 'dp-issues' }, e.issues.map((it) => h('li', {}, h('b', { text: (S.meta.issues[it.code] || {}).label || it.code }), it.detail ? h('span', { class: 'dim', text: ` ${it.detail}` }) : null)))));
    }
    if (e.error) out.push(section('Error', h('p', { class: 'bad', text: e.error })));
    return out.filter(Boolean);
  }

  class DetailsPanel {
    constructor({ onClose, onFilterFolder, onOpen } = {}) {
      this.onClose = onClose;
      this.onFilterFolder = onFilterFolder;
      this.onOpen = onOpen;
      this.seq = 0;
      this.el = h('aside', { class: 'card dpanel', hidden: true });
    }

    async show(entryId) {
      const seq = ++this.seq;
      this.el.hidden = false;
      let e;
      try { e = await DD.call('entry.info', { entryId }, { quiet: true }); } catch (err) { this.el.replaceChildren(h('div', { class: 'card-b', text: err.message })); return; }
      if (seq !== this.seq) return;
      this.entry = e;
      const prev = h('div', { class: 'dp-prevwrap' }, previewBox(null, e));
      const copies = e.copies && e.copies.length ? section(`Identical copies (${e.copies.length})`, h('div', {},
        h('ul', { class: 'dp-copies' }, e.copies.slice(0, 8).map((c) => h('li', { class: 'click', title: c.rel_path, text: c.rel_path, onclick: () => this.onOpen && this.onOpen(c.id) }))),
        h('button', { class: 'btn small', text: 'Compare side by side', onclick: () => DD.compare([e.id, ...e.copies.map((c) => c.id)]) }))) : null;
      const V = DD.VF;
      const excluded = e.vflags & V.EXCLUDED;
      this.el.replaceChildren(
        h('div', { class: 'dp-h' },
          h('div', { class: 'dp-title' }, h('b', { text: e.name, title: e.rel_path }), h('span', { class: 'dim', text: e.kind === 'dir' ? 'folder' : DD.contentSummary(e.info || {}) || e.category })),
          h('button', { class: 'btn ghost small', text: '✕', title: 'Close (Esc)', onclick: () => this.close() })),
        h('div', { class: 'dp-b' }, e.kind === 'file' ? prev : null, ...sections(e), copies),
        h('div', { class: 'dp-f' },
          h('button', { class: 'btn small', text: 'Show in Finder', onclick: () => deck.showItem(e.abs) }),
          e.kind === 'dir' && this.onFilterFolder ? h('button', { class: 'btn small', text: 'Filter to folder', onclick: () => this.onFilterFolder(e.rel_path) }) : null,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', text: excluded ? 'Include' : 'Exclude', title: excluded ? 'Undo the exclusion (E)' : 'Leave out of the export (E)', onclick: () => DD.stage(excluded ? 'include' : 'exclude', { ids: [e.id] }) })));
      if (e.kind === 'file') {
        try {
          const p = await deck.preview(e.id, 360);
          if (seq === this.seq) prev.replaceChildren(previewBox(p, e));
        } catch { if (seq === this.seq) prev.replaceChildren(previewBox({ kind: 'none', reason: 'No preview' }, e)); }
      }
    }

    close() { this.seq++; this.el.hidden = true; this.entry = null; if (this.onClose) this.onClose(); }
  }
  DD.DetailsPanel = DetailsPanel;

  // Side by side: previews and the facts that tell copies apart. Values that
  // differ between the files are highlighted. "Keep this one" stages
  // excluding the others; nothing is deleted.
  DD.compare = async (ids) => {
    const list = await Promise.all(ids.slice(0, 6).map((id) => DD.call('entry.info', { entryId: id })));
    const facts = [
      ['Path', (e) => e.rel_path],
      ['Modified', (e) => DD.fmtDateTime(e.mtime)],
      ['Created', (e) => (e.btime ? DD.fmtDateTime(e.btime) : '–')],
      ['Size', (e) => DD.fmtBytes(e.size)],
      ['Real type', (e) => (e.info ? DD.typeLabel(e.info.type) : '–')],
      ['Taken', (e) => (e.info && e.info.taken ? DD.fmtDateTime(e.info.taken) : '–')],
      ['Camera', (e) => (e.info && e.info.camera) || '–'],
      ['Dimensions', (e) => (e.info ? DD.fmtMP(e.info.width, e.info.height) : '–')],
      ['Last opened', (e) => (e.info && e.info.last_used ? DD.fmtDate(e.info.last_used) : '–')],
      ['Tags', (e) => (e.info && e.info.tags) || '–'],
      ['Planned', (e) => (e.vflags & DD.VF.EXCLUDED ? 'excluded' : e.vpath)],
      ['SHA-256', (e) => (e.hash ? e.hash.slice(0, 12) : 'not computed')],
    ];
    const differs = facts.map(([, f]) => new Set(list.map(f)).size > 1);
    const pick = { id: null };
    const cols = list.map((e) => {
      const prev = h('div', { class: 'dp-prevwrap' }, previewBox(null, e));
      deck.preview(e.id, 280).then((p) => prev.replaceChildren(previewBox(p, e)), () => prev.replaceChildren(previewBox({ kind: 'none', reason: 'No preview' }, e)));
      const btn = h('button', { class: 'btn small', text: 'Keep this one', onclick: () => {
        pick.id = e.id;
        cols.forEach((c) => c.classList.toggle('picked', c === col));
      } });
      const col = h('div', { class: 'cmp-col' }, prev,
        h('table', { class: 'kv' }, h('tbody', {}, facts.map(([k, f], fi) => h('tr', { class: differs[fi] ? 'diff' : '' }, h('th', { text: k }), h('td', { text: f(e), title: f(e) }))))),
        btn);
      return col;
    });
    const same = new Set(list.map((e) => e.hash).filter(Boolean)).size === 1 && list.every((e) => e.hash);
    const v = await DD.confirm({
      title: `Compare ${list.length} files`,
      body: [h('p', { class: 'hint', text: same ? 'Byte-identical (same SHA-256). Highlighted rows are where the copies differ: name, place, dates, tags.' : 'Highlighted rows differ between the files.' }),
        h('div', { class: 'cmp' }, cols)],
      okText: 'Stage: keep the picked one',
    });
    if (v !== true) return;
    if (!pick.id) { DD.toast('Pick a file with “Keep this one” first.', true); return; }
    await DD.stage('exclude', { ids: list.filter((e) => e.id !== pick.id).map((e) => e.id) });
  };
})();
