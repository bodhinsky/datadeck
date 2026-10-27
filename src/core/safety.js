'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { isRemote, tokenize, normalizeProfile, expandHome } = require('./args');

// Options the "extra args" box may not carry. They either change which program
// runs (-e, --rsync-path), bypass our own safety rails, or read/write files
// outside the sync in ways the UI cannot show.
const BLOCKED_OPTS = [
  /^--rsh(=|$)/, /^--rsync-path(=|$)/, /^--daemon$/, /^--config(=|$)/,
  /^--write-batch(=|$)/, /^--only-write-batch(=|$)/, /^--read-batch(=|$)/,
  /^--log-file(=|$)/, /^--out-format(=|$)/, /^--log-format(=|$)/, /^--info(=|$)/,
  /^--password-file(=|$)/, /^--partial-dir(=|$)/, /^--temp-dir(=|$)/,
  /^--delete-excluded$/, /^--ignore-errors$/, /^--force$/,
];
const WARN_OPTS = [
  { re: /^--remove-source-files$/, msg: '--remove-source-files deletes files from the SOURCE after copying.' },
  { re: /^--inplace$/, msg: '--inplace writes directly into destination files; an interrupted run can leave them half written.' },
  { re: /^--append(=|$)/, msg: '--append assumes existing destination data is correct and skips checking it.' },
  { re: /^--(delete|del)(-[a-z]+)?$/, msg: 'Delete options belong in the "Delete extraneous" toggle so the safety checks apply.' },
];

const PROTECTED_DESTS = ['/', '/System', '/Library', '/Applications', '/Users', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/Volumes', '/home', '/root'];


function normLocal(p) {
  return path.resolve(expandHome(p.trim()));
}

/**
 * Checks a profile before a run. Errors block the run; warnings are shown and
 * the user must confirm.
 * @param {object} profile
 * @param {object} opts { dryRun, fs } fs can be stubbed in tests
 */
function validateProfile(profile, opts = {}) {
  const p = normalizeProfile(profile);
  const fsx = opts.fs || fs;
  const errors = [];
  const warnings = [];
  const src = (p.source || '').trim();
  const dst = (p.dest || '').trim();

  if (!src) errors.push('Choose a source.');
  if (!dst) errors.push('Choose a destination.');
  for (const [label, v] of [['Source', src], ['Destination', dst]]) {
    if (/[\n\r\0]/.test(v)) errors.push(`${label} path contains a line break or NUL character.`);
  }
  if (isRemote(src) && isRemote(dst)) errors.push('rsync cannot copy between two remote hosts. Make one side local.');

  const srcLocal = src && !isRemote(src);
  const dstLocal = dst && !isRemote(dst);

  if (srcLocal && !errors.length) {
    const s = normLocal(src);
    let st = null;
    try { st = fsx.statSync(s); } catch { /* missing */ }
    if (!st) errors.push(`Source does not exist: ${s}`);
    else if (p.flags.delete && st.isDirectory() && p.contents) {
      // An empty or unmounted source plus --delete would wipe the destination.
      let entries = [];
      try { entries = fsx.readdirSync(s).filter((n) => n !== '.DS_Store'); } catch (e) { errors.push(`Cannot read source: ${e.message}`); }
      if (!entries.length && !errors.length) errors.push('Source folder is empty. With "Delete extraneous" on, this would delete everything at the destination. Is the drive mounted?');
    }
  }

  if (srcLocal && dstLocal && src && dst) {
    const s = normLocal(src);
    const d = normLocal(dst);
    if (s === d) errors.push('Source and destination are the same folder.');
    else if ((d + path.sep).startsWith(s + path.sep)) errors.push('Destination is inside the source. That would copy the backup into itself.');
    else if (p.flags.delete && (s + path.sep).startsWith(d + path.sep) && p.contents) errors.push('Source is inside the destination; "Delete extraneous" would remove everything else in the destination.');
  }

  if (dstLocal && dst) {
    const d = normLocal(dst);
    const home = os.homedir();
    if (p.flags.delete && (PROTECTED_DESTS.includes(d) || d === home)) {
      errors.push(`Refusing to use "Delete extraneous" on ${d}. Pick a dedicated backup folder.`);
    }
  }

  if (/^rsync:\/\//i.test(src) || /^rsync:\/\//i.test(dst) || /^[^/:]+::/.test(src) || /^[^/:]+::/.test(dst)) {
    warnings.push('rsync:// daemon connections are not encrypted. Use SSH (user@host:/path) for anything that crosses an untrusted network.');
  }

  if (p.flags.delete) {
    warnings.push('"Delete extraneous" is on: files at the destination that are not in the source will be deleted.');
    if (!(p.safety.maxDelete > 0)) warnings.push('No delete limit is set. Consider setting a max-delete limit.');
  }

  let extra = [];
  try { extra = tokenize(p.extraArgs); } catch (e) { errors.push(e.message); }
  for (const tok of extra) {
    if (!tok.startsWith('-')) {
      errors.push(`Extra argument "${tok}" is not an option. Set paths in Source and Destination.`);
      continue;
    }
    const shortBad = /^-[^-]/.test(tok) && /[eT]/.test(tok.slice(1));
    if (shortBad || BLOCKED_OPTS.some((re) => re.test(tok))) errors.push(`Extra argument "${tok}" is not allowed here; use the matching setting instead.`);
    for (const w of WARN_OPTS) if (w.re.test(tok)) warnings.push(w.msg);
  }

  const port = String(p.network.sshPort || '').trim();
  if (port && !(/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536)) errors.push('SSH port must be a number between 1 and 65535.');
  const bw = String(p.network.bwlimit || '').trim();
  if (bw && !/^\d+(\.\d+)?[KMGkmg]?$/.test(bw)) errors.push('Bandwidth limit must look like 5000 or 20M.');
  if (!(Number(p.network.retries) >= 0 && Number(p.network.retries) <= 100)) errors.push('Retries must be between 0 and 100.');
  for (const ex of p.excludes) if (/[\n\r\0]/.test(ex)) errors.push('Exclude patterns cannot contain line breaks.');
  if (p.safety.backup && p.safety.backupDir && /[\n\r\0]/.test(p.safety.backupDir)) errors.push('Backup folder contains invalid characters.');

  return { ok: errors.length === 0, errors, warnings };
}

// Which exit codes are worth retrying: network and timeout failures.
const RETRYABLE = new Set([5, 10, 12, 30, 35, 255]);

function isRetryable(code) {
  return RETRYABLE.has(code);
}

// 5s, 10s, 20s, 40s ... capped at 5 minutes, with +-20% jitter.
function backoffMs(attempt, { base = 5000, cap = 300000, rand = Math.random } = {}) {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (rand() * 0.4 - 0.2);
  return Math.round(raw * jitter);
}

module.exports = { validateProfile, isRetryable, backoffMs, RETRYABLE, BLOCKED_OPTS, expandHome };
