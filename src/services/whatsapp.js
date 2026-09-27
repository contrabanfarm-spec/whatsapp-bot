const config = require('../config');

/**
 * Send a plain-text WhatsApp message via the Meta Graph API.
 * Throws on network failure or a non-2xx response so the caller can log it.
 *
 * @param {string} to   Recipient phone number in international format (as received in the webhook, e.g. "15551234567")
 * @param {string} text Message body (max 4096 chars)
 */
async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data.error ? `${data.error.message} (code ${data.error.code})` : response.statusText;
    throw new Error(`WhatsApp API error ${response.status}: ${detail}`);
  }

  return data;
}

module.exports = { sendMessage };
