const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { getRecentTurns } = require('../db');

// Two providers: OpenRouter (Qwen by default) when OPENROUTER_API_KEY is set, otherwise Anthropic (Claude).
const USE_OPENROUTER = Boolean(config.openrouterApiKey);
const MODEL = config.aiModel || (USE_OPENROUTER ? 'qwen/qwen3.8-flash' : 'claude-opus-5');
const anthropic = USE_OPENROUTER ? null : new Anthropic({ apiKey: config.anthropicApiKey });

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TIMEOUT_MS = 120_000;
const HISTORY_LIMIT = 10;

const REFUSAL_REPLY = "Sorry, I can't help with that one.";
const EMPTY_REPLY = "Sorry, I couldn't come up with a reply. Try rephrasing?";

console.log(`AI replies via ${USE_OPENROUTER ? 'OpenRouter' : 'Anthropic'} using model ${MODEL}`);

// Who the bot is (system-prompt.md) and what it knows about the business (knowledge-base.md). Kept in their
// own files so they can be edited without touching code; read once at startup, so restart (or rebuild the
// Docker image) after changing either. knowledge-base.md is a verbatim copy of the chatbot knowledge base
// kept in the carecircle-web repo (apps/marketing/docs/bot-knowledge-base.md): replace it, don't edit it here.
const readPrompt = (name) => fs.readFileSync(path.join(__dirname, '..', 'prompts', name), 'utf8').trim();
const SYSTEM_PROMPT = `${readPrompt('system-prompt.md')}

<knowledge_base>
${readPrompt('knowledge-base.md')}
</knowledge_base>`;

/**
 * Send the user's message to Claude along with their recent history and return the reply.
 * Doesn't store anything: the caller saves the exchange together with the outbox entry.
 *
 * @param {string} senderNumber The user's WhatsApp number (conversation key)
 * @param {string | null} messageText  The user's incoming message, or a photo's/PDF's caption (may be empty)
 * @param {{ kind: 'image' | 'pdf', data: Buffer, mediaType: string, note: string }} [attachment]
 *   A photo or PDF the user sent with this message. `note` stands in for the text when there's no caption.
 * @returns {Promise<string>} The reply to send back
 */
async function generateAIResponse(senderNumber, messageText, attachment) {
  const history = getRecentTurns(senderNumber, HISTORY_LIMIT);

  // The API requires the conversation to start with a user turn; the 10-message window can cut mid-exchange.
  while (history.length > 0 && history[0].role !== 'user') history.shift();

  // History is stored as text only (a past photo appears as "[Sent a photo] ..."); only the current
  // message can carry an actual image or PDF.
  const pastTurns = history.map(({ role, content }) => ({ role, content }));
  const reply = USE_OPENROUTER
    ? await askOpenRouter(pastTurns, messageText, attachment)
    : await askAnthropic(pastTurns, messageText, attachment);
  return reply || EMPTY_REPLY;
}

/** OpenRouter's OpenAI-style chat completions API. Returns the reply text ('' if the model said nothing). */
async function askOpenRouter(pastTurns, messageText, attachment) {
  let userContent = messageText;
  let plugins;
  if (attachment) {
    const dataUrl = `data:${attachment.mediaType};base64,${attachment.data.toString('base64')}`;
    const file =
      attachment.kind === 'pdf'
        ? { type: 'file', file: { filename: 'document.pdf', file_data: dataUrl } }
        : { type: 'image_url', image_url: { url: dataUrl } };
    userContent = [{ type: 'text', text: messageText || attachment.note }, file];
    // Qwen models don't read PDFs natively; OpenRouter's free pdf-text engine extracts the text first.
    // (Scanned, image-only PDFs have little text to extract.)
    if (attachment.kind === 'pdf') plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      'Content-Type': 'application/json',
      // Optional attribution headers OpenRouter uses to identify the app in its dashboard.
      'HTTP-Referer': 'https://thecarecircle.co.za',
      'X-Title': 'CareCircle WhatsApp Bot',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...pastTurns, { role: 'user', content: userContent }],
      ...(plugins && { plugins }),
    }),
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });

  // OpenRouter can report an error in the body even with a 200 status, so check both.
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const detail = data.error ? `${data.error.message} (code ${data.error.code})` : response.statusText;
    throw new Error(`OpenRouter error ${response.status}: ${detail}`);
  }

  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'content_filter') return REFUSAL_REPLY;
  const content = choice?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => part.text || '').join('') : content || '';
  return text.trim();
}

/** Anthropic's Messages API (Claude). Returns the reply text ('' if the model said nothing). */
async function askAnthropic(pastTurns, messageText, attachment) {
  // The file goes before the text, as the API recommends.
  const userContent = attachment
    ? [
        {
          type: attachment.kind === 'pdf' ? 'document' : 'image',
          source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data.toString('base64') },
        },
        { type: 'text', text: messageText || attachment.note },
      ]
    : messageText;

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // If Claude declines on safety grounds, the API retries on a fallback model in the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [...pastTurns, { role: 'user', content: userContent }],
  });

  if (response.stop_reason === 'refusal') return REFUSAL_REPLY;

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

module.exports = { generateAIResponse };
