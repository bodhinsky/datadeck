'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { SyncRun } = require('../../src/core/runner');
const { newProfile } = require('../../src/core/args');

// A scripted stand-in for child_process.spawn. Each call consumes one step:
// { out: [...stdout chunks], err: [...stderr chunks], code, hang }
function fakeSpawn(steps) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const step = steps[calls.length] || { code: 0 };
    calls.push({ bin, args, opts });
    if (step.throws) throw step.throws;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = null;
    child.kill = (sig) => {
      child.killed = sig;
      setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', null, sig); });
    };
    setImmediate(() => {
      if (step.error) return child.emit('error', step.error);
      for (const c of step.out || []) child.stdout.write(c);
      for (const c of step.err || []) child.stderr.write(c);
      if (step.hang) return;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', step.code ?? 0, null));
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const P = (over = {}) => newProfile({ source: '/s', dest: '/d', ...over });
const item = (code, size, p) => `::SD::${code}|${size}|${p}\n`;
const noWait = () => 1;

test('retries a network failure and resumes', async () => {
  const spawn = fakeSpawn([
    { out: [item('>f+++++++++', 100, 'a'), '     50  50%  1.00MB/s  0:00:01 (xfr#1, to-chk=1/2)\r'], err: ['rsync: connection unexpectedly closed (0 bytes received so far) [sender]\n'], code: 12 },
    { out: [item('>f+++++++++', 100, 'a'), item('>f+++++++++', 200, 'b'), 'Number of files: 2\n'], code: 0 },
    { code: 0 }, // verify
  ]);
  const run = new SyncRun({ profile: P(), spawn, backoff: noWait });
  const events = [];
  for (const e of ['phase', 'attempt', 'retry', 'progress']) run.on(e, (x) => events.push([e, x.phase, x.attempt]));
  const r = await run.start();
  assert.equal(r.status, 'success');
  assert.equal(r.attempts, 2);
  assert.equal(r.retries.length, 1);
  assert.equal(r.retries[0].code, 12);
  assert.match(r.retries[0].reason, /connection unexpectedly closed/);
  assert.equal(r.itemCount, 2, 'same path from two attempts counted once');
  assert.equal(r.bytes, 300);
  assert.equal(r.verify.ok, true);
  assert.equal(spawn.calls.length, 3);
  assert.deepEqual(events.map((e) => e[0]), ['phase', 'attempt', 'progress', 'retry', 'attempt', 'phase', 'attempt']);
  for (const c of spawn.calls) assert.equal(c.opts.shell, false);
  assert.deepEqual(spawn.calls[0].args, spawn.calls[1].args, 'resume uses identical arguments');
});

test('gives up after the configured number of retries', async () => {
  const spawn = fakeSpawn([{ code: 30 }, { code: 30 }, { code: 30 }]);
  const r = await new SyncRun({ profile: P({ network: { retries: 2 } }), spawn, backoff: noWait }).start();
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 3);
  assert.equal(spawn.calls.length, 3);
  assert.match(r.message, /Timeout/);
});

test('non-network errors are not retried', async () => {
  const spawn = fakeSpawn([{ err: ['rsync: send_files failed to open "x": Permission denied (13)\n'], code: 23 }]);
  const r = await new SyncRun({ profile: P(), spawn, backoff: noWait }).start();
  assert.equal(r.status, 'failed');
  assert.equal(spawn.calls.length, 1);
  assert.match(r.message, /Partial transfer.*Permission denied/);
  assert.equal(r.verify, null, 'no verify after a failed transfer');
});

test('stop during the reconnect wait ends the run without another attempt', async () => {
  const spawn = fakeSpawn([{ code: 10 }, { code: 0 }]);
  const run = new SyncRun({ profile: P(), spawn, backoff: () => 60000 });
  run.on('retry', () => setImmediate(() => run.stop()));
  const t0 = Date.now();
  const r = await run.start();
  assert.equal(r.status, 'stopped');
  assert.equal(spawn.calls.length, 1);
  assert.ok(Date.now() - t0 < 2000);
});

test('stop while rsync runs sends SIGTERM', async () => {
  const spawn = fakeSpawn([{ hang: true }]);
  const run = new SyncRun({ profile: P(), spawn, backoff: noWait });
  run.on('attempt', () => setTimeout(() => run.stop(), 10));
  const r = await run.start();
  assert.equal(r.status, 'stopped');
  assert.equal(spawn.calls.length, 1);
});

test('verify mismatches fail the run; attribute-only differences do not', async () => {
  const spawn = fakeSpawn([
    { out: [item('>f+++++++++', 5, 'a')], code: 0 },
    { out: [item('>fc........', 5, 'a'), item('.d..t......', 0, './'), item('*deleting', 0, 'stray')], code: 0 },
  ]);
  const r = await new SyncRun({ profile: P(), spawn, backoff: noWait }).start();
  assert.equal(r.status, 'verify-failed');
  assert.deepEqual(r.verify.mismatches.map((m) => m.path), ['a', 'stray']);
  const verifyArgs = spawn.calls[1].args;
  assert.ok(verifyArgs.includes('-c') && verifyArgs.includes('--dry-run'));

  const spawn2 = fakeSpawn([{ code: 0 }, { out: [item('.d..t......', 0, './')], code: 0 }]);
  const r2 = await new SyncRun({ profile: P(), spawn: spawn2, backoff: noWait }).start();
  assert.equal(r2.status, 'success');
});

test('verify that cannot connect is reported, not silently passed', async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 255 }, { code: 255 }]);
  const r = await new SyncRun({ profile: P({ network: { retries: 1 } }), spawn, backoff: noWait }).start();
  assert.equal(r.status, 'verify-failed');
  assert.match(r.message, /could not finish/);
  assert.equal(r.attempts, 1, 'verify retries are not counted as transfer attempts');
});

