'use strict';
// Worker-thread host for the engine. Messages in: { id, method, params }.
// Messages out: { id, ok, result | error } and { event, data }.
const { parentPort, workerData } = require('worker_threads');
const { Engine, call } = require('./engine');

process.removeAllListeners('warning'); // silence the "SQLite is experimental" notice

const engine = new Engine(workerData.dbFile, { emit: (event, data) => parentPort.postMessage({ event, data }) });

parentPort.on('message', async (msg) => {
  if (msg && msg.type === 'close') { engine.close(); process.exit(0); }
  const { id, method, params } = msg || {};
  try {
    const result = await call(engine, method, params);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});
parentPort.postMessage({ event: 'ready', data: {} });
