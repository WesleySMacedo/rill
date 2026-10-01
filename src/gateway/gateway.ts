import type { GatewayResult, GatewayProfileConfig, ModelProfile, SanitizedGatewayInput } from "../contracts/gateway.contract";
import { GatewayError } from "./errors";
import { callOpenRouter, type OpenRouterClientOptions } from "./openrouter";
import type { ModelCatalog } from "./models";
import { evaluateExecutionBudget } from "../policies/budget.policy";
import type { ExecutionCostSnapshot } from "../contracts/execution-cost.contract";
import { validateModelCatalog } from "./models";
import { sendLangfuseTelemetry, type LangfuseOptions } from "../telemetry/langfuse";
import type { LangfuseTelemetryEvent } from "../contracts/telemetry.contract";

export interface GatewayExecutionOptions extends OpenRouterClientOptions {
	telemetry?: LangfuseOptions;
}

async function recordTelemetry(input: SanitizedGatewayInput, result: GatewayResult, options: GatewayExecutionOptions): Promise<void> {
	if (!options.telemetry) return;
	const event: LangfuseTelemetryEvent = {
		executionId: result.executionId,
		action: input.action,
		domain: input.domain,
		role: input.role,
		modelRequested: result.requestedModel,
		modelUsed: result.usedModel,
		provider: result.usedProvider ?? result.requestedProvider,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		cachedInputTokens: null,
		reportedCost: result.reportedCost,
		latencyMs: result.latencyMs,
		attempt: result.attempt,
		validationResult: "NOT_RUN",
		humanApproval: null,
		sanitizedErrorCode: null,
		status: result.status,
		fallbackUsed: result.fallbackUsed,
		costStatus: result.costStatus,
	};
	await sendLangfuseTelemetry(event, options.telemetry).catch(() => undefined);
}

