// The guard is plain code, so every rule can be tested without calling a model:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyGuard, keywordTriggers } from '../guard.js';
import { getContext } from '../context/getContext.js';

const context = getContext();

const ticket = (body, subject = 'Vraag') => ({ id: 'T999', subject, body, customer_plan: 'Basis' });

const reply = (overrides = {}) => ({
  request_summary_en: 'Customer asks how to add an employee.',
  language: 'nl',
  escalation_triggers: [],
  faq_ids_used: ['F02'],
  category: 'question',
  priority: 'P4',
  action: 'reply',
  reason: 'How-to question answered by F02.',
  draft_reply: 'Hoi, ga naar Team → Medewerker toevoegen. Met vriendelijke groet, Team Roosterly',
  draft_reply_en: 'Hi, go to Team → Add employee. Kind regards, Team Roosterly',
  handoff_note: '',
  confidence: 0.9,
  ...overrides,
});

const handoff = (overrides = {}) =>
  reply({ action: 'handoff', faq_ids_used: [], draft_reply: '', draft_reply_en: '', handoff_note: 'Needs a human.', ...overrides });

test('a clean FAQ reply passes unchanged', () => {
  const { decision, changes } = applyGuard(reply(), ticket('Hoe voeg ik een nieuwe medewerker toe?'), context);
  assert.equal(decision.action, 'reply');
  assert.equal(decision.priority, 'P4');
  assert.deepEqual(changes, []);
});

test('a reply where the model itself flagged a rule becomes a handoff', () => {
  const { decision, changes } = applyGuard(
    reply({ escalation_triggers: ['cancellation_or_contract_change'] }),
    ticket('Hoe werkt het?'),
    context,
  );
  assert.equal(decision.action, 'handoff');
  assert.equal(decision.priority, 'P2');
  assert.match(decision.handoff_note, /NOT sent/);
  assert.equal(changes.length, 2);
});

test('keyword backstop: a refund the model missed becomes a P2 handoff', () => {
  const { decision } = applyGuard(reply(), ticket('Hoe voeg ik iemand toe? En graag terugbetaling van september.'), context);
  assert.equal(decision.action, 'handoff');
  assert.equal(decision.priority, 'P2');
  assert.ok(decision.escalation_triggers.includes('refund_or_disputed_charge'));
});

test('keyword backstop covers the always-human rules in nl, en and de', () => {
  const cases = {
    'Wij willen ons abonnement opzeggen': 'cancellation_or_contract_change',
    'Please cancel our subscription': 'cancellation_or_contract_change',
    'Ich möchte kündigen': 'cancellation_or_contract_change',
    'Hierbij dien ik een inzageverzoek in': 'personal_data_request',
    'Delete my personal data please': 'personal_data_request',
    'Mijn account is gehackt': 'security_incident',
    'We see a suspicious login from another country': 'security_incident',
    'Onze advocaat neemt contact op': 'legal_threat',
    'We will take legal action': 'legal_threat',
    'Dan stappen we over naar een concurrent': 'threat_to_leave',
    'Ich will eine Rückerstattung': 'refund_or_disputed_charge',
  };
  for (const [text, rule] of Object.entries(cases)) {
    assert.ok(keywordTriggers(ticket(text)).includes(rule), `"${text}" should trigger ${rule}`);
  }
});

test('everyday shift-planning wording does not trigger a rule', () => {
  const harmless = [
    'Hoe kan ik een dienst annuleren?', // cancelling a shift
    'How do I cancel a shift?',
    'Wie kann ich eine Schicht wechseln?', // swapping a shift
    'Hoe geef ik medewerkers inzage in hun rooster?', // "inzage" = view
    'There is an issue with the export', // "issue" contains "sue"
    'Waar worden onze gegevens opgeslagen?', // F09 question
    'The app slows down with many concurrent users',
    'Hoe zet ik de terugkerende diensten aan?',
  ];
  for (const text of harmless) {
    assert.deepEqual(keywordTriggers(ticket(text)), [], `"${text}" should not trigger anything`);
  }
});

test('a reply without an FAQ article becomes a handoff', () => {
  const { decision, changes } = applyGuard(reply({ faq_ids_used: [] }), ticket('Vraag'), context);
  assert.equal(decision.action, 'handoff');
  assert.match(changes[0], /cites no FAQ article/);
});

test('a reply linking to a site the FAQ never mentions becomes a handoff', () => {
  const linked = reply({ draft_reply: 'Kijk op help.roosterly.nl/export voor meer info.' });
  const { decision, changes } = applyGuard(linked, ticket('Vraag'), context);
  assert.equal(decision.action, 'handoff');
  assert.match(changes[0], /help\.roosterly\.nl/);
});

test('links the FAQ itself gives are allowed', () => {
  const linked = reply({ faq_ids_used: ['F10'], draft_reply: 'Je kunt stemmen op roadmap.roosterly.nl.' });
  assert.equal(applyGuard(linked, ticket('Idee'), context).decision.action, 'reply');
  const login = reply({ faq_ids_used: ['F01'], draft_reply: 'Ga naar app.roosterly.nl/login.' });
  assert.equal(applyGuard(login, ticket('Wachtwoord'), context).decision.action, 'reply');
});

test('low confidence turns a reply or a close into a handoff', () => {
  assert.equal(applyGuard(reply({ confidence: 0.6 }), ticket('Vraag'), context).decision.action, 'handoff');
  const close = reply({ action: 'close', faq_ids_used: [], draft_reply: '', confidence: 0.5 });
  assert.equal(applyGuard(close, ticket('???'), context).decision.action, 'handoff');
});

test('a close on a ticket that mentions an always-human topic becomes a handoff', () => {
  const close = reply({ action: 'close', faq_ids_used: [], draft_reply: '', confidence: 0.95, category: 'other' });
  const { decision } = applyGuard(close, ticket('Ik wil mijn geld terug'), context);
  assert.equal(decision.action, 'handoff');
});

test('a handoff stays a handoff; only its priority can go up', () => {
  const security = applyGuard(handoff({ priority: 'P3' }), ticket('Ons account is gehackt'), context);
  assert.equal(security.decision.action, 'handoff');
  assert.equal(security.decision.priority, 'P1');
  assert.equal(security.decision.handoff_note, 'Needs a human.');

  const alreadyHigh = applyGuard(handoff({ priority: 'P1' }), ticket('Terugbetaling graag'), context);
  assert.equal(alreadyHigh.decision.priority, 'P1', 'priority must never be lowered');
});

test('the guard never turns a handoff into a reply and does not modify its input', () => {
  const input = handoff({ confidence: 0.99 });
  const frozen = JSON.stringify(input);
  const { decision } = applyGuard(input, ticket('Hoe voeg ik een medewerker toe?'), context);
  assert.equal(decision.action, 'handoff');
  assert.equal(JSON.stringify(input), frozen);
});
