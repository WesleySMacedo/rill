import type { ReviewTicket } from "./review-ticket";
import { updateTicketStatusInStore } from "../infrastructure/hitl.supabase";

export async function approveTicketService(
	ticketId: string,
	reviewer: string,
	justification: string = "Approved by Diretor da Obra",
): Promise<ReviewTicket | null> {
	return await updateTicketStatusInStore(ticketId, "APPROVED", reviewer, justification);
}
