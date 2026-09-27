const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { enqueueIncoming } = require('../services/messageProcessor');

const router = express.Router();

// GET /webhook — Meta's one-time verification handshake.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.verifyToken) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }

  console.warn('Webhook verification failed');
  return res.sendStatus(403);
});

// POST /webhook — incoming messages and status updates.
router.post('/', (req, res) => {
  if (!isValidSignature(req.get('X-Hub-Signature-256'), req.rawBody)) {
    console.warn('Rejected webhook with missing or invalid X-Hub-Signature-256');
    return res.sendStatus(400);
  }

  // Acknowledge immediately so Meta doesn't retry; do the real work afterwards.
  res.sendStatus(200);

  let messages;
  try {
    messages = extractMessages(req.body);
  } catch (err) {
    console.error('Failed to parse webhook payload:', err);
    return;
  }

  for (const message of messages) {
    if (message.type === 'reaction' || message.reaction) {
      console.log(`Ignoring reaction from ${message.from}`);
      continue;
    }

    enqueueIncoming({
      id: message.id,
      from: message.from,
      type: message.type,
      text: message.type === 'text' ? message.text?.body ?? null : null,
    });
  }
});

/**
 * Check Meta's "sha256=<hex>" signature: an HMAC-SHA256 of the raw body keyed with the App Secret.
 */
function isValidSignature(signatureHeader, rawBody) {
  if (!signatureHeader || !rawBody) return false;

  const [algorithm, signature] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !signature) return false;

  const expected = crypto.createHmac('sha256', config.appSecret).update(rawBody).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Collect every message in a WhatsApp webhook payload.
 * Messages live at body.entry[i].changes[j].value.messages; Meta usually sends one entry with one
 * change, but batching is allowed, so walk all of them. Status-only changes have no messages array.
 */
function extractMessages(body) {
  if (!body || body.object !== 'whatsapp_business_account') return [];

  const messages = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      messages.push(...(change.value?.messages ?? []));
    }
  }
  return messages;
}

module.exports = router;
