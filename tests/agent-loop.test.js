import { describe, expect, it, vi } from "vitest";
import registry from "../engineering-registry.json";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createAgentLoopTelemetry, LangfuseAgentLoopTelemetry, NoopAgentLoopTelemetry } from "../src/runtime/agent-loop-telemetry.ts";
import { runAgentLoopValidationEntrypoint } from "../src/runtime/agent-loop-entrypoint.ts";
import { createModelCatalog } from "../src/gateway/models.ts";

const files = new Map([
	["public/index.html", { exists: true, size: 100 }],
	["docs/product-baseline/UI_ANALYSIS.md", { exists: true, size: 100 }],
	["docs/product-baseline/DOMAIN_KNOWLEDGE.md", { exists: true, size: 100 }],
	[".github/prompts/analyze-rill.prompt.md", { exists: true, size: 100 }],
	["tests/engineering-registry.test.js", { exists: true, size: 100 }],
	["tests/architect.worker.test.js", { exists: true, size: 100 }],
]);

describe("local Agent Loop", () => {
	it("executes Planner -> Context -> Prompt Engineer -> Builder -> Reviewer", async () => {
		const result = await runAgentLoop({
			action: "PATCH_UI",
			domain: "AuditQ",
			task: "Review public/index.html for a PATCH_UI proposal",
			registry,
			fileSystem: { getFileInfo: (path) => files.get(path) ?? { exists: false, size: 0 } },
		});

		expect(result.status).toBe("AGENT_LOOP_OPERATIONAL");
		expect(result.selectedAgent).toBe("Planner");
		expect(result.context.status).toBe("CONTEXT_READY");
		expect(result.promptEngineer.status).toBe("EXECUTED");
		expect(result.builder.status).toBe("DRY_RUN");
		expect(result.builder.filesChanged).toEqual([]);
		expect(result.reviewer.status).toBe("APPROVED_WITH_NOTES");
		expect(result.memoryProposal.status).toBe("PROPOSED");
		expect(result.langfuse.status).toBe("DISABLED");
		expect(result.llmCalls).toBe(0);
	});

	it("supports disabled telemetry without a network call", async () => {
		const telemetry = new NoopAgentLoopTelemetry();
		expect((await runAgentLoop({ action: "PATCH_UI", domain: "AuditQ", task: "Review public/index.html", registry, fileSystem: { getFileInfo: (path) => files.get(path) ?? { exists: false, size: 0 } }, telemetry })).status).toBe("AGENT_LOOP_OPERATIONAL");
	});

	it("wires Langfuse when all runtime environment fields are present", () => {
		const telemetry = createAgentLoopTelemetry({ LANGFUSE_PUBLIC_KEY: "public", LANGFUSE_SECRET_KEY: "secret", LANGFUSE_BASE_URL: "https://langfuse.example" });
		expect(telemetry).toBeInstanceOf(LangfuseAgentLoopTelemetry);
	});

	it("falls back to noop telemetry when runtime environment is incomplete", () => {
		const telemetry = createAgentLoopTelemetry({ LANGFUSE_BASE_URL: "https://langfuse.example" });
		expect(telemetry).toBeInstanceOf(NoopAgentLoopTelemetry);
	});

	it("flushes one trace with deterministic spans and memory proposal", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
		const telemetry = new LangfuseAgentLoopTelemetry({ endpoint: "https://mock/langfuse", fetcher });
		const result = await runAgentLoop({ action: "PATCH_UI", domain: "AuditQ", task: "Review public/index.html", registry, fileSystem: { getFileInfo: (path) => files.get(path) ?? { exists: false, size: 0 } }, telemetry, dryRun: true });
		expect(result.status).toBe("AGENT_LOOP_OPERATIONAL");
		expect(fetcher).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(fetcher.mock.calls[0][1].body);
		const spans = payload.resourceSpans[0].scopeSpans[0].spans;
		expect(spans.length).toBeGreaterThan(0);
		expect(spans.some(({ name }) => name === "resolve-context")).toBe(true);
		expect(spans.some(({ attributes }) => attributes.some(({ key }) => key === "langfuse.observation.type"))).toBe(true);
	});

	it("captures real generation usage and reported cost without exposing sensitive metadata", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		const telemetry = new LangfuseAgentLoopTelemetry({ endpoint: "https://mock/langfuse", fetcher });
		await telemetry.start({ traceId: "trace-test", sessionId: "session-test", executionId: "exec-test", action: "PATCH_UI", domain: "AuditQ", modelProfile: "LOW_COST" });
		await telemetry.generation("real-model-call", { model: "model-profile-member", provider: "provider", inputTokens: 12, outputTokens: 8, reportedCost: 0.02, latencyMs: 30, attempt: 1, fallbackUsed: false });
		await telemetry.span("context", { note: "password: hidden" });
		await telemetry.flush();
		const spans = JSON.parse(fetcher.mock.calls[0][1].body).resourceSpans[0].scopeSpans[0].spans;
		expect(spans.some(({ attributes }) => attributes.some(({ key, value }) => key === "langfuse.observation.metadata.reportedCost" && value.doubleValue === 0.02))).toBe(true);
		expect(spans.some(({ name, attributes }) => name === "context" && attributes.every(({ key }) => key !== "password"))).toBe(true);
	});

	it("keeps fallback without known cost and telemetry failure non-blocking", async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
		const telemetry = new LangfuseAgentLoopTelemetry({ endpoint: "https://mock/langfuse", fetcher });
		await telemetry.start({ traceId: "trace-test", sessionId: "session-test", executionId: "exec-test", action: "PATCH_UI", domain: "AuditQ", modelProfile: "LOW_COST" });
		await telemetry.generation("fallback-call", { model: "fallback", provider: "provider", inputTokens: 10, outputTokens: 4, reportedCost: null, latencyMs: 40, attempt: 2, fallbackUsed: true });
		await expect(telemetry.flush()).resolves.toBeUndefined();
	});

	it("refuses the validation entrypoint when disabled by default", async () => {
		const result = await runAgentLoopValidationEntrypoint({}, { registry, fileSystem: { getFileInfo: (path) => files.get(path) ?? { exists: false, size: 0 } } });
		expect(result.status).toBe("AGENT_LOOP_ENTRYPOINT_DISABLED");
		expect(result.telemetryProvider).toBe("noop");
	});

	it("executes the protected dry-run entrypoint with configured runtime env", async () => {
		const result = await runAgentLoopValidationEntrypoint({ AGENT_LOOP_RUNTIME_ENABLED: "true", LANGFUSE_PUBLIC_KEY: "public", LANGFUSE_SECRET_KEY: "secret", LANGFUSE_BASE_URL: "https://mock/langfuse", fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 202 })) }, { registry, fileSystem: { getFileInfo: (path) => files.get(path) ?? { exists: false, size: 0 } } });
		expect(result.status).toBe("AGENT_LOOP_ENTRYPOINT_RESULT");
		expect(result.telemetryProvider).toBe("langfuse");
		expect(result.filesChanged).toEqual([]);
		expect(result.llmCalls).toBe(0);
	});

	it("routes one sanitized model call without changing files", async () => {
		const providerFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "PATCH_PROPOSAL", targetFiles: ["public/index.html"], proposedChanges: [], acceptanceCriteria: [], risks: [], testsRecommended: [] }) } }], model: "effective-model", provider: "effective-provider", usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost: 0.02 } }), { status: 200, headers: { "content-type": "application/json" } }));
		const telemetryFetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
		const telemetry = new LangfuseAgentLoopTelemetry({ endpoint: "https://mock/langfuse", fetcher: telemetryFetcher });
		const result = await runAgentLoop({
			action: "PATCH_UI",
			domain: "AuditQ",
			task: "Review public/index.html for a PATCH_UI proposal",
			registry,
			fileSystem: { getFileInfo: (path) => files.get(path) ?? { exists: false, size: 0 } },
			modelCatalog: createModelCatalog({ OPENROUTER_LOW_COST_MODEL: "low-cost-model" }),
			openRouterApiKey: "test-key",
			openRouterFetcher: providerFetcher,
			telemetry,
			estimatedCost: 0.1,
		});

		expect(result.llmCalls).toBe(1);
		expect(result.modelUsed).toBe("effective-model");
		expect(result.builder.filesChanged).toEqual([]);
		expect(providerFetcher).toHaveBeenCalledTimes(1);
		expect(telemetryFetcher).toHaveBeenCalledTimes(1);
		const spans = JSON.parse(telemetryFetcher.mock.calls[0][1].body).resourceSpans[0].scopeSpans[0].spans;
		const generation = spans.find(({ attributes }) => attributes.some(({ key, value }) => key === "langfuse.observation.type" && value.stringValue === "generation"));
		expect(generation).toBeDefined();
		expect(generation.attributes.some(({ key, value }) => key === "langfuse.observation.metadata.catalogVersion" && value.stringValue === "model-catalog-v1")).toBe(true);
		expect(generation.attributes.some(({ key, value }) => key === "langfuse.observation.metadata.totalCostKnown" && value.boolValue === true)).toBe(true);
		expect(generation.attributes.some(({ key, value }) => key === "langfuse.observation.metadata.reviewerOutcome" && value.stringValue === "APPROVED_WITH_NOTES")).toBe(true);
	});
});
