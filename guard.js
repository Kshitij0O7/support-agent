// Guard: deterministic safety checks between the model's decision and the helpdesk.
//
// applyGuard(decision, ticket, context) -> { decision, changes }
//
// It can only make a decision MORE careful:
//   - turn a reply or close into a handoff
//   - raise a priority (never lower it)
// It never turns a handoff into a reply, and never writes customer-facing text.
// So the client's always-human rules hold even when the model gets them wrong.
//
// Rules (sources: faq.md "client's rules", brief section 03 priorities):
//   1. The model itself listed an always-human rule          -> handoff
//   2. Keywords for an always-human rule appear in the ticket -> handoff (backstop
//      for when the model misses it; deliberately narrow, see KEYWORD_RULES)
//   3. A reply that cites no FAQ article                      -> handoff
//   4. A reply that links to a site the FAQ never mentions    -> handoff
//   5. Confidence below 0.7 on a reply or close               -> handoff
//   6. Priority floor per rule: security/legal -> P1; money/contract -> P2

export const MIN_CONFIDENCE = 0.7;

// Lower-cased ticket text is matched against these. Each pattern should only match
// wording that clearly signals the rule, because a false match sends an answerable
// ticket to a human. Words with an everyday meaning in a shift-planning app are left
// out on purpose: "annuleren" / "cancel" (cancelling a shift), "wechseln" (swapping a
// shift), "gegevens" / "data" (the FAQ answers where data is stored).
const KEYWORD_RULES = {
  refund_or_disputed_charge: [
    /terugbetal/, /terugstort/, /\bgeld terug\b/, /restitutie/, /onterecht (afgeschreven|gefactureerd|in rekening)/,
    /\brefund/, /\bmoney back\b/, /\bchargeback/, /\bcharged twice\b/,
    /rückerstatt/, /\bgeld zurück\b/,
  ],
  cancellation_or_contract_change: [
    /\bopzeg/, /\bopgezegd\b/, /contract (beëindigen|stopzetten)/, /\bdowngrade/,
    /cancel\w* (my|our|the) (subscription|account|contract|plan)/, /terminate (my|our|the) (subscription|account|contract)/,
    /\bkündig/,
  ],
  personal_data_request: [
    // Not plain "inzage": it also means "view" ("medewerkers inzage geven in het rooster").
    /inzageverzoek/, /recht op inzage/, /inzage in (mijn|onze) (persoons)?gegevens/, /\bavg\b/, /\bgdpr\b/, /\bdsgvo\b/, /recht op vergetelheid/, /right to be forgotten/,
    /(verwijder|wis)\w* (al )?(mijn|onze) (persoons)?gegevens/, /delete (all )?(my|our) (personal )?data/,
  ],
  security_incident: [
    /gehackt/, /\bhacked\b/, /\bdatalek/, /data ?(breach|leak)/, /onbekende? (login|inlog)/,
    /verdachte (login|inlog|activiteit)/, /suspicious (login|activity)/, /\bunauthori[sz]ed\b/,
  ],
  legal_threat: [
    /\badvocaat/, /\bjurist\b/, /juridische (stappen|actie)/, /ingebrekestelling/, /rechtszaak/, /\bdagvaard/,
    /\blawyer\b/, /\battorney\b/, /legal action/, /\bsue\b/, /\banwalt/, /rechtliche schritte/,
  ],
  threat_to_leave: [
    // Not plain "concurrent": in English it means "simultaneous" ("concurrent users").
    /\boverstappen\b/, /(naar|bij) (een|de) concurrent/, /andere (aanbieder|leverancier|software)/,
    /switch(ing)? to (another|a different|an other)/, /\bcompetitor/, /anderen anbieter/,
  ],
};

// Brief, section 03: P1 = security or legal risk; P2 = money or the contract is involved.
const PRIORITY_FLOOR = {
  security_incident: 'P1',
  legal_threat: 'P1',
  refund_or_disputed_charge: 'P2',
  cancellation_or_contract_change: 'P2',
  threat_to_leave: 'P2',
};

