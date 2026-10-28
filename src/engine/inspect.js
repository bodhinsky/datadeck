'use strict';
// Reads what is inside a file without trusting its name: the real type from
// the first bytes, and the useful metadata of common formats (photo EXIF,
// video/audio containers, ID3/FLAC tags, PDF and Office properties).
//
// Pure JavaScript, no native modules and no external tools. Every parser
// reads a bounded amount of data, checks every offset, and gives up quietly
// on anything malformed, so a hostile or broken file can't crash a scan.
const fs = require('fs');
const zlib = require('zlib');

// Read only what a format needs: 4 KB tells the type, and the formats we
// parse get a larger first chunk (JPEG EXIF lives in the first 64 KB).
const SNIFF = 4096;
const NEED = { jpeg: 192 * 1024, png: 64 * 1024, webp: 64 * 1024, tiff: 128 * 1024, heic: 128 * 1024, avif: 128 * 1024, cr3: 128 * 1024,
  mp3: 64 * 1024, flac: 64 * 1024, wav: 16 * 1024, pdf: 256 * 1024, text: 64 * 1024, html: 64 * 1024, xml: 64 * 1024, svg: 64 * 1024 };
const MAX_BOX = 64 * 1024 * 1024; // largest moov/ilst we are willing to read
const MAX_ZIP_PART = 2 * 1024 * 1024;

// Known types: what they are and which extensions are honest for them.
// Types in the same `group` are interchangeable (e.g. .mp4 and .mov).
const TYPES = {
  jpeg: { mime: 'image/jpeg', family: 'image', exts: ['jpg', 'jpeg', 'jpe', 'jfif'] },
  png: { mime: 'image/png', family: 'image', exts: ['png', 'apng'] },
  gif: { mime: 'image/gif', family: 'image', exts: ['gif'] },
  webp: { mime: 'image/webp', family: 'image', exts: ['webp'] },
  heic: { mime: 'image/heic', family: 'image', exts: ['heic', 'heif', 'hif'] },
  avif: { mime: 'image/avif', family: 'image', exts: ['avif'] },
  tiff: { mime: 'image/tiff', family: 'image', exts: ['tif', 'tiff', 'dng', 'cr2', 'nef', 'arw', 'orf', 'rw2', 'pef', 'srw', 'nrw', 'sr2', 'erf', '3fr', 'iiq', 'mos', 'kdc', 'dcr'] },
  cr3: { mime: 'image/x-canon-cr3', family: 'image', exts: ['cr3'] },
  raf: { mime: 'image/x-fuji-raf', family: 'image', exts: ['raf'] },
  bmp: { mime: 'image/bmp', family: 'image', exts: ['bmp', 'dib'] },
  ico: { mime: 'image/x-icon', family: 'image', exts: ['ico', 'cur'] },
  psd: { mime: 'image/vnd.adobe.photoshop', family: 'image', exts: ['psd', 'psb'] },
  svg: { mime: 'image/svg+xml', family: 'image', exts: ['svg', 'svgz'] },
  mp4: { mime: 'video/mp4', family: 'video', group: 'isobmff', exts: ['mp4', 'm4v', 'mov', 'qt', '3gp', '3g2', 'm4a', 'm4b', 'm4p', 'f4v', 'mp4v'] },
  mov: { mime: 'video/quicktime', family: 'video', group: 'isobmff', exts: ['mov', 'qt', 'mp4', 'm4v'] },
  m4a: { mime: 'audio/mp4', family: 'audio', group: 'isobmff', exts: ['m4a', 'm4b', 'm4p', 'mp4', 'aac'] },
  mkv: { mime: 'video/x-matroska', family: 'video', group: 'ebml', exts: ['mkv', 'mka', 'mks', 'mk3d', 'webm'] },
  webm: { mime: 'video/webm', family: 'video', group: 'ebml', exts: ['webm', 'mkv'] },
  avi: { mime: 'video/x-msvideo', family: 'video', exts: ['avi'] },
  mpegts: { mime: 'video/mp2t', family: 'video', exts: ['ts', 'mts', 'm2ts', 'tsv'] },
  mp3: { mime: 'audio/mpeg', family: 'audio', exts: ['mp3', 'mp2', 'mpga'] },
  flac: { mime: 'audio/flac', family: 'audio', exts: ['flac'] },
  wav: { mime: 'audio/wav', family: 'audio', exts: ['wav', 'wave'] },
  aiff: { mime: 'audio/aiff', family: 'audio', exts: ['aif', 'aiff', 'aifc'] },
  ogg: { mime: 'audio/ogg', family: 'audio', exts: ['ogg', 'oga', 'opus', 'ogv', 'spx'] },
  midi: { mime: 'audio/midi', family: 'audio', exts: ['mid', 'midi', 'kar'] },
  pdf: { mime: 'application/pdf', family: 'document', exts: ['pdf', 'ai'] },
  rtf: { mime: 'application/rtf', family: 'document', exts: ['rtf'] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', family: 'document', group: 'zip', exts: ['docx', 'docm', 'dotx', 'dotm'] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', family: 'spreadsheet', group: 'zip', exts: ['xlsx', 'xlsm', 'xltx', 'xltm'] },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', family: 'presentation', group: 'zip', exts: ['pptx', 'pptm', 'potx', 'ppsx'] },
  odt: { mime: 'application/vnd.oasis.opendocument.text', family: 'document', group: 'zip', exts: ['odt', 'ott'] },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', family: 'spreadsheet', group: 'zip', exts: ['ods', 'ots'] },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation', family: 'presentation', group: 'zip', exts: ['odp', 'otp'] },
  epub: { mime: 'application/epub+zip', family: 'document', group: 'zip', exts: ['epub'] },
  pages: { mime: 'application/x-iwork-pages', family: 'document', group: 'zip', exts: ['pages', 'numbers', 'key'] },
  ole: { mime: 'application/x-ole-storage', family: 'document', exts: ['doc', 'xls', 'ppt', 'msg', 'msi', 'dot', 'xlt', 'pot', 'vsd', 'pub'] },
  zip: { mime: 'application/zip', family: 'archive', group: 'zip', exts: ['zip', 'jar', 'apk', 'ipa', 'xpi', 'whl', 'nupkg', 'aar', 'sketch', 'kmz', 'cbz', 'ora', '3mf', 'usdz', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'pages', 'numbers', 'key'] },
  gzip: { mime: 'application/gzip', family: 'archive', exts: ['gz', 'tgz', 'svgz', 'emz'] },
  bzip2: { mime: 'application/x-bzip2', family: 'archive', exts: ['bz2', 'tbz', 'tbz2'] },
  xz: { mime: 'application/x-xz', family: 'archive', exts: ['xz', 'txz'] },
  zstd: { mime: 'application/zstd', family: 'archive', exts: ['zst', 'tzst'] },
  '7z': { mime: 'application/x-7z-compressed', family: 'archive', exts: ['7z'] },
  rar: { mime: 'application/vnd.rar', family: 'archive', exts: ['rar', 'cbr'] },
  tar: { mime: 'application/x-tar', family: 'archive', exts: ['tar'] },
  sqlite: { mime: 'application/vnd.sqlite3', family: 'data', exts: ['sqlite', 'sqlite3', 'db', 'db3', 'sqlitedb'] },
  plist: { mime: 'application/x-bplist', family: 'data', exts: ['plist', 'bplist', 'webloc', 'strings'] },
  elf: { mime: 'application/x-elf', family: 'executable', exts: ['so', 'o', 'elf', 'bin', 'axf', 'ko'] },
  macho: { mime: 'application/x-mach-binary', family: 'executable', exts: ['dylib', 'bundle', 'o', 'app'] },
  exe: { mime: 'application/vnd.microsoft.portable-executable', family: 'executable', exts: ['exe', 'dll', 'sys', 'scr', 'efi', 'ocx', 'cpl', 'com'] },
  wasm: { mime: 'application/wasm', family: 'executable', exts: ['wasm'] },
  ttf: { mime: 'font/ttf', family: 'font', exts: ['ttf', 'tte', 'dfont'] },
  otf: { mime: 'font/otf', family: 'font', exts: ['otf'] },
  woff: { mime: 'font/woff', family: 'font', exts: ['woff'] },
  woff2: { mime: 'font/woff2', family: 'font', exts: ['woff2'] },
  html: { mime: 'text/html', family: 'code', exts: ['html', 'htm', 'xhtml', 'shtml', 'php', 'jsp', 'asp', 'aspx', 'vue', 'svelte', 'hbs', 'ejs', 'erb', 'md', 'txt'] },
  xml: { mime: 'application/xml', family: 'data', exts: ['xml', 'plist', 'xsd', 'xsl', 'xslt', 'rss', 'atom', 'kml', 'gpx', 'xlf', 'xliff', 'resx', 'csproj', 'svg', 'xhtml', 'dae', 'musicxml', 'drawio', 'storyboard', 'xib', 'opf', 'ncx', 'fodt', 'config', 'manifest', 'nfo', 'txt'] },
  text: { mime: 'text/plain', family: 'text' },
  empty: { mime: 'application/x-empty', family: 'empty' },
};

