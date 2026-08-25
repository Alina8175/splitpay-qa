'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.SPLITPAY_DATA
  ? path.resolve(process.env.SPLITPAY_DATA)
  : path.join(__dirname, '..', 'data.json');

const EMPTY = {
  users: [],
  sessions: [],
  groups: [],
  expenses: [],
  settlements: [],
  activity: []
};

let db = null;
let writeTimer = null;
let writing = false;
let pending = false;

function load() {
  if (db) return db;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = Object.assign({}, EMPTY, parsed);
    for (const key of Object.keys(EMPTY)) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[store] data file unreadable, starting empty:', err.message);
    }
    db = JSON.parse(JSON.stringify(EMPTY));
    flushSync();
  }
  return db;
}

function flushSync() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Debounced async write so a burst of requests does not thrash the disk.
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(doWrite, 25);
  if (writeTimer.unref) writeTimer.unref();
}

function doWrite() {
  writeTimer = null;
  if (writing) {
    pending = true;
    return;
  }
  writing = true;
  const tmp = DATA_FILE + '.tmp';
  const payload = JSON.stringify(db, null, 2);
  fs.writeFile(tmp, payload, (err) => {
    if (err) {
      writing = false;
      console.error('[store] write failed:', err.message);
      return;
    }
    fs.rename(tmp, DATA_FILE, (err2) => {
      writing = false;
      if (err2) console.error('[store] rename failed:', err2.message);
      if (pending) {
        pending = false;
        doWrite();
      }
    });
  });
}

function data() {
  return load();
}

function saveOnExit() {
  try {
    if (db) flushSync();
  } catch (err) {
    console.error('[store] final flush failed:', err.message);
  }
}

module.exports = { data, persist, flushSync, saveOnExit, DATA_FILE };
