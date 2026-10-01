export type ReviewTicketStatus =
	| "PENDING"
	| "APPROVED"
	| "REJECTED"
	| "REQUESTED_CHANGES"
	| "EXPIRED";

export interface ReviewTicket {
	ticketId: string;
	executionId: string;
	reasonCode: string;
	summary: string;
	createdAt: string;
	status: ReviewTicketStatus;
	justification?: string;
	reviewer?: string;
	targetFiles?: string[];
}
