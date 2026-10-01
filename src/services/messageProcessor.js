const config = require('../config');
const {
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
} = require('../db');
const { getOfflineState, awayMessage } = require('../offline');
const { sendMessage, downloadMedia } = require('./whatsapp');
const { generateAIResponse } = require('./ai');

const WHATSAPP_MAX_TEXT_LENGTH = 4096;
// Media Thandi can read, per WhatsApp message type. Images: the formats Claude accepts, up to Claude's
// 5 MB per-image limit. Documents: PDFs only, capped at 10 MB because every page costs tokens to read.
const MEDIA_KINDS = {
  image: {
    kind: 'image',
    types: new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    maxBytes: 5 * 1024 * 1024,
    label: 'photo',
    tooLarge: 'That photo is too large for me to open. Could you send a smaller one, or describe it in a message?',
    wrongType: "I can't open that kind of image. Could you send it as a normal photo instead?",
  },
  document: {
    kind: 'pdf',
    types: new Set(['application/pdf']),
    maxBytes: 10 * 1024 * 1024,
    label: 'PDF',
    tooLarge: 'That document is too large for me to open (the limit is 10 MB). Could you send a smaller PDF, or tell me what you need help with?',
    wrongType: 'I can only read documents sent as PDFs. Could you save it as a PDF and send it again, or tell me what it says?',
  },
};
// Pause before retrying a failed attempt in-process (indexed by retry_count - 1). Holding the sender's
// lock while waiting keeps their messages in order.
const RETRY_DELAYS_MS = [2000, 5000];
// When Claude can't be reached, send a person the away message at most this often, so a run of failures
// (an outage, a billing problem) doesn't answer every message with it.
const AI_FAILURE_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/*
 * Messages here use one normalized shape, whether they came from a live webhook or from the database
 * during crash recovery:  { id, from, type, text, mediaId, filename }  where text is the body of a 'text'
 * message or a photo's/document's caption (else null), mediaId is the WhatsApp media ID for images and
 * documents (else null), and filename is a document's name (live messages only; not kept for recovery).
 *
 * Each message moves through: processing -> reply_ready (reply saved in the outbox) -> completed (WhatsApp
 * accepted it). A crash at any point is picked up by recoverCrashedMessages() on the next start; if the
 * reply was already saved, recovery only re-sends it and never calls Claude again.
 */

// Per-sender queue: each sender's messages run one at a time, in arrival order, so every reply sees the
// history written by the one before it. Different senders still run in parallel. Live webhooks and
// startup recovery both go through this, so a recovered message and a new one from the same person
// can never run concurrently.
const senderLocks = new Map();

function enqueueForSender(sender, task) {
  const previous = senderLocks.get(sender) || Promise.resolve();
  const next = previous.then(task).catch(() => {}); // task logs its own errors; never break the chain
  senderLocks.set(sender, next);
  // Drop the entry once this sender's queue drains so the Map doesn't grow with every number ever seen.
  next.then(() => {
    if (senderLocks.get(sender) === next) senderLocks.delete(sender);
  });
  return next;
}

/** Queue a message that just arrived on the webhook. */
function enqueueIncoming(message) {
  return enqueueForSender(message.from, () => processMessage(message, { recovered: false }));
}

/**
 * Runs inside the sender's lock. The dedup claim happens here, not at enqueue time, so a redelivery that
 * queues behind the original sees its final status rather than racing it.
 *
 * Retry accounting: every attempt that doesn't finish counts once toward MAX_RETRIES. Errors caught here
 * are counted immediately and retried in-process after a pause. A hard crash never reaches a catch block,
 * so recovery counts it when it reclaims the row on the next start. Either way the message is marked
 * 'failed' once the count reaches the limit, which stops crash loops.
 */
async function processMessage(message, { recovered }) {
  const { id, from } = message;

  let retryCount;
  try {
    retryCount = recovered ? reclaimForRecovery(id) : id ? claimMessage(message) : null;
  } catch (err) {
    console.error(`Deduplication claim failed for ${id}:`, err);
    return;
  }
  if (retryCount === null) {
    console.log(`Skipping duplicate or in-flight message ${id}`);
    return;
  }

  while (retryCount < MAX_RETRIES) {
    try {
      await handleMessage(message);
      return;
    } catch (err) {
      retryCount = incrementRetry(id);
      console.error(`Attempt ${retryCount}/${MAX_RETRIES} failed for message ${id} from ${from}:`, err);
      if (retryCount < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[retryCount - 1]));
      }
    }
  }

  markFailed(id);
  console.error(`Giving up on message ${id} from ${from} after ${MAX_RETRIES} attempts; marked failed.`);
}

async function handleMessage(message) {
  const { id, from } = message;

  // Outbox: if a previous attempt already produced a reply, just deliver that one.
  if (getReplyText(id) === null) {
    const { reply, exchange, awayNotice } = await composeReply(message);
    if (reply === null) {
      markCompleted(id);
      return;
    }
    saveReply(id, reply, exchange, awayNotice ? from : undefined);
  } else {
    console.log(`Message ${id} already has a saved reply; sending it without regenerating`);
  }

  await waitForReplyTime(message);
  await deliverReply(id, from);
}

