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

/**
 * Download a media file (e.g. an image a customer sent) by its WhatsApp media ID. Two steps: look up the
 * media's metadata to get a short-lived download URL, then fetch that URL with the same token.
 * The file is returned in memory; nothing is written to disk.
 *
 * @param {string} mediaId  The `id` from the incoming message's media object
 * @param {{ maxBytes?: number }} [options]  Skip the download if the file is bigger than this
 * @returns {Promise<{ tooLarge: true, fileSize: number } | { tooLarge: false, data: Buffer, mimeType: string }>}
 */
async function downloadMedia(mediaId, { maxBytes = Infinity } = {}) {
  const headers = { Authorization: `Bearer ${config.whatsappToken}` };

  const metaResponse = await fetch(`https://graph.facebook.com/${config.graphApiVersion}/${mediaId}`, { headers });
  const meta = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok || !meta.url) {
    const detail = meta.error ? `${meta.error.message} (code ${meta.error.code})` : metaResponse.statusText;
    throw new Error(`WhatsApp media lookup error ${metaResponse.status}: ${detail}`);
  }

  const fileSize = Number(meta.file_size) || 0;
  if (fileSize > maxBytes) return { tooLarge: true, fileSize };

  const fileResponse = await fetch(meta.url, { headers });
  if (!fileResponse.ok) {
    throw new Error(`WhatsApp media download error ${fileResponse.status}: ${fileResponse.statusText}`);
  }
  const data = Buffer.from(await fileResponse.arrayBuffer());
  if (data.length > maxBytes) return { tooLarge: true, fileSize: data.length };

  return { tooLarge: false, data, mimeType: meta.mime_type || fileResponse.headers.get('content-type') || '' };
}

module.exports = { sendMessage, downloadMedia };
