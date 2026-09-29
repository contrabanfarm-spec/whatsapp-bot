const {
  MAX_RETRIES,
  claimMessage,
  reclaimForRecovery,
  getRecoverableMessages,
  incrementRetry,
  getReplyText,
  saveReply,
  markCompleted,
  markFailed,
} = require('../db');
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
    const { reply, exchange } = await composeReply(message);
    saveReply(id, reply, exchange);
  } else {
    console.log(`Message ${id} already has a saved reply; sending it without regenerating`);
  }

  await deliverReply(id, from);
}

/**
 * Work out the reply for a message. Returns { reply, exchange }, where exchange (when present) is the turn to
 * record in conversation history alongside the reply; fallbacks and apologies aren't recorded.
 */
async function composeReply({ from, type, text, mediaId, filename }) {
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
    // Not saved to history: the apology isn't part of the conversation.
    return { reply: "Sorry, I'm having trouble thinking right now. Please try again in a moment." };
  }
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
