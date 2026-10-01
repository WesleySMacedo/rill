export type RillExecutionState =
	| "CLASSIFIED"
	| "CONTEXT_READY"
	| "PLANNED"
	| "PROPOSAL_REVIEWED"
	| "AWAITING_HUMAN_APPROVAL"
	| "EXECUTING"
	| "VALIDATING"
	| "COMPLETED"
	| "BLOCKED"
	| "FAILED"
	| "REJECTED"
	| "REQUESTED_CHANGES"
	| "CANCELED";

export interface RillExecution {
	executionId: string;
	state: RillExecutionState;
	action: string | null;
	domain: string | null;
	requestedBy: string | null;
	serviceAccountId?: string | null;
	humanUserId?: string | null;
	sourceClient: "cline" | "continue" | "copilot" | "api";
	createdAt: string;
	traceId: string | null;
	sessionId: string | null;
	idempotencyKey?: string | null;
	proposalHash?: string | null;
}

export const terminalExecutionStates = new Set<RillExecutionState>([
	"COMPLETED",
	"BLOCKED",
	"FAILED",
	"REJECTED",
	"REQUESTED_CHANGES",
	"CANCELED",
]);
