'use strict';
// The engine API. Runs inside a worker thread (see worker.js) so scans,
// hashing and file operations never block the window. Every call arrives as
// { method, params }; only methods listed in API can be called.
const fs = require('fs');
const path = require('path');
const { openDb, tx } = require('./db');
const { scanSource } = require('./scanner');
const { overview, ISSUE_INFO } = require('./analysis');
const { queryEntries, groupBy, buildWhere } = require('./query');
const { findDuplicates, dupeGroups } = require('./dupes');
const { createPlan, planOps, getPlan } = require('./planner');
const { Executor, undoPlan } = require('./executor');
const { TOKENS, PRESETS, checkTemplate, renderTarget } = require('./template');
const { TARGETS } = require('./compat');
const { CATEGORIES } = require('./categories');
const ws = require('./changes');

const str = (v, name, max = 4096) => {
  if (typeof v !== 'string' || !v || v.length > max || /\0/.test(v)) throw new Error(`Invalid ${name}`);
  return v;
};
const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${name}`);
  return n;
};
const absPath = (v, name) => {
  const p = str(v, name);
  if (!path.isAbsolute(p)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(p);
};

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Prefix formula-looking cells so spreadsheets don't execute them.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

class Engine {
  constructor(dbFile, { emit = () => {} } = {}) {
    this.db = openDb(dbFile);
    this.dbFile = dbFile;
    this.emit = emit;
    this.jobs = new Map();
    this.jobSeq = 0;
    this.busy = null; // only one disk-heavy job at a time
    // Plans left "running" by a crash are marked so the UI can offer resume.
    this.db.prepare("UPDATE plans SET status = 'interrupted' WHERE status = 'running'").run();
    this.db.prepare("UPDATE sources SET status = 'partial' WHERE status = 'scanning'").run();
  }

  close() {
    for (const j of this.jobs.values()) j.signal.aborted = true;
    this.db.close();
  }

  // ── jobs ──
  startJob(kind, label, fn, meta = {}) {
    if (this.busy) throw new Error(`Busy: ${this.busy.label}. Wait for it or cancel it.`);
    const id = ++this.jobSeq;
    const job = { id, kind, label, status: 'running', progress: null, result: null, error: null, startedAt: Date.now(), finishedAt: null, signal: { aborted: false }, ...meta };
    this.jobs.set(id, job);
    this.busy = job;
    const pub = () => this.emit('job', this.jobView(job));
    pub();
    const onProgress = (p) => { job.progress = p; pub(); };
    Promise.resolve()
      .then(() => fn({ signal: job.signal, onProgress }))
      .then((result) => { job.result = result; job.status = job.signal.aborted ? 'cancelled' : 'done'; })
      .catch((e) => { job.error = e.message; job.status = 'failed'; })
      .finally(() => { job.finishedAt = Date.now(); if (this.busy === job) this.busy = null; pub(); });
    return this.jobView(job);
  }

  jobView(j) {
    const { signal, ...rest } = j;
    return rest;
  }

  // ── API ──
  meta() {
    return { dbFile: this.dbFile, sqlite: this.db.prepare('SELECT sqlite_version() AS v').get().v, node: process.versions.node, tokens: TOKENS, presets: PRESETS, targets: Object.fromEntries(Object.entries(TARGETS).map(([k, v]) => [k, v.label])), categories: CATEGORIES, issues: ISSUE_INFO };
  }

  sourcesList() {
    return this.db.prepare('SELECT * FROM sources ORDER BY label COLLATE NOCASE').all();
  }

  sourcesAdd({ path: p, label }) {
    const abs = absPath(p, 'path');
    let st;
    try { st = fs.statSync(abs); } catch (e) { throw new Error(`Cannot open ${abs}: ${e.code}`); }
    if (!st.isDirectory()) throw new Error(`${abs} is not a folder`);
    const existing = this.db.prepare('SELECT * FROM sources WHERE path = ?').get(abs);
    if (existing) return existing;
    const name = label && typeof label === 'string' ? label.slice(0, 120) : path.basename(abs) || abs;
    const r = this.db.prepare('INSERT INTO sources (path, label, created_at) VALUES (?, ?, ?)').run(abs, name, Date.now());
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  sourcesRename({ id, label }) {
    this.db.prepare('UPDATE sources SET label = ? WHERE id = ?').run(str(label, 'label', 120), int(id, 'id'));
    return this.sourcesList();
  }

  // Forgets the catalog entries only; files on disk are not touched.
  sourcesRemove({ id }) {
    if (this.busy && this.busy.sourceId === Number(id)) throw new Error('A job is running on this source.');
    tx(this.db, () => this.db.prepare('DELETE FROM sources WHERE id = ?').run(int(id, 'id')));
    return this.sourcesList();
  }

  scanStart({ sourceId, oneFileSystem = false }) {
    const id = int(sourceId, 'sourceId');
    const src = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!src) throw new Error('Unknown source');
    return this.startJob('scan', `Scanning ${src.label}`, async (j) => {
      const r = await scanSource(this.db, id, { ...j, oneFileSystem: !!oneFileSystem });
      ws.evaluate(this.db, id); // the planned state follows the new catalog
      return r;
    }, { sourceId: id });
  }

  overview({ sourceId }) { return overview(this.db, int(sourceId, 'sourceId')); }

  entriesQuery({ filter, sort, dir, offset, limit, totals }) {
    return queryEntries(this.db, { ...(filter || {}), sourceId: int(filter && filter.sourceId, 'sourceId') }, { sort, dir, offset, limit, totals });
  }

  entriesGroup({ filter, dim, limit, order }) {
    return groupBy(this.db, { ...(filter || {}), sourceId: int(filter && filter.sourceId, 'sourceId') }, String(dim), { limit, order });
  }

  dupesFind({ sourceId }) {
    const id = int(sourceId, 'sourceId');
    const src = this.db.prepare('SELECT label FROM sources WHERE id = ?').get(id);
    if (!src) throw new Error('Unknown source');
    return this.startJob('dupes', `Finding duplicates in ${src.label}`, async (j) => { const r = await findDuplicates(this.db, id, j); ws.evaluate(this.db, id); return r; }, { sourceId: id });
  }

  dupesGroups({ sourceId, offset, limit }) { return dupeGroups(this.db, int(sourceId, 'sourceId'), { offset, limit }); }

  // Shows where a few sample files would go, before building a plan.
  templatePreview({ filter, template, targetFs = 'apfs', limit = 8 }) {
    const errors = checkTemplate(template);
    if (errors.length) return { errors, rows: [] };
    const sourceId = int(filter && filter.sourceId, 'sourceId');
    const src = this.db.prepare('SELECT label FROM sources WHERE id = ?').get(sourceId);
    const { rows } = queryEntries(this.db, { ...filter, sourceId, kinds: ['file'] }, { limit: Math.min(50, limit), totals: false, sort: 'path' });
    return { errors: [], rows: rows.map((e) => ({ from: e.rel_path, to: renderTarget(template, { ...e, parent: e.rel_path.includes('/') ? e.rel_path.slice(0, e.rel_path.lastIndexOf('/')) : '' }, { target: targetFs, source: src && src.label }) })) };
  }

  planCreate(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('Invalid plan');
    return createPlan(this.db, { ...spec, sourceId: int(spec.sourceId, 'sourceId') });
  }

  planGet({ planId }) { return getPlan(this.db, int(planId, 'planId')); }
  planOps(q) { return planOps(this.db, int(q.planId, 'planId'), q); }
  planList({ sourceId }) {
    return this.db.prepare('SELECT id, source_id, created_at, status, summary, started_at, finished_at FROM plans WHERE source_id = ? ORDER BY id DESC LIMIT 100')
      .all(int(sourceId, 'sourceId')).map((p) => ({ ...p, summary: JSON.parse(p.summary) }));
  }
  planDelete({ planId }) {
    const p = getPlan(this.db, int(planId, 'planId'));
    if (p && p.status === 'running') throw new Error('Plan is running');
    this.db.prepare('DELETE FROM plans WHERE id = ?').run(Number(planId));
    return true;
  }

  planExecute({ planId }) {
    const id = int(planId, 'planId');
    const plan = getPlan(this.db, id);
    if (!plan) throw new Error('Unknown plan');
    if (plan.status === 'invalid') throw new Error('This plan has errors; fix them and create a new plan.');
    if (plan.spec.fromWorkspace) {
      const check = ws.exportCheck(this.db, plan.source_id);
      if (check.version !== plan.spec.wsVersion) throw new Error('The planned state changed after this export plan was built. Build the export again so it matches what you reviewed.');
      const blocking = check.items.filter((i) => !i.ok && i.key !== 'checked');
      if (blocking.length) throw new Error(`Export blocked: ${blocking.map((i) => i.label).join('; ')}.`);
    }
    return this.startJob('execute', `${plan.spec.mode === 'move' ? 'Moving' : 'Copying'} files (plan #${id})`, async (j) => {
      const r = await new Executor(this.db, id, j).run();
      if (plan.spec.fromWorkspace && r.status === 'done') this.markExported(plan);
      return r;
    }, { sourceId: plan.source_id, planId: id });
  }

  // After a complete export the reviewed commits are recorded with the plan.
  // An in-place move makes them real on disk, so they stop shaping the
  // planned state; a copy elsewhere leaves the workspace as it was.
  markExported(plan) {
    const inPlace = plan.spec.mode === 'move' && path.resolve(plan.spec.targetRoot) === path.resolve(this.db.prepare('SELECT path FROM sources WHERE id = ?').get(plan.source_id).path);
    const ids = plan.spec.commitIds || [];
    const up = this.db.prepare('UPDATE commits SET status = ?, plan_id = ? WHERE id = ? AND status IN (\'reviewed\', \'exported\')');
    tx(this.db, () => { for (const c of ids) up.run(inPlace ? 'applied' : 'exported', plan.id, c); });
    if (!inPlace) ws.evaluate(this.db, plan.source_id);
  }

  planUndo({ planId }) {
    const id = int(planId, 'planId');
    const plan = getPlan(this.db, id);
    if (!plan) throw new Error('Unknown plan');
    return this.startJob('undo', `Undoing plan #${id}`, async (j) => {
      const r = await undoPlan(this.db, id, j);
      // Undone exports return their commits to "reviewed", ready to export again.
      if (plan.spec.fromWorkspace) {
        this.db.prepare("UPDATE commits SET status = 'reviewed', plan_id = NULL WHERE plan_id = ?").run(id);
        ws.evaluate(this.db, plan.source_id);
      }
      return r;
    }, { sourceId: plan.source_id, planId: id });
  }

  // ── workspace: stage → commit → review → export ──
  guardSource(id) {
    if (this.busy && this.busy.sourceId === id && ['scan', 'execute', 'undo'].includes(this.busy.kind)) throw new Error(`Busy: ${this.busy.label}. Wait for it to finish.`);
  }
  wsSummary({ sourceId }) { return ws.summary(this.db, int(sourceId, 'sourceId')); }
  wsList({ sourceId }) { return ws.listChanges(this.db, { sourceId: int(sourceId, 'sourceId') }); }
  wsStage({ sourceId, op, params, selection, label }) {
    const id = int(sourceId, 'sourceId');
    this.guardSource(id);
    return ws.stage(this.db, { sourceId: id, op: String(op), params: params || {}, selection: selection || {}, label });
  }
  wsUnstage({ sourceId, changeId }) { return ws.unstage(this.db, { sourceId: int(sourceId, 'sourceId'), changeId: int(changeId, 'changeId') }); }
  wsDiscardStaged({ sourceId }) {
    const id = int(sourceId, 'sourceId');
    this.db.prepare('DELETE FROM changes WHERE source_id = ? AND commit_id IS NULL').run(id);
    return ws.evaluate(this.db, id);
  }
  wsCommit({ sourceId, message }) { return ws.commit(this.db, { sourceId: int(sourceId, 'sourceId'), message }); }
  wsReview({ sourceId, commitId, reviewed }) { return ws.review(this.db, { sourceId: int(sourceId, 'sourceId'), commitId: int(commitId, 'commitId'), reviewed: reviewed !== false }); }
  wsRevert({ sourceId, commitId }) {
    const id = int(sourceId, 'sourceId');
    this.guardSource(id);
    return ws.revert(this.db, { sourceId: id, commitId: int(commitId, 'commitId') });
  }
  wsTarget({ sourceId, targetFs }) { return ws.setTarget(this.db, { sourceId: int(sourceId, 'sourceId'), targetFs: String(targetFs) }); }
  wsDiff(q) { return ws.diff(this.db, { ...q, sourceId: int(q.sourceId, 'sourceId') }); }
  wsFolders({ sourceId, depth }) { return ws.plannedFolders(this.db, { sourceId: int(sourceId, 'sourceId'), depth }); }
  wsCheck({ sourceId }) { return ws.exportCheck(this.db, int(sourceId, 'sourceId')); }
  wsVerify({ sourceId }) {
    const id = int(sourceId, 'sourceId');
    const src = this.db.prepare('SELECT label FROM sources WHERE id = ?').get(id);
    if (!src) throw new Error('Unknown source');
    return this.startJob('verify', `Re-checking ${src.label} against the disk`, (j) => ws.verifySources(this.db, id, j), { sourceId: id });
  }

  // Builds the export plan from the reviewed planned state. Refuses unless
  // every check passes; the plan remembers the state version it was built from.
  wsExport({ sourceId, targetRoot, mode = 'copy', conflict = 'skip', finalReview }) {
    const id = int(sourceId, 'sourceId');
    this.guardSource(id);
    if (finalReview !== true) throw new Error('Confirm that you reviewed the final state.');
    const check = ws.exportCheck(this.db, id);
    if (!check.ok) return { ok: false, errors: check.items.filter((i) => !i.ok).map((i) => `${i.label}. ${i.fix}`), warnings: check.warnings };
    const commitIds = this.db.prepare(`SELECT id FROM commits WHERE source_id = ? AND status IN ${ws.ACTIVE}`).all(id).map((r) => r.id);
    return createPlan(this.db, { sourceId: id, fromWorkspace: true, wsVersion: check.version, commitIds, targetRoot, mode, conflict, targetFs: check.targetFs, template: '(planned state)', filter: {}, skipJunk: false, dedupe: false });
  }

  jobCancel({ jobId }) {
    const j = this.jobs.get(int(jobId, 'jobId'));
    if (j) j.signal.aborted = true;
    return !!j;
  }

  jobsList() { return [...this.jobs.values()].slice(-50).reverse().map((j) => this.jobView(j)); }

  // Writes the filtered table, or a plan's journal, as CSV.
  exportCsv({ file, filter, planId }) {
    const out = absPath(file, 'file');
    const tmp = `${out}.part`;
    const fd = fs.openSync(tmp, 'w', 0o644);
    let n = 0;
    try {
      const line = (cells) => fs.writeSync(fd, `${cells.map(csvCell).join(',')}\n`);
      if (planId !== undefined && planId !== null) {
        line(['seq', 'op', 'status', 'source', 'target', 'bytes', 'sha256_source', 'sha256_target', 'note', 'error', 'done_at']);
        for (const r of this.db.prepare('SELECT * FROM plan_ops WHERE plan_id = ? ORDER BY seq').iterate(int(planId, 'planId'))) {
          line([r.seq, r.op, r.status, r.src, r.dst, r.size, r.src_hash, r.dst_hash, r.note, r.error, r.done_at ? new Date(r.done_at).toISOString() : '']);
          n++;
        }
      } else {
        const f = { ...(filter || {}), sourceId: int(filter && filter.sourceId, 'sourceId') };
        const { where, params } = buildWhere(f);
        line(['path', 'name', 'kind', 'category', 'extension', 'bytes', 'modified', 'depth', 'sha256', 'issues', 'error']);
        const it = this.db.prepare(`SELECT e.*, (SELECT GROUP_CONCAT(code) FROM issues i WHERE i.entry_id = e.id) AS issue_codes
          FROM entries e WHERE ${where} ORDER BY e.rel_path`).iterate(...params);
        for (const r of it) {
          line([r.rel_path, r.name, r.kind, r.category, r.ext, r.kind === 'dir' ? r.tree_bytes : r.size, r.mtime ? new Date(r.mtime).toISOString() : '', r.depth, r.hash, r.issue_codes, r.error]);
          n++;
        }
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, out);
    return { file: out, rows: n };
  }
}

