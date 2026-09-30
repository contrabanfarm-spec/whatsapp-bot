const fs = require('fs');
const path = require('path');
const config = require('./config');

// Present while Thandi is switched off with scripts/offline.js. Read on every message, so switching takes
// effect immediately without a restart; kept next to the database so it survives container rebuilds.
// Contents: { "since": ISO time, "note": text added to the away message, or null }.
const OFFLINE_FILE = path.join(path.dirname(config.dbPath), 'offline.json');

/**
 * { since, note } while the bot is offline (since in ms), otherwise null. A file that can't be parsed (say,
 * hand-edited or empty) still means offline, dated from when it was last changed.
 */
function getOfflineState() {
  let stat;
  try {
    stat = fs.statSync(OFFLINE_FILE);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  let saved = {};
  try {
    const text = fs.readFileSync(OFFLINE_FILE, 'utf8').trim();
    if (text) saved = JSON.parse(text);
  } catch (err) {
    console.error(`Can't read ${OFFLINE_FILE}; treating the bot as offline since the file last changed:`, err.message);
  }
  const note = typeof saved.note === 'string' && saved.note.trim() ? saved.note.trim() : null;
  return { since: Date.parse(saved.since) || stat.mtimeMs, note };
}

/**
 * Take the bot offline, or update the note if it already is. The start time is kept, so people who have
 * already had the away message aren't sent it again. Without a note, an existing one is kept.
 */
function setOffline(note) {
  const current = getOfflineState();
  const state = {
    since: current ? current.since : Date.now(),
    note: note === undefined ? current?.note ?? null : note,
  };
  fs.writeFileSync(OFFLINE_FILE, `${JSON.stringify({ since: new Date(state.since).toISOString(), note: state.note }, null, 2)}\n`);
  return { ...state, wasOffline: Boolean(current) };
}

/** Bring the bot back online. Returns the offline state that just ended, or null if it wasn't offline. */
function setOnline() {
  const current = getOfflineState();
  fs.rmSync(OFFLINE_FILE, { force: true });
  return current;
}

/**
 * What people get while the bot is offline, or when Claude can't be reached. Their message isn't answered
 * later, so it asks them to send it again and gives the team's contact details for anything sooner.
 */
function awayMessage(note) {
  return [
    "Hi, this is Thandi from CareCircle. I'm offline at the moment, so I can't answer your message right now.",
    note,
    'Please send your question again later, or for help sooner, email support@thecarecircle.co.za or call 010 594 4166.',
  ]
    .filter(Boolean)
    .join(' ');
}

module.exports = { OFFLINE_FILE, getOfflineState, setOffline, setOnline, awayMessage };
