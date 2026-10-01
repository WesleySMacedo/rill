import { describe, expect, it, vi } from "vitest";
import { executeGateway } from "../src/gateway/gateway.ts";
import { sanitizeGatewayInput } from "../src/security/gateway-input-sanitizer.ts";


const catalog = {
	catalogVersion: "model-catalog-pilot-v1",
	status: "PILOT",
	LOW_COST: { profile: "LOW_COST", primary: { provider: "mock", endpoint: "https://mock/primary", model: "low-cost-model", structuredOutput: true }, fallback: { provider: "mock", endpoint: "https://mock/fallback", model: "low-cost-fallback", structuredOutput: true }, timeoutMs: 100, maxInputTokens: 1000, maxOutputTokens: 200, maxEstimatedCost: 1, maxRetries: 1 },
	HIGH_CONFIDENCE: { profile: "HIGH_CONFIDENCE", primary: { provider: "mock", endpoint: "https://mock/high", model: "high-confidence-model", structuredOutput: true }, timeoutMs: 100, maxInputTokens: 1000, maxOutputTokens: 200, maxEstimatedCost: 2, maxRetries: 0 },
};
const input = sanitizeGatewayInput({ executionId: "exec-1", action: "PATCH_UI", domain: "AuditQ", role: "Architect", modelProfile: "LOW_COST", input: { task: "safe" }, inputTokenEstimate: 10, outputTokenLimit: 20, estimatedCost: 0.1 });
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const chatResponse = (content, extra = {}, status = 200) => response({ ...extra, choices: [{ message: { content } }] }, status);

describe("OpenRouter gateway", () => {
	it("captures effective model, provider, usage and cost", async () => {
		const fetcher = vi.fn().mockResolvedValue(chatResponse("ok", { model: "effective-model", provider: "effective-provider", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.2 } }));
		const result = await executeGateway(input, catalog, { fetcher });
		expect(result.usedModel).toBe("effective-model");
		expect(result.usedProvider).toBe("effective-provider");
		expect(result.inputTokens).toBe(10);
		expect(result.totalTokens).toBe(15);
		expect(result.reportedCost).toBe(0.2);
		expect(result.totalReportedCost).toBe(0.2);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("retries transient failures and uses one fallback", async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(response({ error: { code: "provider_down" } }, 503)).mockResolvedValueOnce(response({ error: { code: "provider_down" } }, 503)).mockResolvedValueOnce(chatResponse("fallback"));
		const result = await executeGateway(input, catalog, { fetcher });
		expect(result.fallbackUsed).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(3);
		expect(result.totalReportedCost).toBeNull();
		expect(result.retryEstimatedCost).toBeGreaterThan(0);
	});

	it("rejects input that exceeds configured limits", async () => {
		await expect(executeGateway({ ...input, inputTokenEstimate: 1001 }, catalog)).rejects.toMatchObject({ code: "INPUT_TOKEN_LIMIT_EXCEEDED" });
	});

	it("rejects structured output when the profile does not support it", async () => {
		const restrictedCatalog = { ...catalog, LOW_COST: { ...catalog.LOW_COST, primary: { ...catalog.LOW_COST.primary, structuredOutput: false } } };
		await expect(executeGateway({ ...input, structuredOutput: { name: "result", schema: {} } }, restrictedCatalog)).rejects.toMatchObject({ code: "STRUCTURED_OUTPUT_UNSUPPORTED" });
	});

	it("requires a sanitizer proof", async () => {
		await expect(executeGateway({ ...input, sanitization: undefined }, catalog)).rejects.toMatchObject({ code: "SANITIZATION_REQUIRED" });
	});

	it("sends structured output and rejects empty provider responses", async () => {
		const fetcher = vi.fn().mockResolvedValue(chatResponse(JSON.stringify({ ok: true })));
		await executeGateway({ ...input, structuredOutput: { name: "result", schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] } } }, catalog, { fetcher });
		const request = JSON.parse(fetcher.mock.calls[0][1].body);
		expect(request.response_format.type).toBe("json_schema");
		expect(request.response_format.json_schema.strict).toBe(true);
		expect(request.provider.require_parameters).toBe(true);
		await expect(executeGateway(input, catalog, { fetcher: vi.fn().mockResolvedValue(response({})) })).rejects.toMatchObject({ code: "OPENROUTER_EMPTY_RESPONSE" });
	});

	it("reports sanitized telemetry without making it a gateway dependency", async () => {
		const fetcher = vi.fn().mockResolvedValue(chatResponse("ok"));
		const telemetryFetcher = vi.fn().mockRejectedValue(new Error("telemetry offline"));
		const result = await executeGateway(input, catalog, { fetcher, telemetry: { endpoint: "https://mock/langfuse", fetcher: telemetryFetcher } });
		expect(result.status).toBe("COMPLETED");
		expect(telemetryFetcher).toHaveBeenCalledTimes(1);
	});

	it.each([[400, "OPENROUTER_BAD_REQUEST"], [401, "OPENROUTER_AUTH_FAILURE"], [402, "OPENROUTER_CREDITS_FAILURE"], [403, "OPENROUTER_FORBIDDEN"], [408, "OPENROUTER_TIMEOUT"], [429, "OPENROUTER_RATE_LIMIT"], [502, "OPENROUTER_PROVIDER_ERROR"], [503, "OPENROUTER_PROVIDER_UNAVAILABLE"]])("maps OpenRouter HTTP %s errors", async (status, code) => {
		const singleAttemptCatalog = { ...catalog, LOW_COST: { ...catalog.LOW_COST, fallback: undefined, maxRetries: 0 } };
		await expect(executeGateway(input, singleAttemptCatalog, { fetcher: vi.fn().mockResolvedValue(response({ error: { code: "sanitized" } }, status)) })).rejects.toMatchObject({ code, httpStatus: status });
	});

	it("rejects choices without content", async () => {
		const singleAttemptCatalog = { ...catalog, LOW_COST: { ...catalog.LOW_COST, fallback: undefined, maxRetries: 0 } };
		await expect(executeGateway(input, singleAttemptCatalog, { fetcher: vi.fn().mockResolvedValue(response({ choices: [{ message: {} }] })) })).rejects.toMatchObject({ code: "OPENROUTER_EMPTY_RESPONSE" });
	});

	it("rejects invalid structured content and schema", async () => {
		const structuredInput = { ...input, structuredOutput: { name: "patch_proposal", schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } } } };
		await expect(executeGateway(structuredInput, catalog, { fetcher: vi.fn().mockResolvedValue(chatResponse("not-json")) })).rejects.toMatchObject({ code: "PATCH_PROPOSAL_PARSE_FAILURE" });
		await expect(executeGateway(structuredInput, catalog, { fetcher: vi.fn().mockResolvedValue(chatResponse(JSON.stringify({ extra: true }))) })).rejects.toMatchObject({ code: "PATCH_PROPOSAL_SCHEMA_FAILURE" });
	});
});
