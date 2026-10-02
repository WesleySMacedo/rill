export type ModelProfile = "LOW_COST" | "STANDARD" | "HIGH_CONFIDENCE";

export interface GatewayChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface GatewayReasoningOptions {
	enabled?: boolean;
	effort?: "low" | "medium" | "high";
	exclude?: boolean;
}

export interface SanitizedGatewayInput {
	executionId: string;
	action: string;
	domain: string;
	role: string;
	modelProfile: ModelProfile;
	sanitized: true;
	sanitization: { version: "1"; fields: string[] };
	input: Record<string, unknown>;
	inputTokenEstimate: number;
	outputTokenLimit: number;
	estimatedCost: number | null;
	maxEstimatedCost?: number;
	retryEstimatedCost?: number;
	fallbackEstimatedCost?: number;
	structuredOutput?: { name: string; schema: Record<string, unknown> };
	/** Pre-compiled chat messages (e.g. from a managed prompt). When absent, `input` is sent as a single user message. */
	messages?: GatewayChatMessage[];
	reasoning?: GatewayReasoningOptions;
}

export interface GatewayModelConfig {
	provider: string;
	endpoint: string;
	model: string;
	structuredOutput: boolean;
}

export interface GatewayProfileConfig {
	profile: ModelProfile;
	primary: GatewayModelConfig;
	fallback?: GatewayModelConfig;
	timeoutMs: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	maxEstimatedCost: number;
	maxRetries: number;
}

export interface GatewayProviderResponse {
	result: unknown;
	usedModel: string | null;
	usedProvider: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	reportedCost: number | null;
}

export interface GatewayResult extends GatewayProviderResponse {
	status: "COMPLETED";
	executionId: string;
	modelProfile: ModelProfile;
	requestedModel: string;
	requestedProvider: string;
	endpoint: string;
	attempt: number;
	fallbackUsed: boolean;
	structuredOutput: boolean;
	latencyMs: number;
	maxEstimatedCost: number;
	estimatedCost: number | null;
	remainingExecutionBudget: number | null;
	retryCost: number | null;
	retryEstimatedCost: number;
	totalReportedCost: number | null;
	costStatus: string;
}