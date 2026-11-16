import { setTimeout as sleep } from 'node:timers/promises';

// Shared HTTP client for the Roosterly helpdesk. Every call to the helpdesk goes
// through request(), so auth, rate limiting, retries and timeouts live in one place.
//
// What it handles (see api_reference.md, "Errors you must handle"):
//   429 rate_limited        -> wait Retry-After, pause ALL calls, retry
//   503 service_unavailable -> "nothing was saved": retry with backoff (GET and POST)
//   no response / other 5xx -> GET: retry. POST: throw `ambiguous`, because the
//                              helpdesk may or may not have saved it; the caller must
//                              check the ticket before trying again (see sendAction.js)
//   anything else (400/401/404/409/422) -> throw HelpdeskError, no retry

// ~3.3 requests/second. The helpdesk returns 429 above 5/s; 250ms spacing was measured
// to let 5 requests land within one second once network timing varies, so keep a margin.
const MIN_INTERVAL_MS = 300;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 6; // per request, counting the first try
const BACKOFF_BASE_MS = 500; // 0.5s, 1s, 2s, 4s, 8s (+ jitter)
const BACKOFF_MAX_MS = 8_000;

export class HelpdeskError extends Error {
  /**
   * @param {string} message
   * @param {object} details
   * @param {number} [details.status]   HTTP status, if there was a response
   * @param {string} [details.code]     the helpdesk's `error` field, e.g. 'already_handled'
   * @param {Array}  [details.problems] for 422 validation_failed
   * @param {boolean} [details.ambiguous] true when a POST may or may not have been saved
   */
  constructor(message, { status, code, problems, ambiguous = false, cause } = {}) {
    super(message, { cause });
    this.name = 'HelpdeskError';
    this.status = status;
    this.code = code;
    this.problems = problems;
    this.ambiguous = ambiguous;
  }
}

let config;

// Read lazily, so importing this file never crashes (e.g. in tests); the first
// real request fails fast with a clear message if something is missing.
function getConfig() {
  if (config) return config;
  const { HELPDESK_URL, HELPDESK_KEY, CANDIDATE_EMAIL, CANDIDATE_NAME } = process.env;
  const missing = Object.entries({ HELPDESK_URL, HELPDESK_KEY, CANDIDATE_EMAIL })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')} (see .env.example)`);
  }
  config = {
    baseUrl: HELPDESK_URL.replace(/\/+$/, ''),
    headers: {
      Authorization: `Bearer ${HELPDESK_KEY}`,
      'X-Candidate-Email': CANDIDATE_EMAIL,
      ...(CANDIDATE_NAME ? { 'X-Candidate-Name': CANDIDATE_NAME } : {}),
    },
  };
  return config;
}

// --- Rate limiting -----------------------------------------------------------
// Each request reserves the next free time slot synchronously, so the limit also
// holds if several requests are started at once.
let nextSlotAt = 0;

async function waitForSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  if (slot > now) await sleep(slot - now);
}

// After a 429, hold back every caller, not just the one that got it.
function pauseAllUntil(timestamp) {
  nextSlotAt = Math.max(nextSlotAt, timestamp);
}

function backoffMs(attempt) {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  return exponential + Math.random() * 250;
}

function retryAfterMs(response) {
  const seconds = Number.parseFloat(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Calls the helpdesk and returns the parsed JSON body.
 *
 * @param {'GET'|'POST'} method
 * @param {string} path   e.g. '/tickets' or '/tickets/T005/reply'
 * @param {object} [options]
 * @param {object} [options.query] query string values; undefined/null are left out
 * @param {object} [options.body]  JSON body for POST
 */
export async function request(method, path, { query, body } = {}) {
  const { baseUrl, headers } = getConfig();
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const isRead = method === 'GET';
  const label = `${method} ${path}`;

  for (let attempt = 1; ; attempt++) {
    await waitForSlot();

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or timeout: no status code, so we don't know what happened.
      if (!isRead) {
        throw new HelpdeskError(`${label}: no response (${err.name})`, { ambiguous: true, cause: err });
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new HelpdeskError(`${label}: no response after ${attempt} attempts`, { cause: err });
      }
      const wait = backoffMs(attempt);
      console.warn(`[helpdesk] ${label}: ${err.name}, retry ${attempt + 1} in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
      continue;
    }

    const data = await parseBody(response);
    if (response.ok) return data;

    const status = response.status;
    const code = data?.error ?? `http_${status}`;
    const canRetry = attempt < MAX_ATTEMPTS;

    if (status === 429 && canRetry) {
      const wait = retryAfterMs(response);
      pauseAllUntil(Date.now() + wait);
      console.warn(`[helpdesk] ${label}: 429 rate_limited, retry ${attempt + 1} in ${(wait / 1000).toFixed(1)}s`);
      continue;
    }

    // 503 is documented as "nothing was saved", so even a POST is safe to retry.
    if (status === 503 && canRetry) {
      const wait = backoffMs(attempt);
      console.warn(`[helpdesk] ${label}: 503, retry ${attempt + 1} in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
      continue;
    }

    // Other 5xx (500/502/504): retry reads; for writes we can't know if it was saved.
    if (status >= 500 && status !== 503) {
      if (!isRead) {
        throw new HelpdeskError(`${label} -> ${status} ${code}`, { status, code, ambiguous: true });
      }
      if (canRetry) {
        const wait = backoffMs(attempt);
        console.warn(`[helpdesk] ${label}: ${status}, retry ${attempt + 1} in ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
        continue;
      }
    }

    throw new HelpdeskError(`${label} -> ${status} ${code}`, {
      status,
      code,
      problems: data?.problems,
    });
  }
}
