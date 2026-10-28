'use strict';
// Previews for the details panel, made in the main process. The renderer
// sends an entry id only; the path comes from the catalog, so the window can
// never ask for an arbitrary file. Nothing here writes anywhere.
const fs = require('fs');

const RAW_IMAGE = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon' };
const RAW_MAX = 12 * 1024 * 1024; // send small images as they are (keeps EXIF rotation)
const TEXT_MAX = 6 * 1024;

/**
 * @param {object} entry from engine 'entry.info' (abs, kind, size, mtime, info)
 * @param {object} opts { nativeImage, platform, size }
 * @returns {Promise<{kind:'image', src}|{kind:'text', text, truncated}|{kind:'none', reason}>}
 */
async function makePreview(entry, { nativeImage, platform = process.platform, size = 360 } = {}) {
  if (!entry || entry.kind !== 'file') return { kind: 'none', reason: 'Not a file' };
  let st;
  try { st = await fs.promises.lstat(entry.abs); } catch (e) { return { kind: 'none', reason: `Not readable (${e.code})` }; }
  if (!st.isFile()) return { kind: 'none', reason: 'Not a regular file' };
  if (st.size !== entry.size || Math.abs(Math.floor(st.mtimeMs) - entry.mtime) > 1) return { kind: 'none', reason: 'Changed since the scan. Rescan to preview.', stale: true };
  const type = entry.info && entry.info.type;
  const family = entry.info && entry.info.family;

  if (RAW_IMAGE[type] && st.size <= RAW_MAX) {
    const buf = await fs.promises.readFile(entry.abs);
    return { kind: 'image', src: `data:${RAW_IMAGE[type]};base64,${buf.toString('base64')}` };
  }
  // Quick Look thumbnails (macOS, Windows): HEIC, RAW, video, PDF, Office, big images.
  if (nativeImage && (platform === 'darwin' || platform === 'win32') && ['image', 'video', 'document', 'presentation', 'spreadsheet'].includes(family)) {
    try {
      const img = await nativeImage.createThumbnailFromPath(entry.abs, { width: size * 2, height: size * 2 });
      if (img && !img.isEmpty()) return { kind: 'image', src: img.toDataURL() };
    } catch { /* no thumbnail available */ }
  }
  if (nativeImage && (type === 'jpeg' || type === 'png')) {
    const img = nativeImage.createFromPath(entry.abs);
    if (!img.isEmpty()) return { kind: 'image', src: img.resize({ width: size * 2 }).toDataURL() };
  }
  if (['text', 'code', 'data'].includes(family) && ['text', 'html', 'xml', 'svg'].includes(type)) {
    const fd = await fs.promises.open(entry.abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(TEXT_MAX, st.size));
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      return { kind: 'text', text: buf.subarray(0, bytesRead).toString('utf8').replace(/�+$/, ''), truncated: st.size > bytesRead };
    } finally { await fd.close(); }
  }
  return { kind: 'none', reason: family === 'audio' ? 'Audio file' : 'No preview for this type' };
}

module.exports = { makePreview };