const API = {
  meta: 'meta', 'sources.list': 'sourcesList', 'sources.add': 'sourcesAdd', 'sources.rename': 'sourcesRename', 'sources.remove': 'sourcesRemove',
  'scan.start': 'scanStart', overview: 'overview', 'entries.query': 'entriesQuery', 'entries.group': 'entriesGroup',
  'dupes.find': 'dupesFind', 'dupes.groups': 'dupesGroups',
  'template.preview': 'templatePreview', 'plan.get': 'planGet', 'plan.ops': 'planOps', 'plan.list': 'planList', 'plan.delete': 'planDelete',
  'plan.execute': 'planExecute', 'plan.undo': 'planUndo',
  'ws.summary': 'wsSummary', 'ws.list': 'wsList', 'ws.stage': 'wsStage', 'ws.unstage': 'wsUnstage', 'ws.discard': 'wsDiscardStaged', 'ws.commit': 'wsCommit',
  'ws.review': 'wsReview', 'ws.revert': 'wsRevert', 'ws.target': 'wsTarget', 'ws.diff': 'wsDiff', 'ws.folders': 'wsFolders', 'ws.check': 'wsCheck', 'ws.verify': 'wsVerify', 'ws.export': 'wsExport',
  'job.cancel': 'jobCancel', 'jobs.list': 'jobsList', 'export.csv': 'exportCsv',
};

function call(engine, method, params) {
  const fn = API[method];
  if (!fn) throw new Error(`Unknown method ${method}`);
  return engine[fn](params || {});
}

module.exports = { Engine, API, call, csvCell };
