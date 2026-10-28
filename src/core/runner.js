'use strict';
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { buildArgs, normalizeProfile, hasCap } = require('./args');
const { parseItem, parseItemize, parseProgress, parseStats, LineSplitter, describeExit } = require('./parse');
const { isRetryable, backoffMs } = require('./safety');

const UTF8_LOCALE = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';

/**
 * One sync job: the transfer (with automatic retry/resume on network errors)
 * and, after a real run, a checksum verify pass.
 *
 * Events:
 *   phase    { phase: 'preview'|'transfer'|'verify' }
 *   attempt  { phase, attempt, maxAttempts, args }
 *   item     { phase, item }
 *   progress { phase, bytes, percent, overall, rate, eta, xfr, toCheck, total, file }
 *   log      { phase, stream, line }
 *   retry    { phase, attempt, code, reason, delayMs, at }
 *   done     result (see finish())
 */
class SyncRun extends EventEmitter {
  constructor({ bin = 'rsync', profile, caps = { modern: true }, dryRun = false, spawn = childProcess.spawn, backoff = backoffMs, killGraceMs = 5000 }) {
    super();
    this.bin = bin;
    this.profile = normalizeProfile(profile);
    this.caps = caps;
    this.dryRun = dryRun;
    this.spawn = spawn;
    this.backoff = backoff;
    this.killGraceMs = killGraceMs;
    this.stopped = false;
    this.child = null;
    this.sleepTimer = null;
    this.sleepResolve = null;
    this.items = new Map();
    this.verifyItems = [];
    this.attempts = 0;
    this.retries = [];
  }

  async start() {
    const t0 = Date.now();
    const phase = this.dryRun ? 'preview' : 'transfer';
    const transfer = await this.runPhase(phase, buildArgs(this.profile, { dryRun: this.dryRun, caps: this.caps }));

    let verify = null;
    const transferOk = transfer.code === 0 || transfer.code === 24;
    if (!this.dryRun && transferOk && this.profile.safety.verifyAfter && !this.stopped) {
      const v = await this.runPhase('verify', buildArgs(this.profile, { verify: true, caps: this.caps }));
      // Attribute-only differences (".f..t....") are not content mismatches.
      const mismatches = this.verifyItems.filter((it) => ['new', 'update', 'delete', 'mkdir'].includes(it.action));
      verify = { code: v.code, ok: v.code === 0 && mismatches.length === 0, mismatches, checked: v.stats.files ?? null, error: v.code === 0 ? null : v.message };
    }
    return this.finish(transfer, verify, Date.now() - t0);
  }

  finish(transfer, verify, durationMs) {
    let status;
    let message;
    if (this.stopped) { status = 'stopped'; message = 'Stopped by you.'; }
    else if (transfer.code === 0) { status = 'success'; message = this.dryRun ? 'Preview complete. Nothing was changed.' : 'Sync complete.'; }
    else if (transfer.code === 24) { status = 'warning'; message = 'Sync complete, but some source files vanished while copying.'; }
    else if (transfer.code === 25) { status = 'warning'; message = 'Stopped deleting at the max-delete limit. Review the preview and raise the limit if this is expected.'; }
    else { status = 'failed'; message = transfer.message; }

    if (verify && status !== 'stopped') {
      if (verify.ok) message += ` Verified: every file matches by checksum.`;
      else if (verify.code !== 0) { status = 'verify-failed'; message += ` Verification could not finish: ${verify.error}`; }
      else { status = 'verify-failed'; message += ` Verification found ${verify.mismatches.length} mismatch(es).`; }
    }

    const items = [...this.items.values()];
    const counts = { new: 0, update: 0, delete: 0, mkdir: 0, meta: 0, link: 0, other: 0 };
    let bytes = 0;
    for (const it of items) {
      counts[it.action] = (counts[it.action] || 0) + 1;
      if ((it.action === 'new' || it.action === 'update') && it.kind === 'file') bytes += it.size;
    }
    const result = {
      status, message, code: transfer.code, dryRun: this.dryRun,
      attempts: this.attempts, retries: this.retries, durationMs,
      counts, bytes, stats: transfer.stats, verify, itemCount: items.length,
    };
    this.emit('done', result);
    return result;
  }

