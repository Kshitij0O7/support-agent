import { sendAction, baseFields } from './sendAction.js';

/** Closes the ticket without contacting anyone: spam and empty tickets only. */
export const closeTicket = async (ticketId, decision) =>
  sendAction(ticketId, 'close', baseFields(decision));
