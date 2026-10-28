'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only surface the UI gets. No Node, no fs, no child_process.
contextBridge.exposeInMainWorld('deck', {
  engine: (method, params) => ipcRenderer.invoke('engine:call', method, params),
  onEngineEvent: (fn) => ipcRenderer.on('engine:event', (_e, m) => fn(m.event, m.data)),
  preview: (entryId, size) => ipcRenderer.invoke('preview:get', entryId, size),
  saveFile: (opts) => ipcRenderer.invoke('dialog:save', opts),
  init: () => ipcRenderer.invoke('app:init'),
  newProfile: () => ipcRenderer.invoke('profiles:new'),
  saveProfile: (p) => ipcRenderer.invoke('profiles:save', p),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  detectRsync: () => ipcRenderer.invoke('rsync:detect'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pick', opts),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  check: (profile, dryRun) => ipcRenderer.invoke('run:check', { profile, dryRun }),
  start: (profile, dryRun, runId) => ipcRenderer.invoke('run:start', { profile, dryRun, runId }),
  stop: () => ipcRenderer.invoke('run:stop'),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onRunEvent: (fn) => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on('run:event', h);
    return () => ipcRenderer.removeListener('run:event', h);
  },
});
