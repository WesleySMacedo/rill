import type { RillExecutionState } from "./rill-execution.contract";

export type RillApprovalDecision = "APPROVED" | "REJECTED" | "REQUESTED_CHANGES";

export const terminalStates = new Set<RillExecutionState>([
	"COMPLETED",
	"BLOCKED",
	"FAILED",
	"REJECTED",
	"REQUESTED_CHANGES",
	"CANCELED",
]);

const transitions: Record<RillExecutionState, readonly RillExecutionState[]> = {
	CLASSIFIED: ["CONTEXT_READY", "BLOCKED", "FAILED"],
	CONTEXT_READY: ["PLANNED", "BLOCKED", "FAILED"],
	PLANNED: ["PROPOSAL_REVIEWED", "BLOCKED", "FAILED"],
	PROPOSAL_REVIEWED: ["AWAITING_HUMAN_APPROVAL", "BLOCKED", "FAILED"],
	AWAITING_HUMAN_APPROVAL: ["EXECUTING", "REJECTED", "REQUESTED_CHANGES", "CANCELED", "FAILED"],
	EXECUTING: ["VALIDATING", "FAILED", "BLOCKED"],
	VALIDATING: ["COMPLETED", "FAILED", "BLOCKED"],
	COMPLETED: [],
	BLOCKED: [],
	FAILED: [],
	REJECTED: [],
	REQUESTED_CHANGES: [],
	CANCELED: [],
};

export function canTransition(from: RillExecutionState, to: RillExecutionState): boolean {
	return transitions[from]?.includes(to) ?? false;
}

export function assertValidTransition(from: RillExecutionState, to: RillExecutionState, decision?: RillApprovalDecision): void {
	if (from === "AWAITING_HUMAN_APPROVAL" && to === "EXECUTING" && decision !== "APPROVED") throw new Error("HUMAN_APPROVAL_REQUIRED");
	if (!canTransition(from, to)) throw new Error(`INVALID_RILL_TRANSITION:${from}:${to}`);
}

export function isTerminalState(state: RillExecutionState): boolean {
	return terminalStates.has(state);
}
