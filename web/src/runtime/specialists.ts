import type { LangfuseAgent } from "@langfuse/tracing";
import type { GatewayResult, ModelProfile } from "../../../src/contracts/gateway.contract";
import { executeGateway } from "../../../src/gateway/gateway";
import { GatewayError } from "../../../src/gateway/errors";
import { createModelCatalog } from "../../../src/gateway/models";
import { assertSafe, sanitizeGatewayInput } from "../../../src/security/gateway-input-sanitizer";
import { resolveMissionPrompt, type LangfuseRuntimeEnv, type ResolvedMissionPrompt } from "./langfuse";

export interface ModelRuntimeEnv extends LangfuseRuntimeEnv {
	OPENROUTER_API_KEY?: string;
	OPENROUTER_LOW_COST_MODEL?: string;
	OPENROUTER_BASE_URL?: string;
}

/** Conservative per-token ceiling (USD) used for the pre-call budget check; the reported cost replaces it after the call. */
export const ESTIMATED_USD_PER_TOKEN_CEILING = 0.000002;
const OUTPUT_TOKEN_LIMIT = 1024;

export type SpecialistRole = "Estrategista" | "Projetista";

export interface MissionPlanOutput {
	summary: string;
	steps: string[];
	risks: string[];
	recommendedTests: string[];
}

export interface PatchProposalOutput {
	summary: string;
	targetFiles: string[];
	proposedChanges: string[];
	acceptanceCriteria: string[];
	risks: string[];
	testsRecommended: string[];
}

const stringArray = { type: "array", items: { type: "string" } };

export const MISSION_PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["summary", "steps", "risks", "recommendedTests"],
	properties: { summary: { type: "string" }, steps: stringArray, risks: stringArray, recommendedTests: stringArray },
};

export const PATCH_PROPOSAL_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["summary", "targetFiles", "proposedChanges", "acceptanceCriteria", "risks", "testsRecommended"],
	properties: { summary: { type: "string" }, targetFiles: stringArray, proposedChanges: stringArray, acceptanceCriteria: stringArray, risks: stringArray, testsRecommended: stringArray },
};

export interface SpecialistRequest {
	missionId: string;
	role: SpecialistRole;
	action: string;
	domain: string;
	risk: string;
	modelProfile: ModelProfile;
	goal: string;
	contextManifest: Array<{ path: string; category: string; reason: string }>;
	approvalRequired: boolean;
}

export interface SpecialistTelemetry {
	prompt: Pick<ResolvedMissionPrompt, "name" | "label" | "source" | "version">;
	requestedModel: string | null;
	usedModel: string | null;
	provider: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	estimatedCostUsd: number | null;
	reportedCostUsd: number | null;
	latencyMs: number | null;
	attempt: number | null;
	fallbackUsed: boolean;
}

export type SpecialistResult<T> =
	| { ok: true; output: T; telemetry: SpecialistTelemetry }
	| { ok: false; code: string; telemetry: SpecialistTelemetry };

export function modelRuntimeConfigured(env: ModelRuntimeEnv): boolean {
	return Boolean(env.OPENROUTER_API_KEY?.trim() && env.OPENROUTER_LOW_COST_MODEL?.trim());
}

function boundedText(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text && text.length <= maxLength ? text : null;
}

function boundedList(value: unknown, minItems: number, maxItems: number, maxLength = 600): string[] | null {
	if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) return null;
	const items = value.map((item) => boundedText(item, maxLength));
	return items.every((item): item is string => item !== null) ? items : null;
}

export function parsePlanOutput(value: unknown): MissionPlanOutput | null {
	if (!value || typeof value !== "object") return null;
	const source = value as Record<string, unknown>;
	const summary = boundedText(source.summary, 1_200);
	const steps = boundedList(source.steps, 1, 12);
	const risks = boundedList(source.risks, 0, 12);
	const recommendedTests = boundedList(source.recommendedTests, 0, 12);
	if (!summary || !steps || !risks || !recommendedTests) return null;
	return { summary, steps, risks, recommendedTests };
}

export function parseProposalOutput(value: unknown): PatchProposalOutput | null {
	if (!value || typeof value !== "object") return null;
	const source = value as Record<string, unknown>;
	const summary = boundedText(source.summary, 1_200);
	const targetFiles = boundedList(source.targetFiles, 0, 10, 512);
	const proposedChanges = boundedList(source.proposedChanges, 1, 12);
	const acceptanceCriteria = boundedList(source.acceptanceCriteria, 1, 12);
	const risks = boundedList(source.risks, 0, 12);
	const testsRecommended = boundedList(source.testsRecommended, 0, 12);
	if (!summary || !targetFiles || !proposedChanges || !acceptanceCriteria || !risks || !testsRecommended) return null;
	return { summary, targetFiles: [...new Set(targetFiles)], proposedChanges, acceptanceCriteria, risks, testsRecommended };
}

function errorCode(error: unknown): string {
	if (error instanceof GatewayError) return error.code;
	if (error instanceof Error && /^[A-Z_:]+$/.test(error.message)) return error.message.split(":")[0];
	return "MODEL_INVOCATION_FAILED";
}

/**
 * Runs one specialist call through the Rill gateway: managed prompt -> input guardrail -> generation.
 * Never throws; failures are returned as sanitized codes so the workflow can fail closed.
 */
