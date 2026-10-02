import { runAgentLoop } from "./agent-loop";
import { classifyRillTask } from "../classification/rill-classifier";
import type { LangfuseRuntimeEnv } from "./agent-loop-telemetry";
import type { RillExecutionState } from "../contracts/rill-execution.contract";
import type { EngineeringAction, EngineeringRegistry } from "../routing/engineering-registry-resolver";
import { resolveContext, type ContextFileSystem } from "../routing/context-resolver";

export interface RillRequest {
	task: string;
	sourceClient?: "cline" | "continue" | "copilot" | "api";
	idempotencyKey?: string;
}

export interface RillRequestResponse {
	executionId: string;
	status: "BLOCKED" | "CONTEXT_EXPANSION_REQUIRED" | "READY";
	action: EngineeringAction | null;
	domain: "AuditQ" | null;
	specialist: "Planner" | "Builder" | "Reviewer" | null;
	reason: string;
}

export interface RillExecutionResponse extends RillRequestResponse {
	workflowState: RillExecutionState | "NOT_STARTED";
	traceId: string | null;
	sessionId: string | null;
}

export function createRillRequest(
	request: RillRequest,
	dependencies: { registry: EngineeringRegistry; fileSystem: ContextFileSystem },
): RillRequestResponse {
	const executionId = `rill-${crypto.randomUUID()}`;
	if (!request || typeof request.task !== "string" || !request.task.trim() || request.task.length > 2_000 || (request.sourceClient !== undefined && !["cline", "continue", "copilot", "api"].includes(request.sourceClient)) || (request.idempotencyKey !== undefined && (!/^[A-Za-z0-9._:-]{8,128}$/.test(request.idempotencyKey)))) {
		return { executionId, status: "BLOCKED", action: null, domain: null, specialist: null, reason: "INVALID_REQUEST" };
	}

	const classification = classifyRillTask(request.task);
	if (!classification.action || !classification.domain || !classification.specialist) {
		return { executionId, status: "BLOCKED", ...classification };
	}

	const manifest = resolveContext(dependencies.registry, { action: classification.action, domain: classification.domain, task: request.task }, dependencies.fileSystem);
	if (manifest.status !== "CONTEXT_READY") {
		return { executionId, status: manifest.status === "CONTEXT_EXPANSION_REQUIRED" ? "CONTEXT_EXPANSION_REQUIRED" : "BLOCKED", ...classification, reason: manifest.exclusionReasons.join(",") || manifest.status };
	}

	return { executionId, status: "READY", ...classification, reason: "CONTEXT_READY" };
}

export async function startRillRequest(
	request: RillRequest,
	dependencies: { registry: EngineeringRegistry; fileSystem: ContextFileSystem; env?: LangfuseRuntimeEnv },
): Promise<RillExecutionResponse> {
	const response = createRillRequest(request, dependencies);
	if (response.status !== "READY" || !response.action || !response.domain) {
		return { ...response, workflowState: "NOT_STARTED", traceId: null, sessionId: null };
	}

	const result = await runAgentLoop({
		action: response.action,
		domain: response.domain,
		task: request.task,
		registry: dependencies.registry,
		fileSystem: dependencies.fileSystem,
		env: dependencies.env,
		dryRun: true,
	});
	return {
		...response,
		workflowState: result.status === "AGENT_LOOP_OPERATIONAL" ? "AWAITING_HUMAN_APPROVAL" : "BLOCKED",
		traceId: result.traceId,
		sessionId: result.sessionId,
	};
}
