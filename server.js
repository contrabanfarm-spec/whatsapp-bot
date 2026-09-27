const express = require('express');
const config = require('./src/config');
const { cleanupDeduplication } = require('./src/db');
const { recoverCrashedMessages } = require('./src/services/messageProcessor');
const webhookRouter = require('./src/routes/webhook');

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

console.log(`SQLite database ready at ${config.dbPath}`);
// Cleanup runs first, so messages that were stuck for over 24h are dropped rather than answered a day late.
console.log(`Removed ${cleanupDeduplication()} deduplication records older than 24h`);
// Queue unfinished messages from a previous run before accepting webhooks; they share the per-sender lock.
console.log(`Recovered ${recoverCrashedMessages()} unfinished message(s) from a previous run`);
// Keep pruning while running too, so a long-lived process doesn't accumulate IDs.
setInterval(cleanupDeduplication, CLEANUP_INTERVAL_MS).unref();

const app = express();

// Keep the exact raw bytes: the webhook signature is computed over them, not the parsed JSON.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get('/', (req, res) => res.send('WhatsApp bot is running'));
app.use('/webhook', webhookRouter);

// Malformed JSON bodies still get a 200 on /webhook so Meta doesn't retry.
app.use((err, req, res, next) => {
  console.error('Request error:', err.message);
  if (req.path.startsWith('/webhook')) return res.sendStatus(200);
  return res.sendStatus(500);
});

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