export async function executeGateway(
	input: SanitizedGatewayInput,
	catalog: ModelCatalog,
	options: GatewayExecutionOptions = {},
): Promise<GatewayResult> {
	if (!input.executionId || !input.action || !input.domain || !input.role || !input.sanitized || input.sanitization?.version !== "1") throw new GatewayError("SANITIZATION_REQUIRED", "A validated sanitized input is required");
	if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) throw new GatewayError("GATEWAY_INPUT_INVALID", "Gateway input must be an object");
	const config = catalog[input.modelProfile as ModelProfile] as GatewayProfileConfig | undefined;
	if (!config) throw new GatewayError("PROFILE_UNKNOWN", "Unknown model profile");
	validateModelCatalog(catalog, input.modelProfile);
	if (input.estimatedCost === null || !Number.isFinite(input.estimatedCost) || input.estimatedCost < 0) throw new GatewayError("ESTIMATE_REQUIRED", "A finite non-negative estimate is required");
	const maxEstimatedCost = Math.min(input.maxEstimatedCost ?? config.maxEstimatedCost, config.maxEstimatedCost);
	let remainingExecutionBudget: number | null = maxEstimatedCost;
	let retryCost = 0;
	let retryEstimatedCost = 0;
	let totalReportedCost = 0;
	let costUnknown = false;
	if (input.inputTokenEstimate > config.maxInputTokens) throw new GatewayError("INPUT_TOKEN_LIMIT_EXCEEDED", "Input token limit exceeded");
	if (input.outputTokenLimit > config.maxOutputTokens) throw new GatewayError("OUTPUT_TOKEN_LIMIT_EXCEEDED", "Output token limit exceeded");
	if (input.estimatedCost > config.maxEstimatedCost) throw new GatewayError("ESTIMATED_COST_LIMIT_EXCEEDED", "Estimated cost limit exceeded");
	if (input.structuredOutput && !config.primary.structuredOutput) throw new GatewayError("STRUCTURED_OUTPUT_UNSUPPORTED", "Structured output is not configured");

	let model = config.primary;
	let fallbackUsed = false;
	let attempt = 0;
	let lastError: GatewayError | undefined;
	const startedAt = Date.now();
	while (attempt <= config.maxRetries) {
		const estimatedCost = attempt === 0 ? input.estimatedCost : (input.retryEstimatedCost ?? input.estimatedCost);
		const snapshot: ExecutionCostSnapshot = {
			executionId: input.executionId,
			maxEstimatedCost,
			estimatedCost,
			reportedCost: null,
			remainingExecutionBudget,
			attempt: attempt + 1,
			retryCost: attempt > 0 ? retryCost : 0,
			status: "COST_ALLOWED",
		};
		const decision = evaluateExecutionBudget(snapshot);
		if (!decision.allowed) throw new GatewayError("EXECUTION_COST_LIMIT_REACHED", decision.reason);
		remainingExecutionBudget = decision.remainingExecutionBudget;
		if (attempt > 0) retryCost += estimatedCost ?? 0;
		if (attempt > 0) retryEstimatedCost += estimatedCost ?? 0;
		try {
			const response = await callOpenRouter(model, input, config.timeoutMs, options);
			if (attempt > 0) costUnknown = true;
			if (response.reportedCost === null) costUnknown = true;
			if (response.reportedCost !== null) totalReportedCost += response.reportedCost;
			const result: GatewayResult = {
				status: "COMPLETED",
				executionId: input.executionId,
				modelProfile: input.modelProfile,
				requestedModel: config.primary.model,
				requestedProvider: config.primary.provider,
				endpoint: model.endpoint,
				attempt: attempt + 1,
				fallbackUsed,
				structuredOutput: Boolean(input.structuredOutput),
				latencyMs: Date.now() - startedAt,
				maxEstimatedCost,
				estimatedCost,
				remainingExecutionBudget: costUnknown ? null : Math.max(0, maxEstimatedCost - totalReportedCost),
				retryCost: attempt > 0 && costUnknown ? null : (attempt > 0 ? retryCost : 0),
				retryEstimatedCost,
				totalReportedCost: costUnknown ? null : totalReportedCost,
				costStatus: response.reportedCost === null ? "COST_UNKNOWN" : "COST_REPORTED",
				...response,
			};
			await recordTelemetry(input, result, options);
			return result;
		} catch (error) {
			lastError = error instanceof GatewayError ? error : new GatewayError("PROVIDER_RESPONSE_INVALID", "Unknown gateway error");
			if (!lastError.retryable) break;
			attempt += 1;
		}
	}
	if (config.fallback && lastError?.retryable) {
		model = config.fallback;
		fallbackUsed = true;
		const fallbackEstimatedCost = input.fallbackEstimatedCost ?? input.estimatedCost;
		const fallbackDecision = evaluateExecutionBudget({
			executionId: input.executionId,
			maxEstimatedCost,
			estimatedCost: fallbackEstimatedCost,
			reportedCost: null,
			remainingExecutionBudget,
			attempt: attempt + 1,
			retryCost,
			status: "COST_ALLOWED",
		});
		if (!fallbackDecision.allowed) throw new GatewayError("FALLBACK_BUDGET_EXCEEDED", fallbackDecision.reason);
		remainingExecutionBudget = fallbackDecision.remainingExecutionBudget;
		retryCost += fallbackEstimatedCost ?? 0;
		retryEstimatedCost += fallbackEstimatedCost ?? 0;
		const response = await callOpenRouter(model, input, config.timeoutMs, options);
		costUnknown = true;
		if (response.reportedCost !== null) totalReportedCost += response.reportedCost;
		const result: GatewayResult = {
			status: "COMPLETED",
			executionId: input.executionId,
			modelProfile: input.modelProfile,
			requestedModel: config.primary.model,
			requestedProvider: config.primary.provider,
			endpoint: model.endpoint,
			attempt: attempt + 1,
			fallbackUsed,
			structuredOutput: Boolean(input.structuredOutput),
			latencyMs: Date.now() - startedAt,
			maxEstimatedCost,
			estimatedCost: fallbackEstimatedCost,
			remainingExecutionBudget: null,
			retryCost: null,
			retryEstimatedCost,
			totalReportedCost: null,
			costStatus: response.reportedCost === null ? "COST_UNKNOWN" : "COST_REPORTED",
			...response,
		};
		await recordTelemetry(input, result, options);
		return result;
	}
	throw lastError ?? new GatewayError("RETRY_EXHAUSTED", "Gateway retry exhausted");
}
