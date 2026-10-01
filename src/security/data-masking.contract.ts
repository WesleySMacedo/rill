export interface SanitizationResult {
	sanitized: true;
	input: Record<string, unknown>;
}

export type Sanitizer = (input: Record<string, unknown>) => SanitizationResult;
