/*
 * Take Thandi offline and bring her back, without restarting or rebuilding the bot.
 *
 *   node scripts/offline.js on                                   go offline
 *   node scripts/offline.js on "I'll be back on Monday at 08:00."  ...and add a note to the away message
 *   node scripts/offline.js off                                  back online
 *   node scripts/offline.js status                               show whether she's offline
 *
 * While offline the bot keeps receiving messages. Each person gets the away message from src/offline.js once
 * per offline period; their messages are logged but not answered, now or later. Running "on" again while
 * offline only changes the note, so nobody is sent the away message twice.
 */
const path = require('path');
// Load .env from the project root even when run from another directory; src/config.js then validates it.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const config = require('../src/config');
const { getOfflineState, setOffline, setOnline, awayMessage } = require('../src/offline');

/** How many people have been sent the away message since `since` (ms), or null if that can't be read. */
function awayNoticesSince(since) {
  try {
    const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM away_notices WHERE notified_at >= ?').get(since).n;
    } finally {
      db.close();
    }
  } catch (err) {
    // No database yet, or the bot hasn't started with the version that creates away_notices.
    return null;
  }
}

function formatSast(ms) {
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
}

function describeOffline({ since, note }) {
  const told = awayNoticesSince(since);
  console.log(`Thandi is OFFLINE, since ${formatSast(since)} (SA time).`);
  console.log(`People sent the away message so far: ${told ?? 'unknown'}`);
  console.log(`Each new person who messages gets, once:\n  ${awayMessage(note)}`);
}

const [command, noteArg] = process.argv.slice(2);
const note = noteArg?.trim() || undefined;

if (command === 'on') {
  const state = setOffline(note);
  if (state.wasOffline) console.log(note ? 'Already offline; note updated.' : 'Already offline.');
  describeOffline(state);
  console.log('Bring her back with: node scripts/offline.js off');
} else if (command === 'off') {
  const ended = setOnline();
  if (!ended) {
    console.log('Thandi was already online.');
  } else {
    const told = awayNoticesSince(ended.since);
    console.log(`Thandi is back ONLINE. She was offline since ${formatSast(ended.since)} (SA time).`);
    console.log(`${told ?? 'An unknown number of'} people were sent the away message in that time.`);
  }
} else if (command === 'status') {
  const state = getOfflineState();
  if (state) describeOffline(state);
  else console.log('Thandi is ONLINE and answering messages.');
} else {
  console.error('Usage: node scripts/offline.js on ["note for the away message"] | off | status');
  process.exitCode = 1;
}
