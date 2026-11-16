import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One JSON line per ticket, in logs/run-<timestamp>.jsonl.
// A new file per run, so the final (scored) run's log stands on its own.
//
// Every string that goes into a log line passes through redact() first, so no
// caller can accidentally write payment details (client rule: "Never repeat
// payment details (card numbers, IBANs) in a reply or a log").

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOG_DIR || path.join(PROJECT_ROOT, 'logs');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');

export const logFile = path.join(LOG_DIR, `run-${RUN_ID}.jsonl`);

// IBAN: 2-letter country code, 2 check digits, then 11-30 letters/digits.
// Customers type them with spaces ("NL91 ABNA 0417 1643 00") and in lowercase.
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi;
// Ordinary text like "op12 dagen niet ..." also fits the pattern above, so a
// match is only redacted when it holds enough digits to be an account number.
const IBAN_MIN_DIGITS = 10;

// Card number: 13-19 digits, optionally grouped with spaces or dashes.
// No Luhn check on purpose: a mistyped card number is still a payment detail,
// and redacting a harmless long number costs nothing.
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

function redactText(text) {
  return text
    .replace(IBAN_RE, (match) =>
      (match.match(/\d/g) || []).length >= IBAN_MIN_DIGITS ? '[REDACTED_IBAN]' : match,
    )
    .replace(CARD_RE, '[REDACTED_CARD]');
}

/** Redacts payment details from a string, or from every string inside an object/array. */
export function redact(value) {
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) return redactText(value.message);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redact(v)]));
  }
  return value;
}

let logDirReady = false;

/**
 * Writes one log line for one ticket. Call it exactly once per ticket.
 *
 * Suggested fields: ticketId, action, language, category, priority, confidence,
 * reason, outcome ('sent' | 'already_handled' | 'failed'), error, attempts, durationMs.
 * Leave out the customer's full message: the log needs the decision, not the ticket text.
 */
export function logTicket(entry) {
  const line = { ts: new Date().toISOString(), ...redact(entry) };

  if (!logDirReady) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
  }
  // Synchronous append: if the process crashes right after, the line is already on disk.
  fs.appendFileSync(logFile, JSON.stringify(line) + '\n');

  console.log(
    [line.ticketId, line.action, line.language, line.priority, line.outcome]
      .filter(Boolean)
      .join(' · '),
  );
}
