import type { HumanApproval, LangfuseTelemetryEvent, ValidationResult } from "../contracts/telemetry.contract";

const validationResults = new Set<ValidationResult>(["NOT_RUN", "PASSED", "FAILED", "BLOCKED", "PENDING"]);
const approvals = new Set<HumanApproval>(["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED", "REQUESTED_CHANGES"]);
const errorCodes = new Set(["TIMEOUT", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_INVALID", "STRUCTURED_OUTPUT_INVALID", "SECURITY_REJECTION", "POLICY_BLOCKED", "COST_LIMIT_REACHED", "UNKNOWN_ERROR"]);
const forbiddenPatterns = [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/, /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/, /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/, /\bBearer\s+[A-Za-z0-9._-]+\b/i, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]/i];

function optionalString(value: unknown, field: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length > 200) throw new Error(`TELEMETRY_INVALID:${field}`);
	if (forbiddenPatterns.some((pattern) => pattern.test(value))) throw new Error(`TELEMETRY_INVALID:${field}`);
	return value;
}

function nullableNumber(value: unknown, field: string): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`TELEMETRY_INVALID:${field}`);
	return value;
}

export function sanitizeTelemetryEvent(input: LangfuseTelemetryEvent): LangfuseTelemetryEvent {
	if (!input || typeof input !== "object") throw new Error("TELEMETRY_INVALID:event");
	const executionId = optionalString(input.executionId, "executionId");
	const action = optionalString(input.action, "action");
	const domain = optionalString(input.domain, "domain");
	const role = optionalString(input.role, "role");
	if (!executionId || !action || !domain || !role) throw new Error("TELEMETRY_INVALID:required");
	if (!validationResults.has(input.validationResult) || (input.humanApproval !== null && !approvals.has(input.humanApproval))) throw new Error("TELEMETRY_INVALID:status");
	if (input.sanitizedErrorCode !== null && !errorCodes.has(input.sanitizedErrorCode)) throw new Error("TELEMETRY_INVALID:errorCode");
	if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new Error("TELEMETRY_INVALID:attempt");
	return {
		executionId,
		action,
		domain,
		role,
		modelRequested: optionalString(input.modelRequested, "modelRequested"),
		modelUsed: optionalString(input.modelUsed, "modelUsed"),
		provider: optionalString(input.provider, "provider"),
		inputTokens: nullableNumber(input.inputTokens, "inputTokens"),
		outputTokens: nullableNumber(input.outputTokens, "outputTokens"),
		cachedInputTokens: nullableNumber(input.cachedInputTokens, "cachedInputTokens"),
		reportedCost: nullableNumber(input.reportedCost, "reportedCost"),
		latencyMs: nullableNumber(input.latencyMs, "latencyMs"),
		attempt: input.attempt,
		validationResult: input.validationResult,
		humanApproval: input.humanApproval ?? null,
		sanitizedErrorCode: input.sanitizedErrorCode,
		...(input.status ? { status: optionalString(input.status, "status") ?? undefined } : {}),
		...(input.fallbackUsed !== undefined ? { fallbackUsed: Boolean(input.fallbackUsed) } : {}),
		...(input.costStatus ? { costStatus: optionalString(input.costStatus, "costStatus") ?? undefined } : {}),
	};
}