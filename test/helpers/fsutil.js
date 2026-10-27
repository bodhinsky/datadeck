'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function tmpdir(prefix = 'sd-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Map of relative path -> sha256 (files), 'dir', or 'link:<target>'.
function snapshot(root, { skip = [] } = {}) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      if (skip.some((s) => rel === s || rel.startsWith(s + path.sep))) continue;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(full); }
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function write(root, rel, data) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return f;
}

function randomBytes(n, seed = 1) {
  // Deterministic but incompressible enough for transfer tests.
  const b = Buffer.alloc(n);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  return b;
}

function hasRsync() {
  try { execFileSync('rsync', ['--version']); return true; } catch { return false; }
}

module.exports = { tmpdir, snapshot, write, randomBytes, hasRsync };