  async runPhase(phase, args) {
    this.emit('phase', { phase });
    const maxAttempts = Math.max(1, Math.floor(Number(this.profile.network.retries) || 0) + 1);
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.stopped) break;
      if (phase !== 'verify') this.attempts = attempt;
      else this.verifyItems = [];
      this.emit('attempt', { phase, attempt, maxAttempts, args });
      last = await this.spawnOnce(phase, args);
      if (this.stopped || last.code === 0 || !isRetryable(last.code) || attempt === maxAttempts) break;
      const delayMs = this.backoff(attempt);
      const info = { phase, attempt, code: last.code, reason: last.message, delayMs, at: Date.now() };
      if (phase !== 'verify') this.retries.push(info);
      this.emit('retry', info);
      await this.sleep(delayMs);
    }
    if (this.stopped && last && last.code === 0) return last;
    return last || { code: -1, message: 'Stopped before start.', stats: {} };
  }

  spawnOnce(phase, args) {
    return new Promise((resolve) => {
      let stderrTail = [];
      let statsText = '';
      let currentFile = '';
      const env = { ...process.env, LC_ALL: UTF8_LOCALE, LANG: UTF8_LOCALE };
      let child;
      try {
        child = this.spawn(this.bin, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ code: -1, message: `Could not start rsync: ${e.message}`, stats: {} });
        return;
      }
      this.child = child;

      const onOut = (line, isCR) => {
        const item = parseItem(line) || (this.caps.outFormat === false ? parseItemize(line) : null);
        if (item) {
          currentFile = item.path;
          if (phase === 'verify') this.verifyItems.push(item);
          else this.items.set(item.path, item);
          this.emit('item', { phase, item });
          return;
        }
        const prog = parseProgress(line);
        if (prog) {
          let overall = prog.percent;
          if (!hasCap(this.caps, 'progress2') && prog.total) overall = Math.round(((prog.total - prog.toCheck) / prog.total) * 100);
          this.emit('progress', { phase, ...prog, overall, file: currentFile });
          return;
        }
        if (!isCR) {
          statsText += line + '\n';
          this.emit('log', { phase, stream: 'stdout', line });
        }
      };
      const out = new LineSplitter(onOut);
      const err = new LineSplitter((line) => {
        stderrTail.push(line);
        if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
        this.emit('log', { phase, stream: 'stderr', line });
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));

      let settled = false;
      const done = (code, errMsg) => {
        if (settled) return;
        settled = true;
        out.flush();
        err.flush();
        this.child = null;
        const lastErr = stderrTail.filter((l) => !/^rsync error:/.test(l) && /error|failed|refused|denied|timeout|timed out|closed|reset|unreachable|No such|Permission/i.test(l)).pop();
        const message = errMsg || (code === 0 ? 'OK' : `${describeExit(code)}${lastErr ? ` — ${lastErr.replace(/^rsync:\s*/, '')}` : ''}`);
        resolve({ code, message, stats: parseStats(statsText) });
      };
      child.on('error', (e) => done(-1, e.code === 'ENOENT' ? `rsync not found at "${this.bin}". Check Settings.` : `Could not start rsync: ${e.message}`));
      child.on('close', (code, signal) => done(code === null ? (signal ? 20 : -1) : code));
    });
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimer = setTimeout(() => { this.sleepTimer = null; this.sleepResolve = null; resolve(); }, ms);
    });
  }

  stop() {
    this.stopped = true;
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
      const r = this.sleepResolve;
      this.sleepResolve = null;
      if (r) r();
    }
    const child = this.child;
    if (child) {
      child.kill('SIGTERM');
      const t = setTimeout(() => { if (this.child === child) child.kill('SIGKILL'); }, this.killGraceMs);
      if (t.unref) t.unref();
    }
  }
}

function detectRsync(bin, spawn = childProcess.spawn) {
  const { parseVersion } = require('./parse');
  const { probeCaps } = require('./probe');
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, bin, error: e.message });
      return;
    }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, bin, error: e.code === 'ENOENT' ? 'not found' : e.message }));
    child.on('close', async () => {
      const v = parseVersion(out);
      if (!v) return resolve({ ok: false, bin, error: 'Unrecognized rsync version output', raw: out.split('\n')[0] });
      const caps = await probeCaps(bin, spawn);
      if (!caps.endOfOptions) return resolve({ ok: false, bin, ...v, error: 'This rsync failed a basic test run', raw: out.split('\n')[0] });
      resolve({ ok: true, bin, ...v, caps: { ...caps, modern: v.modern, openrsync: v.openrsync }, raw: out.split('\n')[0] });
    });
  });
}

module.exports = { SyncRun, detectRsync };
