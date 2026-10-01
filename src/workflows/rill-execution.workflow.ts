import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runAgentLoop } from "../runtime/agent-loop";
import type { EngineeringAction } from "../routing/engineering-registry-resolver";
import type { RillExecutionState } from "../contracts/rill-execution.contract";
import type { RillExecutionReport } from "../contracts/rill-report.contract";
import { assertValidTransition } from "../contracts/rill-transition.contract";
import { createRillReviewTicket, updateRillExecutionState, type RillPersistenceEnv } from "../infrastructure/rill-persistence";
import registry from "../../engineering-registry.json" with { type: "json" };

export interface RillWorkflowPayload {
	executionId: string;
	action: EngineeringAction;
	domain: string;
	task: string;
	requestedBy: string | null;
	sourceClient: "cline" | "continue" | "copilot" | "api";
}

export interface RillWorkflowResult {
	executionId: string;
	state: RillExecutionState;
	traceId: string | null;
	sessionId: string | null;
	report?: RillExecutionReport;
}

function fileSystem() {
	return {
		getFileInfo(path: string) {
			const allowed = new Set([
				"public/index.html",
				"public/app.js",
				"public/auditq-business.css",
				"public/auditq-business.js",
				"public/auditq-professional.css",
				"public/auditq-professional.js",
				"public/auditq-official-values.js",
				"AGENTS.md",
				"docs/product-baseline/UI_ANALYSIS.md",
				"docs/product-baseline/DOMAIN_KNOWLEDGE.md",
				".github/prompts/analyze-rill.prompt.md",
				"tests/engineering-registry.test.js",
				"tests/architect.worker.test.js",
			]);
			return { exists: allowed.has(path), size: 1 };
		},
	};
}

export class RillExecutionWorkflow extends WorkflowEntrypoint<RillPersistenceEnv, RillWorkflowPayload> {
	async run(event: WorkflowEvent<RillWorkflowPayload>, step: WorkflowStep): Promise<RillWorkflowResult> {
		let state: RillExecutionState = "CLASSIFIED";
		await step.do("validate-request", async () => {
			await updateRillExecutionState(this.env, event.payload.executionId, "CLASSIFIED");
			return { state: "CLASSIFIED" as const };
		});
		const result = await step.do("run-read-only-agent-loop", { retries: { limit: 0, delay: "1 second" }, timeout: "30 seconds" }, async () => {
			return await runAgentLoop({
				action: event.payload.action,
				domain: event.payload.domain,
				task: event.payload.task,
				registry,
				fileSystem: fileSystem(),
				dryRun: true,
			});
		});

		if (result.status !== "AGENT_LOOP_OPERATIONAL") {
			assertValidTransition(state, "BLOCKED");
			await step.do("persist-blocked-state", async () => { await updateRillExecutionState(this.env, event.payload.executionId, "BLOCKED"); return { state: "BLOCKED" as const }; });
			return { executionId: event.payload.executionId, state: "BLOCKED", traceId: result.traceId, sessionId: result.sessionId, report: { executionId: event.payload.executionId, state: "BLOCKED", action: event.payload.action, domain: event.payload.domain, sourceClient: event.payload.sourceClient, serviceAccountId: null, humanUserId: event.payload.requestedBy, specialist: "Planner", modelProfile: null, model: null, provider: null, fallbackUsed: false, inputTokens: null, outputTokens: null, reportedCost: null, latencyMs: null, filesChanged: [], testsPassed: null, testsFailed: null, reviewerOutcome: "BLOCKED", humanDecision: null, traceId: result.traceId, riskResidual: ["Agent Loop blocked before approval."], rollbackAvailable: true, reason: "AGENT_LOOP_BLOCKED" } };
		}

		assertValidTransition(state, "CONTEXT_READY");
		state = "CONTEXT_READY";
		assertValidTransition(state, "PLANNED");
		state = "PLANNED";
		assertValidTransition(state, "PROPOSAL_REVIEWED");
		state = "PROPOSAL_REVIEWED";
		assertValidTransition(state, "AWAITING_HUMAN_APPROVAL");
		state = "AWAITING_HUMAN_APPROVAL";
		await step.do("create-review-ticket", async () => {
			await createRillReviewTicket(this.env, { executionId: event.payload.executionId, reasonCode: "HUMAN_APPROVAL_REQUIRED", summary: `Review ${event.payload.action} x ${event.payload.domain}` });
			await updateRillExecutionState(this.env, event.payload.executionId, "AWAITING_HUMAN_APPROVAL");
			return { state: "AWAITING_HUMAN_APPROVAL" as const };
		});
		const decision = await step.waitForEvent<{ decision: "APPROVED" | "REJECTED" | "REQUESTED_CHANGES" }>("wait-human-decision", {
			type: "rill-approval",
			timeout: "7 days",
		});
		if (decision.decision !== "APPROVED") {
			assertValidTransition(state, decision.decision);
			return { executionId: event.payload.executionId, state: decision.decision, traceId: result.traceId, sessionId: result.sessionId, report: { executionId: event.payload.executionId, state: decision.decision, action: event.payload.action, domain: event.payload.domain, sourceClient: event.payload.sourceClient, serviceAccountId: null, humanUserId: event.payload.requestedBy, specialist: "Planner", modelProfile: null, model: null, provider: null, fallbackUsed: false, inputTokens: null, outputTokens: null, reportedCost: null, latencyMs: null, filesChanged: [], testsPassed: null, testsFailed: null, reviewerOutcome: "NOT_RUN", humanDecision: decision.decision, traceId: result.traceId, riskResidual: [], rollbackAvailable: true } };
		}

		assertValidTransition(state, "EXECUTING", "APPROVED");
		state = "EXECUTING";
		return await step.do("complete-read-only-mission", async () => ({
			executionId: event.payload.executionId,
			state: "COMPLETED" as const,
			traceId: result.traceId,
			sessionId: result.sessionId,
			report: { executionId: event.payload.executionId, state: "COMPLETED" as const, action: event.payload.action, domain: event.payload.domain, sourceClient: event.payload.sourceClient, serviceAccountId: null, humanUserId: event.payload.requestedBy, specialist: "Planner", modelProfile: null, model: null, provider: null, fallbackUsed: false, inputTokens: null, outputTokens: null, reportedCost: null, latencyMs: null, filesChanged: [], testsPassed: null, testsFailed: null, reviewerOutcome: "APPROVED_WITH_NOTES", humanDecision: "APPROVED", traceId: result.traceId, riskResidual: [], rollbackAvailable: true },
		}));
	}
}
