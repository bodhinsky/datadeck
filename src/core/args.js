'use strict';
const os = require('os');
const path = require('path');
// Builds the rsync argument vector for a profile. The result is always passed
// to spawn() as an array with shell:false, so nothing here is ever interpreted
// by a shell. Paths are placed after a literal "--" so a path that starts with
// "-" can never be read as an option.

const OUT_MARK = '::SD::';
const OUT_FORMAT = `${OUT_MARK}%i|%l|%n`;
const PARTIAL_DIR = '.rsync-partial';

// Toggleable flags shown in the UI, in display order.
const FLAGS = [
  { key: 'archive', arg: '-a', label: 'Archive', hint: 'Recurse and keep permissions, times, symlinks, owner, group' },
  { key: 'checksum', arg: '-c', label: 'Checksum compare', hint: 'Compare files by checksum, not size and mtime. Slower, most careful' },
  { key: 'compress', arg: '-z', label: 'Compress', hint: 'Compress data in transit. Helps on slow networks' },
  { key: 'update', arg: '-u', label: 'Skip newer', hint: 'Never overwrite files that are newer on the destination' },
  { key: 'ignoreExisting', arg: '--ignore-existing', label: 'Ignore existing', hint: 'Only copy files missing on the destination' },
  { key: 'hardLinks', arg: '-H', label: 'Hard links', hint: 'Preserve hard links' },
  { key: 'acls', arg: '-A', label: 'ACLs', hint: 'Preserve access control lists', cap: 'acls' },
  { key: 'xattrs', arg: '-X', label: 'Extended attrs', hint: 'Preserve extended attributes (Finder tags, etc.)', cap: 'xattrs' },
  { key: 'oneFileSystem', arg: '-x', label: 'One filesystem', hint: 'Do not cross filesystem boundaries' },
  { key: 'numericIds', arg: '--numeric-ids', label: 'Numeric IDs', hint: 'Do not map uid/gid by name' },
  { key: 'delayUpdates', arg: '--delay-updates', label: 'Atomic-ish', hint: 'Put all updated files into place at the end of the run' },
  { key: 'delete', arg: '--delete', label: 'Delete extraneous', hint: 'Remove files from the destination that are not in the source', danger: true },
];

const DEFAULT_PROFILE = Object.freeze({
  name: 'New profile',
  source: '',
  dest: '',
  contents: true,
  flags: { archive: true, checksum: false, compress: false, update: false, ignoreExisting: false, hardLinks: false, acls: false, xattrs: false, oneFileSystem: false, numericIds: false, delayUpdates: false, delete: false },
  excludes: ['.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd'],
  safety: { verifyAfter: true, backup: false, backupDir: '', maxDelete: 500 },
  network: { retries: 8, timeout: 60, sshPort: '', bwlimit: '', identityFile: '' },
  extraArgs: '',
});

function newProfile(over = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  return normalizeProfile({ ...base, ...over, id: over.id || randomId() });
}

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Fill in any missing fields so older saved profiles keep working.
function normalizeProfile(p) {
  const d = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  return {
    ...d,
    ...p,
    flags: { ...d.flags, ...(p.flags || {}) },
    safety: { ...d.safety, ...(p.safety || {}) },
    network: { ...d.network, ...(p.network || {}) },
    excludes: Array.isArray(p.excludes) ? p.excludes.filter((e) => typeof e === 'string') : d.excludes,
  };
}

