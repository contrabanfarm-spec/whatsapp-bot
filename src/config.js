const path = require('path');
require('dotenv').config();

/*
 * Environment variables (put these in a .env file in the project root):
 *
 *   WHATSAPP_TOKEN            required  Access token from Meta App Dashboard > WhatsApp > API Setup
 *   WHATSAPP_PHONE_NUMBER_ID  required  Phone number ID (not the number itself) from WhatsApp > API Setup
 *   WHATSAPP_VERIFY_TOKEN     required  Any secret string; enter the same value in Meta's webhook config
 *   WHATSAPP_APP_SECRET       required  App Secret from App Dashboard > App settings > Basic; used to verify X-Hub-Signature-256
 *   OPENROUTER_API_KEY        one of    API key from openrouter.ai; when set, replies come from OpenRouter (Qwen by default)
 *   ANTHROPIC_API_KEY         these     API key from console.anthropic.com; used (with Claude) only if no OpenRouter key
 *   AI_MODEL                  optional  Model to use, e.g. qwen/qwen3.8-max-0902 (default qwen/qwen3.8-flash on
 *                                       OpenRouter, claude-opus-5 on Anthropic)
 *   REPLY_DELAY_SECONDS       optional  Wait this long after a message arrives before replying (default 30; 0 = off)
 *   PORT                      optional  Port to listen on (default 3000)
 *   DB_PATH                   optional  SQLite database file (default data/bot.db)
 */
const REQUIRED = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  missing.push('OPENROUTER_API_KEY (or ANTHROPIC_API_KEY)');
}
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Create a .env file with the variables listed at the top of src/config.js.');
  process.exit(1);
}

module.exports = {
  whatsappToken: process.env.WHATSAPP_TOKEN,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  appSecret: process.env.WHATSAPP_APP_SECRET,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  aiModel: process.env.AI_MODEL,
  // Counted from when the message arrived, so AI thinking time is part of the wait, not added to it.
  replyDelayMs: Math.max(0, Number(process.env.REPLY_DELAY_SECONDS ?? 30) || 0) * 1000,
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.db'),
  graphApiVersion: 'v19.0',
};
