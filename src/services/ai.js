const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { getRecentTurns } = require('../db');

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const MODEL = 'claude-opus-5';
const HISTORY_LIMIT = 10;

// Who the bot is and what it knows about the business. Kept in its own file so it can be edited without
// touching code; read once at startup, so restart (or rebuild the Docker image) after changing it.
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system-prompt.md'), 'utf8').trim();

/**
 * Send the user's message to Claude along with their recent history and return the reply.
 * Doesn't store anything: the caller saves the exchange together with the outbox entry.
 *
 * @param {string} senderNumber The user's WhatsApp number (conversation key)
 * @param {string | null} messageText  The user's incoming message, or an image's caption (may be empty)
 * @param {{ data: Buffer, mediaType: string }} [image]  A photo the user sent with this message
 * @returns {Promise<string>} The reply to send back
 */
async function generateAIResponse(senderNumber, messageText, image) {
  const history = getRecentTurns(senderNumber, HISTORY_LIMIT);

  // The API requires the conversation to start with a user turn; the 10-message window can cut mid-exchange.
  while (history.length > 0 && history[0].role !== 'user') history.shift();

  // History is stored as text only (a past photo appears as "[Sent a photo] ..."); only the current
  // message can carry an actual image.
  const userContent = image
    ? [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data.toString('base64') } },
        { type: 'text', text: messageText || '[Photo sent without a caption]' },
      ]
    : messageText;

  const messages = [
    ...history.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: userContent },
  ];

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // If Claude declines on safety grounds, the API retries on a fallback model in the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return "Sorry, I can't help with that one.";
  }

  return (
    response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim() || "Sorry, I couldn't come up with a reply. Try rephrasing?"
  );
}

module.exports = { generateAIResponse };
