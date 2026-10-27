'use strict';
// Network failure drills: a real rsync daemon behind a proxy that we cut,
// take down and freeze in the middle of a transfer. The run must recover on
// its own, resume from partial data, and end with a checksum-verified copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SyncRun } = require('../../src/core/runner');
const { newProfile, PARTIAL_DIR } = require('../../src/core/args');
const { tmpdir, snapshot, write, randomBytes, hasRsync } = require('../helpers/fsutil');
const { startDaemon, FlakyProxy } = require('../helpers/netlab');

const skip = hasRsync() ? false : 'rsync not installed';
const SIZE = 8 * 1024 * 1024;

let root, daemon, proxy;
test.beforeEach(async () => {
  if (skip) return;
  root = tmpdir('sd-net-');
  daemon = await startDaemon(root);
  proxy = new FlakyProxy(daemon.port);
  await proxy.listen();
});
test.afterEach(async () => {
  if (skip) return;
  await proxy.close();
  daemon.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function run(profile, hooks = {}) {
  const r = new SyncRun({ profile: newProfile(profile), caps: { modern: true }, backoff: () => 400 });
  const log = { attempts: [], retries: [], progress: 0 };
  r.on('attempt', (e) => log.attempts.push(e.phase));
  r.on('retry', (e) => log.retries.push(e));
  r.on('progress', (p) => { log.progress++; if (hooks.progress) hooks.progress(p, r); });
  return r.start().then((res) => ({ res, log }));
}

test('push: connection cut mid-transfer, then a 3s outage — resumes and verifies', { skip, timeout: 120000 }, async () => {
  const src = path.join(root, 'src');
  write(src, 'video.mov', randomBytes(SIZE, 5));
  write(src, 'notes/today.txt', 'hello\n');
  write(src, 'ünïcødé 🙂.txt', 'x');

  let tripped = false;
  proxy.onBytes = (n) => {
    if (!tripped && n > SIZE * 0.4) {
      tripped = true;
      proxy.down = true;
      proxy.cut();
      setTimeout(() => { proxy.down = false; }, 3000);
    }
  };
  const { res, log } = await run({
    source: src,
    dest: `rsync://127.0.0.1:${proxy.port}/mod/`,
    network: { retries: 20, timeout: 10, bwlimit: '4000' },
  });

  if (process.env.DEBUG_NET) console.error(JSON.stringify({ attempts: res.attempts, codes: log.retries.map((r) => r.code), sent: res.stats.sent, msgs: log.retries.map((r) => r.reason) }));
  assert.ok(tripped, 'the outage really happened mid-transfer');
  assert.equal(res.status, 'success', res.message);
  assert.ok(res.attempts >= 2, `needed more than one attempt (got ${res.attempts})`);
  assert.ok(log.retries.every((r) => [5, 10, 12, 30, 35].includes(r.code)), `retry codes ${log.retries.map((r) => r.code)}`);
  assert.equal(res.verify.ok, true, 'checksum verification passed');
  assert.deepEqual(snapshot(daemon.modPath, { skip: [PARTIAL_DIR] }), snapshot(src));
  // Resume: the last attempt must not have re-sent the whole file.
  assert.ok(res.stats.sent < SIZE * 0.8, `last attempt sent ${res.stats.sent} bytes of ${SIZE}`);
  assert.equal(fs.existsSync(path.join(daemon.modPath, PARTIAL_DIR, 'video.mov')), false, 'partial file cleaned up');
});

test('pull: link silently stalls — stall timeout fires, run reconnects and completes', { skip, timeout: 120000 }, async () => {
  write(daemon.modPath, 'archive.tar', randomBytes(SIZE / 2, 9));
  write(daemon.modPath, 'a/b/c.txt', 'deep');
  const dst = path.join(root, 'local');

  let frozeAt = 0;
  proxy.onBytes = (n) => {
    if (!frozeAt && n > SIZE * 0.15) {
      frozeAt = Date.now();
      proxy.frozen = true;
      // Unfreeze for new connections once the old one has been abandoned.
      setTimeout(() => { proxy.frozen = false; proxy.cut(); }, 6000);
    }
  };
  const { res, log } = await run({
    source: `rsync://127.0.0.1:${proxy.port}/mod/`,
    dest: dst,
    network: { retries: 10, timeout: 3, bwlimit: '3000' },
  });

  assert.ok(frozeAt, 'the stall really happened');
  assert.equal(res.status, 'success', res.message);
  assert.ok(log.retries.length >= 1, 'at least one reconnect');
  assert.ok(log.retries.some((r) => r.code === 30 || r.code === 12 || r.code === 10), `codes ${log.retries.map((r) => r.code)}`);
  assert.equal(res.verify.ok, true);
  assert.deepEqual(snapshot(dst), snapshot(daemon.modPath));
});

test('server unreachable the whole time — gives up cleanly after the retry budget', { skip, timeout: 60000 }, async () => {
  proxy.down = true;
  const src = path.join(root, 'src');
  write(src, 'f', 'f');
  const { res } = await run({ source: src, dest: `rsync://127.0.0.1:${proxy.port}/mod/`, network: { retries: 3, timeout: 5 } });
  assert.equal(res.status, 'failed');
  assert.equal(res.attempts, 4);
  assert.equal(res.verify, null);
  assert.deepEqual(fs.readdirSync(daemon.modPath), []);
});

test('repeated flapping link (cut three times) still ends byte-identical', { skip, timeout: 180000 }, async () => {
  const src = path.join(root, 'src');
  for (let i = 0; i < 3; i++) write(src, `part-${i}.bin`, randomBytes(SIZE / 2, 20 + i));
  const cuts = [0.2, 0.45, 0.7].map((f) => f * SIZE * 1.5);
  let done = 0;
  proxy.onBytes = (n) => {
    if (done < cuts.length && n > cuts[done]) { done++; proxy.cut(); }
  };
  const { res } = await run({ source: src, dest: `rsync://127.0.0.1:${proxy.port}/mod/`, network: { retries: 20, timeout: 10, bwlimit: '5000' } });
  assert.equal(done, 3, 'all three cuts happened');
  assert.equal(res.status, 'success', res.message);
  assert.ok(res.attempts >= 3);
  assert.equal(res.verify.ok, true);
  assert.deepEqual(snapshot(daemon.modPath, { skip: [PARTIAL_DIR] }), snapshot(src));
});
