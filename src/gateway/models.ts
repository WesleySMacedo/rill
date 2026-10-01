import type { GatewayProfileConfig, ModelProfile } from "../contracts/gateway.contract";

export type ModelPurpose = "STRATEGIST" | "DESIGNER" | "REVIEWER" | "REPORT";

export interface ModelCatalog {
	catalogVersion: string;
	status: "PILOT" | "PRODUCTION";
	LOW_COST?: GatewayProfileConfig & { purpose: ModelPurpose[] };
	STANDARD?: GatewayProfileConfig & { purpose: ModelPurpose[] };
	HIGH_CONFIDENCE?: GatewayProfileConfig & { purpose: ModelPurpose[] };
}

export interface ModelCatalogRuntimeEnv {
	OPENROUTER_BASE_URL?: string;
	OPENROUTER_LOW_COST_MODEL?: string;
	OPENROUTER_STANDARD_MODEL?: string;
	OPENROUTER_HIGH_CONFIDENCE_MODEL?: string;
}

function required(value: string | undefined, name: string): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`MODEL_NOT_CONFIGURED:${name}`);
	return normalized;
}

function profile(model: string, profileName: ModelProfile, purpose: ModelPurpose[], endpoint: string, limits: Pick<GatewayProfileConfig, "timeoutMs" | "maxInputTokens" | "maxOutputTokens" | "maxEstimatedCost" | "maxRetries">): GatewayProfileConfig & { purpose: ModelPurpose[] } {
	return { profile: profileName, purpose, primary: { provider: "openrouter", endpoint, model, structuredOutput: true }, ...limits };
}

export function createModelCatalog(env: ModelCatalogRuntimeEnv): ModelCatalog {
	const baseUrl = (env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/$/, "");
	const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
	return {
		catalogVersion: "model-catalog-v1",
		status: "PRODUCTION",
		LOW_COST: profile(required(env.OPENROUTER_LOW_COST_MODEL, "OPENROUTER_LOW_COST_MODEL"), "LOW_COST", ["STRATEGIST", "REPORT"], endpoint, { timeoutMs: 15000, maxInputTokens: 4000, maxOutputTokens: 1024, maxEstimatedCost: 1, maxRetries: 1 }),
		STANDARD: profile(required(env.OPENROUTER_STANDARD_MODEL ?? env.OPENROUTER_LOW_COST_MODEL, "OPENROUTER_STANDARD_MODEL"), "STANDARD", ["DESIGNER"], endpoint, { timeoutMs: 30000, maxInputTokens: 8000, maxOutputTokens: 2048, maxEstimatedCost: 3, maxRetries: 1 }),
		HIGH_CONFIDENCE: profile(required(env.OPENROUTER_HIGH_CONFIDENCE_MODEL ?? env.OPENROUTER_STANDARD_MODEL ?? env.OPENROUTER_LOW_COST_MODEL, "OPENROUTER_HIGH_CONFIDENCE_MODEL"), "HIGH_CONFIDENCE", ["REVIEWER"], endpoint, { timeoutMs: 45000, maxInputTokens: 12000, maxOutputTokens: 2048, maxEstimatedCost: 8, maxRetries: 1 }),
	};
}

export function validateModelCatalog(catalog: ModelCatalog, requiredProfile?: ModelProfile): void {
	if (!catalog.catalogVersion || !["PILOT", "PRODUCTION"].includes(catalog.status)) throw new Error("MODEL_CATALOG_METADATA_INVALID");
	const profiles = requiredProfile ? [requiredProfile] : (["LOW_COST", "STANDARD", "HIGH_CONFIDENCE"] as const).filter((profileName) => catalog[profileName]);
	for (const profileName of profiles) {
		const config = catalog[profileName];
		if (!config || config.profile !== profileName) throw new Error(`MODEL_PROFILE_INVALID:${profileName}`);
		if (!config.primary.endpoint || !config.primary.model || !config.primary.provider) throw new Error(`MODEL_PRIMARY_INVALID:${profileName}`);
		if (config.maxRetries < 0 || config.timeoutMs <= 0 || config.maxInputTokens <= 0 || config.maxOutputTokens <= 0 || config.maxEstimatedCost < 0) throw new Error(`MODEL_LIMITS_INVALID:${profileName}`);
	}
}