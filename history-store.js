'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_PATH = path.join(__dirname, 'data', 'history.json');
// No cap on stored entries or on the size of each entry's text — history
// keeps every run, in full, indefinitely, until the user deletes it.

let entries = [];

function load() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      entries = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (!Array.isArray(entries)) entries = [];
    }
  } catch (err) {
    console.error(`[history] failed to load persisted history, starting empty: ${err.message}`);
    entries = [];
  }
}

function persist() {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

function countWords(str) {
  const m = (str || '').trim().match(/\S+/g);
  return m ? m.length : 0;
}

function append({ intensity, style, original, humanized, hadError }) {
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    timestamp: new Date().toISOString(),
    intensity: intensity || 'balanced',
    style: style || 'academic',
    original,
    humanized,
    wordsBefore: countWords(original),
    wordsAfter: countWords(humanized),
    hadError: !!hadError,
  };
  entries.unshift(entry); // newest first, never trimmed
  persist();
  return entry;
}

function list({ limit, offset = 0 } = {}) {
  // No limit passed (or limit <= 0) means "everything".
  const slice = limit > 0 ? entries.slice(offset, offset + limit) : entries.slice(offset);
  return { entries: slice, total: entries.length };
}

function remove(id) {
  const before = entries.length;
  entries = entries.filter((e) => e.id !== id);
  if (entries.length !== before) persist();
  return entries.length !== before;
}

function clear() {
  entries = [];
  persist();
}

load();

module.exports = { append, list, remove, clear };
