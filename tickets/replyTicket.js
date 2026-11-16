import { sendAction, baseFields } from './sendAction.js';

/** Sends the drafted reply (in the customer's language) to the customer. */
export const replyTicket = async (ticketId, decision) => {
  if (!decision.draft_reply?.trim()) {
    throw new Error(`${ticketId}: reply without a draft_reply`);
  }
  return sendAction(ticketId, 'reply', {
    ...baseFields(decision),
    draft_reply: decision.draft_reply,
  });
};
