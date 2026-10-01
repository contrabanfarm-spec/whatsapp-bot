/*
 * Watch customers' WhatsApp messages and Thandi's replies live, in the terminal.
 *
 *   node scripts/watch.js        show the last 10 messages, then follow new ones
 *   node scripts/watch.js 50     show the last 50 first
 *   node scripts/watch.js 0      only new messages
 *
 * On the server:  docker compose exec whatsapp-bot node scripts/watch.js     (Ctrl+C to stop)
 *
 * Read-only: it opens the database without write access, so it can't affect the running bot. It shows every
 * incoming message (text, photos and PDFs with their captions, other media by type) and the reply that was
 * actually sent, including fallbacks and away messages. Messages are kept for 24 hours, so history goes back
 * at most that far.
 */
const path = require('path');
// Load .env from the project root even when run from another directory; src/config.js then validates it.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const config = require('../src/config');

const POLL_INTERVAL_MS = 1000;
const historyArg = process.argv[2];
const HISTORY = historyArg === undefined ? 10 : Number(historyArg);
if (!Number.isInteger(HISTORY) || HISTORY < 0) {
  console.error('Usage: node scripts/watch.js [number of past messages to show first, default 10]');
  process.exit(1);
}

let db;
try {
  db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`Can't open the database at ${config.dbPath}: ${err.message}`);
  console.error('Has the bot been started at least once?');
  process.exit(1);
}

const COLUMNS = 'rowid, message_id, created_at, status, sender_number, message_type, message_text, reply_text';
const statements = {
  latestRowid: db.prepare('SELECT COALESCE(MAX(rowid), 0) AS id FROM deduplication'),
  lastN: db.prepare(`SELECT * FROM (SELECT ${COLUMNS} FROM deduplication ORDER BY rowid DESC LIMIT ?) ORDER BY rowid`),
  newer: db.prepare(`SELECT ${COLUMNS} FROM deduplication WHERE rowid > ? ORDER BY rowid`),
  byId: db.prepare('SELECT status, reply_text FROM deduplication WHERE message_id = ?'),
};

// Colours only when writing to a terminal, so piping to a file stays clean.
const tty = process.stdout.isTTY;
const paint = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint('2');
const cyan = paint('36');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');

const TYPE_LABELS = { image: 'photo', document: 'PDF/document', audio: 'voice note', video: 'video', sticker: 'sticker' };
const PAD = ' '.repeat(15); // lines up history replies under the message timestamp

function sast(ms) {
  return new Date(ms).toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Indent continuation lines so multi-line messages stay readable under their header. */
function indent(text) {
  return String(text).replace(/\n/g, '\n      ');
}

function printIncoming(row) {
  const label = row.message_type === 'text' ? '' : yellow(`[${TYPE_LABELS[row.message_type] || row.message_type}] `);
  const body = row.message_text ? indent(row.message_text) : dim(row.message_type === 'text' ? '(empty)' : '(no caption)');
  console.log(`${dim(sast(row.created_at))}  ${cyan(`+${row.sender_number} →`)}  ${label}${body}`);
}

/** The reply (or lack of one) for a finished message. `prefix` is a timestamp for live events, padding for history. */
function printOutcome(prefix, row, status, replyText) {
  if (status === 'completed' && replyText) {
    console.log(`${prefix}  ${green(`Thandi → +${row.sender_number}`)}  ${indent(replyText)}`);
  } else if (status === 'completed') {
    console.log(`${prefix}  ${dim(`(no reply sent to +${row.sender_number}: already had the away message)`)}`);
  } else if (status === 'failed') {
    console.log(`${prefix}  ${red(`✖ reply to +${row.sender_number} FAILED after 3 attempts (see docker compose logs)`)}`);
  }
}

// Messages printed but not yet answered, so their reply can be shown when it goes out.
const pending = new Map(); // message_id -> row

function show(row, { live }) {
  printIncoming(row);
  if (row.status === 'completed' || row.status === 'failed') {
    // In history the reply's send time isn't stored, so it's shown under the message without its own time.
    printOutcome(live ? dim(sast(Date.now())) : PAD, row, row.status, row.reply_text);
  } else {
    pending.set(row.message_id, row);
  }
}

if (HISTORY > 0) {
  const rows = statements.lastN.all(HISTORY);
  if (rows.length) console.log(dim(`── last ${rows.length} message(s) ──`));
  for (const row of rows) show(row, { live: false });
}
let lastRowid = statements.latestRowid.get().id;
console.log(dim('── watching for new messages (SA time) · Ctrl+C to stop ──'));

function poll() {
  for (const row of statements.newer.all(lastRowid)) {
    lastRowid = row.rowid;
    show(row, { live: true });
  }
  for (const [id, row] of pending) {
    const current = statements.byId.get(id);
    if (!current) {
      pending.delete(id); // pruned after 24 hours
    } else if (current.status === 'completed' || current.status === 'failed') {
      pending.delete(id);
      printOutcome(dim(sast(Date.now())), row, current.status, current.reply_text);
    }
  }
}

const timer = setInterval(poll, POLL_INTERVAL_MS);
process.on('SIGINT', () => {
  clearInterval(timer);
  db.close();
  process.exit(0);
});
