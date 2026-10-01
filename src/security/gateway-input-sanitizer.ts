import type { ModelProfile, SanitizedGatewayInput } from "../contracts/gateway.contract";

const forbiddenPatterns = [
	/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,
	/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/,
	/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/,
	/\bBearer\s+[A-Za-z0-9._-]+\b/i,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
	/(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]/i,
];

function assertSafe(value: unknown): void {
	if (typeof value === "string" && forbiddenPatterns.some((pattern) => pattern.test(value))) throw new Error("SECURITY_REJECTION");
	if (Array.isArray(value)) {
		for (const item of value) assertSafe(item);
		return;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) assertSafe(item);
	}
}

export interface GatewayInputRequest {
	executionId: string;
	action: string;
	domain: string;
	role: string;
	modelProfile: ModelProfile;
	input: Record<string, unknown>;
	inputTokenEstimate: number;
	outputTokenLimit: number;
	estimatedCost: number | null;
	maxEstimatedCost?: number;
	structuredOutput?: { name: string; schema: Record<string, unknown> };
}

export function sanitizeGatewayInput(input: GatewayInputRequest): SanitizedGatewayInput {
	assertSafe(input.input);
	return {
		...input,
		sanitized: true,
		sanitization: { version: "1", fields: Object.keys(input.input) },
	};
}