// ── byte helpers ──
const u16 = (b, o, le) => (o + 2 <= b.length ? (le ? b.readUInt16LE(o) : b.readUInt16BE(o)) : 0);
const u32 = (b, o, le) => (o + 4 <= b.length ? (le ? b.readUInt32LE(o) : b.readUInt32BE(o)) : 0);
const ascii = (b, o, n) => (o >= 0 && o + n <= b.length ? b.toString('latin1', o, o + n) : '');
const startsWith = (b, sig, o = 0) => b.length >= o + sig.length && sig.every((v, i) => v === null || b[o + i] === v);
const clean = (s) => {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\0+$/, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t ? t.slice(0, 300) : null;
};

function readAt(fd, pos, len) {
  const b = Buffer.alloc(Math.max(0, len));
  let n = 0;
  while (n < len) {
    const r = fs.readSync(fd, b, n, len - n, pos + n);
    if (!r) break;
    n += r;
  }
  return n < len ? b.subarray(0, n) : b;
}

// ── sniffing ──
function sniff(b, size) {
  if (!size || !b.length) return 'empty';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF') {
    const t = ascii(b, 8, 4);
    if (t === 'WEBP') return 'webp';
    if (t === 'WAVE') return 'wav';
    if (t === 'AVI ') return 'avi';
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brands = [ascii(b, 8, 4)];
    const end = Math.min(b.length, u32(b, 0));
    for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(b, o, 4));
    const has = (...x) => brands.some((br) => x.includes(br));
    if (has('crx ')) return 'cr3';
    if (has('avif', 'avis')) return 'avif';
    if (has('heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1')) return brands[0] === 'mif1' && has('avif') ? 'avif' : 'heic';
    if (brands[0] === 'qt  ') return 'mov';
    if (has('M4A ', 'M4B ', 'M4P ')) return 'm4a';
    return 'mp4';
  }
  if (['moov', 'mdat', 'wide', 'free', 'pnot', 'skip'].includes(ascii(b, 4, 4)) && u32(b, 0) >= 8) return 'mov';
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]) || startsWith(b, [0x49, 0x49, 0x52, 0x4f]) || startsWith(b, [0x49, 0x49, 0x55, 0x00])) return 'tiff';
  if (ascii(b, 0, 15) === 'FUJIFILMCCD-RAW') return 'raf';
  if (ascii(b, 0, 2) === 'BM' && u32(b, 2, true) <= size + 16 && b.length > 26) return 'bmp';
  if (startsWith(b, [0, 0, 1, 0]) && u16(b, 4, true) > 0 && u16(b, 4, true) < 256 && b.length > 22) return 'ico';
  if (ascii(b, 0, 4) === '8BPS') return 'psd';
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return b.subarray(0, 4096).includes('webm') ? 'webm' : 'mkv';
  if (b[0] === 0x47 && b.length >= 189 && b[188] === 0x47) return 'mpegts';
  if (ascii(b, 0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0 && ((b[2] >> 4) & 0xf) !== 0xf && ((b[2] >> 4) & 0xf) !== 0) return 'mp3';
  if (ascii(b, 0, 4) === 'fLaC') return 'flac';
  if (ascii(b, 0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(b, 8, 4))) return 'aiff';
  if (ascii(b, 0, 4) === 'OggS') return 'ogg';
  if (ascii(b, 0, 4) === 'MThd') return 'midi';
  if (ascii(b, 0, 5) === '%PDF-') return 'pdf';
  if (b.subarray(0, 1024).indexOf('%PDF-') >= 0 && b.subarray(0, 1024).indexOf('%PDF-') < 1024) return 'pdf';
  if (ascii(b, 0, 5) === '{\\rtf') return 'rtf';
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(b, [0x1f, 0x8b])) return 'gzip';
  if (ascii(b, 0, 3) === 'BZh') return 'bzip2';
  if (startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (startsWith(b, [0x28, 0xb5, 0x2f, 0xfd])) return 'zstd';
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (ascii(b, 0, 4) === 'Rar!') return 'rar';
  if (ascii(b, 257, 5) === 'ustar') return 'tar';
  if (ascii(b, 0, 16) === 'SQLite format 3\0') return 'sqlite';
  if (ascii(b, 0, 8) === 'bplist00') return 'plist';
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return 'elf';
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(u32(b, 0))) return 'macho';
  if (ascii(b, 0, 2) === 'MZ' && b.length > 64) {
    const pe = u32(b, 60, true);
    if (pe > 0 && pe + 4 <= b.length && ascii(b, pe, 4) === 'PE\0\0') return 'exe';
  }
  if (startsWith(b, [0x00, 0x61, 0x73, 0x6d])) return 'wasm';
  if (startsWith(b, [0x00, 0x01, 0x00, 0x00, 0x00]) || ascii(b, 0, 4) === 'true') return 'ttf';
  if (ascii(b, 0, 4) === 'OTTO') return 'otf';
  if (ascii(b, 0, 4) === 'wOFF') return 'woff';
  if (ascii(b, 0, 4) === 'wOF2') return 'woff2';
  return sniffText(b);
}

