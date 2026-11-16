// Runs the helpdesk client against a local fake helpdesk, so every error path in
// api_reference.md ("Errors you must handle") can be triggered on demand.
// No real API calls, no API keys needed:  npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { getOpenTickets } from '../tickets/readTickets.js';
import { replyTicket } from '../tickets/replyTicket.js';
import { escalateTicket } from '../tickets/escalateTicket.js';
import { closeTicket } from '../tickets/closeTicket.js';
import { HelpdeskError } from '../tickets/client.js';
import { getContext } from '../context/getContext.js';

// --- Fake helpdesk ------------------------------------------------------------
// 25 open tickets; T001-T006 each play one failure scenario on POST.

const tickets = Array.from({ length: 25 }, (_, i) => ({
  id: `T${String(i + 1).padStart(3, '0')}`,
  handled: null,
}));
const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
const hits = []; // every request the fake helpdesk received: { at, method, path, body }
const played = new Set(); // one-time scenario steps already played

function firstTime(key) {
  if (played.has(key)) return false;
  played.add(key);
  return true;
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://fake');
  const path = url.pathname.replace(/^\/fn/, '');
  hits.push({ at: Date.now(), method: req.method, path, body: raw ? JSON.parse(raw) : null, headers: req.headers });

  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && path === '/tickets') {
    if (firstTime('list-503')) return send(503, { error: 'service_unavailable' });
    const open = tickets.filter((t) => !t.handled);
    const cursor = url.searchParams.get('cursor');
    const start = cursor ? open.findIndex((t) => t.id === cursor) + 1 : 0;
    const page = open.slice(start, start + Number(url.searchParams.get('limit')));
    const next = start + page.length < open.length ? page.at(-1).id : null;
    return send(200, { tickets: page, next_cursor: next });
  }

  const match = path.match(/^\/tickets\/(T\d+)(?:\/(\w+))?$/);
  if (req.method === 'GET' && match && !match[2]) return send(200, byId[match[1]]);

  if (req.method === 'POST' && match) {
    const [, id, action] = match;
    const save = () => {
      byId[id].handled = { action };
    };
    switch (id) {
      case 'T001': // 503 once, then OK
        if (firstTime('t1')) return send(503, { error: 'service_unavailable' });
        save();
        return send(200, { ok: true });
      case 'T002': // 429 once, then OK
        if (firstTime('t2')) return send(429, { error: 'rate_limited' }, { 'retry-after': '1' });
        save();
        return send(200, { ok: true });
      case 'T003': // already handled
        return send(409, { error: 'already_handled' });
      case 'T004': // saved, but the response is lost
        save();
        return req.socket.destroy();
      case 'T005': // response lost and NOT saved the first time
        if (firstTime('t5')) return req.socket.destroy();
        save();
        return send(200, { ok: true });
      case 'T006': // invalid body
        return send(422, { error: 'validation_failed', problems: ['priority must be P1-P4'] });
    }
  }
  send(404, { error: 'not_found' });
});

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.HELPDESK_URL = `http://127.0.0.1:${server.address().port}/fn/`;
  process.env.HELPDESK_KEY = 'test-key';
  process.env.CANDIDATE_EMAIL = 'candidate@example.test';
});

after(() => server.close());

const decision = {
  language: 'nl',
  category: 'question',
  priority: 'P4',
  reason: 'test',
  confidence: 0.9,
  draft_reply: 'Hoi, ons IBAN NL91 ABNA 0417 1643 00 klopt',
  handoff_note: 'Refund request',
};
const postsFor = (id) => hits.filter((h) => h.method === 'POST' && h.path.startsWith(`/tickets/${id}/`));

// --- Tests (they run in order and share the fake helpdesk) ------------------------

test('collects all pages of open tickets, after a 503, with auth headers', async () => {
  const open = await getOpenTickets();
  assert.equal(open.length, 25);
  assert.equal(new Set(open.map((t) => t.id)).size, 25);
  const last = hits.at(-1);
  assert.equal(last.headers.authorization, 'Bearer test-key');
  assert.equal(last.headers['x-candidate-email'], 'candidate@example.test');
});

test('503 on a POST is retried; payment details are redacted from the body', async () => {
  assert.deepEqual(await replyTicket('T001', decision), { outcome: 'sent' });
  const posts = postsFor('T001');
  assert.equal(posts.length, 2);
  const body = posts.at(-1).body;
  assert.ok(!JSON.stringify(body).includes('0417'), 'IBAN reached the helpdesk');
  assert.equal(body.confidence, 0.9);
  assert.ok(!('handoff_note' in body), 'reply body carries a handoff_note');
});

test('429 waits Retry-After before retrying', async () => {
  const started = Date.now();
  assert.deepEqual(await replyTicket('T002', decision), { outcome: 'sent' });
  assert.ok(Date.now() - started >= 1000, 'retried before Retry-After passed');
});

test('409 is reported as already_handled and never retried', async () => {
  assert.deepEqual(await escalateTicket('T003', decision), { outcome: 'already_handled' });
  assert.equal(postsFor('T003').length, 1);
});

test('lost response on a saved ticket: confirmed via GET, not sent twice', async () => {
  const result = await replyTicket('T004', decision);
  assert.equal(result.outcome, 'sent');
  assert.ok(result.confirmedAfter);
  assert.equal(postsFor('T004').length, 1);
});

test('lost response on an unsaved ticket: checked, then sent again once', async () => {
  assert.deepEqual(await replyTicket('T005', decision), { outcome: 'sent' });
  assert.equal(postsFor('T005').length, 2);
});

test('422 is thrown with the problems list and not retried', async () => {
  await assert.rejects(
    closeTicket('T006', decision),
    (err) => err instanceof HelpdeskError && err.status === 422 && err.problems[0].includes('priority'),
  );
  assert.equal(postsFor('T006').length, 1);
});

test('an empty reply or handoff note is refused before any request', async () => {
  await assert.rejects(replyTicket('T007', { ...decision, draft_reply: '  ' }), /without a draft_reply/);
  await assert.rejects(escalateTicket('T007', { ...decision, handoff_note: '' }), /without a handoff_note/);
  assert.equal(postsFor('T007').length, 0);
});

// Runs last, so it covers every request the tests above made.
test('never more than 4 requests in any one-second window', () => {
  const times = hits.map((h) => h.at);
  const busiest = Math.max(...times.map((t) => times.filter((u) => u >= t && u < t + 1000).length));
  assert.ok(busiest <= 4, `${busiest} requests within one second`);
});

test('getContext loads all 12 FAQ articles and reuses the same object', () => {
  const context = getContext();
  assert.deepEqual(context.faqIds, Array.from({ length: 12 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`));
  assert.ok(context.faqText.includes("The client's rules for the support team"));
  assert.equal(getContext(), context);
});
