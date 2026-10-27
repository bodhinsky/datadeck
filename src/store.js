'use strict';
const fs = require('fs');
const path = require('path');

const HISTORY_LIMIT = 300;
const DEFAULT_SETTINGS = { rsyncPath: '', theme: 'retro', notifications: true, preventSleep: true };

// JSON files in the app's data folder. Every write goes to a temp file that is
// fsynced and renamed over the old one, so a crash never leaves half a file.
class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = {
      profiles: this.read('profiles.json', []),
      history: this.read('history.json', []),
      settings: { ...DEFAULT_SETTINGS, ...this.read('settings.json', {}) },
    };
  }

  file(name) {
    return path.join(this.dir, name);
  }

  read(name, fallback) {
    const f = this.file(name);
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of overwriting it.
        try { fs.renameSync(f, `${f}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      return fallback;
    }
  }

  write(name, value) {
    const f = this.file(name);
    const tmp = `${f}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, f);
  }

  profiles() { return this.data.profiles; }
  history() { return this.data.history; }
  settings() { return this.data.settings; }

  saveProfile(p) {
    const i = this.data.profiles.findIndex((x) => x.id === p.id);
    if (i >= 0) this.data.profiles[i] = p;
    else this.data.profiles.push(p);
    this.write('profiles.json', this.data.profiles);
    return this.data.profiles;
  }

  deleteProfile(id) {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    this.write('profiles.json', this.data.profiles);
    return this.data.profiles;
  }

  saveSettings(s) {
    const clean = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in s) clean[k] = s[k];
    this.data.settings = { ...this.data.settings, ...clean };
    this.write('settings.json', this.data.settings);
    return this.data.settings;
  }

  addHistory(entry) {
    this.data.history.unshift(entry);
    this.data.history = this.data.history.slice(0, HISTORY_LIMIT);
    this.write('history.json', this.data.history);
    return this.data.history;
  }

  clearHistory() {
    this.data.history = [];
    this.write('history.json', []);
    return [];
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