const PRIORITY_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };

const HOST_PATTERN = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:nl|com|de|eu|io|net|org|app))\b/gi;

function hostsIn(text) {
  return new Set([...(text ?? '').matchAll(HOST_PATTERN)].map((m) => m[1].toLowerCase()));
}

/** Always-human rules whose keywords appear in the ticket's subject or body. */
export function keywordTriggers(ticket) {
  const text = `${ticket.subject ?? ''}\n${ticket.body ?? ''}`.toLowerCase();
  return Object.entries(KEYWORD_RULES)
    .filter(([, patterns]) => patterns.some((p) => p.test(text)))
    .map(([rule]) => rule);
}

function raisePriority(current, triggers) {
  let best = current;
  for (const rule of triggers) {
    const floor = PRIORITY_FLOOR[rule];
    if (floor && PRIORITY_RANK[floor] < PRIORITY_RANK[best]) best = floor;
  }
  return best;
}

/**
 * @param {object} decision  from makeDecision
 * @param {object} ticket    the helpdesk ticket
 * @param {object} context   from getContext(): { faqText, faqIds }
 * @returns {{ decision: object, changes: string[] }} a new decision (input is not modified)
 */
export function applyGuard(decision, ticket, context) {
  const changes = [];
  const reasonsForHuman = [];

  const fromKeywords = keywordTriggers(ticket);
  const triggers = [...new Set([...(decision.escalation_triggers ?? []), ...fromKeywords])];

  if (decision.action !== 'handoff') {
    if (decision.escalation_triggers?.length) {
      reasonsForHuman.push(`the agent itself flagged an always-human rule (${decision.escalation_triggers.join(', ')})`);
    }
    const missedByModel = fromKeywords.filter((r) => !decision.escalation_triggers?.includes(r));
    if (missedByModel.length) {
      reasonsForHuman.push(`the ticket mentions an always-human topic (${missedByModel.join(', ')})`);
    }
    if (decision.confidence < MIN_CONFIDENCE) {
      reasonsForHuman.push(`confidence ${decision.confidence} is below ${MIN_CONFIDENCE}`);
    }
  }

  if (decision.action === 'reply') {
    const cited = decision.faq_ids_used ?? [];
    if (cited.length === 0) {
      reasonsForHuman.push('the reply cites no FAQ article');
    } else if (cited.some((id) => !context.faqIds.includes(id))) {
      reasonsForHuman.push(`the reply cites an unknown FAQ article (${cited.join(', ')})`);
    }
    const allowedHosts = hostsIn(context.faqText);
    const unknownHosts = [...hostsIn(decision.draft_reply)].filter((h) => !allowedHosts.has(h));
    if (unknownHosts.length) {
      reasonsForHuman.push(`the reply links to a site the FAQ does not mention (${unknownHosts.join(', ')})`);
    }
  }

  let guarded = { ...decision, escalation_triggers: triggers };

  if (reasonsForHuman.length) {
    const why = reasonsForHuman.join('; ');
    changes.push(`${decision.action} -> handoff: ${why}`);
    guarded = {
      ...guarded,
      action: 'handoff',
      reason: `Safety check sent this to a human: ${why}. Agent's assessment: ${decision.reason}`,
      handoff_note:
        `The agent proposed "${decision.action}", but an automatic safety check sent it to you because ${why}. ` +
        `Customer's request: ${decision.request_summary_en || 'see the ticket'}` +
        (decision.action === 'reply' ? ' The drafted reply was NOT sent.' : ''),
    };
  }

  const raised = raisePriority(guarded.priority, triggers);
  if (raised !== guarded.priority) {
    changes.push(`priority ${guarded.priority} -> ${raised} (${triggers.filter((t) => PRIORITY_FLOOR[t]).join(', ')})`);
    guarded.priority = raised;
  }

  return { decision: guarded, changes };
}
