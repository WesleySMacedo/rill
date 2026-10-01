import type { ReviewTicket } from "./review-ticket";
import { createTicketInStore } from "../infrastructure/hitl.supabase";

export async function createReviewTicketService(
	executionId: string,
	summary: string,
	reasonCode: string = "HUMAN_APPROVAL_REQUIRED",
	targetFiles: string[] = [],
): Promise<ReviewTicket> {
	const ticket: ReviewTicket = {
		ticketId: `ticket-${crypto.randomUUID()}`,
		executionId,
		reasonCode,
		summary,
		createdAt: new Date().toISOString(),
		status: "PENDING",
		targetFiles,
	};
	return await createTicketInStore(ticket);
}