function sniffText(b) {
  const s = b.subarray(0, 8192);
  if (s.includes(0)) {
    // UTF-16 text has NULs; check for a byte order mark.
    if ((s[0] === 0xff && s[1] === 0xfe) || (s[0] === 0xfe && s[1] === 0xff)) return 'text';
    return null;
  }
  let str;
  try { str = new TextDecoder('utf-8', { fatal: true }).decode(s.length === 8192 ? s.subarray(0, lastCharBoundary(s)) : s); } catch { return null; }
  const head = str.replace(/^﻿/, '').trimStart().slice(0, 1024).toLowerCase();
  if (head.startsWith('<?xml')) return /<svg[\s>]/.test(str.slice(0, 4096).toLowerCase()) ? 'svg' : 'xml';
  if (head.startsWith('<svg')) return 'svg';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  return 'text';
}

function lastCharBoundary(b) {
  let i = b.length;
  // Step back over a trailing partial UTF-8 sequence.
  for (let k = 1; k <= 4 && i - k >= 0; k++) {
    const c = b[i - k];
    if ((c & 0xc0) === 0x80) continue;
    if ((c & 0xe0) === 0xc0 && k < 2) return i - k;
    if ((c & 0xf0) === 0xe0 && k < 3) return i - k;
    if ((c & 0xf8) === 0xf0 && k < 4) return i - k;
    break;
  }
  return i;
}

// Is the extension honest for the detected type?
function mismatch(type, ext) {
  if (!type || !TYPES[type] || !TYPES[type].exts) return false;
  const e = String(ext || '').toLowerCase();
  if (!e) return false;
  const t = TYPES[type];
  if (t.exts.includes(e)) return false;
  // Only call it a mismatch when the extension clearly belongs to a different known type.
  const owners = Object.entries(TYPES).filter(([, v]) => v.exts && v.exts.includes(e));
  if (!owners.length) return false;
  return !owners.some(([k, v]) => k === type || (t.group && v.group === t.group));
}

// ── EXIF / TIFF ──
function exifDate(s, offset) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const om = /^([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  if (om) {
    const off = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]));
    return Date.UTC(y, mo - 1, d, h, mi, se) - off * 60000;
  }
  return new Date(y, mo - 1, d, h, mi, se).getTime();
}

function parseTiff(b, start) {
  const out = {};
  if (start < 0 || start + 8 > b.length) return out;
  const bo = ascii(b, start, 2);
  if (bo !== 'II' && bo !== 'MM') return out;
  const le = bo === 'II';
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const seen = new Set();
  const readIfd = (off) => {
    const tags = {};
    const at = start + off;
    if (off <= 0 || seen.has(off) || at + 2 > b.length) return tags;
    seen.add(off);
    const n = Math.min(u16(b, at, le), 512);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = u16(b, e, le);
      const type = u16(b, e + 2, le);
      const count = u32(b, e + 4, le);
      const sz = (SIZES[type] || 1) * count;
      if (count > 1e6) continue;
      const vo = sz <= 4 ? e + 8 : start + u32(b, e + 8, le);
      if (vo < 0 || vo + sz > b.length) continue;
      const one = (k) => {
        const p = vo + k * (SIZES[type] || 1);
        switch (type) {
          case 3: return u16(b, p, le);
          case 4: return u32(b, p, le);
          case 9: return le ? b.readInt32LE(p) : b.readInt32BE(p);
          case 5: { const d = u32(b, p + 4, le); return d ? u32(b, p, le) / d : 0; }
          case 11: return le ? b.readFloatLE(p) : b.readFloatBE(p);
          case 12: return le ? b.readDoubleLE(p) : b.readDoubleBE(p);
          case 8: return le ? b.readInt16LE(p) : b.readInt16BE(p);
          case 10: { const d = le ? b.readInt32LE(p + 4) : b.readInt32BE(p + 4); return d ? (le ? b.readInt32LE(p) : b.readInt32BE(p)) / d : 0; }
          default: return b[p];
        }
      };
      if (type === 2) tags[tag] = b.toString('latin1', vo, vo + count).replace(/\0.*$/s, '');
      else if (type === 7) tags[tag] = b.subarray(vo, vo + Math.min(count, 64));
      else tags[tag] = count === 1 ? one(0) : Array.from({ length: Math.min(count, 16) }, (_, k) => one(k));
      tags[`_ptr${tag}`] = u32(b, e + 8, le);
    }
    return tags;
  };
  const ifd0 = readIfd(u32(b, start + 4, le));
  const exif = ifd0[0x8769] ? readIfd(ifd0._ptr34665) : {};
  const gps = ifd0[0x8825] ? readIfd(ifd0._ptr34853) : {};
  const make = clean(ifd0[0x010f]);
  let model = clean(ifd0[0x0110]);
  if (make && model && model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0])) model = model;
  else if (make && model) model = `${make} ${model}`;
  out.camera = model || make || null;
  out.lens = clean(exif[0xa434]) || null;
  out.orientation = typeof ifd0[0x0112] === 'number' ? ifd0[0x0112] : null;
  out.taken = exifDate(exif[0x9003], exif[0x9011]) || exifDate(exif[0x9004], exif[0x9012]) || exifDate(ifd0[0x0132], exif[0x9010]);
  const w = exif[0xa002] || ifd0[0x0100];
  const h = exif[0xa003] || ifd0[0x0101];
  if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) { out.width = w; out.height = h; }
  const dms = (v) => (Array.isArray(v) && v.length >= 3 ? v[0] + v[1] / 60 + v[2] / 3600 : null);
  const lat = dms(gps[2]);
  const lon = dms(gps[4]);
  if (lat !== null && lon !== null && (lat || lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.gpsLat = Math.round((String(gps[1]).toUpperCase() === 'S' ? -lat : lat) * 1e6) / 1e6;
    out.gpsLon = Math.round((String(gps[3]).toUpperCase() === 'W' ? -lon : lon) * 1e6) / 1e6;
  }
  const ex = {};
  if (typeof exif[0x829a] === 'number' && exif[0x829a] > 0) ex.exposure = exif[0x829a] < 1 ? `1/${Math.round(1 / exif[0x829a])}` : `${exif[0x829a]}`;
  if (typeof exif[0x829d] === 'number' && exif[0x829d] > 0) ex.fnumber = `f/${Math.round(exif[0x829d] * 10) / 10}`;
  const iso = Array.isArray(exif[0x8827]) ? exif[0x8827][0] : exif[0x8827];
  if (typeof iso === 'number' && iso > 0) ex.iso = iso;
  if (typeof exif[0x920a] === 'number' && exif[0x920a] > 0) ex.focal = `${Math.round(exif[0x920a])} mm`;
  const sw = clean(ifd0[0x0131]);
  if (sw) ex.software = sw;
  out.extra = ex;
  return out;
}

