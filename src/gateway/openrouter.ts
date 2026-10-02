import { GatewayError, type GatewayErrorCode } from "./errors";
import type { GatewayModelConfig, GatewayProviderResponse, SanitizedGatewayInput } from "../contracts/gateway.contract";

export interface OpenRouterClientOptions {
	fetcher?: typeof fetch;
	apiKey?: string;
}

const errorCodeByStatus: Record<number, { code: GatewayErrorCode; retryable: boolean }> = {
	400: { code: "OPENROUTER_BAD_REQUEST", retryable: false },
	401: { code: "OPENROUTER_AUTH_FAILURE", retryable: false },
	402: { code: "OPENROUTER_CREDITS_FAILURE", retryable: false },
	403: { code: "OPENROUTER_FORBIDDEN", retryable: false },
	408: { code: "OPENROUTER_TIMEOUT", retryable: true },
	429: { code: "OPENROUTER_RATE_LIMIT", retryable: true },
	502: { code: "OPENROUTER_PROVIDER_ERROR", retryable: true },
	503: { code: "OPENROUTER_PROVIDER_UNAVAILABLE", retryable: true },
};

function safeErrorMetadata(error: unknown): Record<string, string | number | boolean> {
	if (!error || typeof error !== "object") return {};
	const source = error as Record<string, unknown>;
	return Object.fromEntries(Object.entries(source).filter(([key, value]) => key !== "message" && key !== "metadata" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")).slice(0, 8)) as Record<string, string | number | boolean>;
}

function structuredValue(value: unknown, schema: Record<string, any>): unknown {
	if (typeof value === "string") {
		try { value = JSON.parse(value); } catch { throw new GatewayError("PATCH_PROPOSAL_PARSE_FAILURE", "Structured output is not valid JSON"); }
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError("PATCH_PROPOSAL_SCHEMA_FAILURE", "Structured output schema mismatch");
	const object = value as Record<string, unknown>;
	const required = Array.isArray(schema.required) ? schema.required : [];
	if (required.some((key: unknown) => typeof key !== "string" || !(key in object))) throw new GatewayError("PATCH_PROPOSAL_SCHEMA_FAILURE", "Structured output schema mismatch");
	if (schema.additionalProperties === false && Object.keys(object).some((key) => !schema.properties?.[key])) throw new GatewayError("PATCH_PROPOSAL_SCHEMA_FAILURE", "Structured output schema mismatch");
	return object;
}

export async function callOpenRouter(
	config: GatewayModelConfig,
	input: SanitizedGatewayInput,
	timeoutMs: number,
	options: OpenRouterClientOptions = {},
): Promise<GatewayProviderResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await (options.fetcher ?? fetch)(config.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: config.model,
				messages: input.messages?.length ? input.messages.map(({ role, content }) => ({ role, content })) : [{ role: "user", content: JSON.stringify(input.input) }],
				max_tokens: input.outputTokenLimit,
				...(input.reasoning ? { reasoning: input.reasoning } : {}),
				...(input.structuredOutput ? { provider: { require_parameters: true } } : {}),
				...(input.structuredOutput && config.structuredOutput ? {
					response_format: {
						type: "json_schema",
						json_schema: { name: input.structuredOutput.name, strict: true, schema: input.structuredOutput.schema },
					},
				} : {}),
			}),
			signal: controller.signal,
		});
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		let payload: Record<string, any> = {};
		if (contentType.includes("json")) {
			try { payload = await response.json() as Record<string, any>; } catch { throw new GatewayError("PROVIDER_RESPONSE_INVALID", "OpenRouter JSON response invalid", false, { httpStatus: response.status, category: "OPENROUTER_RESPONSE_INVALID" }); }
		} else {
			await response.text();
		}
		if (payload.error) {
			const mapped = errorCodeByStatus[response.status] ?? { code: "PROVIDER_RESPONSE_INVALID" as GatewayErrorCode, retryable: response.status >= 500 };
			throw new GatewayError(mapped.code, "OpenRouter request failed", mapped.retryable, { httpStatus: response.status, category: "OPENROUTER_ERROR", metadata: safeErrorMetadata(payload.error) });
		}
		if (!response.ok) {
			const mapped = errorCodeByStatus[response.status] ?? { code: "PROVIDER_RESPONSE_INVALID" as GatewayErrorCode, retryable: response.status >= 500 };
			throw new GatewayError(mapped.code, "OpenRouter request failed", mapped.retryable, { httpStatus: response.status, category: "OPENROUTER_ERROR" });
		}
		const content = payload.choices?.[0]?.message?.content;
		if (payload.choices && (content === undefined || content === null || content === "")) throw new GatewayError("OPENROUTER_EMPTY_RESPONSE", "OpenRouter returned empty content", false, { httpStatus: response.status, category: "OPENROUTER_EMPTY_RESPONSE" });
		if (content === undefined || content === null) throw new GatewayError("OPENROUTER_EMPTY_RESPONSE", "OpenRouter response missing choices", false, { httpStatus: response.status, category: "OPENROUTER_EMPTY_RESPONSE" });
		const result = input.structuredOutput ? structuredValue(content, input.structuredOutput.schema) : content;
		return {
			result,
			usedModel: payload.model ?? config.model,
			usedProvider: payload.provider ?? config.provider,
			inputTokens: payload.usage?.prompt_tokens ?? payload.usage?.input_tokens ?? null,
			outputTokens: payload.usage?.completion_tokens ?? payload.usage?.output_tokens ?? null,
			totalTokens: payload.usage?.total_tokens ?? null,
			reportedCost: payload.usage?.cost ?? payload.cost ?? null,
		};
	} catch (error) {
		if (error instanceof GatewayError) throw error;
		if (error instanceof DOMException && error.name === "AbortError") throw new GatewayError("TIMEOUT", "Provider timeout", true);
		throw new GatewayError("PROVIDER_UNAVAILABLE", "Provider request failed", true);
	} finally {
		clearTimeout(timeout);
	}
}
