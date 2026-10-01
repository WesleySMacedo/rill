import type { ExecutionCostDecision, ExecutionCostSnapshot } from "../contracts/execution-cost.contract";

export function evaluateExecutionBudget(snapshot: ExecutionCostSnapshot): ExecutionCostDecision {
	if (!snapshot.executionId || !Number.isFinite(snapshot.maxEstimatedCost) || snapshot.maxEstimatedCost < 0 || !Number.isInteger(snapshot.attempt) || snapshot.attempt < 1) {
		return { allowed: false, status: "POLICY_BLOCKED", reason: "COST_SNAPSHOT_INVALID", remainingExecutionBudget: null };
	}
	if (snapshot.estimatedCost === null || !Number.isFinite(snapshot.estimatedCost) || snapshot.estimatedCost < 0) {
		return { allowed: false, status: "ESTIMATE_REQUIRED", reason: "ESTIMATE_REQUIRED", remainingExecutionBudget: snapshot.remainingExecutionBudget };
	}
	if (snapshot.remainingExecutionBudget === null || !Number.isFinite(snapshot.remainingExecutionBudget) || snapshot.remainingExecutionBudget < 0) {
		return { allowed: false, status: "COST_UNKNOWN", reason: "REMAINING_BUDGET_UNKNOWN", remainingExecutionBudget: null };
	}
	if (snapshot.estimatedCost > snapshot.remainingExecutionBudget) {
		return { allowed: false, status: "COST_LIMIT_REACHED", reason: "ESTIMATE_EXCEEDS_REMAINING_BUDGET", remainingExecutionBudget: snapshot.remainingExecutionBudget };
	}
	return {
		allowed: true,
		status: "COST_ALLOWED",
		reason: "ESTIMATE_WITHIN_REMAINING_BUDGET",
		remainingExecutionBudget: snapshot.remainingExecutionBudget - snapshot.estimatedCost,
	};
}