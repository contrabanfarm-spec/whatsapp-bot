const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { getRecentTurns } = require('../db');

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const MODEL = 'claude-opus-5';
const HISTORY_LIMIT = 10;

const SYSTEM_PROMPT = `You are my personal assistant, chatting with me over WhatsApp.
Help with whatever I ask: questions, planning, drafting messages, reminders to think about, quick research from what you know.
Keep replies short and conversational, as suits a chat app. Use plain text; WhatsApp only supports *bold*, _italic_ and simple lists, not Markdown headings or tables.
If you don't know something or can't do it (for example, you can't set real reminders or browse the web), say so plainly.`;

/**
 * Send the user's message to Claude along with their recent history and return the reply.
 * Doesn't store anything: the caller saves the exchange together with the outbox entry.
 *
 * @param {string} senderNumber The user's WhatsApp number (conversation key)
 * @param {string} messageText  The user's incoming message
 * @returns {Promise<string>} The reply to send back
 */
async function generateAIResponse(senderNumber, messageText) {
  const history = getRecentTurns(senderNumber, HISTORY_LIMIT);

  // The API requires the conversation to start with a user turn; the 10-message window can cut mid-exchange.
  while (history.length > 0 && history[0].role !== 'user') history.shift();

  const messages = [
    ...history.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: messageText },
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
