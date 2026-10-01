import { runArchitect } from "../workers/architect.worker";
import { createBuilderProposal } from "../workers/builder.worker";
import { auditBuilderProposal } from "../workers/reviewer.worker";
import { createReviewTicketService } from "../hitl/create-ticket";
import { resolveContext, type ContextFileSystem } from "../routing/context-resolver";
import { resolveEngineeringAction, type EngineeringAction, type EngineeringRegistry } from "../routing/engineering-registry-resolver";
import type { ContextManifest } from "../contracts/context-manifest.contract";
import { createAgentLoopTelemetry, type AgentLoopTelemetry, type LangfuseRuntimeEnv } from "./agent-loop-telemetry";
import { executeGateway } from "../gateway/gateway";
import { sanitizeGatewayInput } from "../security/gateway-input-sanitizer";
import type { ModelCatalog, ModelProfile } from "../contracts/gateway.contract";

export type AgentLoopStatus = "AGENT_LOOP_OPERATIONAL" | "AGENT_LOOP_BLOCKED";

export interface AgentLoopInput {
	action: EngineeringAction;
	domain: string;
	task: string;
	registry: EngineeringRegistry;
	fileSystem: ContextFileSystem;
	modelUsed?: string | null;
	modelProfile?: string | null;
	modelCatalog?: ModelCatalog;
	openRouterApiKey?: string;
	openRouterFetcher?: typeof fetch;
	estimatedCost?: number;
	telemetry?: AgentLoopTelemetry;
	env?: LangfuseRuntimeEnv;
	dryRun?: boolean;
}

export interface AgentLoopResult {
	status: AgentLoopStatus;
	selectedAgent: "Planner";
	context: ContextManifest;
	promptEngineer: { status: "EXECUTED"; promptVersion: string; includedItems: number };
	builder: { status: "DRY_RUN"; proposedChanges: string[]; filesChanged: string[] };
	reviewer: { status: "APPROVED_WITH_NOTES" | "BLOCKED"; findings: string[] };
	memoryProposal: { status: "PROPOSED"; area: string; evidence: string };
	langfuse: { status: "DISABLED" | "PENDING"; traceId: null };
	modelUsed: string | null;
	estimatedCost: number;
	latencyMs: number;
	llmCalls: number;
	traceId: string | null;
	sessionId: string | null;
}

function buildPrompt(context: ContextManifest): string {
	return [
		"You are the local Prompt Engineer for PATCH_UI x AuditQ.",
		`Targets: ${context.targetFiles.join(", ")}`,
		"Produce a read-only change proposal. Do not modify files.",
	].join("\n");
}

const patchProposalSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		summary: { type: "string" },
		targetFiles: { type: "array", items: { type: "string" } },
		proposedChanges: { type: "array", items: { type: "string" } },
		acceptanceCriteria: { type: "array", items: { type: "string" } },
		risks: { type: "array", items: { type: "string" } },
		testsRecommended: { type: "array", items: { type: "string" } },
	},
	required: ["summary", "targetFiles", "proposedChanges", "acceptanceCriteria", "risks", "testsRecommended"],
};