// ── images ──
function jpegInfo(b) {
  const out = {};
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd9 || m === 0xda) break;
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    const len = u16(b, o + 2);
    if (len < 2) break;
    if (m === 0xe1 && ascii(b, o + 4, 6) === 'Exif\0\0' && !out.exif) out.exif = parseTiff(b.subarray(0, Math.min(b.length, o + 2 + len)), o + 10);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m) && !out.width) {
      out.height = u16(b, o + 5);
      out.width = u16(b, o + 7);
    }
    o += 2 + len;
  }
  const r = { ...(out.exif || {}) };
  // The frame size is the truth; EXIF can describe a thumbnail or be stale.
  if (out.width) { r.width = out.width; r.height = out.height; }
  return r;
}

function pngInfo(b) {
  const r = { width: u32(b, 16), height: u32(b, 20) };
  let o = 8;
  while (o + 12 <= b.length) {
    const len = u32(b, o);
    const type = ascii(b, o + 4, 4);
    if (type === 'eXIf' && o + 8 + len <= b.length) Object.assign(r, parseTiff(b.subarray(o + 8, o + 8 + len), 0), { width: r.width, height: r.height });
    if (type === 'tEXt' && o + 8 + len <= b.length) {
      const [k, v] = b.toString('latin1', o + 8, o + 8 + len).split('\0');
      if (k === 'Creation Time' && !r.taken) { const t = Date.parse(v); if (Number.isFinite(t)) r.taken = t; }
    }
    if (type === 'IDAT' || type === 'IEND' || len > b.length) break;
    o += 12 + len;
  }
  return r;
}

function webpInfo(b) {
  const c = ascii(b, 12, 4);
  if (c === 'VP8 ') return { width: u16(b, 26, true) & 0x3fff, height: u16(b, 28, true) & 0x3fff };
  if (c === 'VP8L') { const v = u32(b, 21, true); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  if (c === 'VP8X') {
    const r = { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    let o = 12;
    while (o + 8 <= b.length) {
      const id = ascii(b, o, 4);
      const len = u32(b, o + 4, true);
      if (id === 'EXIF' && o + 8 + len <= b.length) {
        const s = b.subarray(o + 8, o + 8 + len);
        Object.assign(r, parseTiff(s, ascii(s, 0, 6) === 'Exif\0\0' ? 6 : 0), { width: r.width, height: r.height });
      }
      o += 8 + len + (len & 1);
    }
    return r;
  }
  return {};
}

// ── ISO base media (MP4, MOV, HEIC, AVIF, CR3) ──
function boxes(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = ascii(b, o + 4, 4);
    let hdr = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type, start: o + hdr, end: o + size });
    o += size;
  }
  return out;
}
const child = (b, box, type, skip = 0) => boxes(b, box.start + skip, box.end).find((x) => x.type === type);

