import type { RillExecutionState } from "./rill-execution.contract";

export interface RillExecutionReport {
	executionId: string;
	state: Extract<RillExecutionState, "COMPLETED" | "BLOCKED" | "FAILED" | "REJECTED" | "REQUESTED_CHANGES" | "CANCELED">;
	action: string | null;
	domain: string | null;
	sourceClient: string;
	serviceAccountId: string | null;
	humanUserId: string | null;
	specialist: string | null;
	modelProfile: string | null;
	model: string | null;
	provider: string | null;
	fallbackUsed: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	reportedCost: number | null;
	latencyMs: number | null;
	filesChanged: string[];
	testsPassed: number | null;
	testsFailed: number | null;
	reviewerOutcome: string | null;
	humanDecision: string | null;
	traceId: string | null;
	riskResidual: string[];
	rollbackAvailable: boolean;
	reason?: string;
}