// "host:path" or "user@host:path" or "rsync://..." is remote. A local path is
// anything else. rsync treats "foo:bar" as remote too, so we mirror that rule.
function isRemote(path) {
  if (typeof path !== 'string') return false;
  if (/^rsync:\/\//i.test(path)) return true;
  const colon = path.indexOf(':');
  if (colon <= 0) return false;
  return !path.slice(0, colon).includes('/');
}

// rsync is spawned without a shell, so "~" would be taken literally.
function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function localize(p) {
  const t = p.trim();
  return isRemote(t) ? t : expandHome(t);
}

// Source trailing slash decides whether the folder itself or its contents get
// copied. We make that explicit instead of relying on the user typing a "/".
function sourceSpec(source, contents) {
  let s = source.trim();
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (contents && !s.endsWith('/')) s += '/';
  return s;
}

// Minimal tokenizer for the "extra args" box: whitespace-separated, with
// single and double quotes. No variables, globs or escapes are expanded.
function tokenize(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of str || '') {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error('Unclosed quote in extra arguments');
  if (has || cur) out.push(cur);
  return out;
}

function sshCommand(net) {
  const parts = ['ssh', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=20'];
  if (net.sshPort) parts.push('-p', String(Number(net.sshPort)));
  if (net.identityFile) parts.push('-i', shellQuote(net.identityFile));
  return parts.join(' ');
}

// rsync splits the -e value itself (not via a shell), honoring quotes.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {object} profile
 * @param {object} opts { dryRun, verify, caps }
 *   caps comes from probeCaps(); a feature counts as supported unless its
 *   key is explicitly false. `modern` (rsync >= 3.1) is the fallback hint.
 * @returns {string[]} argv for rsync, without the binary
 */
function buildArgs(profile, opts = {}) {
  const p = normalizeProfile(profile);
  const caps = opts.caps || { modern: true };
  const has = (k) => hasCap(caps, k);
  const a = [];

  for (const f of FLAGS) {
    if (!p.flags[f.key]) continue;
    if (f.cap && !has(f.cap)) continue;
    a.push(f.arg);
  }
  if (!p.flags.archive) a.push('-r'); // always recurse; that's what a sync means

  if (opts.verify) {
    // Integrity pass: full-content checksum, change nothing.
    if (!a.includes('-c')) a.push('-c');
  }
  if (opts.dryRun || opts.verify) a.push('--dry-run');

  if (p.flags.delete && p.safety.maxDelete > 0 && !opts.verify && has('maxDelete')) a.push(`--max-delete=${Math.floor(p.safety.maxDelete)}`);

  if (p.safety.backup && !opts.dryRun && !opts.verify) {
    a.push('--backup');
    if (p.safety.backupDir && has('backupDir')) a.push(`--backup-dir=${p.safety.backupDir}`);
  }

  // Resume support: keep partially transferred files in a hidden dir so the
  // next attempt continues from them instead of starting over.
  if (!opts.verify && !opts.dryRun) a.push(has('partialDir') ? `--partial-dir=${PARTIAL_DIR}` : '--partial');
  a.push(`--exclude=${PARTIAL_DIR}/`);

  // A stalled network turns into a clean error (exit 30) we can retry.
  const timeout = Number(p.network.timeout);
  if (timeout > 0 && has('timeout')) a.push(`--timeout=${Math.floor(timeout)}`);
  const bw = String(p.network.bwlimit || '').trim();
  if (bw) a.push(`--bwlimit=${bw}`);

  for (const ex of p.excludes) {
    const e = ex.trim();
    if (e) a.push(`--exclude=${e}`);
  }

  if ((isRemote(p.source) || isRemote(p.dest)) && !/^rsync:/i.test(p.source) && !/^rsync:/i.test(p.dest)) {
    a.push('-e', sshCommand(p.network));
  }
  if (has('protectArgs')) a.push('-s'); // protect remote paths from the remote shell

  // Itemized output drives the transfer list; our marked format also carries
  // sizes. Without --out-format, fall back to plain -i.
  a.push(has('outFormat') ? `--out-format=${OUT_FORMAT}` : '-i');
  if (!opts.verify && !opts.dryRun) {
    if (has('progress2')) a.push('--info=progress2');
    else if (has('progress')) a.push('--progress');
  }
  if (has('stats')) a.push('--stats');

  a.push(...tokenize(p.extraArgs));

  a.push('--', sourceSpec(localize(p.source), p.contents), localize(p.dest));
  return a;
}

// Probed features; when a key is missing we fall back to the version hint.
const MODERN_ONLY = new Set(['progress2', 'protectArgs', 'xattrs', 'acls']);
function hasCap(caps, k) {
  if (caps[k] === false) return false;
  if (caps[k] === true) return true;
  return MODERN_ONLY.has(k) ? caps.modern !== false : true;
}

// Display-only: what the command would look like in a terminal.
function commandPreview(bin, args) {
  const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : shellQuote(s));
  return [bin, ...args].map(q).join(' ');
}

module.exports = { hasCap, expandHome, localize, FLAGS, DEFAULT_PROFILE, OUT_MARK, PARTIAL_DIR, newProfile, normalizeProfile, isRemote, sourceSpec, tokenize, buildArgs, commandPreview, shellQuote };
