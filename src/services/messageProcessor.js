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
const { sendMessage } = require('./whatsapp');
const { generateAIResponse } = require('./ai');

const WHATSAPP_MAX_TEXT_LENGTH = 4096;
// Pause before retrying a failed attempt in-process (indexed by retry_count - 1). Holding the sender's
// lock while waiting keeps their messages in order.
const RETRY_DELAYS_MS = [2000, 5000];

/*
 * Messages here use one normalized shape, whether they came from a live webhook or from the database
 * during crash recovery:  { id, from, type, text }  where text is the body for 'text' messages, else null.
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
  const { id, from, type, text } = message;

  // Outbox: if a previous attempt already produced a reply, just deliver that one.
  if (getReplyText(id) === null) {
    if (type !== 'text' || !text) {
      console.log(`Received ${type} from ${from}; queuing media fallback`);
      saveReply(id, `I received your ${type}, but I can't process media files yet. Please send text.`);
    } else {
      console.log(`Message from ${from}: ${text}`);
      try {
        const reply = await generateAIResponse(from, text);
        saveReply(id, reply, { senderNumber: from, userText: text });
      } catch (err) {
        console.error(`AI generation failed for ${from}:`, err);
        // Not saved to history: the apology isn't part of the conversation.
        saveReply(id, "Sorry, I'm having trouble thinking right now. Please try again in a moment.");
      }
    }
  } else {
    console.log(`Message ${id} already has a saved reply; sending it without regenerating`);
  }

  await deliverReply(id, from);
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
