import { request } from './client.js';

const PAGE_SIZE = 10; // the helpdesk's maximum

/**
 * All open (not yet handled) tickets, every page collected BEFORE any is handled.
 * Handling a ticket removes it from the open set, which could shift the cursor if
 * we handled tickets while still paging.
 */
export const getOpenTickets = async () => {
  const tickets = [];
  const seenCursors = new Set();
  let cursor;

  do {
    const page = await request('GET', '/tickets', {
      query: { limit: PAGE_SIZE, status: 'open', cursor },
    });
    tickets.push(...(page.tickets ?? []));
    cursor = page.next_cursor ?? null;

    // Guard against a cursor that never advances, so a helpdesk bug can't loop forever.
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(`Pagination stuck: cursor ${cursor} returned twice`);
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  return tickets;
};

/** One ticket. `ticket.handled` is null while open, and describes the action once handled. */
export const getTicket = async (ticketId) =>
  request('GET', `/tickets/${encodeURIComponent(ticketId)}`);

export const isHandled = (ticket) => ticket?.handled != null;

/** The 10 labelled examples, for the eval. Not part of the 30 tickets; never post to them. */
export const getExamples = async () => {
  const data = await request('GET', '/examples');
  return data.examples ?? [];
};
