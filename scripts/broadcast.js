/*
 * Send a pre-approved WhatsApp template to a list of people, one at a time, 2-3 seconds apart.
 *
 *   node scripts/broadcast.js --dry-run          list who would receive it; sends nothing
 *   node scripts/broadcast.js --to=27821234567   send once to a single number (check the template on your phone)
 *   node scripts/broadcast.js --limit=50         send to the next 50 people not yet messaged
 *   node scripts/broadcast.js                    send to the next BATCH_SIZE people not yet messaged
 *
 * Options for any of the above:
 *   --template=background_check_fee   which of TEMPLATES to send (default DEFAULT_TEMPLATE)
 *   --contacts=data/contacts.csv      send to the numbers in this CSV instead of the bot's customers
 *                                     (column phone_number, plus name for templates that greet by name)
 *   --daily-limit=1000                the number's messaging limit from WhatsApp Manager
 *                                     (default DEFAULT_DAILY_LIMIT)
 *   --language=en                     the approved template's language (default DEFAULT_TEMPLATE_LANGUAGE)
 *
 * Without --contacts, recipients are everyone who has messaged the bot, most recently active first. Anyone who
 * has sent the bot a reply that only says "stop" (or "unsubscribe", "opt out") is never messaged.
 *
 * Each number Meta accepts is appended to broadcast-<template>.log next to the database. Numbers in a
 * template's log are skipped on later runs of that template, and sends of every template in the last 24 hours
 * count against the daily limit, so the script can simply be rerun each day until everyone has the message.
 * A rerun after a crash or Ctrl+C picks up where it stopped, and nobody gets the same message twice.
 *
 * Uses the bot's .env and database path (via src/config.js). The database is opened read-only; nothing here
 * touches the webhook or the bot's tables.
 */
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { setTimeout: sleep } = require('timers/promises');
// Load .env from the project root even when run from another directory; src/config.js then validates it.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const config = require('../src/config');
const { getOfflineState } = require('../src/offline');

// Templates this script can send. Each must match an APPROVED template in WhatsApp Manager with the same
// name. Meta sends the text it approved, not these copies; they're here so the text submitted to Meta and the
// text in this script can be checked against each other. A {{1}} is filled with the recipient's first name
// from the contacts file, or "there" without one. needsContacts: only ever sent to a --contacts list, never to
// everyone who has messaged the bot.
const TEMPLATES = {
  carecircle_update: {
    body:
      'Hello there, this is Thandi from The CareCircle. Great news! We have removed all subscription fees. ' +
      'You can now use CareCircle for free, and only pay for background checks. Reply if you need help!',
  },
  background_check_fee: {
    body:
      'Hello {{1}}, this is Thandi from CareCircle, writing from our official WhatsApp number. Your CareCircle ' +
      'job involves caring for children, so it needs a background check: an electronic criminal record check ' +
      'with a once-off fee of R80. No police station visit or paper certificate is needed. You can pay by card ' +
      'on the Background Check screen in the CareCircle app or portal, or by bank deposit: reply to this ' +
      "message and we'll send you our banking details. No CareCircle account yet? Sign up first at " +
      'https://portal.thecarecircle.co.za/signup. Reply STOP to stop these messages.',
    needsContacts: true,
  },
};
const DEFAULT_TEMPLATE = 'carecircle_update';
// The language the templates were approved in: WhatsApp Manager's "English (US)" is en_US, "English" is en.
// Override per run with --language=en instead of editing this.
const DEFAULT_TEMPLATE_LANGUAGE = 'en_US';

// Most people messaged in one run; the daily limit can make a run smaller.
const BATCH_SIZE = 500;
// Meta caps how many different people the number can message first in any 24 hours (WhatsApp Manager >
// Phone numbers > Messaging limit). Sends of every template in the last 24 hours count against it. Pass
// --daily-limit=1000 when WhatsApp Manager shows a higher limit.
const DEFAULT_DAILY_LIMIT = 250;
const DAY_MS = 24 * 60 * 60 * 1000;
// A reply that only asks to stop, e.g. "STOP", "Stop please", "unsubscribe.", "opt out".
const OPT_OUT_REPLY = /^\W*(please\s+)?(stop|unsubscribe|opt[\s-]?out)(\s+(please|messages|now))?\W*$/i;
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 3000;
const COUNTDOWN_SECONDS = 10;
const REQUEST_TIMEOUT_MS = 30 * 1000;
// After a throughput limit, wait this long before moving on to the next number.
const RATE_LIMIT_PAUSE_MS = 60 * 1000;
// This many failures in a row points at the account or template rather than the numbers, so stop.
const MAX_CONSECUTIVE_FAILURES = 5;

