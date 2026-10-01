export type ExecutionCostStatus = "ESTIMATE_REQUIRED" | "COST_ALLOWED" | "COST_LIMIT_REACHED" | "COST_UNKNOWN" | "POLICY_BLOCKED" | "COST_REPORTED";

export interface ExecutionCostSnapshot {
	executionId: string;
	maxEstimatedCost: number;
	estimatedCost: number | null;
	reportedCost: number | null;
	remainingExecutionBudget: number | null;
	attempt: number;
	retryCost: number | null;
	status: ExecutionCostStatus;
}

export interface ExecutionCostDecision {
	allowed: boolean;
	status: ExecutionCostStatus;
	reason: string;
	remainingExecutionBudget: number | null;
}