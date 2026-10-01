import { describe, expect, it } from "vitest";
import registry from "../engineering-registry.json";
import { createRillRequest, startRillRequest } from "../src/runtime/rill-request-entrypoint.ts";

const files = new Map([
	["public/index.html", { exists: true, size: 100 }],
	["docs/product-baseline/UI_ANALYSIS.md", { exists: true, size: 100 }],
	["docs/product-baseline/DOMAIN_KNOWLEDGE.md", { exists: true, size: 100 }],
	[".github/prompts/analyze-rill.prompt.md", { exists: true, size: 100 }],
	["tests/engineering-registry.test.js", { exists: true, size: 100 }],
	["tests/architect.worker.test.js", { exists: true, size: 100 }],
]);

const dependencies = { registry, fileSystem: { getFileInfo: (path) => files.get(path) ?? { exists: false, size: 0 } } };

describe("Rill operational request entrypoint", () => {
	it("starts an authorized AuditQ planning request with explicit context", () => {
		const result = createRillRequest({ task: "Analise a UI do Audit Q em public/index.html", sourceClient: "cline" }, dependencies);
		expect(result.status).toBe("READY");
		expect(result.action).toBe("PLAN_CHANGE");
		expect(result.domain).toBe("AuditQ");
		expect(result.specialist).toBe("Planner");
	});

	it("starts the authorized request as a read-only Agent Loop mission", async () => {
		const result = await startRillRequest({ task: "Analise a UI do Audit Q em public/index.html", sourceClient: "cline" }, dependencies);
		expect(result.status).toBe("READY");
		expect(result.workflowState).toBe("AWAITING_HUMAN_APPROVAL");
		expect(result.traceId).toMatch(/^trace-/);
	});

	it("fails closed when AuditQ context is not explicitly targeted", () => {
		const result = createRillRequest({ task: "Analise a UI do Audit Q", sourceClient: "continue" }, dependencies);
		expect(result.status).toBe("CONTEXT_EXPANSION_REQUIRED");
	});

	it("blocks an unregistered request without guessing", () => {
		const result = createRillRequest({ task: "Crie um componente React para a tela de login", sourceClient: "copilot" }, dependencies);
		expect(result.status).toBe("BLOCKED");
		expect(result.reason).toBe("UNKNOWN_DOMAIN");
	});

	it("blocks unrecognized client sources", () => {
		const result = createRillRequest({ task: "Analise a UI do Audit Q em public/index.html", sourceClient: "unknown" }, dependencies);
		expect(result.status).toBe("BLOCKED");
		expect(result.reason).toBe("INVALID_REQUEST");
	});
});
