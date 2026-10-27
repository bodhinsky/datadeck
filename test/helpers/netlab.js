'use strict';
// A local rsync daemon behind a TCP proxy we can break on purpose: cut every
// connection, refuse new ones (outage), or silently stop forwarding (stall).
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function waitForPort(port, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${port} never opened`);
}

async function startDaemon(root) {
  const port = await freePort();
  const modPath = path.join(root, 'remote');
  fs.mkdirSync(modPath, { recursive: true });
  const asRoot = process.getuid && process.getuid() === 0;
  const conf = path.join(root, 'rsyncd.conf');
  fs.writeFileSync(conf, [
    `pid file = ${path.join(root, 'rsyncd.pid')}`,
    'use chroot = no',
    asRoot ? 'uid = root\ngid = root' : '',
    '[mod]',
    `  path = ${modPath}`,
    '  read only = no',
    '',
  ].join('\n'));
  const proc = spawn('rsync', ['--daemon', '--no-detach', `--config=${conf}`, `--port=${port}`, '--address=127.0.0.1'], { stdio: 'ignore' });
  await waitForPort(port);
  return { port, modPath, stop: () => proc.kill('SIGKILL') };
}

class FlakyProxy {
  constructor(targetPort) {
    this.targetPort = targetPort;
    this.sockets = new Set();
    this.down = false;
    this.frozen = false;
    this.bytes = 0;
    this.connections = 0;
    this.onBytes = null;
    this.server = net.createServer((client) => this.handle(client));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); }));
  }

  handle(client) {
    if (this.down) { client.destroy(); return; }
    this.connections++;
    const upstream = net.connect(this.targetPort, '127.0.0.1');
    const pair = { client, upstream };
    this.sockets.add(pair);
    const pipe = (from, to) => from.on('data', (d) => {
      if (this.frozen) return; // swallow: the link looks alive but nothing arrives
      this.bytes += d.length;
      to.write(d);
      if (this.onBytes) this.onBytes(this.bytes);
    });
    pipe(client, upstream);
    pipe(upstream, client);
    const kill = () => { client.destroy(); upstream.destroy(); this.sockets.delete(pair); };
    client.on('error', kill).on('close', kill);
    upstream.on('error', kill).on('close', kill);
  }

  cut() {
    for (const { client, upstream } of this.sockets) { client.destroy(); upstream.destroy(); }
    this.sockets.clear();
  }

  close() {
    this.cut();
    return new Promise((r) => this.server.close(() => r()));
  }
}

module.exports = { startDaemon, FlakyProxy, freePort };
