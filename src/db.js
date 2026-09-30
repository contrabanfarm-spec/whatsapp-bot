const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const DEDUP_RETENTION_MS = 24 * 60 * 60 * 1000;
// A message still unfinished after this long is assumed to belong to a crashed run and may be retried.
const STALE_PROCESSING_MS = 2 * 60 * 1000;
// Attempts allowed per message before it's marked 'failed' and left alone.
const MAX_RETRIES = 3;

// Bump when the deduplication schema changes; stored in SQLite's PRAGMA user_version.
const SCHEMA_VERSION = 3;

/*
 * deduplication.status lifecycle:
 *   processing   claimed; reply not generated yet
 *   reply_ready  reply generated and stored in reply_text (outbox); not yet confirmed sent
 *   completed    WhatsApp accepted the reply
 *   failed       gave up after MAX_RETRIES attempts
 */
const DEDUP_COLUMNS = `
  message_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'reply_ready', 'completed', 'failed')),
  -- Enough of the original message to replay it after a crash. message_text is the text body, or an
  -- image's caption; media_id is the WhatsApp media ID for images, used to download the file again.
  sender_number TEXT,
  message_type TEXT,
  message_text TEXT,
  media_id TEXT,
  reply_text TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
`;

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    sender_number TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_sender_time
    ON conversations (sender_number, timestamp);

  -- When each person was last sent the away message (src/offline.js), so they get it only once per
  -- offline period.
  CREATE TABLE IF NOT EXISTS away_notices (
    sender_number TEXT PRIMARY KEY,
    notified_at INTEGER NOT NULL
  );