function heifInfo(fd, head, size) {
  const r = {};
  const top = boxes(head, 0, head.length);
  const metaBox = top.find((x) => x.type === 'meta');
  if (!metaBox) return r;
  const kids = boxes(head, metaBox.start + 4, metaBox.end);
  // Largest image spatial extent = the full picture (tiles are smaller).
  const iprp = kids.find((x) => x.type === 'iprp');
  const ipco = iprp && child(head, iprp, 'ipco');
  if (ipco) {
    for (const p of boxes(head, ipco.start, ipco.end)) {
      if (p.type !== 'ispe') continue;
      const w = u32(head, p.start + 4);
      const h = u32(head, p.start + 8);
      if (w * h > (r.width || 0) * (r.height || 0)) { r.width = w; r.height = h; }
    }
  }
  const iinf = kids.find((x) => x.type === 'iinf');
  const iloc = kids.find((x) => x.type === 'iloc');
  if (!iinf || !iloc) return r;
  const iv = head[iinf.start];
  let exifId = null;
  for (const e of boxes(head, iinf.start + 4 + (iv === 0 ? 2 : 4), iinf.end)) {
    if (e.type !== 'infe') continue;
    const v = head[e.start];
    if (v < 2) continue;
    const id = v === 2 ? u16(head, e.start + 4) : u32(head, e.start + 4);
    const typeAt = e.start + 4 + (v === 2 ? 2 : 4) + 2;
    if (ascii(head, typeAt, 4) === 'Exif') { exifId = id; break; }
  }
  if (exifId === null) return r;
  const v = head[iloc.start];
  let o = iloc.start + 4;
  const offSize = head[o] >> 4; const lenSize = head[o] & 15; const baseSize = head[o + 1] >> 4; const idxSize = v >= 1 ? head[o + 1] & 15 : 0;
  o += 2;
  const readN = (n) => { let x = 0; for (let k = 0; k < n; k++) x = x * 256 + head[o + k]; o += n; return x; };
  const count = v < 2 ? readN(2) : readN(4);
  for (let i = 0; i < Math.min(count, 4096) && o < iloc.end; i++) {
    const id = v < 2 ? readN(2) : readN(4);
    const method = v >= 1 ? readN(2) & 15 : 0;
    readN(2);
    const base = readN(baseSize);
    const extents = readN(2);
    let first = null;
    for (let k = 0; k < extents; k++) {
      if (idxSize) readN(idxSize);
      const eo = readN(offSize);
      const el = readN(lenSize);
      if (first === null) first = { off: base + eo, len: el };
    }
    if (id === exifId && first && method === 0 && first.len > 8 && first.len < 4 * 1024 * 1024 && first.off + first.len <= size) {
      const data = readAt(fd, first.off, first.len);
      const skip = u32(data, 0);
      Object.assign(r, parseTiff(data, 4 + skip), { width: r.width, height: r.height });
      break;
    }
  }
  return r;
}

const MAC_EPOCH = Date.UTC(1904, 0, 1);
function iso6709(s) {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(s || '');
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon) ? { lat, lon } : null;
}

