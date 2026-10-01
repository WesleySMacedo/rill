export type GatewayErrorCode =
	| "GATEWAY_INPUT_INVALID"
	| "SANITIZATION_REQUIRED"
	| "PROFILE_UNKNOWN"
	| "MODEL_NOT_CONFIGURED"
	| "INPUT_TOKEN_LIMIT_EXCEEDED"
	| "OUTPUT_TOKEN_LIMIT_EXCEEDED"
	| "ESTIMATED_COST_LIMIT_EXCEEDED"
	| "TIMEOUT"
	| "RATE_LIMITED"
	| "PROVIDER_UNAVAILABLE"
	| "PROVIDER_RESPONSE_INVALID"
	| "STRUCTURED_OUTPUT_UNSUPPORTED"
	| "RETRY_EXHAUSTED"
	| "FALLBACK_NOT_ALLOWED"
	| "ESTIMATE_REQUIRED"
	| "EXECUTION_COST_LIMIT_REACHED"
	| "RETRY_ESTIMATE_REQUIRED"
	| "FALLBACK_BUDGET_EXCEEDED"
	| "COST_UNKNOWN"
	| "POLICY_BUDGET_BLOCKED"
	| "COST_SNAPSHOT_INVALID"
	| "SECURITY_REJECTION"
	| "OPENROUTER_BAD_REQUEST"
	| "OPENROUTER_AUTH_FAILURE"
	| "OPENROUTER_CREDITS_FAILURE"
	| "OPENROUTER_FORBIDDEN"
	| "OPENROUTER_TIMEOUT"
	| "OPENROUTER_RATE_LIMIT"
	| "OPENROUTER_PROVIDER_ERROR"
	| "OPENROUTER_PROVIDER_UNAVAILABLE"
	| "OPENROUTER_EMPTY_RESPONSE"
	| "PATCH_PROPOSAL_PARSE_FAILURE"
	| "PATCH_PROPOSAL_SCHEMA_FAILURE";

export type GatewayErrorCategory = "OPENROUTER_ERROR" | "OPENROUTER_RESPONSE_INVALID" | "OPENROUTER_EMPTY_RESPONSE" | "PATCH_PROPOSAL_PARSE_FAILURE" | "PATCH_PROPOSAL_SCHEMA_FAILURE";

export class GatewayError extends Error {
	readonly code: GatewayErrorCode;
	readonly retryable: boolean;
	readonly httpStatus: number | null;
	readonly category: GatewayErrorCategory | null;
	readonly metadata: Record<string, string | number | boolean>;

	constructor(code: GatewayErrorCode, message: string, retryable = false, options: { httpStatus?: number; category?: GatewayErrorCategory; metadata?: Record<string, string | number | boolean> } = {}) {
		super(message);
		this.name = "GatewayError";
		this.code = code;
		this.retryable = retryable;
		this.httpStatus = options.httpStatus ?? null;
		this.category = options.category ?? null;
		this.metadata = options.metadata ?? {};
	}
}