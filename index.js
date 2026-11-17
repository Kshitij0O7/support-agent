// Support agent: reads every open ticket from the helpdesk and posts one decision per ticket.
//
//   npm start                      handle all open tickets
//   npm start -- --dry-run         decide, log, but post nothing to the helpdesk
//   npm start -- --limit 3         handle only the first 3 open tickets
//
// Safe to re-run at any time: the helpdesk's open list is the only state. A ticket
// that was handled no longer shows up; a ticket whose run crashed is still open and
// gets handled next time. A second answer is prevented by sendAction (409 handling,
// checking the ticket after a lost response).

import { getOpenTickets } from './tickets/readTickets.js';
import { replyTicket } from './tickets/replyTicket.js';
import { escalateTicket } from './tickets/escalateTicket.js';
import { closeTicket } from './tickets/closeTicket.js';
import { getContext } from './context/getContext.js';
import { makeDecision } from './decision.js';
import { applyGuard } from './guard.js';
import { logTicket, logFile } from './logger.js';
import { estimateCostUsd } from './pricing.js';

const MAX_DECIDE_FAILURES_IN_A_ROW = 3;

const ACTIONS = {
  reply: replyTicket,
  handoff: escalateTicket,
  close: closeTicket,
};

function parseArgs(argv) {
  const args = { dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!(args.limit > 0)) throw new Error('--limit must be a positive number');
  return args;
}

function tokenSummary(usage) {
  if (!usage) return null;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Decides and acts on one ticket, and writes exactly one log line for it.
 * Never throws: a failure is logged and the ticket stays open for the next run.
 */
async function handleTicket(ticket, context, { dryRun }) {
  const started = Date.now();
  const entry = { ticketId: ticket.id };

  // 1. Decide. If the LLM API is down, leave the ticket open rather than guessing.
  let proposed;
  let meta;
  try {
    ({ decision: proposed, meta } = await makeDecision(ticket, context));
  } catch (err) {
    logTicket({ ...entry, outcome: 'failed', stage: 'decide', error: err, durationMs: Date.now() - started });
    return { outcome: 'failed', stage: 'decide', costUsd: 0 };
  }

  // 2. Guard: deterministic safety checks; can only make the decision more careful.
  const { decision, changes } = applyGuard(proposed, ticket, context);

  const costUsd = estimateCostUsd(meta.model, meta.usage) ?? 0;
  Object.assign(entry, {
    action: decision.action,
    proposedAction: decision.action !== proposed.action ? proposed.action : undefined,
    guard: changes.length ? changes : undefined,
    language: decision.language,
    category: decision.category,
    priority: decision.priority,
    confidence: decision.confidence,
    faqIds: decision.faq_ids_used,
    escalationTriggers: decision.escalation_triggers,
    reason: decision.reason,
    // English versions only, so a reviewer who does not read Dutch can check the log.
    replyEn: decision.draft_reply_en || undefined,
    handoffNote: decision.handoff_note || undefined,
    fallback: meta.fallback ?? undefined,
    model: meta.model,
    tokens: tokenSummary(meta.usage),
    costUsd,
  });

  // 3. Act.
  if (dryRun) {
    logTicket({ ...entry, outcome: 'dry_run', durationMs: Date.now() - started });
    return { outcome: 'dry_run', action: decision.action, costUsd };
  }

  const act = ACTIONS[decision.action];
  if (!act) {
    logTicket({ ...entry, outcome: 'failed', stage: 'act', error: `unknown action "${decision.action}"` });
    return { outcome: 'failed', costUsd };
  }

  try {
    const result = await act(ticket.id, decision);
    logTicket({ ...entry, outcome: result.outcome, confirmedAfter: result.confirmedAfter, durationMs: Date.now() - started });
    return { outcome: result.outcome, action: decision.action, costUsd };
  } catch (err) {
    logTicket({
      ...entry,
      outcome: 'failed',
      stage: 'act',
      error: err,
      problems: err.problems,
      durationMs: Date.now() - started,
    });
    return { outcome: 'failed', costUsd };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const context = getContext();

  const open = await getOpenTickets();
  const unique = [...new Map(open.map((t) => [t.id, t])).values()];
  const tickets = unique.slice(0, args.limit);
  console.log(
    `${unique.length} open ticket(s)` +
      (tickets.length < unique.length ? `, handling the first ${tickets.length}` : '') +
      (args.dryRun ? ' (dry run: nothing is posted)' : ''),
  );

  // One at a time: simple to follow, and the helpdesk's rate limit would cap
  // parallel work anyway. 30 tickets take about two minutes.
  const results = [];
  let decideFailuresInARow = 0;
  for (const ticket of tickets) {
    const result = await handleTicket(ticket, context, args);
    results.push(result);

    // If the model API keeps failing (outage, bad key, spend limit), stop instead of
    // trying every ticket: they all stay open for the next run.
    decideFailuresInARow = result.stage === 'decide' ? decideFailuresInARow + 1 : 0;
    if (decideFailuresInARow >= MAX_DECIDE_FAILURES_IN_A_ROW) {
      console.error(
        `\nStopping: the model API failed ${decideFailuresInARow} times in a row. ` +
          `The remaining ${tickets.length - results.length} ticket(s) are untouched; see the log for the error.`,
      );
      break;
    }
  }

  const count = (fn) => results.filter(fn).length;
  const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const failed = count((r) => r.outcome === 'failed');
  console.log(
    `\nDone: ${results.length} ticket(s). ` +
      `reply ${count((r) => r.action === 'reply')}, ` +
      `handoff ${count((r) => r.action === 'handoff')}, ` +
      `close ${count((r) => r.action === 'close')}, ` +
      `already handled ${count((r) => r.outcome === 'already_handled')}, ` +
      `failed ${failed}. ` +
      `Model cost about $${totalCost.toFixed(4)}.`,
  );
  if (results.length) console.log(`Log: ${logFile}`);
  if (failed) {
    console.log(`${failed} ticket(s) failed and are still open; run again to retry them.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // Only setup problems end up here (missing env vars, helpdesk unreachable when
  // listing tickets). Per-ticket problems are logged and the run continues.
  console.error(`Run aborted: ${err.message}`);
  process.exitCode = 1;
});