function mp4Info(fd, size) {
  const r = {};
  // Walk top-level boxes on disk; moov may sit after gigabytes of media data.
  let pos = 0;
  let moov = null;
  for (let i = 0; i < 64 && pos + 8 <= size; i++) {
    const h = readAt(fd, pos, 16);
    let bs = u32(h, 0);
    const type = ascii(h, 4, 4);
    let hdr = 8;
    if (bs === 1) { bs = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (bs === 0) bs = size - pos;
    if (bs < hdr) break;
    if (type === 'moov') { if (bs - hdr <= MAX_BOX) moov = readAt(fd, pos + hdr, bs - hdr); break; }
    pos += bs;
  }
  if (!moov) return r;
  const root = { start: 0, end: moov.length };
  const kids = boxes(moov, 0, moov.length);
  const mvhd = kids.find((x) => x.type === 'mvhd');
  if (mvhd) {
    const v = moov[mvhd.start];
    const created = v === 1 ? Number(moov.readBigUInt64BE(mvhd.start + 4)) : u32(moov, mvhd.start + 4);
    const ts = u32(moov, mvhd.start + (v === 1 ? 20 : 12));
    const dur = v === 1 ? Number(moov.readBigUInt64BE(mvhd.start + 24)) : u32(moov, mvhd.start + 16);
    if (ts) r.duration = Math.round((dur / ts) * 100) / 100;
    const t = MAC_EPOCH + created * 1000;
    if (created && t > Date.UTC(1971, 0, 1) && t < Date.UTC(2200, 0, 1)) r.taken = t;
  }
  let hasVideo = false;
  for (const trak of kids.filter((x) => x.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    const kind = hdlr ? ascii(moov, hdlr.start + 8, 4) : '';
    if (kind === 'vide') {
      hasVideo = true;
      const tkhd = child(moov, trak, 'tkhd');
      if (tkhd) {
        const v = moov[tkhd.start];
        const at = tkhd.start + (v === 1 ? 88 : 76);
        const w = u32(moov, at) / 65536;
        const h = u32(moov, at + 4) / 65536;
        if (w * h > (r.width || 0) * (r.height || 0)) { r.width = Math.round(w); r.height = Math.round(h); }
      }
      const minf = child(moov, mdia, 'minf');
      const stbl = minf && child(moov, minf, 'stbl');
      const stsd = stbl && child(moov, stbl, 'stsd');
      if (stsd && !r.codec) r.codec = ascii(moov, stsd.start + 12, 4).trim() || null;
    }
  }
  r.hasVideo = hasVideo;
  // Metadata: QuickTime keys/ilst (iPhone), iTunes ilst (music), udta ©xyz.
  const udta = kids.find((x) => x.type === 'udta');
  const tags = {};
  const readIlst = (ilst, keys) => {
    for (const it of boxes(moov, ilst.start, ilst.end)) {
      const data = child(moov, it, 'data');
      if (!data) continue;
      const typeCode = u32(moov, data.start) & 0xffffff;
      const val = moov.subarray(data.start + 8, data.end);
      let name = it.type;
      if (keys) { const idx = moov.readUInt32BE(it.start - 4); name = keys[idx] || name; }
      tags[name] = typeCode === 1 ? val.toString('utf8') : typeCode === 21 || typeCode === 22 ? val.readIntBE(0, Math.min(val.length, 6) || 1) : val;
    }
  };
  for (const metaParent of [root, udta].filter(Boolean)) {
    const meta = metaParent === root ? kids.find((x) => x.type === 'meta') : child(moov, udta, 'meta');
    if (!meta) continue;
    // QuickTime 'meta' is a plain box; iTunes 'meta' is a full box.
    const plain = boxes(moov, meta.start, meta.end).some((x) => x.type === 'hdlr');
    const mk = boxes(moov, meta.start + (plain ? 0 : 4), meta.end);
    const keysBox = mk.find((x) => x.type === 'keys');
    const ilst = mk.find((x) => x.type === 'ilst');
    let keys = null;
    if (keysBox) {
      keys = {};
      let o = keysBox.start + 8;
      for (let i = 1; o + 8 <= keysBox.end && i < 1024; i++) {
        const ks = u32(moov, o);
        if (ks < 8) break;
        keys[i] = ascii(moov, o + 8, ks - 8);
        o += ks;
      }
    }
    if (ilst) readIlst(ilst, keys);
  }
  if (udta) {
    for (const x of boxes(moov, udta.start, udta.end)) {
      if (x.type === '©xyz') tags.xyz = moov.toString('utf8', x.start + 4, x.end);
    }
  }
  const cd = tags['com.apple.quicktime.creationdate'];
  if (typeof cd === 'string') { const t = Date.parse(cd); if (Number.isFinite(t)) r.taken = t; }
  const loc = iso6709(tags['com.apple.quicktime.location.ISO6709'] || tags.xyz || tags.location);
  if (loc) { r.gpsLat = loc.lat; r.gpsLon = loc.lon; }
  const make = tags['com.apple.quicktime.make'];
  const model = tags['com.apple.quicktime.model'];
  if (typeof model === 'string') r.camera = clean(typeof make === 'string' && !model.startsWith(make) ? `${make} ${model}` : model);
  const str = (k) => (typeof tags[k] === 'string' ? clean(tags[k]) : null);
  r.title = str('©nam') || str('com.apple.quicktime.title');
  r.artist = str('©ART') || str('aART');
  r.album = str('©alb');
  const day = str('©day');
  if (day && !r.taken && /^\d{4}/.test(day)) r.year = Number(day.slice(0, 4));
  return r;
}

// ── audio ──
function id3Text(b, enc) {
  if (!b.length) return '';
  if (enc === 0) return b.toString('latin1');
  if (enc === 3) return b.toString('utf8');
  if (enc === 1) {
    if (b[0] === 0xfe && b[1] === 0xff) return swap16(b.subarray(2)).toString('utf16le');
    return b.subarray(b[0] === 0xff && b[1] === 0xfe ? 2 : 0).toString('utf16le');
  }
  if (enc === 2) return swap16(b).toString('utf16le');
  return '';
}
function swap16(b) { const c = Buffer.from(b.subarray(0, b.length & ~1)); c.swap16(); return c; }
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function mp3Info(fd, head, size) {
  const r = {};
  let audioStart = 0;
  if (ascii(head, 0, 3) === 'ID3') {
    const ver = head[3];
    const tagSize = syncsafe(head, 6) + 10 + (head[5] & 0x10 ? 10 : 0);
    audioStart = tagSize;
    const tag = tagSize <= head.length ? head.subarray(0, tagSize) : readAt(fd, 0, Math.min(tagSize, 1024 * 1024));
    let o = 10;
    if (head[5] & 0x40 && ver >= 3) o += ver === 4 ? syncsafe(tag, 10) : u32(tag, 10) + 4; // extended header
    const T = {};
    while (o + (ver === 2 ? 6 : 10) <= tag.length) {
      const id = ascii(tag, o, ver === 2 ? 3 : 4);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      const fsz = ver === 2 ? (tag[o + 3] << 16) | (tag[o + 4] << 8) | tag[o + 5] : ver === 4 ? syncsafe(tag, o + 4) : u32(tag, o + 4);
      const ds = o + (ver === 2 ? 6 : 10);
      if (fsz <= 0 || ds + fsz > tag.length) break;
      if (id[0] === 'T' && fsz < 4096) T[id] = clean(id3Text(tag.subarray(ds + 1, ds + fsz), tag[ds]).replace(/\0/g, ' / ').replace(/( \/ )+$/, ''));
      o = ds + fsz;
    }
    r.title = T.TIT2 || T.TT2 || null;
    r.artist = T.TPE1 || T.TP1 || T.TPE2 || null;
    r.album = T.TALB || T.TAL || null;
    const y = T.TDRC || T.TYER || T.TYE;
    if (y && /^\d{4}/.test(y)) r.year = Number(y.slice(0, 4));
    if (T.TRCK) r.track = T.TRCK;
    if (T.TCON) r.genre = T.TCON.replace(/^\((\d+)\)$/, '$1');
  }
  // Duration from the first MPEG frame: Xing/Info frame count, or bitrate.
  const fh = readAt(fd, audioStart, 4096);
  let o = 0;
  while (o + 4 < fh.length && !(fh[o] === 0xff && (fh[o + 1] & 0xe0) === 0xe0)) o++;
  if (o + 4 < fh.length) {
    const vbits = (fh[o + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (fh[o + 1] >> 1) & 3; // 1 = Layer III
    const bi = fh[o + 2] >> 4;
    const si = (fh[o + 2] >> 2) & 3;
    const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    if (layer === 1 && vbits !== 1 && bi > 0 && bi < 15 && si < 3) {
      const br = (vbits === 3 ? BR1 : BR2)[bi] * 1000;
      const sr = SR[vbits][si];
      const spf = vbits === 3 ? 1152 : 576;
      const mono = (fh[o + 3] >> 6) === 3;
      const xo = o + 4 + (vbits === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17));
      const tag = ascii(fh, xo, 4);
      let frames = 0;
      if ((tag === 'Xing' || tag === 'Info') && u32(fh, xo + 4) & 1) frames = u32(fh, xo + 8);
      else if (ascii(fh, o + 36, 4) === 'VBRI') frames = u32(fh, o + 50);
      if (frames) {
        // Variable bitrate: the header frame's own rate means nothing; use the average.
        r.duration = Math.round((frames * spf / sr) * 100) / 100;
        r.bitrate = r.duration ? Math.round(((size - audioStart) * 8) / r.duration / 1000) * 1000 : null;
      } else if (br) {
        r.duration = Math.round(((size - audioStart) * 8 / br) * 100) / 100;
        r.bitrate = br;
      }
      r.sampleRate = sr;
    }
  }
  return r;
}

function flacInfo(fd, head) {
  const r = {};
  let o = 4;
  let b = head;
  for (let i = 0; i < 64; i++) {
    if (o + 4 > b.length) { b = Buffer.concat([b, readAt(fd, b.length, Math.max(4096, o + 4 - b.length))]); if (o + 4 > b.length) break; }
    const last = b[o] & 0x80;
    const type = b[o] & 0x7f;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    if (type === 0 || type === 4) {
      if (o + 4 + len > b.length) {
        if (len > 4 * 1024 * 1024) break;
        b = Buffer.concat([b, readAt(fd, b.length, o + 4 + len - b.length)]);
        if (o + 4 + len > b.length) break;
      }
      const d = o + 4;
      if (type === 0 && len >= 18) {
        const sr = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4);
        const total = (b[d + 13] & 0x0f) * 2 ** 32 + u32(b, d + 14);
        if (sr) { r.sampleRate = sr; if (total) r.duration = Math.round((total / sr) * 100) / 100; }
      }
      if (type === 4) Object.assign(r, vorbisComments(b.subarray(d, d + len)));
    }
    if (last) break;
    o += 4 + len;
  }
  return r;
}

function vorbisComments(c) {
  const r = {};
  let o = 4 + u32(c, 0, true);
  const n = Math.min(u32(c, o, true), 1000);
  o += 4;
  const T = {};
  for (let i = 0; i < n && o + 4 <= c.length; i++) {
    const l = u32(c, o, true);
    if (o + 4 + l > c.length) break;
    const s = c.toString('utf8', o + 4, o + 4 + l);
    const eq = s.indexOf('=');
    if (eq > 0) { const k = s.slice(0, eq).toUpperCase(); if (!T[k]) T[k] = s.slice(eq + 1); }
    o += 4 + l;
  }
  r.title = clean(T.TITLE);
  r.artist = clean(T.ARTIST || T.ALBUMARTIST);
  r.album = clean(T.ALBUM);
  if (T.DATE && /^\d{4}/.test(T.DATE)) r.year = Number(T.DATE.slice(0, 4));
  if (T.TRACKNUMBER) r.track = clean(T.TRACKNUMBER);
  if (T.GENRE) r.genre = clean(T.GENRE);
  return r;
}

function wavInfo(b) {
  const r = {};
  let o = 12;
  let byteRate = 0;
  while (o + 8 <= b.length) {
    const id = ascii(b, o, 4);
    const len = u32(b, o + 4, true);
    if (id === 'fmt ') { byteRate = u32(b, o + 16, true); r.sampleRate = u32(b, o + 12, true); }
    if (id === 'data') { if (byteRate) r.duration = Math.round((len / byteRate) * 100) / 100; break; }
    o += 8 + len + (len & 1);
  }
  return r;
}

// ── documents ──
function pdfString(s) {
  if (!s) return null;
  if (s.startsWith('<')) {
    const hex = s.slice(1, -1).replace(/\s+/g, '');
    const buf = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    return clean(buf[0] === 0xfe && buf[1] === 0xff ? swap16(buf.subarray(2)).toString('utf16le') : buf.toString('latin1'));
  }
  const body = s.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c, 8))));
  if (body.charCodeAt(0) === 0xfe && body.charCodeAt(1) === 0xff) return clean(swap16(Buffer.from(body.slice(2), 'latin1')).toString('utf16le'));
  return clean(body);
}
function pdfDate(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)).getTime();
  return Number.isFinite(t) ? t : null;
}