function isPatchProposal(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proposal = value as Record<string, unknown>;
	const fields = ["summary", "targetFiles", "proposedChanges", "acceptanceCriteria", "risks", "testsRecommended"];
	return fields.every((field) => field in proposal) && Object.keys(proposal).every((field) => fields.includes(field));
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
	const startedAt = Date.now();
	const telemetry = input.telemetry ?? createAgentLoopTelemetry(input.env ?? {});
	const traceId = `trace-${crypto.randomUUID()}`;
	const sessionId = `session-${crypto.randomUUID()}`;
	const executionId = `execution-${crypto.randomUUID()}`;
	const baseFailure = (context: ContextManifest, errorCategory: string): AgentLoopResult => ({
		status: "AGENT_LOOP_BLOCKED",
		selectedAgent: "Planner",
		context,
		promptEngineer: { status: "EXECUTED", promptVersion: "local-v1", includedItems: context.includedItems.length },
		builder: { status: "DRY_RUN", proposedChanges: [], filesChanged: [] },
		reviewer: { status: "BLOCKED", findings: [errorCategory] },
		memoryProposal: { status: "PROPOSED", area: "frontend", evidence: "Agent Loop failure was recorded without applying changes." },
		langfuse: { status: "DISABLED", traceId: null },
		modelUsed: input.modelUsed ?? null,
		estimatedCost: 0,
		latencyMs: Date.now() - startedAt,
		llmCalls: 0,
		traceId,
		sessionId,
	});

	try {
		await telemetry.start({ traceId, sessionId, executionId, action: input.action, domain: input.domain, modelProfile: input.modelProfile ?? null });
		await telemetry.span("resolve-context", { status: "started" });
		const context = resolveContext(input.registry, input, input.fileSystem);
		await telemetry.span("resolve-context", { status: context.status, files: context.includedItems.length, estimatedContextSize: context.estimatedContextSize });
		if (context.status !== "CONTEXT_READY") {
			const blocked = baseFailure(context, context.status);
			await telemetry.memoryProposal(blocked.memoryProposal);
			return blocked;
		}

		await telemetry.span("plan-task", { status: "started" });
		const plan = runArchitect({ action: input.action, domain: input.domain, task: input.task, allowedPaths: context.allowedPaths });
		await telemetry.span("plan-task", { status: plan.decision, planSteps: plan.plan.length });
		await telemetry.span("prepare-prompt", { status: "started" });
		const prompt = buildPrompt(context);
		await telemetry.span("prepare-prompt", { status: "EXECUTED", promptVersion: "local-v1", promptLength: prompt.length });
		let gatewayResult: Awaited<ReturnType<typeof executeGateway>> | null = null;
		if (plan.decision === "ALLOWED" && input.modelCatalog && input.openRouterApiKey) {
			const resolution = resolveEngineeringAction(input.registry, input.action, input.domain);
			const modelProfile = (input.modelProfile ?? (resolution.status === "REGISTRY_MATCH" ? resolution.entry.modelProfile : null)) as ModelProfile | null;
			if (!modelProfile) throw new Error("MODEL_PROFILE_NOT_CONFIGURED");
			const gatewayInput = sanitizeGatewayInput({ executionId, action: input.action, domain: input.domain, role: "PromptEngineer", modelProfile, input: { task: prompt, targets: context.targetFiles }, inputTokenEstimate: Math.max(1, Math.ceil(prompt.length / 4)), outputTokenLimit: 512, estimatedCost: input.estimatedCost ?? 0, structuredOutput: { name: "patch_proposal", schema: patchProposalSchema } });
			await telemetry.span("generate-patch-proposal", { status: "started" });
			try {
				gatewayResult = await executeGateway(gatewayInput, input.modelCatalog, { apiKey: input.openRouterApiKey, fetcher: input.openRouterFetcher });
				const structuredOutputValid = isPatchProposal(gatewayResult.result);
				await telemetry.generation("generate-patch-proposal", { status: structuredOutputValid ? "OK" : "ERROR", errorCategory: structuredOutputValid ? null : "PATCH_PROPOSAL_SCHEMA_FAILURE", structuredOutputValid, model: gatewayResult.usedModel, provider: gatewayResult.usedProvider, modelProfile: gatewayResult.modelProfile, catalogVersion: input.modelCatalog.catalogVersion, routerVersion: "router-v1", promptVersion: "local-v1", inputTokens: gatewayResult.inputTokens, outputTokens: gatewayResult.outputTokens, totalTokens: gatewayResult.totalTokens, reportedCost: gatewayResult.reportedCost, estimatedCost: gatewayResult.estimatedCost, totalCostKnown: gatewayResult.totalReportedCost !== null, latencyMs: gatewayResult.latencyMs, attempt: gatewayResult.attempt, retryCount: Math.max(0, gatewayResult.attempt - 1), fallbackUsed: gatewayResult.fallbackUsed });
			} catch (error) {
				await telemetry.span("generate-patch-proposal", { status: "ERROR", errorCategory: error instanceof Error ? error.name : "UNKNOWN_ERROR" });
				throw error;
			}
			await telemetry.span("validate-patch-proposal", { status: isPatchProposal(gatewayResult.result) ? "PASSED" : "ERROR", structuredOutputValid: isPatchProposal(gatewayResult.result), errorCategory: isPatchProposal(gatewayResult.result) ? null : "PATCH_PROPOSAL_SCHEMA_FAILURE" });
			if (!isPatchProposal(gatewayResult.result)) throw new Error("PATCH_PROPOSAL_SCHEMA_FAILURE");
		}
		const builderProposal = createBuilderProposal({
			action: input.action,
			domain: input.domain,
			task: input.task,
			allowedPaths: context.allowedPaths,
			maxChangedFiles: 3,
			plan: plan.plan,
		});
		await telemetry.span("builder-proposal", { status: builderProposal.status, targetFilesCount: builderProposal.targetFiles.length });

		const auditResult = auditBuilderProposal({
			action: input.action,
			domain: input.domain,
			proposal: builderProposal,
			allowedPaths: context.allowedPaths,
			forbiddenPaths: context.forbiddenPaths,
			maxChangedFiles: 3,
		});
		await telemetry.span("reviewer-audit", { status: auditResult.status, approvedForHumanReview: auditResult.approvedForHumanReview });

		if (auditResult.approvedForHumanReview) {
			await createReviewTicketService(
				executionId,
				`PATCH_PROPOSAL FINAL para ${input.action} x ${input.domain}`,
				"HUMAN_APPROVAL_REQUIRED",
				builderProposal.targetFiles,
			);
			await telemetry.span("create-review-ticket", { status: "PENDING", executionId });
		}

		const proposedChanges = plan.plan.length > 0 && prompt.length > 0 ? [gatewayResult ? "PATCH_PROPOSAL" : `Review ${context.targetFiles.join(", ")} against the AuditQ UI baseline.`] : [];
		const findings = plan.decision === "ALLOWED" && proposedChanges.length > 0 ? auditResult.findings : ["Planner did not authorize the task."];
		const result: AgentLoopResult = { status: plan.decision === "ALLOWED" && proposedChanges.length > 0 && auditResult.status !== "BLOCKED" ? "AGENT_LOOP_OPERATIONAL" : "AGENT_LOOP_BLOCKED", selectedAgent: "Planner", context, promptEngineer: { status: "EXECUTED", promptVersion: "local-v1", includedItems: context.includedItems.length }, builder: { status: "DRY_RUN", proposedChanges, filesChanged: [] }, reviewer: { status: auditResult.status === "APPROVED_WITH_NOTES" ? "APPROVED_WITH_NOTES" : "BLOCKED", findings }, memoryProposal: { status: "PROPOSED", area: "frontend", evidence: "Read-only PATCH_UI x AuditQ dry-run completed." }, langfuse: { status: "DISABLED", traceId: null }, modelUsed: gatewayResult?.usedModel ?? input.modelUsed ?? null, estimatedCost: gatewayResult?.estimatedCost ?? 0, latencyMs: Date.now() - startedAt, llmCalls: gatewayResult ? 1 : 0, traceId, sessionId };
		await telemetry.span("review-proposal", { status: result.reviewer.status, findings: result.reviewer.findings.length });
		await telemetry.updateGeneration({ reviewerOutcome: result.reviewer.status });
		await telemetry.span("create-memory-proposal", result.memoryProposal);
		await telemetry.memoryProposal(result.memoryProposal);
		return result;
	} catch (error) {
		const context = resolveContext(input.registry, input, input.fileSystem);
		const blocked = baseFailure(context, error instanceof Error ? error.message : "INTERNAL_RUNTIME_FAILURE");
		await telemetry.span("review-proposal", { status: "NOT_RUN", errorCategory: error instanceof Error ? error.message : "INTERNAL_RUNTIME_FAILURE" });
		await telemetry.memoryProposal(blocked.memoryProposal);
		return blocked;
	} finally {
		await telemetry.flush();
	}
}