// Meta error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
// Throughput limits: log, back off, carry on with the next number.
const RATE_LIMIT_CODES = new Set([4, 80007, 130429]);
// Every later send would fail the same way, or carrying on would hurt the number's quality rating: stop.
// Anything else (invalid or undeliverable number, user opted out, ...) only affects that one recipient.
const FATAL_CODES = new Map([
  [0, 'access token rejected'],
  [10, 'permission denied'],
  [190, 'access token expired'],
  [368, 'number temporarily blocked for policy violations'],
  [131031, 'business account locked'],
  [131042, 'payment problem on the business account'],
  [131048, 'spam rate limit: too many recent messages from this number were blocked or reported'],
  [132000, 'template parameter count does not match the approved template'],
  [132001, 'template does not exist in this language (check --template and --language)'],
  [132012, 'template parameter format does not match the approved template'],
  [132015, 'template paused by Meta for low quality'],
  [132016, 'template disabled by Meta'],
  [133010, 'business phone number not registered'],
]);

const logDir = path.dirname(config.dbPath);
const sentLogPath = (templateName) => path.join(logDir, `broadcast-${templateName}.log`);

/**
 * Meta wants digits only, country code first, no "+" or spaces, e.g. "27821234567". The webhook already
 * delivers numbers that way; spreadsheets often don't. Returns null if it can't be a valid number.
 */
function toMetaNumber(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2); // international dialling prefix
  else if (/^0[1-9]\d{8}$/.test(digits)) digits = `27${digits.slice(1)}`; // South African local format, 0XX XXX XXXX
  if (digits.startsWith('27')) return digits.length === 11 ? digits : null;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/**
 * The greeting name from a spreadsheet's name cell: the first word, letters only, with "THANDI" or "thandi"
 * written as "Thandi". Returns null when nothing usable is left, so the greeting falls back to "there".
 */