function pdfInfo(fd, head, size) {
  const r = {};
  const tail = size > head.length ? readAt(fd, Math.max(head.length, size - 1024 * 1024), Math.min(1024 * 1024, size - head.length)) : Buffer.alloc(0);
  const text = head.toString('latin1') + tail.toString('latin1');
  let pages = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages\b[^]{0,400}?\/Count\s+(\d+)|\/Count\s+(\d+)[^]{0,400}?\/Type\s*\/Pages\b/g)) pages = Math.max(pages, Number(m[1] || m[2]));
  if (!pages) pages = (text.match(/\/Type\s*\/Page\b(?!s)/g) || []).length || 0;
  if (pages) r.pages = pages;
  const str = '(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9a-fA-F\\s]*>)';
  const get = (k) => { const m = new RegExp(`/${k}\\s*${str}`).exec(text); return m ? m[1] : null; };
  r.title = pdfString(get('Title'));
  r.author = pdfString(get('Author'));
  r.created = pdfDate(pdfString(get('CreationDate')));
  const xt = /<dc:title>[^]*?<rdf:li[^>]*>([^<]*)<\/rdf:li>/.exec(text);
  if (!r.title && xt) r.title = clean(xt[1]);
  const xc = /<dc:creator>[^]*?<rdf:li[^>]*>([^<]*)<\/rdf:li>/.exec(text);
  if (!r.author && xc) r.author = clean(xc[1]);
  if (/\/Encrypt\s/.test(text)) r.encrypted = true;
  const v = /^%PDF-(\d\.\d)/.exec(head.toString('latin1', 0, 16));
  if (v) r.version = v[1];
  return r;
}

function zipEntries(fd, size) {
  const tailLen = Math.min(size, 66 * 1024);
  const t = readAt(fd, size - tailLen, tailLen);
  let e = -1;
  for (let i = t.length - 22; i >= 0; i--) if (t.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return null;
  const count = Math.min(u16(t, e + 10, true), 65535);
  const cdSize = u32(t, e + 12, true);
  const cdOff = u32(t, e + 16, true);
  if (cdOff + cdSize > size || cdSize > 32 * 1024 * 1024) return null;
  const cd = readAt(fd, cdOff, cdSize);
  const out = new Map();
  let o = 0;
  for (let i = 0; i < count && o + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(o) !== 0x02014b50) break;
    const method = u16(cd, o + 10, true);
    const csize = u32(cd, o + 20, true);
    const usize = u32(cd, o + 24, true);
    const nl = u16(cd, o + 28, true); const xl = u16(cd, o + 30, true); const cl = u16(cd, o + 32, true);
    const local = u32(cd, o + 42, true);
    out.set(cd.toString('utf8', o + 46, o + 46 + nl), { method, csize, usize, local });
    o += 46 + nl + xl + cl;
  }
  return out;
}

function zipRead(fd, size, ent) {
  if (!ent || ent.usize > MAX_ZIP_PART || ent.csize > MAX_ZIP_PART || ent.local + 30 > size) return null;
  const lh = readAt(fd, ent.local, 30);
  if (lh.readUInt32LE(0) !== 0x04034b50) return null;
  const data = readAt(fd, ent.local + 30 + u16(lh, 26, true) + u16(lh, 28, true), ent.csize);
  try {
    if (ent.method === 0) return data;
    if (ent.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ZIP_PART });
  } catch { /* corrupt */ }
  return null;
}