`);

// Create the deduplication table, or bring one from an earlier version up to date.
db.transaction(() => {
  const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deduplication'").get();

  if (!tableExists) {
    db.exec(`CREATE TABLE deduplication (${DEDUP_COLUMNS})`);
  } else if (db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) {
    // Older tables may carry CHECK (status IN ('processing','completed')), which SQLite can't ALTER.
    // Rebuild with the current schema and copy over whatever columns the old table had.
    const oldColumns = new Set(db.prepare('PRAGMA table_info(deduplication)').all().map((c) => c.name));
    db.exec(`CREATE TABLE deduplication_new (${DEDUP_COLUMNS})`);
    const newColumns = db.prepare('PRAGMA table_info(deduplication_new)').all().map((c) => c.name);
    const shared = newColumns.filter((name) => oldColumns.has(name)).join(', ');
    db.exec(`INSERT INTO deduplication_new (${shared}) SELECT ${shared} FROM deduplication`);
    if (!oldColumns.has('status')) {
      // Rows from before status tracking were fully handled; don't let them look like crashed runs.
      db.exec("UPDATE deduplication_new SET status = 'completed'");
    }
    db.exec('DROP TABLE deduplication; ALTER TABLE deduplication_new RENAME TO deduplication;');

    const added = newColumns.filter((name) => !oldColumns.has(name));
    console.log(`Migrated deduplication table to schema v${SCHEMA_VERSION}; added: ${added.join(', ') || 'none'}`);
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
})();

const statements = {
  // Inserts a new row, or takes over an unfinished row whose last attempt went stale (counting that as a
  // failed attempt). Returns the row's retry_count if claimed; returns nothing if completed/failed/in-flight.
  claimMessage: db.prepare(`
    INSERT INTO deduplication (message_id, created_at, status, sender_number, message_type, message_text, media_id)
    VALUES (@id, @now, 'processing', @from, @type, @text, @mediaId)
    ON CONFLICT (message_id) DO UPDATE SET
      created_at = excluded.created_at,
      retry_count = deduplication.retry_count + 1
    WHERE deduplication.status IN ('processing', 'reply_ready') AND deduplication.created_at < @staleBefore
    RETURNING retry_count
  `),
  // Recovery takes over any unfinished row regardless of age: at startup nothing else can own it.
  // The run that left it unfinished died mid-attempt, so that attempt counts toward the retry limit.
  reclaimForRecovery: db.prepare(`
    UPDATE deduplication SET created_at = ?, retry_count = retry_count + 1
    WHERE message_id = ? AND status IN ('processing', 'reply_ready')
    RETURNING retry_count
  `),
  recoverableMessages: db.prepare(`
    SELECT message_id, sender_number, message_type, message_text, media_id FROM deduplication
    WHERE status IN ('processing', 'reply_ready') AND retry_count < ?
    ORDER BY created_at ASC
  `),
  incrementRetry: db.prepare(
    'UPDATE deduplication SET retry_count = retry_count + 1 WHERE message_id = ? RETURNING retry_count'
  ),
  getReplyText: db.prepare('SELECT reply_text FROM deduplication WHERE message_id = ?'),
  setReplyReady: db.prepare("UPDATE deduplication SET status = 'reply_ready', reply_text = ? WHERE message_id = ?"),
  markCompleted: db.prepare("UPDATE deduplication SET status = 'completed' WHERE message_id = ?"),
  markFailed: db.prepare("UPDATE deduplication SET status = 'failed' WHERE message_id = ?"),
  // Covers every status, so 'failed' rows are removed too once they're a day old.
  deleteOldDedup: db.prepare('DELETE FROM deduplication WHERE created_at < ?'),
  lastAwayNotice: db.prepare('SELECT notified_at FROM away_notices WHERE sender_number = ?'),
  recordAwayNotice: db.prepare(`
    INSERT INTO away_notices (sender_number, notified_at) VALUES (?, ?)
    ON CONFLICT (sender_number) DO UPDATE SET notified_at = excluded.notified_at
  `),
  insertTurn: db.prepare(
    'INSERT INTO conversations (sender_number, role, content, timestamp) VALUES (?, ?, ?, ?)'
  ),
  recentTurns: db.prepare(`
    SELECT role, content FROM (
      SELECT rowid, role, content, timestamp FROM conversations
      WHERE sender_number = ?
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?
    ) ORDER BY timestamp ASC, rowid ASC
  `),
};

/**
 * Try to take ownership of a live message and store what's needed to replay it. Claims it if it's new, or if
 * a previous attempt left it unfinished for over 2 minutes (assumed crash). Check and write are one statement.
 *
 * @param {{ id: string, from: string, type: string, text: string | null, mediaId?: string | null }} message
 * @returns {number | null} the retry_count after claiming, or null if it must be skipped
 */
function claimMessage({ id, from, type, text, mediaId }) {
  const now = Date.now();
  const row = statements.claimMessage.get({
    id,
    from,
    type,
    text: text ?? null,
    mediaId: mediaId ?? null,
    now,
    staleBefore: now - STALE_PROCESSING_MS,
  });
  return row ? row.retry_count : null;
}

/** Take over an unfinished row during startup recovery. Returns the new retry_count, or null if it's finished. */
function reclaimForRecovery(messageId) {
  const row = statements.reclaimForRecovery.get(Date.now(), messageId);
  return row ? row.retry_count : null;
}

/** Unfinished messages still under the retry limit, oldest first, in the same shape the webhook produces. */
function getRecoverableMessages() {
  return statements.recoverableMessages.all(MAX_RETRIES).map((row) => ({
    id: row.message_id,
    from: row.sender_number,
    type: row.message_type,
    text: row.message_text,
    mediaId: row.media_id,
  }));
}

/** Record a failed attempt. Returns the new retry_count. */
function incrementRetry(messageId) {
  return statements.incrementRetry.get(messageId).retry_count;
}

/** The stored outbox reply for a message, or null if none has been generated yet. */
function getReplyText(messageId) {
  return statements.getReplyText.get(messageId)?.reply_text ?? null;
}

/**
 * Put a generated reply in the outbox (status 'reply_ready'). When `exchange` is given, the conversation
 * turns are saved in the same transaction, so history and outbox can never disagree after a crash. When
 * `awayNoticeTo` is given, the reply is the away message and that sender is recorded as having had it, also
 * in the same transaction, so a crash can't leave them told twice or never.
 */
const saveReply = db.transaction((messageId, replyText, exchange, awayNoticeTo) => {
  if (exchange) {
    const now = Date.now();
    statements.insertTurn.run(exchange.senderNumber, 'user', exchange.userText, now);
    statements.insertTurn.run(exchange.senderNumber, 'assistant', replyText, now);
  }
  if (awayNoticeTo) statements.recordAwayNotice.run(awayNoticeTo, Date.now());
  statements.setReplyReady.run(replyText, messageId);
});

/** When this sender was last sent the away message (ms since epoch), or null if never. */
function getLastAwayNotice(senderNumber) {
  return statements.lastAwayNotice.get(senderNumber)?.notified_at ?? null;
}

function markCompleted(messageId) {
  statements.markCompleted.run(messageId);
}

function markFailed(messageId) {
  statements.markFailed.run(messageId);
}

/** Delete deduplication records (any status, including 'failed') older than 24 hours. Returns the number removed. */
function cleanupDeduplication() {
  return statements.deleteOldDedup.run(Date.now() - DEDUP_RETENTION_MS).changes;
}

/** The last `limit` conversation turns with this sender, oldest first. */
function getRecentTurns(senderNumber, limit) {
  return statements.recentTurns.all(senderNumber, limit);
}

module.exports = {
  db,
  MAX_RETRIES,
  claimMessage,
  reclaimForRecovery,
  getRecoverableMessages,
  incrementRetry,
  getReplyText,
  saveReply,
  getLastAwayNotice,
  markCompleted,
  markFailed,
  cleanupDeduplication,
  getRecentTurns,
};