function toFirstName(raw) {
  const word = String(raw ?? '')
    .replace(/[^\p{L}'-]+/gu, ' ')
    .trim()
    .split(' ')[0]
    .replace(/^['-]+|['-]+$/g, '');
  if (word.replace(/[^\p{L}]/gu, '').length < 2) return null;
  const oneCase = word === word.toUpperCase() || word === word.toLowerCase();
  if (!oneCase) return word;
  return word.toLowerCase().replace(/(^|['-])(\p{L})/gu, (match, separator, letter) => separator + letter.toUpperCase());
}

/**
 * From the conversation history: every customer number, most recently active first, and the numbers that
 * have sent a reply asking to stop.
 */
function readDatabase() {
  const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  try {
    const customers = db
      .prepare(`
        SELECT sender_number, MAX(timestamp) AS last_seen FROM conversations
        WHERE role = 'user'
        GROUP BY sender_number
        ORDER BY last_seen DESC
      `)
      .all()
      .map((row) => row.sender_number);
    // Only a short message can be a bare "stop", so longer ones aren't fetched.
    const optedOut = db
      .prepare("SELECT sender_number, content FROM conversations WHERE role = 'user' AND length(content) <= 40")
      .all()
      .filter((row) => OPT_OUT_REPLY.test(row.content))
      .map((row) => toMetaNumber(row.sender_number));
    return { customers, optedOut: new Set(optedOut) };
  } finally {
    db.close();
  }
}

/**
 * People from a spreadsheet saved as CSV, in file order: { raw, firstName }. Needs a header row with a column
 * called phone_number (or phone); a name (or first_name) column is optional. Excel writes commas or
 * semicolons depending on regional settings; both work, and quoted fields are handled so a name containing a
 * comma doesn't shift the columns.
 */
function readContactsCsv(filePath) {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const headerLine = lines[0] ?? '';
  const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
  const header = parseCsvLine(headerLine, delimiter).map((name) => name.trim().toLowerCase());
  const phoneColumn = header.findIndex((name) => name === 'phone_number' || name === 'phone');
  if (phoneColumn === -1) throw new Error(`${filePath} needs a column headed phone_number (found: ${header.join(', ')})`);
  const nameColumn = header.findIndex((name) => name === 'name' || name === 'first_name');
  return lines
    .slice(1)
    .map((line) => parseCsvLine(line, delimiter))
    .filter((fields) => fields[phoneColumn]?.trim())
    .map((fields) => ({
      raw: fields[phoneColumn],
      firstName: nameColumn === -1 ? null : toFirstName(fields[nameColumn]),
    }));
}

/** Split one CSV line into fields; "quoted, fields" keep their delimiters and "" is an escaped quote. */
function parseCsvLine(line, delimiter) {
  const fields = [''];
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') {
      fields[fields.length - 1] += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      fields.push('');
    } else {
      fields[fields.length - 1] += ch;
    }
  }
  return fields;
}

/** The sends recorded in one sent log: who received the template and when (ms since epoch). */
function readSentLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([to]) => to.trim())
    .map(([to, sentAt]) => ({ to: to.trim(), sentAt: Date.parse(sentAt) }));
}

/** When each send in the last 24 hours happened, across every template's log. */
function sendsInLast24h() {
  const since = Date.now() - DAY_MS;
  return fs
    .readdirSync(logDir)
    .filter((name) => /^broadcast-.+\.log$/.test(name))
    .flatMap((name) => readSentLog(path.join(logDir, name)))
    .map((entry) => entry.sentAt)
    .filter((sentAt) => sentAt > since);
}

/**
 * The next `limit` people to message, as { to, firstName }: the contacts file if one is given, otherwise the
 * bot's customers. Skips invalid numbers, duplicates, anyone already sent this template and anyone who asked
 * the bot to stop. `remaining` counts eligible people left for a later run.
 */
function pickRecipients(limit, alreadySent, contactsPath) {
  const { customers, optedOut } = readDatabase();
  const source = contactsPath ? path.basename(contactsPath) : 'database';
  const people = contactsPath ? readContactsCsv(contactsPath) : customers.map((raw) => ({ raw, firstName: null }));

  const seen = new Set();
  const recipients = [];
  let invalid = 0;
  let skippedAlreadySent = 0;
  let skippedOptedOut = 0;
  let remaining = 0;

  for (const { raw, firstName } of people) {
    const to = toMetaNumber(raw);
    if (!to) {
      console.warn(`Skipping invalid number from ${source}: ${raw}`);
      invalid++;
      continue;
    }
    if (seen.has(to)) continue;
    seen.add(to);

    if (alreadySent.has(to)) skippedAlreadySent++;
    else if (optedOut.has(to)) skippedOptedOut++;
    else if (recipients.length < limit) recipients.push({ to, firstName });
    else remaining++;
  }

  return { source, recipients, invalid, skippedAlreadySent, skippedOptedOut, remaining };
}

/**
 * Send a template to one number and resolve with Meta's message ID. `name` fills the template's {{1}}; pass
 * null for a template without one, since sending a parameter it doesn't expect fails (132000). On failure,
 * throws an error whose `code` is Meta's error code (undefined for network errors and timeouts).
 */
async function sendTemplate(to, templateName, language, name) {
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
  const template = { name: templateName, language: { code: language } };
  if (name !== null) template.components = [{ type: 'body', parameters: [{ type: 'text', text: name }] }];

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const { message, code, error_data: errorData } = data.error ?? {};
    const detail = errorData?.details ? ` (${errorData.details})` : '';
    const err = new Error(`${message ?? response.statusText}${detail}`);
    err.code = code;
    throw err;
  }

  return data.messages?.[0]?.id ?? '(no message id returned)';
}

function randomDelayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

