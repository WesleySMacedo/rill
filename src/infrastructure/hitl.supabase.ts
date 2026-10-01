import type { ReviewTicket, ReviewTicketStatus } from "../domain/review-ticket";

const inMemoryTicketStore = new Map<string, ReviewTicket>();

export async function createTicketInStore(ticket: ReviewTicket): Promise<ReviewTicket> {
	inMemoryTicketStore.set(ticket.ticketId, { ...ticket });
	return ticket;
}

export async function getTicketFromStore(ticketId: string): Promise<ReviewTicket | null> {
	const found = inMemoryTicketStore.get(ticketId);
	return found ? { ...found } : null;
}

export async function updateTicketStatusInStore(
	ticketId: string,
	status: ReviewTicketStatus,
	reviewer?: string,
	justification?: string,
): Promise<ReviewTicket | null> {
	const ticket = inMemoryTicketStore.get(ticketId);
	if (!ticket) return null;
	ticket.status = status;
	if (reviewer) ticket.reviewer = reviewer;
	if (justification) ticket.justification = justification;
	inMemoryTicketStore.set(ticketId, ticket);
	return { ...ticket };
}
