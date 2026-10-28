'use strict';
// Rules for names and paths that break on other file systems or tools.
// Used both to flag issues after a scan and to sanitize target names when
// restructuring.

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
const WIN_BAD_CHARS = /[<>:"\\|?*\u0000-\u001f]/;
const WIN_BAD_CHARS_G = /[<>:"\\|?*\u0000-\u001f]/g;
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized', 'ehthumbs.db', '.spotlight-v100', '.trashes', '.fseventsd', '.temporaryitems', '.apdisk', '._.ds_store']);

const TARGETS = {
  apfs: { label: 'APFS / HFS+ (macOS)', maxName: 255, maxPath: 1024, badChars: /[\u0000/]/, caseInsensitive: true, maxFile: Infinity, win: false },
  ext4: { label: 'ext4 / Linux', maxName: 255, maxPath: 4096, badChars: /[\u0000/]/, caseInsensitive: false, maxFile: Infinity, win: false },
  ntfs: { label: 'NTFS (Windows)', maxName: 255, maxPath: 260, badChars: WIN_BAD_CHARS, caseInsensitive: true, maxFile: Infinity, win: true },
  exfat: { label: 'exFAT (USB drives, SD cards)', maxName: 255, maxPath: 260, badChars: WIN_BAD_CHARS, caseInsensitive: true, maxFile: Infinity, win: true },
  fat32: { label: 'FAT32 (old USB drives)', maxName: 255, maxPath: 260, badChars: WIN_BAD_CHARS, caseInsensitive: true, maxFile: 4294967295, win: true },
};

function utf8Len(s) {
  return Buffer.byteLength(s, 'utf8');
}

// Problems a single name has on a given target.
function nameProblems(name, target = 'exfat') {
  const t = TARGETS[target] || TARGETS.exfat;
  const out = [];
  if (t.badChars.test(name)) out.push('bad-char');
  if (t.win) {
    if (WIN_RESERVED.test(name)) out.push('reserved-name');
    if (/[. ]$/.test(name)) out.push('trailing-dot-space');
  }
  if (t.win ? name.length > t.maxName : utf8Len(name) > t.maxName) out.push('name-too-long');
  if (/^\s|\s$/.test(name) && !out.includes('trailing-dot-space')) out.push('edge-whitespace');
  if (name.normalize('NFC') !== name) out.push('not-nfc');
  return out;
}

// Turns any name into one that is valid on the target. Deterministic, so a
// plan built twice gives the same result.
function sanitizeName(name, target = 'exfat') {
  const t = TARGETS[target] || TARGETS.exfat;
  let n = name.normalize('NFC');
  n = n.replace(/\u0000/g, '').replace(/\//g, '_');
  if (t.win) {
    n = n.replace(WIN_BAD_CHARS_G, '_');
    n = n.replace(/[. ]+$/, '');
    if (WIN_RESERVED.test(n)) n = `_${n}`;
  }
  n = n.trim();
  if (!n || n === '.' || n === '..') n = '_';
  // Shorten to the limit, keeping the extension.
  const limit = t.maxName;
  const tooLong = (x) => (t.win ? x.length : utf8Len(x)) > limit;
  if (tooLong(n)) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    let stem = ext ? n.slice(0, dot) : n;
    while (stem.length && tooLong(stem + ext)) stem = [...stem].slice(0, -1).join('');
    n = stem + ext;
  }
  return n;
}

function isJunk(name) {
  return JUNK.has(name.toLowerCase()) || name.startsWith('._');
}

module.exports = { TARGETS, nameProblems, sanitizeName, isJunk, utf8Len, WIN_RESERVED };