/** A whole-number command-line option of at least 1, or `fallback` when it isn't given. */
function positiveIntArg(args, name, fallback) {
  if (args[name] === undefined) return fallback;
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive whole number, got "${args[name]}"`);
  return value;
}

/** A timestamp in South African time, for telling the operator when to run again. */
function formatSast(ms) {
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      to: { type: 'string' },
      template: { type: 'string', default: DEFAULT_TEMPLATE },
      language: { type: 'string', default: DEFAULT_TEMPLATE_LANGUAGE },
      contacts: { type: 'string' },
      'daily-limit': { type: 'string' },
    },
  });

  const limit = positiveIntArg(args, 'limit', BATCH_SIZE);
  const dailyLimit = positiveIntArg(args, 'daily-limit', DEFAULT_DAILY_LIMIT);
  // Meta's codes look like "en" or "en_US"; catch typos such as "en-US" or "EN" before anything is sent.
  const { language } = args;
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw new Error(`--language should look like en or en_US, got "${language}"`);

  const templateName = args.template;
  if (!Object.hasOwn(TEMPLATES, templateName)) {
    throw new Error(`--template must be one of ${Object.keys(TEMPLATES).join(', ')}, got "${templateName}"`);
  }
  const template = TEMPLATES[templateName];
  const testMode = args.to !== undefined;
  if (template.needsContacts && !args.contacts && !testMode) {
    throw new Error(`${templateName} is only sent to a --contacts list, never to everyone who has messaged the bot`);
  }
  if (!args['dry-run'] && getOfflineState()) {
    throw new Error('Thandi is offline, so replies would only get the away message. Run: node scripts/offline.js off');
  }
  // What fills {{1}}, or null when the template has no {{1}}.
  const greetingName = (firstName) => (template.body.includes('{{1}}') ? firstName ?? 'there' : null);

  let recipients;

  if (testMode) {
    const to = toMetaNumber(args.to);
    if (!to) throw new Error(`--to is not a valid phone number: "${args.to}"`);
    recipients = [{ to, firstName: null }];
    console.log(`Test send of "${templateName}" (${language}) to ${to} (not recorded in the sent log)`);
  } else {
    console.log(`Database: ${config.dbPath}`);
    if (args.contacts) console.log(`Contacts: ${path.resolve(args.contacts)}`);
    console.log(`Sent log: ${sentLogPath(templateName)}`);

    const recent = sendsInLast24h();
    const allowance = dailyLimit - recent.length;
    console.log(`Daily limit: ${recent.length} of ${dailyLimit} used in the last 24 hours (all templates)`);
    if (allowance <= 0) {
      console.log(
        `Daily limit reached. The first slot frees up at ${formatSast(Math.min(...recent) + DAY_MS)}; ` +
          `all ${dailyLimit} are free again from ${formatSast(Math.max(...recent) + DAY_MS)} (SA time).`
      );
      return;
    }

    const alreadySent = new Set(readSentLog(sentLogPath(templateName)).map((entry) => entry.to));
    const picked = pickRecipients(Math.min(limit, allowance), alreadySent, args.contacts);
    recipients = picked.recipients;
    console.log(
      `${recipients.length} recipient(s) this run from ${picked.source}; ${picked.skippedAlreadySent} already sent ` +
        `earlier, ${picked.skippedOptedOut} asked to stop, ${picked.invalid} invalid, ${picked.remaining} left for a later run`
    );
  }

  if (recipients.length === 0) {
    console.log('Nobody to send to.');
    return;
  }

  if (args['dry-run']) {
    recipients.forEach(({ to, firstName }, i) => {
      const name = greetingName(firstName);
      console.log(`[${i + 1}/${recipients.length}] ${to}${name === null ? '' : ` "Hello ${name}"`} (dry run, not sent)`);
    });
    console.log(`Dry run: would send "${templateName}" (${language}) to ${recipients.length} number(s).`);
    console.log(`The approved template in WhatsApp Manager should read:\n  ${template.body}`);
    return;
  }

  if (!testMode) {
    const minutes = Math.ceil((recipients.length * (MIN_DELAY_MS + MAX_DELAY_MS)) / 2 / 60000);
    console.log(
      `Sending "${templateName}" (${language}) to ${recipients.length} number(s), about ${minutes} min. ` +
        `Press Ctrl+C within ${COUNTDOWN_SECONDS}s to cancel.`
    );
    await sleep(COUNTDOWN_SECONDS * 1000);
  }

  let sent = 0;
  let consecutiveFailures = 0;
  let stopReason = null;
  const failuresByCode = new Map();

  for (const [i, { to, firstName }] of recipients.entries()) {
    if (i > 0) await sleep(randomDelayMs());
    const tag = `[${i + 1}/${recipients.length}] ${to}`;

    try {
      const messageId = await sendTemplate(to, templateName, language, greetingName(firstName));
      console.log(`${tag} sent (${messageId})`);
      if (!testMode) fs.appendFileSync(sentLogPath(templateName), `${to}\t${new Date().toISOString()}\t${messageId}\n`);
      sent++;
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      const key = err.code ?? 'network/timeout';
      failuresByCode.set(key, (failuresByCode.get(key) ?? 0) + 1);
      console.error(`${tag} FAILED${err.code !== undefined ? ` [code ${err.code}]` : ''}: ${err.message}`);

      if (FATAL_CODES.has(err.code)) {
        stopReason = `Meta error ${err.code}: ${FATAL_CODES.get(err.code)}`;
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `${consecutiveFailures} failures in a row`;
        break;
      }
      if (RATE_LIMIT_CODES.has(err.code)) {
        console.warn(`Rate limited; pausing ${RATE_LIMIT_PAUSE_MS / 1000}s before the next number`);
        await sleep(RATE_LIMIT_PAUSE_MS);
      }
    }
  }

  const failed = [...failuresByCode.values()].reduce((a, b) => a + b, 0);
  console.log('---');
  console.log(`Sent: ${sent}   Failed: ${failed}   Not attempted: ${recipients.length - sent - failed}`);
  for (const [code, count] of failuresByCode) console.log(`  failures with code ${code}: ${count}`);
  // "Sent" means Meta accepted the message; delivery failures arrive later as webhook status updates.
  if (stopReason) {
    console.error(`STOPPED EARLY: ${stopReason}. Fix the cause, then rerun; numbers already sent are skipped.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Broadcast aborted:', err.message);
  process.exit(1);
});
