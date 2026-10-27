'use strict';
const { OUT_MARK } = require('./args');

// Itemize code reference: https://download.samba.org/pub/rsync/rsync.1#opt--itemize-changes
// YXcstpoguax  Y = update type, X = file type.
function classifyItem(code) {
  if (code.startsWith('*deleting')) return 'delete';
  const y = code[0];
  const x = code[1];
  const isNew = code.slice(2).startsWith('+++');
  if (y === '>' || y === '<') return isNew ? 'new' : 'update';
  if (y === 'c') return x === 'd' ? 'mkdir' : isNew ? 'new' : 'update';
  if (y === 'h') return 'link';
  if (y === '.') return 'meta';
  return 'other';
}

function kindOf(code) {
  if (code.startsWith('*')) return 'any';
  return { f: 'file', d: 'dir', L: 'symlink', D: 'device', S: 'special' }[code[1]] || 'other';
}

// "::SD::>f+++++++++|300000|sub/big.bin" -> item
function parseItem(line) {
  if (!line.startsWith(OUT_MARK)) return null;
  const rest = line.slice(OUT_MARK.length);
  const p1 = rest.indexOf('|');
  const p2 = rest.indexOf('|', p1 + 1);
  if (p1 < 0 || p2 < 0) return null;
  const code = rest.slice(0, p1).trimEnd();
  const size = Number(rest.slice(p1 + 1, p2).replace(/,/g, '')) || 0;
  const path = rest.slice(p2 + 1);
  return { code, action: classifyItem(code), kind: kindOf(code), size, path };
}

// Plain "-i" itemize output (no --out-format support): "%i %n%L".
const ITEMIZE_RE = /^(\*deleting|[<>ch.][fdLDS][.+?a-zA-Z ]{9})\s+(.+)$/;
function parseItemize(line) {
  const m = ITEMIZE_RE.exec(line);
  if (!m) return null;
  const code = m[1].trimEnd();
  return { code, action: classifyItem(code), kind: kindOf(code), size: 0, path: m[2] };
}

// Progress lines, both the modern --info=progress2 total line and the older
// per-file --progress line.
//   "    300,005 100%  286.10MB/s    0:00:00 (xfr#3, to-chk=0/5)"
//   "      32768 100%   31.25MB/s    0:00:00 (xfer#1, to-check=3/5)"
const PROGRESS_RE = /^\s*([\d,.]+)\s+(\d{1,3})%\s+([\d.,]+\s*[kKMGT]?B\/s)\s+(\d+:\d{2}:\d{2})(?:\s+\((?:xfr|xfer)#(\d+),\s*(?:to-chk|to-check|ir-chk)=(\d+)\/(\d+)\))?/;

function parseProgress(line) {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const out = {
    bytes: Number(m[1].replace(/[,.]/g, '')),
    percent: Number(m[2]),
    rate: m[3].replace(/\s+/g, ''),
    eta: m[4],
  };
  if (m[5]) {
    out.xfr = Number(m[5]);
    out.toCheck = Number(m[6]);
    out.total = Number(m[7]);
  }
  return out;
}

function num(s) {
  return Number(String(s).replace(/,/g, ''));
}

// Picks numbers out of the --stats block.
function parseStats(text) {
  const s = {};
  const grab = (key, re) => {
    const m = re.exec(text);
    if (m) s[key] = num(m[1]);
  };
  grab('files', /Number of files:\s+([\d,]+)/);
  grab('created', /Number of created files:\s+([\d,]+)/);
  grab('deleted', /Number of deleted files:\s+([\d,]+)/);
  grab('transferred', /Number of (?:regular )?files transferred:\s+([\d,]+)/);
  grab('totalSize', /Total file size:\s+([\d,]+)/);
  grab('transferredSize', /Total transferred file size:\s+([\d,]+)/);
  grab('sent', /Total bytes sent:\s+([\d,]+)/);
  grab('received', /Total bytes received:\s+([\d,]+)/);
  grab('speedup', /speedup is ([\d,.]+)/);
  return s;
}

// "rsync  version 3.2.7  protocol version 31"
// "rsync  version 2.6.9  protocol version 29"
// "openrsync: protocol version 29"
function parseVersion(text) {
  const t = String(text || '');
  if (/openrsync/i.test(t)) return { name: 'openrsync', version: null, major: 0, minor: 0, modern: false, openrsync: true };
  const m = /version\s+v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(t);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return {
    name: 'rsync',
    version: `${m[1]}.${m[2]}${m[3] !== undefined ? '.' + m[3] : ''}`,
    major,
    minor,
    modern: major > 3 || (major === 3 && minor >= 1),
    openrsync: false,
  };
}

// Streaming splitter: rsync redraws progress with \r, normal lines end in \n.
class LineSplitter {
  constructor(onLine) {
    this.buf = '';
    this.onLine = onLine;
  }
  push(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.search(/[\r\n]/)) >= 0) {
      const line = this.buf.slice(0, i);
      const sep = this.buf[i];
      this.buf = this.buf.slice(i + 1);
      if (line.length) this.onLine(line, sep === '\r');
    }
  }
  flush() {
    if (this.buf.length) this.onLine(this.buf, false);
    this.buf = '';
  }
}

const EXIT_CODES = {
  0: 'Success',
  1: 'Syntax or usage error',
  2: 'Protocol incompatibility',
  3: 'Errors selecting input/output files, dirs',
  4: 'Requested action not supported',
  5: 'Error starting client-server protocol',
  6: 'Daemon unable to append to log-file',
  10: 'Error in socket I/O',
  11: 'Error in file I/O',
  12: 'Error in rsync protocol data stream',
  13: 'Errors with program diagnostics',
  14: 'Error in IPC code',
  20: 'Received SIGUSR1 or SIGINT',
  21: 'Some error returned by waitpid()',
  22: 'Error allocating core memory buffers',
  23: 'Partial transfer due to error',
  24: 'Partial transfer due to vanished source files',
  25: 'The --max-delete limit stopped deletions',
  30: 'Timeout in data send/receive',
  35: 'Timeout waiting for daemon connection',
  255: 'SSH connection failed',
};

function describeExit(code) {
  return EXIT_CODES[code] || `Exited with code ${code}`;
}

module.exports = { classifyItem, parseItem, parseItemize, parseProgress, parseStats, parseVersion, LineSplitter, describeExit, EXIT_CODES };
