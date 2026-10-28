'use strict';
const fs = require('fs');
const path = require('path');
const { Engine } = require('../../src/engine/engine');
const { tmpdir } = require('./fsutil');

process.removeAllListeners('warning');

// A fresh engine with its own catalog file, plus a helper to await jobs.
function makeEngine() {
  const dir = tmpdir('dm-eng-');
  const events = [];
  const engine = new Engine(path.join(dir, 'catalog.sqlite'), { emit: (e, d) => events.push([e, d]) });
  const waitJob = (job) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const j = engine.jobs.get(job.id);
      if (j.status !== 'running') return j.status === 'failed' ? reject(new Error(j.error)) : resolve(engine.jobView(j));
      if (Date.now() - t0 > 120000) return reject(new Error('job timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
  const cleanup = () => { try { engine.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); };
  return { engine, events, waitJob, cleanup, dir };
}

module.exports = { makeEngine };
