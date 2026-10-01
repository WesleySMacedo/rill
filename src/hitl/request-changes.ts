import type { ReviewTicket } from "./review-ticket";
import { updateTicketStatusInStore } from "../infrastructure/hitl.supabase";

export async function requestChangesTicketService(
	ticketId: string,
	reviewer: string,
	requestedChanges: string = "Changes requested by Diretor da Obra",
): Promise<ReviewTicket | null> {
	return await updateTicketStatusInStore(ticketId, "REQUESTED_CHANGES", reviewer, requestedChanges);
}
