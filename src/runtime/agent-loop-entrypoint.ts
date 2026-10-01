import { runAgentLoop, type AgentLoopResult } from "./agent-loop";
import { createAgentLoopTelemetry, type LangfuseRuntimeEnv } from "./agent-loop-telemetry";
import type { ContextFileSystem } from "../routing/context-resolver";
import type { EngineeringRegistry } from "../routing/engineering-registry-resolver";
import { createModelCatalog, type ModelCatalogRuntimeEnv } from "../gateway/models";

export interface AgentLoopValidationEnv extends LangfuseRuntimeEnv, ModelCatalogRuntimeEnv {
	AGENT_LOOP_RUNTIME_ENABLED?: string;
	OPENROUTER_API_KEY?: string;
	OPENROUTER_ESTIMATED_COST?: string;
}

export interface AgentLoopValidationDependencies {
	registry: EngineeringRegistry;
	fileSystem: ContextFileSystem;
}

export interface AgentLoopValidationResponse {
	status: "AGENT_LOOP_ENTRYPOINT_DISABLED" | "AGENT_LOOP_ENTRYPOINT_RESULT";
	traceSent: boolean;
	traceId: string | null;
	sessionId: string | null;
	telemetryProvider: "noop" | "langfuse";
	spansCompleted: number;
	generationsCreated: number;
	llmCalls: number;
	filesChanged: string[];
	memoryProposalStatus: string;
	flushStatus: "NOT_RUN" | "BEST_EFFORT";
	openRouterLowCostModelPresent: boolean;
}

function summarize(result: AgentLoopResult, telemetryProvider: "noop" | "langfuse", openRouterLowCostModelPresent: boolean): AgentLoopValidationResponse {
	return {
		status: "AGENT_LOOP_ENTRYPOINT_RESULT",
		traceSent: telemetryProvider === "langfuse",
		traceId: result.traceId,
		sessionId: result.sessionId,
		telemetryProvider,
		spansCompleted: 5,
		generationsCreated: result.llmCalls,
		llmCalls: result.llmCalls,
		filesChanged: result.builder.filesChanged,
		memoryProposalStatus: result.memoryProposal.status,
		flushStatus: "BEST_EFFORT",
		openRouterLowCostModelPresent,
	};
}

export async function runAgentLoopValidationEntrypoint(
	env: AgentLoopValidationEnv,
	dependencies: AgentLoopValidationDependencies,
): Promise<AgentLoopValidationResponse> {
	if (env.AGENT_LOOP_RUNTIME_ENABLED !== "true") {
		return { status: "AGENT_LOOP_ENTRYPOINT_DISABLED", traceSent: false, traceId: null, sessionId: null, telemetryProvider: "noop", spansCompleted: 0, generationsCreated: 0, llmCalls: 0, filesChanged: [], memoryProposalStatus: "NOT_RUN", flushStatus: "NOT_RUN", openRouterLowCostModelPresent: Boolean(env.OPENROUTER_LOW_COST_MODEL?.trim()) };
	}
	const telemetry = createAgentLoopTelemetry(env);
	const modelCatalog = env.OPENROUTER_API_KEY ? createModelCatalog(env) : undefined;
	const estimatedCost = env.OPENROUTER_ESTIMATED_COST ? Number(env.OPENROUTER_ESTIMATED_COST) : 0;
	const result = await runAgentLoop({ action: "PATCH_UI", domain: "AuditQ", task: "Review public/index.html for a PATCH_UI proposal", registry: dependencies.registry, fileSystem: dependencies.fileSystem, telemetry, dryRun: true, modelCatalog, openRouterApiKey: env.OPENROUTER_API_KEY, estimatedCost });
	return summarize(result, telemetry.kind, Boolean(env.OPENROUTER_LOW_COST_MODEL?.trim()));
}
