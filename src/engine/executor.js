'use strict';
// Carries out a restructure plan, one file at a time, with these guarantees:
//  * Nothing existing is ever overwritten. Files are written to a temp name
//    and published with link() (atomic, fails if the name is taken).
//  * Every copy is hashed while reading the source and again from the disk
//    after fsync; it is only published if both hashes match.
//  * A source is only deleted (move) after its copy is verified, or it is
//    renamed in place on the same disk.
//  * Every step is journaled in the catalog before and after, so a crash or
//    power cut is recovered on the next run, and a finished plan can be undone.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { hashFile, ALGO } = require('./hash');
const { getPlan } = require('./planner');
const { numbered } = require('./template');

const CHUNK = 1 << 20;

const tmpName = (dst, planId, opId) => path.join(path.dirname(dst), `.dmtmp-${planId}-${opId}`);

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

async function fsyncDir(dir) {
  let fh;
  try { fh = await fsp.open(dir, 'r'); await fh.sync(); } catch { /* not supported everywhere */ } finally { if (fh) await fh.close().catch(() => {}); }
}

// Publish tmp at dst without ever replacing an existing file.
async function publish(tmp, dst) {
  try {
    await fsp.link(tmp, dst);
    await fsp.unlink(tmp);
    return;
  } catch (e) {
    if (e.code === 'EEXIST') throw Object.assign(new Error('target appeared during the run'), { code: 'EEXIST' });
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'].includes(e.code)) throw e;
  }
  // File systems without hard links (exFAT, FAT32, some network shares).
  if (await exists(dst)) throw Object.assign(new Error('target appeared during the run'), { code: 'EEXIST' });
  await fsp.rename(tmp, dst);
}

// Copy src to tmp, hashing on the way, fsync, then re-read and hash again.
async function copyVerified(src, tmp, { signal, onBytes, faults, op }) {
  const h = crypto.createHash(ALGO);
  const rd = await fsp.open(src, 'r');
  let wr;
  try {
    wr = await fsp.open(tmp, 'wx', 0o600);
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    for (;;) {
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ECANCELED' });
      const { bytesRead } = await rd.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
      let off = 0;
      while (off < bytesRead) {
        const { bytesWritten } = await wr.write(buf, off, bytesRead - off, pos + off);
        off += bytesWritten;
      }
      pos += bytesRead;
      onBytes(bytesRead);
    }
    await wr.sync();
  } finally {
    await rd.close().catch(() => {});
    if (wr) await wr.close().catch(() => {});
  }
  const srcHash = h.digest('hex');
  if (faults && faults.corrupt && faults.corrupt(op)) {
    const fh = await fsp.open(tmp, 'r+');
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, 0);
    b[0] ^= 0xff;
    await fh.write(b, 0, 1, 0);
    await fh.close();
  }
  const dstHash = await hashFile(tmp, { signal });
  return { srcHash, dstHash };
}

