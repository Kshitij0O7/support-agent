import { request, HelpdeskError } from './client.js';
import { getTicket, isHandled } from './readTickets.js';
import { redact } from '../logger.js';

// Shared by replyTicket, escalateTicket and closeTicket: the three actions take the
// same body shape and need the same "never answer a customer twice" handling.

const MAX_RETRIES_AFTER_AMBIGUOUS = 2;

/** Fields every action requires (api_reference.md, "Sending a decision"). */
export function baseFields(decision) {
  return {
    language: decision.language,
    category: decision.category,
    priority: decision.priority,
    reason: decision.reason,
    ...(typeof decision.confidence === 'number' ? { confidence: decision.confidence } : {}),
  };
}

/**
 * Posts one action for one ticket.
 * Returns { outcome: 'sent' } or { outcome: 'already_handled' }; throws on anything else.
 *
 * - 409 already_handled: never retried. Reported so the caller can log it.
 * - No response / unclear 5xx: the helpdesk may have saved it, so we look at the
 *   ticket first and only send again if it is still open.
 */
export async function sendAction(ticketId, action, body) {
  const path = `/tickets/${encodeURIComponent(ticketId)}/${action}`;
  // Client rule: never repeat payment details (IBANs, card numbers) to anyone.
  const safeBody = redact(body);

  for (let retry = 0; ; retry++) {
    try {
      await request('POST', path, { body: safeBody });
      return { outcome: 'sent' };
    } catch (err) {
      if (!(err instanceof HelpdeskError)) throw err;
      if (err.code === 'already_handled') return { outcome: 'already_handled' };
      if (!err.ambiguous) throw err;

      const ticket = await getTicket(ticketId);
      if (isHandled(ticket)) return { outcome: 'sent', confirmedAfter: err.message };
      if (retry >= MAX_RETRIES_AFTER_AMBIGUOUS) throw err;
      console.warn(`[helpdesk] ${ticketId}: ${err.message}; ticket still open, sending again`);
    }
  }
}
