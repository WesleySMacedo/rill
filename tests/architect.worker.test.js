import { describe, expect, it } from "vitest";
import { runArchitect } from "../src/workers/architect.worker.ts";

describe("Architect worker", () => {
	it("produces a read-only plan for an allowed action", () => {
		const result = runArchitect({
			action: "PLAN_CHANGE",
			domain: "AuditQ",
			task: "Avaliar uma alteração de interface",
			allowedPaths: ["public/"],
		});

		expect(result.decision).toBe("ALLOWED");
		expect(result.plan).toHaveLength(3);
		expect(result.plan.at(-1)).toContain("sem modificar");
	});

	it("blocks an unsupported action", () => {
		const result = runArchitect({
			action: "EXECUTE_PRODUCTION",
			domain: "AuditQ",
			task: "Alterar a interface",
			allowedPaths: ["public/"],
		});

		expect(result.decision).toBe("BLOCKED_BY_POLICY");
		expect(result.plan).toEqual([]);
	});
});