async function mkdirp(dir, created) {
  const parts = [];
  let cur = dir;
  while (!(await exists(cur))) { parts.unshift(cur); cur = path.dirname(cur); }
  for (const p of parts) {
    try { await fsp.mkdir(p); created.add(p); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

async function freeName(dst) {
  let n = 2;
  const dir = path.dirname(dst);
  const base = path.basename(dst);
  while (await exists(path.join(dir, numbered(base, n)))) n++;
  return path.join(dir, numbered(base, n));
}

class Executor {
  constructor(db, planId, { signal = { aborted: false }, onProgress, faults } = {}) {
    this.db = db;
    this.planId = Number(planId);
    this.signal = signal;
    this.onProgress = onProgress;
    this.faults = faults || null;
    this.plan = getPlan(db, planId);
    if (!this.plan) throw new Error(`Unknown plan ${planId}`);
    this.spec = this.plan.spec;
    this.createdDirs = new Set();
    this.stats = { done: 0, skipped: 0, failed: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: '', recovered: 0 };
    this.lastEmit = 0;
    this.t0 = Date.now();
    this.q = {
      setStatus: db.prepare('UPDATE plan_ops SET status = ?, note = COALESCE(?, note), error = ?, done_at = ? WHERE id = ?'),
      finish: db.prepare('UPDATE plan_ops SET status = ?, note = COALESCE(?, note), dst = ?, src_hash = ?, dst_hash = ?, error = NULL, done_at = ? WHERE id = ?'),
      plan: db.prepare('UPDATE plans SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?'),
    };
  }

  emit(force) {
    const now = Date.now();
    if (!this.onProgress || (!force && now - this.lastEmit < 150)) return;
    this.lastEmit = now;
    this.onProgress({ ...this.stats, elapsedMs: now - this.t0 });
  }

  // After a crash: settle ops left in "running".
  async recover() {
    const rows = this.db.prepare("SELECT * FROM plan_ops WHERE plan_id = ? AND status = 'running'").all(this.planId);
    for (const op of rows) {
      const tmp = tmpName(op.dst, this.planId, op.id);
      await fsp.unlink(tmp).catch(() => {});
      const srcThere = await exists(op.src);
      const dstThere = await exists(op.dst);
      if (dstThere && srcThere) {
        const [a, b] = await Promise.all([hashFile(op.src), hashFile(op.dst)]);
        if (a === b) {
          if (op.op === 'move') await fsp.unlink(op.src);
          this.q.finish.run('done', 'recovered after interruption', op.dst, a, b, Date.now(), op.id);
        } else {
          this.q.setStatus.run('pending', null, null, null, op.id);
        }
      } else if (dstThere && !srcThere && op.op === 'move') {
        const b = await hashFile(op.dst);
        this.q.finish.run('done', 'recovered after interruption', op.dst, op.src_hash || b, b, Date.now(), op.id);
      } else {
        this.q.setStatus.run('pending', null, null, null, op.id);
      }
      this.stats.recovered++;
    }
  }

  async run() {
    const { db, planId } = this;
    if (!['draft', 'running', 'cancelled', 'failed', 'done-with-errors', 'interrupted'].includes(this.plan.status)) {
      throw new Error(`Plan is ${this.plan.status}; it cannot be run.`);
    }
    this.q.plan.run('running', Date.now(), null, planId);
    await this.recover();
    const tot = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM plan_ops WHERE plan_id = ? AND status IN ('pending', 'failed')").get(planId);
    this.stats.total = tot.n;
    this.stats.bytesTotal = tot.b;
    const ops = db.prepare("SELECT * FROM plan_ops WHERE plan_id = ? AND status IN ('pending', 'failed') ORDER BY seq").all(planId);
    let n = 0;
    for (const op of ops) {
      if (this.signal.aborted) break;
      this.stats.current = op.dst;
      this.emit(false);
      await this.runOne(op);
      n++;
      if (this.faults && this.faults.crashAfter && n >= this.faults.crashAfter) {
        throw Object.assign(new Error('simulated crash'), { code: 'SIMULATED_CRASH' });
      }
    }
    if (this.spec.mode === 'move' && this.spec.pruneEmpty !== false && !this.signal.aborted) await this.pruneSourceDirs();
    const failed = db.prepare("SELECT COUNT(*) AS n FROM plan_ops WHERE plan_id = ? AND status = 'failed'").get(planId).n;
    const status = this.signal.aborted ? 'cancelled' : failed ? 'done-with-errors' : 'done';
    this.q.plan.run(status, null, Date.now(), planId);
    this.emit(true);
    return { status, ...this.stats, failed };
  }

  async runOne(op) {
    const now = () => Date.now();
    this.q.setStatus.run('running', null, null, null, op.id);
    try {
      const st = await fsp.lstat(op.src).catch((e) => { throw Object.assign(new Error(`source missing: ${e.code}`), { code: 'SRC' }); });
      if (!st.isFile()) throw Object.assign(new Error('source is no longer a regular file'), { code: 'SRC' });
      if (st.size !== op.size || (op.mtime && Math.abs(Math.floor(st.mtimeMs) - op.mtime) > 1)) {
        throw Object.assign(new Error('source changed since the scan; rescan and plan again'), { code: 'SRC' });
      }
      await mkdirp(path.dirname(op.dst), this.createdDirs);
      let dst = op.dst;
      let note = null;

      if (await exists(dst)) {
        const dstSt = await fsp.lstat(dst);
        if (dstSt.isFile() && dstSt.size === st.size) {
          const [a, b] = await Promise.all([hashFile(op.src, { signal: this.signal }), hashFile(dst, { signal: this.signal })]);
          if (a === b) {
            if (op.op === 'move' && !(dstSt.ino === st.ino && dstSt.dev === st.dev)) {
              await fsp.unlink(op.src);
              note = 'identical file already at target; original removed';
            } else note = 'identical file already at target';
            this.q.finish.run('skipped', note, dst, a, b, now(), op.id);
            this.stats.skipped++;
            this.stats.bytesDone += op.size;
            return;
          }
        }
        if (this.spec.conflict === 'skip') {
          this.q.setStatus.run('skipped', 'target exists with different content', null, now(), op.id);
          this.stats.skipped++;
          return;
        }
        dst = await freeName(dst);
        note = 'renamed: target exists';
      }

      const dstDev = (await fsp.stat(path.dirname(dst))).dev;
      if (op.op === 'move' && dstDev === st.dev) {
        await this.moveSameDisk(op, st, dst, note);
      } else {
        await this.copyThenMaybeDelete(op, st, dst, note);
      }
      this.stats.done++;
    } catch (e) {
      if (e.code === 'SIMULATED_CRASH') throw e;
      const tmp = tmpName(op.dst, this.planId, op.id);
      await fsp.unlink(tmp).catch(() => {});
      if (e.code === 'ECANCELED') {
        this.q.setStatus.run('pending', null, null, null, op.id);
        return;
      }
      this.q.setStatus.run('failed', null, `${e.code ? `${e.code}: ` : ''}${e.message}`, now(), op.id);
      this.stats.failed++;
    }
  }

  async moveSameDisk(op, st, dst, note) {
    // link + unlink: atomic, never replaces. Fallback rename after a check.
    try {
      await fsp.link(op.src, dst);
      const a = await fsp.lstat(dst);
      if (a.ino !== st.ino) throw new Error('link verification failed');
      await fsp.unlink(op.src);
    } catch (e) {
      if (e.code === 'EEXIST') throw e;
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'].includes(e.code)) throw e;
      if (await exists(dst)) throw Object.assign(new Error('target appeared during the run'), { code: 'EEXIST' });
      await fsp.rename(op.src, dst);
    }
    await fsyncDir(path.dirname(dst));
    await fsyncDir(path.dirname(op.src));
    // Same inode: the data is untouched; record its hash for undo checks.
    const h = await hashFile(dst, { signal: { aborted: false } });
    this.q.finish.run('done', note || 'renamed on same disk', dst, h, h, Date.now(), op.id);
    this.stats.bytesDone += op.size;
  }

  async copyThenMaybeDelete(op, st, dst, note) {
    const tmp = tmpName(dst, this.planId, op.id);
    await fsp.unlink(tmp).catch(() => {});
    const { srcHash, dstHash } = await copyVerified(op.src, tmp, {
      signal: this.signal,
      faults: this.faults,
      op,
      onBytes: (n) => { this.stats.bytesDone += n; this.emit(false); },
    });
    if (srcHash !== dstHash) {
      await fsp.unlink(tmp).catch(() => {});
      throw Object.assign(new Error('checksum mismatch after writing; target disk or connection is unreliable'), { code: 'EVERIFY' });
    }
    const after = await fsp.lstat(op.src);
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) {
      await fsp.unlink(tmp).catch(() => {});
      throw Object.assign(new Error('source was modified while copying'), { code: 'SRC' });
    }
    await fsp.utimes(tmp, st.atime, st.mtime);
    await fsp.chmod(tmp, st.mode & 0o7777).catch(() => {});
    await publish(tmp, dst);
    await fsyncDir(path.dirname(dst));
    if (op.op === 'move') {
      // Only now, with a verified and published copy, remove the original.
      await fsp.unlink(op.src);
      await fsyncDir(path.dirname(op.src));
    }
    this.q.finish.run('done', note, dst, srcHash, dstHash, Date.now(), op.id);
  }

  // After a move, remove source folders that are now empty. rmdir only:
  // it fails on anything that still has content.
  async pruneSourceDirs() {
    const src = this.db.prepare('SELECT path FROM sources WHERE id = ?').get(this.plan.source_id);
    if (!src) return;
    const root = path.resolve(src.path);
    const dirs = new Set();
    for (const r of this.db.prepare("SELECT src FROM plan_ops WHERE plan_id = ? AND status = 'done'").all(this.planId)) {
      let d = path.dirname(r.src);
      while (d.startsWith(root + path.sep)) { dirs.add(d); d = path.dirname(d); }
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      try {
        await fsp.rmdir(d);
      } catch { /* not empty: keep */ }
    }
  }
}

// Reverses a finished plan. Copies are removed only if they still match what
// was written; moves are moved back with the same verification.
async function undoPlan(db, planId, { signal = { aborted: false }, onProgress } = {}) {
  const plan = getPlan(db, planId);
  if (!plan) throw new Error(`Unknown plan ${planId}`);
  const ops = db.prepare("SELECT * FROM plan_ops WHERE plan_id = ? AND status = 'done' ORDER BY seq DESC").all(Number(planId));
  const set = db.prepare('UPDATE plan_ops SET status = ?, note = ? WHERE id = ?');
  const stats = { undone: 0, kept: 0, failed: 0, total: ops.length };
  const touchedDirs = new Set();
  for (const op of ops) {
    if (signal.aborted) break;
    try {
      if (!(await exists(op.dst))) { set.run('undone', 'target already gone', op.id); stats.kept++; continue; }
      const h = await hashFile(op.dst, { signal });
      if (h !== op.dst_hash) { set.run('done', 'changed since the run; left in place', op.id); stats.kept++; continue; }
      if (op.op === 'copy') {
        await fsp.unlink(op.dst);
      } else {
        await mkdirp(path.dirname(op.src), new Set());
        if (await exists(op.src)) { set.run('done', 'original location is taken; left in place', op.id); stats.kept++; continue; }
        const sameDisk = (await fsp.stat(path.dirname(op.src))).dev === (await fsp.stat(op.dst)).dev;
        if (sameDisk) {
          try { await fsp.link(op.dst, op.src); await fsp.unlink(op.dst); } catch (e) {
            if (e.code === 'EEXIST') throw e;
            await fsp.rename(op.dst, op.src);
          }
        } else {
          const tmp = path.join(path.dirname(op.src), `.dmtmp-undo-${op.id}`);
          const r = await copyVerified(op.dst, tmp, { signal, onBytes: () => {}, op });
          if (r.srcHash !== r.dstHash) { await fsp.unlink(tmp).catch(() => {}); throw new Error('checksum mismatch while moving back'); }
          const st = await fsp.stat(op.dst);
          await fsp.utimes(tmp, st.atime, st.mtime);
          await publish(tmp, op.src);
          await fsp.unlink(op.dst);
        }
      }
      touchedDirs.add(path.dirname(op.dst));
      set.run('undone', null, op.id);
      stats.undone++;
    } catch (e) {
      set.run('done', `undo failed: ${e.message}`, op.id);
      stats.failed++;
    }
    if (onProgress) onProgress({ ...stats });
  }
  // Remove folders the plan created that are now empty.
  const root = path.resolve(plan.spec.targetRoot);
  const dirs = new Set();
  for (const d of touchedDirs) { let x = d; while (x.startsWith(root + path.sep)) { dirs.add(x); x = path.dirname(x); } }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) await fsp.rmdir(d).catch(() => {});
  db.prepare('UPDATE plans SET status = ?, finished_at = ? WHERE id = ?').run(stats.failed ? 'undo-partial' : 'undone', Date.now(), Number(planId));
  return stats;
}

module.exports = { Executor, undoPlan, publish, copyVerified };
