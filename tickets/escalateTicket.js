import { sendAction, baseFields } from './sendAction.js';

/** Hands the ticket to the human support team (the helpdesk calls this "handoff"). */
export const escalateTicket = async (ticketId, decision) => {
  if (!decision.handoff_note?.trim()) {
    throw new Error(`${ticketId}: handoff without a handoff_note`);
  }
  return sendAction(ticketId, 'handoff', {
    ...baseFields(decision),
    handoff_note: decision.handoff_note,
  });
};
