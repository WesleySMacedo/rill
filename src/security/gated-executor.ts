import type { BuilderProposalResult } from "../contracts/execution.contract";

export interface ExecutorGateInput {
	proposal: BuilderProposalResult;
	approvedProposalHash: string;
	ticketStatus: "PENDING" | "APPROVED" | "REJECTED" | "REQUESTED_CHANGES";
	executionState: "AWAITING_HUMAN_APPROVAL" | "EXECUTING" | "COMPLETED" | "FAILED";
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value ?? null);
}

export async function hashProposal(proposal: BuilderProposalResult): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(proposal))));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertExecutorGate(input: ExecutorGateInput): Promise<void> {
	if (input.ticketStatus !== "APPROVED") throw new Error("HUMAN_APPROVAL_REQUIRED");
	if (input.executionState !== "EXECUTING") throw new Error("EXECUTION_STATE_INVALID");
	const actualHash = await hashProposal(input.proposal);
	if (actualHash !== input.approvedProposalHash) throw new Error("PROPOSAL_HASH_MISMATCH");
}