test('vanished files (24) is a warning and still verifies', async () => {
  const spawn = fakeSpawn([{ code: 24 }, { code: 0 }]);
  const r = await new SyncRun({ profile: P(), spawn, backoff: noWait }).start();
  assert.equal(r.status, 'warning');
  assert.equal(r.verify.ok, true);
});

test('max-delete stop (25) is a warning', async () => {
  const spawn = fakeSpawn([{ code: 25 }]);
  const r = await new SyncRun({ profile: P({ safety: { verifyAfter: false } }), spawn, backoff: noWait }).start();
  assert.equal(r.status, 'warning');
  assert.match(r.message, /max-delete/);
});

test('dry run never verifies and never retries into a real run', async () => {
  const spawn = fakeSpawn([{ out: [item('*deleting', 0, 'x'), item('>f+++++++++', 9, 'y')], code: 0 }]);
  const r = await new SyncRun({ profile: P(), spawn, dryRun: true, backoff: noWait }).start();
  assert.equal(r.status, 'success');
  assert.equal(r.verify, null);
  assert.equal(spawn.calls.length, 1);
  assert.ok(spawn.calls[0].args.includes('--dry-run'));
  assert.deepEqual(r.counts.delete, 1);
});

test('missing rsync binary gives a clear message', async () => {
  const e = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
  const r = await new SyncRun({ profile: P(), spawn: fakeSpawn([{ error: e }]), backoff: noWait }).start();
  assert.equal(r.status, 'failed');
  assert.match(r.message, /not found/);
});

test('legacy rsync progress is turned into an overall percentage', async () => {
  const spawn = fakeSpawn([{ out: ['     10 100%  1.00kB/s  0:00:00 (xfer#1, to-check=3/4)\r'], code: 0 }]);
  const run = new SyncRun({ profile: P({ safety: { verifyAfter: false } }), spawn, caps: { modern: false }, backoff: noWait });
  const seen = [];
  run.on('progress', (p) => seen.push(p.overall));
  await run.start();
  assert.deepEqual(seen, [25]);
  assert.ok(spawn.calls[0].args.includes('--progress'));
});

test('rsync runs with a UTF-8 locale so names and numbers parse', async () => {
  const spawn = fakeSpawn([{ code: 0 }]);
  await new SyncRun({ profile: P({ safety: { verifyAfter: false } }), spawn, backoff: noWait }).start();
  assert.match(spawn.calls[0].opts.env.LC_ALL, /UTF-8/);
});
