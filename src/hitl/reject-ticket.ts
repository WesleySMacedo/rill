import type { ReviewTicket } from "./review-ticket";
import { updateTicketStatusInStore } from "../infrastructure/hitl.supabase";

export async function rejectTicketService(
	ticketId: string,
	reviewer: string,
	reason: string = "Rejected by Diretor da Obra",
): Promise<ReviewTicket | null> {
	return await updateTicketStatusInStore(ticketId, "REJECTED", reviewer, reason);
}