/**
 * Hold the reply until REPLY_DELAY_SECONDS after the message arrived. The reply is already saved, so a crash
 * during the wait is recovered and sent on restart. Counting from arrival means AI time is part of the wait,
 * and a message that queued behind the same sender's earlier ones isn't delayed a second time. Recovered
 * messages have no arrival time and go straight out, since they're already late.
 */
async function waitForReplyTime({ id, receivedAt }) {
  if (!receivedAt || !config.replyDelayMs) return;
  const remaining = receivedAt + config.replyDelayMs - Date.now();
  if (remaining <= 0) return;
  console.log(`Holding reply to message ${id} for ${Math.round(remaining / 1000)}s`);
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

/**
 * Work out the reply for a message. Returns { reply, exchange }, where exchange (when present) is the turn to
 * record in conversation history alongside the reply; fallbacks and apologies aren't recorded. The away
 * message comes back as { reply, awayNotice: true }, and { reply: null } means send nothing.
 */
async function composeReply({ from, type, text, mediaId, filename }) {
  // Checked first, so nothing is downloaded or sent to Claude while Thandi is offline. The message is only
  // logged: it isn't answered, now or when she's back.
  const offline = getOfflineState();
  if (offline) {
    console.log(`Offline: ${type} from ${from}${text ? `: ${text}` : ''}`);
    return awayReply(from, offline.since, offline.note);
  }

  if (type === 'text' && text) {
    console.log(`Message from ${from}: ${text}`);
    return askClaude(from, text, text);
  }

  const media = MEDIA_KINDS[type];
  if (media && mediaId) {
    console.log(`${media.label} from ${from}${filename ? ` (${filename})` : ''}${text ? ` with caption: ${text}` : ''}`);

    let file;
    try {
      file = await downloadMedia(mediaId, { maxBytes: media.maxBytes });
    } catch (err) {
      console.error(`${media.label} download failed for ${from}:`, err);
      return { reply: `Sorry, I couldn't open that ${media.label}. Could you send it again?` };
    }
    if (file.tooLarge) return { reply: media.tooLarge };
    const mediaType = file.mimeType.split(';')[0].trim().toLowerCase();
    if (!media.types.has(mediaType)) return { reply: media.wrongType };

    // The file itself is never stored; history only records that it was sent, plus its caption.
    const sent = `[Sent a ${media.label}${filename ? `: ${filename}` : ''}]`;
    const historyText = text ? `${sent} ${text}` : sent;
    const note = `${sent.slice(0, -1)}, no caption]`;
    return askClaude(from, text, historyText, { kind: media.kind, data: file.data, mediaType, note });
  }

  console.log(`Received ${type} from ${from}; queuing media fallback`);
  return {
    reply: `I received your ${type}, but I can only read text messages, photos and PDFs for now. Please send one of those.`,
  };
}

async function askClaude(from, text, historyText, attachment) {
  try {
    const reply = await generateAIResponse(from, text, attachment);
    return { reply, exchange: { senderNumber: from, userText: historyText } };
  } catch (err) {
    console.error(`AI generation failed for ${from}:`, err);
    // Not saved to history. The away message gives them the team's contact details instead of a dead end.
    return awayReply(from, Date.now() - AI_FAILURE_NOTICE_INTERVAL_MS, null);
  }
}

/**
 * The away message for this sender, or { reply: null } if they've already had it since `since`: once per
 * offline period, or once per AI_FAILURE_NOTICE_INTERVAL_MS while Claude can't be reached.
 */
function awayReply(from, since, note) {
  const last = getLastAwayNotice(from);
  if (last !== null && last >= since) {
    console.log(`${from} already has the away message; not replying`);
    return { reply: null };
  }
  return { reply: awayMessage(note), awayNotice: true };
}

/** Send the outbox reply stored for this message, then mark it completed. Throws if the send fails. */
async function deliverReply(id, to) {
  const reply = getReplyText(id);
  // WhatsApp caps text messages at 4096 characters, so send long replies in parts.
  for (let i = 0; i < reply.length; i += WHATSAPP_MAX_TEXT_LENGTH) {
    await sendMessage(to, reply.slice(i, i + WHATSAPP_MAX_TEXT_LENGTH));
  }
  markCompleted(id);
  console.log(`Replied to ${to} (message ${id} completed)`);
}

/**
 * Re-queue every message a previous run left unfinished ('processing' or 'reply_ready', under the retry
 * limit). Call once at startup, before the server accepts webhooks. Queuing is synchronous, so any live
 * message that arrives afterwards for the same sender lines up behind the recovered ones.
 * Returns the number of messages queued.
 */
function recoverCrashedMessages() {
  let queued = 0;
  for (const message of getRecoverableMessages()) {
    if (!message.from || !message.type) {
      // Claimed by a version that didn't store message context; nothing to replay.
      console.error(`Cannot recover message ${message.id}: no stored context. Marking failed.`);
      markFailed(message.id);
      continue;
    }
    console.log(`Recovering ${message.type} message ${message.id} from ${message.from}`);
    enqueueForSender(message.from, () => processMessage(message, { recovered: true }));
    queued++;
  }
  return queued;
}

module.exports = { enqueueIncoming, recoverCrashedMessages };