export async function invokeSpecialist<T>(
	env: ModelRuntimeEnv,
	parent: LangfuseAgent,
	request: SpecialistRequest,
	structured: { name: string; schema: Record<string, unknown>; parse: (value: unknown) => T | null },
): Promise<SpecialistResult<T>> {
	const agent = parent.startObservation(request.role.toLowerCase(), {
		input: { action: request.action, domain: request.domain, risk: request.risk, approvalRequired: request.approvalRequired },
		metadata: { modelProfile: request.modelProfile },
	}, { asType: "agent" });
	const variables = {
		goal: request.goal,
		action: request.action,
		domain: request.domain,
		risk: request.risk,
		context_manifest: JSON.stringify(request.contextManifest),
		approval_required: String(request.approvalRequired),
	};
	const promptSpan = agent.startObservation("resolve-mission-prompt", { input: { variables: Object.keys(variables) } });
	const prompt = await resolveMissionPrompt(env, variables);
	promptSpan.update({ output: { name: prompt.name, label: prompt.label, source: prompt.source, version: prompt.version } }).end();
	const telemetry: SpecialistTelemetry = {
		prompt: { name: prompt.name, label: prompt.label, source: prompt.source, version: prompt.version },
		requestedModel: env.OPENROUTER_LOW_COST_MODEL?.trim() || null,
		usedModel: null,
		provider: null,
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		estimatedCostUsd: null,
		reportedCostUsd: null,
		latencyMs: null,
		attempt: null,
		fallbackUsed: false,
	};
	const fail = (code: string): SpecialistResult<T> => {
		agent.update({ level: "ERROR", statusMessage: code, output: { status: "FAILED", code } }).end();
		return { ok: false, code, telemetry };
	};

	let catalog: ReturnType<typeof createModelCatalog>;
	try {
		catalog = createModelCatalog(env);
	} catch (error) {
		return fail(errorCode(error));
	}
	const profile = catalog[request.modelProfile];
	if (!profile) return fail("PROFILE_UNKNOWN");
	telemetry.requestedModel = profile.primary.model;
	const promptCharacters = prompt.messages.reduce((total, message) => total + message.content.length, 0) + JSON.stringify(structured.schema).length;
	const inputTokenEstimate = Math.max(1, Math.ceil(promptCharacters / 4));
	const estimatedCost = Number(((inputTokenEstimate + OUTPUT_TOKEN_LIMIT) * ESTIMATED_USD_PER_TOKEN_CEILING).toFixed(8));
	telemetry.estimatedCostUsd = estimatedCost;

	const guardrail = agent.startObservation("gateway-input-guardrail", { input: { fields: Object.keys(variables), messages: prompt.messages.length } }, { asType: "guardrail" });
	let sanitized: ReturnType<typeof sanitizeGatewayInput>;
	try {
		sanitized = sanitizeGatewayInput({
			executionId: request.missionId,
			action: request.action,
			domain: request.domain,
			role: request.role,
			modelProfile: request.modelProfile,
			input: variables,
			messages: prompt.messages,
			inputTokenEstimate,
			outputTokenLimit: OUTPUT_TOKEN_LIMIT,
			estimatedCost,
			structuredOutput: { name: structured.name, schema: structured.schema },
			reasoning: { enabled: false },
		});
		guardrail.update({ output: { status: "PASSED" } }).end();
	} catch {
		guardrail.update({ level: "WARNING", statusMessage: "SECURITY_REJECTION", output: { status: "REJECTED" } }).end();
		return fail("SECURITY_REJECTION");
	}

	const generation = agent.startObservation(`${request.role.toLowerCase()}-generation`, {
		model: profile.primary.model,
		input: prompt.messages,
		modelParameters: { max_tokens: OUTPUT_TOKEN_LIMIT, response_format: structured.name, reasoning: "disabled" },
		...(prompt.link ? { prompt: prompt.link } : {}),
		metadata: { promptSource: prompt.source, promptVersion: prompt.version, catalogVersion: catalog.catalogVersion, modelProfile: request.modelProfile, estimatedCostUsd: estimatedCost },
	}, { asType: "generation" });
	let result: GatewayResult;
	try {
		result = await executeGateway(sanitized, catalog, { apiKey: env.OPENROUTER_API_KEY });
	} catch (error) {
		const code = errorCode(error);
		generation.update({ level: "ERROR", statusMessage: code }).end();
		return fail(code);
	}
	Object.assign(telemetry, {
		usedModel: result.usedModel,
		provider: result.usedProvider,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		totalTokens: result.totalTokens,
		reportedCostUsd: result.reportedCost,
		latencyMs: result.latencyMs,
		attempt: result.attempt,
		fallbackUsed: result.fallbackUsed,
	});
	const usageDetails = Object.fromEntries(Object.entries({ input: result.inputTokens, output: result.outputTokens, total: result.totalTokens }).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
	const parsed = structured.parse(result.result);
	let safe = parsed !== null;
	if (parsed !== null) {
		try { assertSafe(parsed); } catch { safe = false; }
	}
	generation.update({
		output: result.result,
		model: result.usedModel ?? profile.primary.model,
		usageDetails,
		...(result.reportedCost !== null ? { costDetails: { total: result.reportedCost } } : {}),
		metadata: { provider: result.usedProvider, attempt: result.attempt, fallbackUsed: result.fallbackUsed, latencyMs: result.latencyMs, costStatus: result.costStatus },
		...(parsed === null ? { level: "ERROR" as const, statusMessage: "STRUCTURED_OUTPUT_INVALID" } : !safe ? { level: "ERROR" as const, statusMessage: "OUTPUT_SECURITY_REJECTION" } : {}),
	}).end();
	if (parsed === null) return fail("STRUCTURED_OUTPUT_INVALID");
	if (!safe) return fail("OUTPUT_SECURITY_REJECTION");
	agent.update({ output: { status: "COMPLETED", model: result.usedModel } }).end();
	return { ok: true, output: parsed, telemetry };
}
