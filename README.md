# CareCircle WhatsApp Bot

A WhatsApp support bot for [CareCircle](https://thecarecircle.co.za), a South African platform that connects families with home-care and childcare caregivers. Customers message CareCircle's WhatsApp number and **Thandi**, an AI support employee powered by Qwen through OpenRouter (or Anthropic's Claude, if you prefer), replies within seconds: she answers questions about services, pricing, safety checks and signing up, and hands people over to the human team when needed.

Built on the official **Meta WhatsApp Cloud API**, with a small Node.js/Express server, SQLite storage, and Docker deployment behind HTTPS.

## How it works

1. A customer sends a WhatsApp message to CareCircle's number.
2. Meta delivers it to the server's webhook (`https://bot.thecarecircle.co.za/webhook`).
3. The server checks the message really came from Meta, confirms it hasn't been handled before, and queues it behind any earlier messages from the same person.
4. Text messages go to the AI model with Thandi's instructions and that customer's last 10 messages, so she remembers the conversation. Photos and PDFs are downloaded from Meta and sent to the model together with their caption, so Thandi can read screenshots, invoices and other documents the customer shares.
5. The reply is saved, then sent back through the WhatsApp API.
6. Voice notes, videos and non-PDF documents get a polite "please send text, a photo or a PDF" reply; emoji reactions are ignored.

## Features

**Thandi, the AI employee**
- Knows CareCircle from its knowledge base: the free model, cities (Johannesburg, Cape Town, Durban, Pretoria), the electronic criminal record check and how caregivers pay for it (card, or FNB bank deposit), and exactly what is and isn't safety-checked.
- Refers account-specific requests (bookings, refunds, whether a deposit has been allocated) to the portal or the human team, and gives emergency numbers (10111, 10177, 112) when someone's safety is at risk.
- Follows POPIA (never asks for ID numbers, bank details or PINs) and is honest that she's an AI assistant when asked.
- Reads photos (JPEG, PNG, GIF or WebP, up to 5 MB) and PDFs (up to 10 MB), such as screenshots of portal errors or invoices. She won't repeat ID or banking details shown in a file, can't verify documents (and explains that CareCircle uses an electronic criminal record check, not paper police clearances), and doesn't give medical opinions. Each PDF page costs tokens to read, so long PDFs make that reply more expensive.
- Her instructions live in [`src/prompts/system-prompt.md`](src/prompts/system-prompt.md) and her product knowledge in [`src/prompts/knowledge-base.md`](src/prompts/knowledge-base.md), both editable without touching code. `knowledge-base.md` is a verbatim copy of `apps/marketing/docs/bot-knowledge-base.md` in the carecircle-web repo: to update it, replace the file with that one and redeploy.

**Reliability**
- **No duplicate replies:** each WhatsApp message ID is recorded, so a message Meta delivers twice gets one reply.
- **Saved replies:** every reply is stored before sending and only marked done once WhatsApp accepts it; a failed send is retried with the saved reply, without asking the AI again.
- **Crash recovery:** on startup the server finishes any messages a previous run left half-done.
- **Retry limit:** a message is tried at most 3 times, then marked failed, so one bad message can't crash the server over and over.
- **Order per customer:** a person's messages are handled one at a time, in order; different customers are handled in parallel.
- Long replies are split to fit WhatsApp's 4,096-character limit, and customers get a short apology if the AI is unavailable.

**Security**
- Every webhook's `X-Hub-Signature-256` is checked against the app secret; unsigned or forged requests get a 400.
- Secrets live only in `.env`, which is kept out of git and out of the Docker image.
- The container runs as a non-root user with read-only app code; the only writable place is `/app/data`.

## Tech stack

| Part | Technology |
|---|---|
| Runtime | Node.js 22+ |
| Web server | Express 4 |
| AI | Qwen (`qwen/qwen3.8-flash` by default, set with `AI_MODEL`) via OpenRouter's chat completions API. Without an OpenRouter key it falls back to Claude (`claude-opus-5`) via the official `@anthropic-ai/sdk` |
| Messaging | Meta WhatsApp Cloud API (Graph API v26.0) |
| Database | SQLite via `better-sqlite3` |
| Deployment | Docker + Docker Compose, with Caddy or Nginx for HTTPS |

## Status

Live: the Meta app (CareCircle, business "The Care Circle") is published, the webhook is verified, and messages flow end to end. Still open:
- **Business verification** for The Care Circle. Until it's done, Meta caps how many new conversations the business can start each day.
- **Media:** photos and PDFs are handled; voice notes, videos and other document types get a fallback reply for now.
- **Single instance:** per-customer ordering and crash recovery assume one running server.

## Project layout

```
server.js                          Express app entry point; runs DB cleanup and crash recovery before listening
src/config.js                      Loads and validates environment variables (full list documented at the top)
src/db.js                          SQLite schema, migrations, and queries
src/routes/webhook.js              GET (verification) and POST (signature check, parsing) handlers
src/services/messageProcessor.js   Per-sender queue, dedup/outbox state machine, retries, crash recovery
src/services/ai.js                 generateAIResponse() via OpenRouter (Qwen) or Anthropic (Claude), with the last 10 turns as context
src/prompts/system-prompt.md       Who the bot is ("Thandi" from CareCircle support), her rules and tone
src/prompts/knowledge-base.md      What she knows about CareCircle; verbatim copy of carecircle-web's bot-knowledge-base.md
src/services/whatsapp.js           sendMessage(to, text) via the Graph API
Dockerfile, docker-compose.yml     Container deployment (see Deployment)
```

## Prerequisites

- Node.js 22+ (required by `better-sqlite3` 13), or Docker for deployment
- A Meta developer app with the WhatsApp product added ([developers.facebook.com](https://developers.facebook.com/apps))
- [ngrok](https://ngrok.com/download) for exposing your local server

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the project root with:
   - `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`: from **WhatsApp > API Setup** in the Meta App Dashboard. The temporary token expires after 24 hours; create a System User token for anything long-lived.
   - `WHATSAPP_VERIFY_TOKEN`: any random string you choose. You'll paste the same value into Meta in step 3 below.
   - `WHATSAPP_APP_SECRET`: from **App settings > Basic** in the Meta App Dashboard. Used to verify the `X-Hub-Signature-256` header on every webhook POST; unsigned or mis-signed requests get a 400.
   - `OPENROUTER_API_KEY`: from [openrouter.ai/keys](https://openrouter.ai/keys). Replies come from Qwen (`qwen/qwen3.8-flash`) through OpenRouter. Write it as `OPENROUTER_API_KEY=sk-or-v1-...` with no `export` in front.
   - `AI_MODEL` (optional): any OpenRouter model ID, e.g. `qwen/qwen3.8-max-0902` for stronger answers at a higher price. Pick a model that accepts images if you want photos read.
   - `ANTHROPIC_API_KEY` (alternative): from [console.anthropic.com](https://console.anthropic.com). Used only when no OpenRouter key is set; replies then come from Claude (`claude-opus-5`).

   - `REPLY_DELAY_SECONDS` (optional, default `30`): how long after a customer's message Thandi replies, so answers don't arrive suspiciously fast. It counts from when the message arrived, so AI time is included rather than added; `0` replies as soon as the answer is ready. While the customer waits, Thandi marks their message as read (blue ticks) and shows "typing…". WhatsApp keeps the indicator up for at most 25 seconds, so it starts 25 seconds before the reply is due (about 5 seconds after the message arrives with the default delay).

   PDFs on OpenRouter: Qwen models don't read PDFs natively, so OpenRouter's free `pdf-text` engine extracts the text first. Text PDFs (invoices, CVs) work; scanned, image-only PDFs yield little.
   - `PORT`: defaults to `3000`.

   The full list is also documented at the top of `src/config.js`.
3. In **API Setup**, add your personal phone number as a test recipient. While the app is in development mode, the bot can only message numbers on that list.

## Run

```bash
npm start
```

Or use `npm run dev` to restart automatically on file changes.

## Test the webhook with ngrok

1. Start the server (`npm start`).
2. In a second terminal, expose it:
   ```bash
   ngrok http 3000
   ```
   Copy the `https://....ngrok-free.app` forwarding URL.
3. In the Meta App Dashboard go to **WhatsApp > Configuration > Webhook > Edit**:
   - **Callback URL:** `https://<your-ngrok-domain>/webhook`
   - **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save**. The server logs `Webhook verified`.
4. Under **Webhook fields**, subscribe to **messages**.
5. Send a WhatsApp message from your test number to the bot's number. You should see `Message from ...` in the logs and receive Thandi's reply.

The ngrok URL changes each time ngrok restarts (unless you have a reserved domain), so update the callback URL in Meta whenever it does.

If verification succeeds but real messages never arrive, the app is probably unpublished: Meta sends only dashboard test webhooks to unpublished apps. See [Meta configuration](#meta-configuration).

### Testing locally without Meta

Verification handshake:
```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345"
```
It should print `12345`.

Simulated incoming messages must be signed with your App Secret, or they're rejected with a 400. (The reply send will fail unless the number is a real test recipient, but the endpoint still returns 200 and logs the error.)
```bash
BODY='{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"id":"wamid.TEST1","from":"15551234567","type":"text","text":{"body":"hello"}}]}}]}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" | sed 's/^.* //')
curl -X POST http://localhost:3000/webhook -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY"
```
Sending the same `id` again within 24 hours is skipped as a duplicate.

## Error handling

`POST /webhook` returns 400 if the signature is invalid. Otherwise it responds `200 OK` before doing any work, and all parsing, AI, and send errors are caught and logged. Malformed JSON bodies on `/webhook` also get a 200. This prevents Meta from retrying failed deliveries. If the AI call fails, the user gets a short apology instead of silence.

## Next steps

- Handle voice notes (e.g. transcribe them): they currently get a polite "text, photo or PDF only" reply.
- Add a way to reset a conversation (e.g. a `/reset` command that deletes that sender's rows).

## Storage

State lives in SQLite at `data/bot.db` (override with `DB_PATH`), created on first start:
- `deduplication`: every WhatsApp message ID with its processing status, saved reply (outbox), retry count, and for photos and PDFs the WhatsApp media ID (so the file can be downloaded again after a crash). Unfinished messages are resumed at startup; rows are pruned after 24 hours.
- `conversations`: every user message and assistant reply; the last 10 per sender are sent to the AI as context. Photos and PDFs themselves are never stored: they're held in memory only while the AI reads them, and history records just "[Sent a photo]" or "[Sent a PDF: name]" plus the caption.

## Deployment

The app ships as a Docker image based on Debian `node:22-bookworm` (Node 22+ is required by `better-sqlite3` 13, which bundles prebuilt native binaries for Linux x64 and arm64, so nothing is compiled during the build). The container runs as the unprivileged `node` user (uid 1000), not root. The application code and `node_modules` are owned by root and read-only to that user; the only place it can write is `/app/data`. You need a VPS or PaaS with Docker and Docker Compose, and a domain name pointing at it.

### Build and run

1. Copy the project to the server (without `node_modules` or `data`) and create `.env` there with the variables from [Setup](#setup).
2. Create the data directory and give it to uid 1000, the unprivileged `node` user the container runs as:
   ```bash
   mkdir -p data
   sudo chown -R 1000:1000 data
   ```
   Skip this and the bot exits at startup with a SQLite "unable to open database file" error: the bind mount keeps the host's ownership, and if Docker creates `./data` itself it's owned by root. Re-run the `chown` if you restore a backup into `data/` as root.
3. Build and start:
   ```bash
   docker compose up -d --build
   ```
   (Older installs use the `docker-compose` command; the arguments are the same.)
4. Check it's healthy and watch the logs:
   ```bash
   docker compose ps
   docker compose logs -f
   ```

To deploy a new version, pull or copy the new code and run `docker compose up -d --build` again. On startup the bot resumes any messages that were mid-flight when the old container stopped.

Compose pins `PORT=3000` and `DB_PATH=/app/data/bot.db` inside the container, so those two values in `.env` are ignored there. The container port is published on `127.0.0.1:3000` only, so it's reachable by a reverse proxy on the same machine but not directly from the internet.

### Back up `./data`

> **Warning:** `./data` holds the SQLite database: conversation history, the reply outbox, and deduplication state. It is not inside the image, and deleting it, or the server's disk failing, loses all of it. **Back it up regularly.**

The database runs in WAL mode, so copying `bot.db` alone while the bot is running can produce an inconsistent copy. Either:
- stop the container first (`docker compose stop`), copy the whole `data/` directory, then `docker compose start`; or
- take a live snapshot with SQLite's backup API and copy the result off the server:
  ```bash
  docker compose exec whatsapp-bot node -e "new (require('better-sqlite3'))('/app/data/bot.db').backup('/app/data/backup.db').then(() => console.log('done'))"
  ```
  This writes `data/backup.db` on the host.

### HTTPS reverse proxy

Meta only delivers webhooks to an `https://` URL with a valid certificate, so put a reverse proxy in front of the container. Point your domain's DNS at the server first.

**Caddy** (simplest: gets and renews a Let's Encrypt certificate automatically). `/etc/caddy/Caddyfile`:
```
bot.example.com {
    reverse_proxy 127.0.0.1:3000
}
```
Then `sudo systemctl reload caddy`.

**Nginx** with Certbot: add a server block that proxies to the container, then let Certbot add the certificate:
```nginx
server {
    server_name bot.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo certbot --nginx -d bot.example.com
```

If you use a PaaS that provides HTTPS itself (Render, Railway, Fly.io, etc.), skip the proxy, point it at container port 3000, and attach a persistent volume at `/app/data`. Without a persistent volume the database is wiped on every deploy. The container runs as uid 1000, so the volume must be writable by that user; most platforms handle this, but if you see "unable to open database file" at startup, check the volume's ownership.

### Meta configuration

Once `https://bot.example.com/` answers, connect Meta to it. Webhook delivery needs **all three** of these; missing any one delivers nothing, and nothing in the bot's logs will tell you which is missing.

1. **Callback URL:** in the Meta App Dashboard, go to **WhatsApp > Configuration > Webhook > Edit**, set the **Callback URL** to `https://bot.example.com/webhook` and the **Verify token** to your `WHATSAPP_VERIFY_TOKEN`, then click **Verify and save**. The bot logs `Webhook verified`. Under **Webhook fields**, subscribe to **messages**.
2. **Account subscription:** the WhatsApp Business Account that owns your phone number must be subscribed to your app, so its events route there. Setting up WhatsApp through the dashboard's API Setup page normally does this; you can confirm or do it with the MCP tools below.
3. **Publish the app:** go to the Meta Developer Dashboard and click **Publish App**. Real webhooks will not be delivered until the app is live. An unpublished app receives only the test webhooks you fire manually from the App Dashboard, not real messages, even from its own admins and testers. Publishing requires completing Meta's checks first, such as a privacy policy URL, business verification, and data-handling questions; the Publish page lists what's outstanding.

Also make sure the WhatsApp account has a payment method, or replies are accepted by the API but most likely never reach the user.

## Post-Deployment MCP Setup

If a WhatsApp Business MCP server is connected to your AI coding agent (for example Claude Code), the agent can do most of the Meta configuration above for you. It's a setup utility only: it can't receive messages or run the bot, which is why the Node.js server exists. Do this **after** the Docker container is running and `https://<your-domain>/webhook` is live, because Meta verifies the callback URL the moment it's saved and rejects it if the server doesn't answer.

Ask the agent to run, in order:

1. **`whatsapp_biz_configure_webhooks`**: sets the app's callback URL to `https://<your-domain>/webhook` with your `WHATSAPP_VERIFY_TOKEN`, and subscribes the app to the WhatsApp webhook fields (make sure `messages` is included). This replaces any callback URL already configured.
2. **`whatsapp_biz_subscribe_webhook`**: subscribes your WhatsApp Business Account to the app so its message events are delivered there. Adding a subscription doesn't remove other apps already subscribed.
3. **`whatsapp_biz_publish_app`**: checks whether the app is published. This tool **does not publish it**; if the app isn't live, it returns the dashboard link where you finish publishing yourself, because Meta requires the checks listed in step 3 of [Meta configuration](#meta-configuration) to be completed there.

Each of the first two tools shows a summary and asks you to confirm before it changes anything. Neither can be undone from the agent; to change or remove them later, use the app's WhatsApp configuration page in the App Dashboard.

To check progress at any point without changing anything, ask the agent to run **`whatsapp_biz_onboarding_status`**. It reports, as a checklist, whether the webhook, account subscription, app publishing, and payment method are done. It's the first thing to run if the bot is deployed but no messages arrive.