const xmlTag = (x, tag) => { const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(x); return m ? clean(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")) : null; };

function zipInfo(fd, size) {
  const ents = zipEntries(fd, size);
  if (!ents) return { type: 'zip' };
  const r = { entries: ents.size };
  const has = (n) => ents.has(n);
  let type = 'zip';
  if (has('word/document.xml')) type = 'docx';
  else if (has('xl/workbook.xml')) type = 'xlsx';
  else if (has('ppt/presentation.xml')) type = 'pptx';
  else if (has('mimetype')) {
    const mt = (zipRead(fd, size, ents.get('mimetype')) || Buffer.alloc(0)).toString('latin1').trim();
    if (mt === 'application/epub+zip') type = 'epub';
    else if (mt.endsWith('opendocument.text')) type = 'odt';
    else if (mt.endsWith('opendocument.spreadsheet')) type = 'ods';
    else if (mt.endsWith('opendocument.presentation')) type = 'odp';
  } else if (has('Index/Document.iwa') || has('Index.zip')) type = 'pages';
  r.type = type;
  if (['docx', 'xlsx', 'pptx'].includes(type)) {
    const core = zipRead(fd, size, ents.get('docProps/core.xml'));
    const app = zipRead(fd, size, ents.get('docProps/app.xml'));
    if (core) {
      const x = core.toString('utf8');
      r.title = xmlTag(x, 'dc:title');
      r.author = xmlTag(x, 'dc:creator');
      r.lastAuthor = xmlTag(x, 'cp:lastModifiedBy');
      const c = Date.parse(xmlTag(x, 'dcterms:created') || '');
      if (Number.isFinite(c)) r.created = c;
    }
    if (app) {
      const x = app.toString('utf8');
      const n = Number(xmlTag(x, 'Pages') || xmlTag(x, 'Slides') || 0);
      if (n) r.pages = n;
      const words = Number(xmlTag(x, 'Words') || 0);
      if (words) r.words = words;
      r.application = xmlTag(x, 'Application');
    }
    if (type === 'xlsx') r.sheets = [...ents.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).length;
  } else if (['odt', 'ods', 'odp'].includes(type)) {
    const meta = zipRead(fd, size, ents.get('meta.xml'));
    if (meta) {
      const x = meta.toString('utf8');
      r.title = xmlTag(x, 'dc:title');
      r.author = xmlTag(x, 'meta:initial-creator') || xmlTag(x, 'dc:creator');
      const c = Date.parse(xmlTag(x, 'meta:creation-date') || '');
      if (Number.isFinite(c)) r.created = c;
      const pc = /meta:(?:page|slide)-count="(\d+)"/.exec(x);
      if (pc) r.pages = Number(pc[1]);
    }
  } else if (type === 'epub') {
    const opfName = [...ents.keys()].find((k) => k.endsWith('.opf'));
    const opf = opfName && zipRead(fd, size, ents.get(opfName));
    if (opf) { const x = opf.toString('utf8'); r.title = xmlTag(x, 'dc:title'); r.author = xmlTag(x, 'dc:creator'); }
  }
  return r;
}

function textInfo(head, size) {
  const s = head.toString('utf8', 0, Math.min(head.length, 64 * 1024));
  const lines = (s.match(/\n/g) || []).length;
  const r = {};
  // Estimate for big files from the sample.
  r.lines = size <= head.length ? lines + (s.endsWith('\n') ? 0 : 1) : Math.round((lines / Math.max(1, Math.min(head.length, 64 * 1024))) * size);
  if (s.includes('\r\n')) r.eol = 'CRLF';
  return r;
}

/**
 * @returns {{type, mime, family, mismatch, taken, width, height, duration, camera, lens, gpsLat, gpsLon, title, artist, album, author, pages, bitrate, extra}}
 */
async function inspectFile(abs, { ext = '', size } = {}) {
  const fd = fs.openSync(abs, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    const sz = size ?? st.size;
    let head = readAt(fd, 0, Math.min(SNIFF, sz));
    let type = sniff(head, sz);
    if (NEED[type] && sz > head.length) head = readAt(fd, 0, Math.min(NEED[type], sz));
    let info = {};
    try {
      switch (type) {
        case 'jpeg': info = jpegInfo(head); break;
        case 'png': info = pngInfo(head); break;
        case 'gif': info = { width: u16(head, 6, true), height: u16(head, 8, true) }; break;
        case 'webp': info = webpInfo(head); break;
        case 'bmp': info = { width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)) }; break;
        case 'psd': info = { width: u32(head, 18), height: u32(head, 14) }; break;
        case 'tiff': info = parseTiff(head, 0); break;
        case 'heic': case 'avif': case 'cr3': info = heifInfo(fd, head, sz); break;
        case 'mp4': case 'mov': case 'm4a': info = mp4Info(fd, sz); if (type === 'mp4' && info.hasVideo === false) type = 'm4a'; break;
        case 'mp3': info = mp3Info(fd, head, sz); break;
        case 'flac': info = flacInfo(fd, head); break;
        case 'wav': info = wavInfo(head); break;
        case 'pdf': info = pdfInfo(fd, head, sz); break;
        case 'zip': info = zipInfo(fd, sz); type = info.type || 'zip'; break;
        case 'text': case 'html': case 'xml': case 'svg': info = textInfo(head, sz); break;
        default:
      }
    } catch (e) {
      info = { metaError: e.message };
    }
    const t = type ? TYPES[type] : null;
    const r = {
      type: type || null,
      mime: t ? t.mime : null,
      family: t ? t.family : null,
      mismatch: type ? mismatch(type, ext) : false,
      taken: info.taken ?? null,
      width: info.width || null,
      height: info.height || null,
      duration: info.duration ?? null,
      camera: info.camera || null,
      lens: info.lens || null,
      gpsLat: info.gpsLat ?? null,
      gpsLon: info.gpsLon ?? null,
      title: info.title || null,
      artist: info.artist || null,
      album: info.album || null,
      author: info.author || null,
      pages: info.pages || null,
      bitrate: info.bitrate || null,
      created: info.created ?? null,
      extra: {},
    };
    for (const k of ['orientation', 'year', 'track', 'genre', 'codec', 'sampleRate', 'words', 'sheets', 'application', 'lastAuthor', 'encrypted', 'version', 'entries', 'lines', 'eol', 'metaError']) if (info[k] !== undefined && info[k] !== null) r.extra[k] = info[k];
    Object.assign(r.extra, info.extra || {});
    // Sanity: drop absurd dimensions from broken headers.
    if (r.width > 1e6 || r.height > 1e6) { r.width = null; r.height = null; }
    if (r.duration !== null && (!(r.duration >= 0) || r.duration > 1e7)) r.duration = null;
    return r;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { inspectFile, sniff, mismatch, parseTiff, exifDate, TYPES, iso6709 };
