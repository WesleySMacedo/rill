import { describe, expect, it } from "vitest";
import { evaluateExecutionBudget } from "../src/policies/budget.policy.ts";

const base = { executionId: "execution-1", maxEstimatedCost: 1, estimatedCost: 0.25, reportedCost: null, remainingExecutionBudget: 1, attempt: 1, retryCost: 0, status: "COST_ALLOWED" };

describe("execution cost policy", () => {
	it("requires an estimate", () => expect(evaluateExecutionBudget({ ...base, estimatedCost: null }).status).toBe("ESTIMATE_REQUIRED"));
	it("blocks an estimate above the remaining budget", () => expect(evaluateExecutionBudget({ ...base, estimatedCost: 1.1 }).status).toBe("COST_LIMIT_REACHED"));
	it("allows an incremental retry when budget remains", () => expect(evaluateExecutionBudget({ ...base, attempt: 2, remainingExecutionBudget: 0.5, estimatedCost: 0.25 }).allowed).toBe(true));
	it("does not treat unknown budget as zero", () => expect(evaluateExecutionBudget({ ...base, remainingExecutionBudget: null }).status).toBe("COST_UNKNOWN"));
	it("rejects an invalid snapshot", () => expect(evaluateExecutionBudget({ ...base, executionId: "", attempt: 0 }).reason).toBe("COST_SNAPSHOT_INVALID"));
});
