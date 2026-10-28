'use strict';
// Main-process side of the engine worker: promise-based calls, event fan-out,
// automatic restart if the worker dies.
const { Worker } = require('worker_threads');
const path = require('path');
const { API } = require('./engine');

const SLOW = new Set(['export.csv', 'plan.create', 'overview', 'sources.remove']);

class EngineClient {
  constructor(dbFile, { onEvent = () => {}, timeoutMs = 120000 } = {}) {
    this.dbFile = dbFile;
    this.onEvent = onEvent;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { dbFile: this.dbFile } });
    this.worker.on('message', (m) => {
      if (m.event) { this.onEvent(m.event, m.data); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    });
    this.worker.on('error', (e) => this.onEvent('engine-error', { message: e.message }));
    this.worker.on('exit', (code) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Engine stopped')); }
      this.pending.clear();
      if (!this.closed) {
        this.onEvent('engine-restart', { code });
        setTimeout(() => this.spawn(), 500);
      }
    });
  }

  call(method, params) {
    if (!Object.prototype.hasOwnProperty.call(API, method)) return Promise.reject(new Error(`Unknown method ${method}`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      // Synchronous whole-catalog work (CSV export, planning a huge tree) may take minutes.
      const ms = SLOW.has(method) ? this.timeoutMs * 10 : this.timeoutMs;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, params });
    });
  }

  async close() {
    this.closed = true;
    this.worker.postMessage({ type: 'close' });
    await new Promise((r) => { this.worker.once('exit', r); setTimeout(r, 2000); });
  }
}

module.exports = { EngineClient, SLOW };
