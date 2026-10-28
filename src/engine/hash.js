'use strict';
const fs = require('fs');
const crypto = require('crypto');

const ALGO = 'sha256';

// Streams a file through SHA-256. Honors an abort signal between chunks.
function hashFile(file, { signal, onBytes } = {}) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(ALGO);
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    s.on('data', (d) => {
      if (signal && signal.aborted) { s.destroy(new Error('aborted')); return; }
      h.update(d);
      if (onBytes) onBytes(d.length);
    });
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// Cheap pre-filter for duplicate search: size + first and last 64 KB.
async function quickHash(file, size) {
  const fd = await fs.promises.open(file, 'r');
  try {
    const n = 65536;
    const h = crypto.createHash(ALGO);
    const a = Buffer.alloc(Math.min(n, size));
    await fd.read(a, 0, a.length, 0);
    h.update(a);
    if (size > n) {
      const b = Buffer.alloc(Math.min(n, size - n));
      await fd.read(b, 0, b.length, size - b.length);
      h.update(b);
    }
    h.update(String(size));
    return h.digest('hex');
  } finally {
    await fd.close();
  }
}

module.exports = { hashFile, quickHash, ALGO };
