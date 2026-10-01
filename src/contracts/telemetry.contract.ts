export type TelemetryStatus = "TELEMETRY_PENDING" | "TELEMETRY_SENT" | "TELEMETRY_FAILED" | "TELEMETRY_DISABLED" | "TELEMETRY_REJECTED";
export type ValidationResult = "NOT_RUN" | "PASSED" | "FAILED" | "BLOCKED" | "PENDING";
export type HumanApproval = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED" | "REQUESTED_CHANGES";

export interface LangfuseTelemetryEvent {
	executionId: string;
	action: string;
	domain: string;
	role: string;
	modelRequested: string | null;
	modelUsed: string | null;
	provider: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedInputTokens: number | null;
	reportedCost: number | null;
	latencyMs: number | null;
	attempt: number;
	validationResult: ValidationResult;
	humanApproval: HumanApproval | null;
	sanitizedErrorCode: string | null;
	status?: string;
	fallbackUsed?: boolean;
	costStatus?: string;
}

export interface TelemetryResult {
	status: TelemetryStatus;
	errorCode?: "TELEMETRY_DISABLED" | "TELEMETRY_TIMEOUT" | "TELEMETRY_HTTP_ERROR" | "TELEMETRY_INVALID";
}