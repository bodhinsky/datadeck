'use strict';
// Asks the installed rsync which options it really accepts, by running tiny
// dry runs between two temp folders. Version numbers alone are not enough:
// macOS ships openrsync, Apple-patched 2.6.9, and Homebrew 3.x side by side.
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const PROBES = {
  outFormat: ['--out-format=%i|%l|%n'],
  partialDir: ['--partial-dir=.p'],
  progress2: ['--info=progress2'],
  progress: ['--progress'],
  protectArgs: ['-s'],
  maxDelete: ['--delete', '--max-delete=5'],
  stats: ['--stats'],
  backupDir: ['--backup', '--backup-dir=.b'],
  timeout: ['--timeout=30'],
  xattrs: ['-X'],
  acls: ['-A'],
  endOfOptions: [],
};

function runOnce(bin, args, spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    const t = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('error', () => { clearTimeout(t); resolve(false); });
    child.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

async function probeCaps(bin, spawn = childProcess.spawn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncdeck-probe-'));
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'x'), 'x');
  const caps = {};
  try {
    const keys = Object.keys(PROBES);
    const results = await Promise.all(keys.map((k) => runOnce(bin, ['-r', '--dry-run', ...PROBES[k], '--', `${a}/`, b], spawn)));
    keys.forEach((k, i) => { caps[k] = results[i]; });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return caps;
}

module.exports = { probeCaps, PROBES };
