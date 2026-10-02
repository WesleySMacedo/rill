import { propagateAttributes, startObservation, type LangfuseAgent } from "@langfuse/tracing";
import { classifyRillTask } from "../../../src/classification/rill-classifier";
import type { BuilderProposalResult } from "../../../src/contracts/execution.contract";
import type { ModelProfile } from "../../../src/contracts/gateway.contract";
import { createModelCatalog } from "../../../src/gateway/models";
import { resolveContext } from "../../../src/routing/context-resolver";
import { resolveEngineeringAction } from "../../../src/routing/engineering-registry-resolver";
import type { EngineeringRegistry, EngineeringRegistryEntry } from "../../../src/routing/engineering-registry-resolver";
import { runArchitect } from "../../../src/workers/architect.worker";
import { auditBuilderProposal } from "../../../src/workers/reviewer.worker";
import registry from "../../../engineering-registry.json" with { type: "json" };
import { ensureLangfuseTracing, recordHumanDecisionScore } from "./langfuse";
import {
	MISSION_PLAN_SCHEMA,
	PATCH_PROPOSAL_SCHEMA,
	invokeSpecialist,
	modelRuntimeConfigured,
	parsePlanOutput,
	parseProposalOutput,
	type ModelRuntimeEnv,
	type SpecialistResult,
	type SpecialistRole,
} from "./specialists";

interface WorkspaceFileInput {
	path: string;
	size: number;
}

interface CreateMissionInput {
	task: string;
	targetPath: string;
	contextPaths?: string[];
	workspaceFiles: WorkspaceFileInput[];
	clientRequestId: string;
}

interface SupabaseUser {
	id: string;
	email?: string;
}

interface MissionRow {
	id: string;
	user_id: string;
	client_request_id: string;
	task: string;
	target_path: string;
	action: string;
	domain: string;
	risk: string;
	model_profile: string;
	state: string;
	approval_required: boolean;
	provider_status: string;
	selected_model: string | null;
	estimated_cost_usd: number | null;
	context_manifest: unknown;
	plan: unknown;
	created_at: string;
}

interface MissionEventRow {
	event_id: string;
	mission_id: string;
	event_type: string;
	state: string;
	payload: Record<string, unknown>;
	created_at: string;
}

interface MissionAuditRow {
	audit_event_id: string;
	mission_id: string;
	event_type: string;
	actor_id: string | null;
	details: Record<string, unknown>;
	created_at: string;
}

interface ApprovalRow {
	approval_id: string;
	mission_id: string;
	decision: "PENDING" | "APPROVED" | "REJECTED" | "REQUESTED_CHANGES";
	decided_by: string | null;
	justification: string | null;
	proposal_hash: string | null;
	created_at: string;
	decided_at: string | null;
}

interface ProposalVersionRow {
	proposal_version_id: string;
	version: number;
	proposal_hash: string;
	proposal: Record<string, unknown>;
	created_at: string;
}

type MissionRuntimeEnv = Env & ModelRuntimeEnv & { SUPABASE_SERVICE_ROLE_KEY?: string };
type HumanDecision = "APPROVED" | "REJECTED" | "REQUESTED_CHANGES";

const TERMINAL_STATES = new Set(["COMPLETED", "BLOCKED", "FAILED", "REJECTED", "REQUESTED_CHANGES", "CANCELED"]);
const HUMAN_DECISIONS = new Set<HumanDecision>(["APPROVED", "REJECTED", "REQUESTED_CHANGES"]);

function json(payload: unknown, status = 200): Response {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

export async function fetchSupabaseUser(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_PUBLISHABLE_KEY">, token: string): Promise<SupabaseUser | null> {
	if (!token || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return null;
	const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
		headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
	});
	if (!response.ok) return null;
	const user = await response.json() as SupabaseUser;
	return user.id ? user : null;
}

export async function authenticate(request: Request, env: MissionRuntimeEnv): Promise<{ user: SupabaseUser; token: string } | null> {
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = authorization.slice("Bearer ".length).trim();
	const user = await fetchSupabaseUser(env, token);
	return user ? { user, token } : null;
}

async function supabaseRest<T>(env: MissionRuntimeEnv, path: string, init: RequestInit = {}, userToken?: string): Promise<T> {
	const headers = new Headers(init.headers);
	const apiKey = userToken ? env.SUPABASE_PUBLISHABLE_KEY : env.SUPABASE_SERVICE_ROLE_KEY;
	if (!apiKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY_REQUIRED");
	headers.set("apikey", apiKey);
	headers.set("Authorization", `Bearer ${userToken ?? apiKey}`);
	headers.set("Content-Type", "application/json");
	const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, { ...init, headers });
	if (!response.ok) {
		console.error(JSON.stringify({ message: "supabase mission request failed", path: path.split("?")[0], status: response.status }));
		throw new Error("MISSION_PERSISTENCE_FAILED");
	}
	if (response.status === 204 || headers.get("Prefer")?.includes("return=minimal")) return undefined as T;
	return await response.json() as T;
}

function workspaceIndex(value: unknown): Map<string, number> | null {
	if (!Array.isArray(value) || value.length > 2_000) return null;
	const files = new Map<string, number>();
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const file = item as Record<string, unknown>;
		if (typeof file.path !== "string" || file.path.length > 512 || file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").includes("..")) return null;
		const size = typeof file.size === "number" && Number.isFinite(file.size) ? Math.max(0, Math.min(file.size, 20_000_000)) : 0;
		files.set(file.path, size);
	}
	return files;
}

async function recordEvent(env: MissionRuntimeEnv, userId: string, missionId: string, eventType: string, state: string, payload: Record<string, unknown>): Promise<void> {
	await supabaseRest(env, "rill_workflow_events?on_conflict=mission_id,event_type", {
		method: "POST",
		headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
		body: JSON.stringify({ mission_id: missionId, user_id: userId, event_type: eventType, state, payload }),
	});
}

async function recordAuditEvent(env: MissionRuntimeEnv, userId: string, missionId: string, eventType: string, details: Record<string, unknown>): Promise<void> {
	await supabaseRest(env, "rill_audit_events", {
		method: "POST",
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify({ mission_id: missionId, user_id: userId, actor_id: userId, event_type: eventType, details }),
	});
}

async function updateMission(env: MissionRuntimeEnv, userId: string, missionId: string, patch: Record<string, unknown>, expectedState?: string): Promise<boolean> {
	const query = new URLSearchParams({ id: `eq.${missionId}`, user_id: `eq.${userId}` });
	if (expectedState) query.set("state", `eq.${expectedState}`);
	const rows = await supabaseRest<Array<{ id: string }>>(env, `rill_missions?${query}&select=id`, {
		method: "PATCH",
		headers: { Prefer: "return=representation" },
		body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
	});
	return Array.isArray(rows) && rows.length > 0;
}

async function updateExecutionState(env: MissionRuntimeEnv, userId: string, missionId: string, state: string, executionGate: string): Promise<void> {
	await supabaseRest(env, `rill_execution_state?mission_id=eq.${missionId}&user_id=eq.${userId}`, {
		method: "PATCH",
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify({ state, execution_gate: executionGate, updated_at: new Date().toISOString() }),
	});
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown | null> {
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error("REQUEST_TOO_LARGE");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		return null;
	}
}

async function parseBody(request: Request, maxBytes: number): Promise<{ body: unknown } | { response: Response }> {
	if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes) return { response: json({ error: "REQUEST_TOO_LARGE" }, 413) };
	try {
		return { body: await readBoundedJson(request, maxBytes) };
	} catch (error) {
		if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") return { response: json({ error: "REQUEST_TOO_LARGE" }, 413) };
		return { response: json({ error: "INVALID_REQUEST" }, 400) };
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface TraceScope {
	root: LangfuseAgent;
	traceId: string | null;
}

/** One Langfuse trace per mission operation, grouped into a session by mission id. */
async function withMissionTrace<T>(
	env: MissionRuntimeEnv,
	ctx: ExecutionContext | undefined,
	attributes: { traceName: string; userId: string; sessionId: string; tags: string[]; metadata?: Record<string, string> },
	input: unknown,
	fn: (scope: TraceScope) => Promise<T>,
): Promise<T> {
	const processor = ensureLangfuseTracing(env);
	try {
		return await propagateAttributes(attributes, async () => {
			const root = startObservation(attributes.traceName, { input }, { asType: "agent" });
			try {
				return await fn({ root, traceId: processor ? root.traceId : null });
			} catch (error) {
				root.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : "UNKNOWN" });
				throw error;
			} finally {
				root.end();
			}
		});
	} finally {
		if (processor) {
			const flush = processor.forceFlush().catch(() => undefined);
			ctx?.waitUntil(flush);
		}
	}
}

function traceEvent(root: LangfuseAgent, name: string, output: Record<string, unknown>): void {
	root.startObservation(name, { output }, { asType: "event" });
}

function requestedModelFor(env: MissionRuntimeEnv, profile: ModelProfile): string | null {
	try {
		return createModelCatalog(env)[profile]?.primary.model ?? null;
	} catch {
		return null;
	}
}

async function listMissions(env: MissionRuntimeEnv, userId: string, token: string): Promise<Response> {
	const params = new URLSearchParams({
		select: "id,task,target_path,action,domain,risk,model_profile,state,approval_required,provider_status,selected_model,estimated_cost_usd,created_at",
		user_id: `eq.${userId}`,
		order: "created_at.desc",
		limit: "100",
	});
	const missions = await supabaseRest<MissionRow[]>(env, `rill_missions?${params}`, {}, token);
	return json({ missions });
}

async function loadMission(env: MissionRuntimeEnv, userId: string, missionId: string, token: string): Promise<MissionRow | null> {
	const query = new URLSearchParams({
		select: "id,user_id,client_request_id,task,target_path,action,domain,risk,model_profile,state,approval_required,provider_status,selected_model,estimated_cost_usd,context_manifest,plan,created_at",
		id: `eq.${missionId}`,
		user_id: `eq.${userId}`,
		limit: "1",
	});
	const rows = await supabaseRest<MissionRow[]>(env, `rill_missions?${query}`, {}, token);
	return rows[0] ?? null;
}

async function getMission(env: MissionRuntimeEnv, userId: string, missionId: string, token: string): Promise<Response> {
	const mission = await loadMission(env, userId, missionId, token);
	if (!mission) return json({ error: "MISSION_NOT_FOUND" }, 404);
	const scoped = (select: string, order = "created_at.asc", limit?: string) => {
		const query = new URLSearchParams({ select, mission_id: `eq.${missionId}`, user_id: `eq.${userId}`, order });
		if (limit) query.set("limit", limit);
		return query;
	};
	const [events, auditEvents, approvals, proposals] = await Promise.all([
		supabaseRest<MissionEventRow[]>(env, `rill_workflow_events?${scoped("event_id,mission_id,event_type,state,payload,created_at")}`, {}, token),
		supabaseRest<MissionAuditRow[]>(env, `rill_audit_events?${scoped("audit_event_id,mission_id,event_type,actor_id,details,created_at")}`, {}, token),
		supabaseRest<ApprovalRow[]>(env, `rill_approvals?${scoped("approval_id,mission_id,decision,decided_by,justification,proposal_hash,created_at,decided_at", "created_at.desc", "1")}`, {}, token),
		supabaseRest<ProposalVersionRow[]>(env, `rill_proposal_versions?${scoped("proposal_version_id,version,proposal_hash,proposal,created_at", "version.desc", "1")}`, {}, token),
	]);
	return json({ mission, events, auditEvents, approval: approvals[0] ?? null, proposal: proposals[0] ?? null });
}

async function recordModelOutcome(env: MissionRuntimeEnv, userId: string, missionId: string, state: string, role: SpecialistRole, outcome: SpecialistResult<unknown>): Promise<void> {
	const { telemetry } = outcome;
	await recordEvent(env, userId, missionId, "PROMPT_RESOLVED", state, { ...telemetry.prompt });
	const metrics = {
		role,
		requestedModel: telemetry.requestedModel,
		usedModel: telemetry.usedModel,
		provider: telemetry.provider,
		inputTokens: telemetry.inputTokens,
		outputTokens: telemetry.outputTokens,
		totalTokens: telemetry.totalTokens,
		estimatedCostUsd: telemetry.estimatedCostUsd,
		reportedCostUsd: telemetry.reportedCostUsd,
		latencyMs: telemetry.latencyMs,
		attempt: telemetry.attempt,
		fallbackUsed: telemetry.fallbackUsed,
	};
	if (outcome.ok) await recordEvent(env, userId, missionId, "MODEL_COMPLETED", state, metrics);
	else await recordEvent(env, userId, missionId, "MODEL_INVOCATION_FAILED", state, { ...metrics, code: outcome.code });
	await updateMission(env, userId, missionId, {
		provider_status: outcome.ok ? "COMPLETED" : "FAILED",
		selected_model: telemetry.usedModel ?? telemetry.requestedModel,
		estimated_cost_usd: telemetry.reportedCostUsd ?? telemetry.estimatedCostUsd,
	});
}

function proposalFindings(entry: EngineeringRegistryEntry, targetFiles: string[]): string[] {
	const findings: string[] = [];
	if (!targetFiles.length) findings.push("Proposta sem arquivos-alvo.");
	for (const path of targetFiles) {
		if (!entry.allowedExtensions.some((extension) => path.endsWith(extension))) findings.push(`Extensão não autorizada: ${path}`);
		if (entry.forbiddenPaths.some((forbidden) => forbidden.endsWith("/") ? path.startsWith(forbidden) : path === forbidden)) findings.push(`Caminho proibido detectado na proposta: ${path}`);
	}
	return findings;
}

async function createMission(request: Request, env: MissionRuntimeEnv, ctx: ExecutionContext | undefined, user: SupabaseUser, token: string): Promise<Response> {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "SUPABASE_SERVICE_ROLE_KEY_REQUIRED" }, 503);
	const parsed = await parseBody(request, 64_000);
	if ("response" in parsed) return parsed.response;
	const body = parsed.body as Partial<CreateMissionInput> | null;
	if (!body || typeof body.task !== "string" || typeof body.targetPath !== "string" || typeof body.clientRequestId !== "string") {
		return json({ error: "INVALID_REQUEST" }, 400);
	}
	const task = body.task.trim();
	if (!task || task.length > 1_800 || !/^[0-9a-f-]{36}$/i.test(body.clientRequestId)) return json({ error: "INVALID_REQUEST" }, 400);
	const files = workspaceIndex(body.workspaceFiles);
	if (!files || !files.has(body.targetPath)) return json({ error: "WORKSPACE_TARGET_MISSING" }, 400);
	const contextPaths = body.contextPaths ?? [];
	if (!Array.isArray(contextPaths) || contextPaths.length > 6 || contextPaths.some((path) => typeof path !== "string" || !files.has(path))) {
		return json({ error: "INVALID_CONTEXT_PATHS" }, 400);
	}

	const explicitPaths = [...new Set([body.targetPath, ...contextPaths])];
	const fullTask = `${task} ${explicitPaths.map((path) => `in ${path}`).join(" ")}`;
	if (fullTask.length > 2_000) return json({ error: "INVALID_REQUEST" }, 400);
	const typedRegistry = registry as unknown as EngineeringRegistry;
	const classification = classifyRillTask(fullTask);
	if (!classification.action || !classification.domain || !classification.specialist) {
		return json({ mission: { ...classification, status: "BLOCKED" }, events: [] }, 422);
	}
	const fileSystem = {
		getFileInfo(path: string) {
			const bytes = files.get(path);
			return { exists: bytes !== undefined, size: bytes === undefined ? 0 : Math.ceil(bytes / 4) };
		},
	};
	const resolution = resolveEngineeringAction(typedRegistry, classification.action, classification.domain);
	if (resolution.status !== "REGISTRY_MATCH") return json({ error: "REGISTRY_POLICY_REJECTED" }, 403);
	const context = resolveContext(typedRegistry, { action: classification.action, domain: classification.domain, task: fullTask }, fileSystem);
	if (context.status !== "CONTEXT_READY") return json({ error: "CONTEXT_NOT_READY", reasons: context.exclusionReasons }, 409);
	const modelEnabled = modelRuntimeConfigured(env);
	if (classification.action === "PATCH_UI" && !modelEnabled) {
		return json({ error: "PROPOSAL_RUNTIME_NOT_CONFIGURED", reason: "The OpenRouter model runtime is not configured; no proposal, approval ticket, or mutation was started." }, 503);
	}

	const plan = runArchitect({ action: classification.action, domain: classification.domain, task: fullTask, allowedPaths: context.targetFiles });
	if (plan.decision !== "ALLOWED") return json({ error: "PLANNING_BLOCKED", reason: plan.reason }, 403);
	const entry = resolution.entry;
	const clientRequestId = body.clientRequestId;
	const existingQuery = new URLSearchParams({
		select: "id",
		user_id: `eq.${user.id}`,
		client_request_id: `eq.${clientRequestId}`,
		limit: "1",
	});
	const existing = await supabaseRest<Array<{ id: string }>>(env, `rill_missions?${existingQuery}`, {}, token);
	if (existing[0]) return await getMission(env, user.id, existing[0].id, token);

	const missionId = crypto.randomUUID();
	const action = classification.action;
	const domain = classification.domain;
	const modelProfile = (entry.modelProfile ?? "LOW_COST") as ModelProfile;
	const approvalRequired = entry.approvalRequirement.required;
	const manifest = context.includedItems.map(({ path, category, reason }) => ({ path, category, reason }));

	return await withMissionTrace(env, ctx, {
		traceName: "rill-mission-create",
		userId: user.id,
		sessionId: missionId,
		tags: ["rill-web", action, domain],
		metadata: { action, domain, risk: entry.risk, modelProfile },
	}, { goal: task, action, domain, targetPath: body.targetPath, contextPaths: explicitPaths }, async ({ root, traceId }) => {
		const mission: MissionRow = {
			id: missionId,
			user_id: user.id,
			client_request_id: clientRequestId,
			task: fullTask,
			target_path: body.targetPath!,
			action,
			domain,
			risk: entry.risk,
			model_profile: modelProfile,
			state: "CLASSIFIED",
			approval_required: approvalRequired,
			provider_status: "NOT_INVOKED",
			selected_model: null,
			estimated_cost_usd: null,
			context_manifest: context,
			plan: plan.plan,
			created_at: new Date().toISOString(),
		};
		await supabaseRest(env, "rill_missions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(mission) });
		await supabaseRest(env, "rill_execution_state", {
			method: "POST",
			headers: { Prefer: "return=minimal" },
			body: JSON.stringify({ mission_id: missionId, user_id: user.id, state: "CLASSIFIED", execution_gate: approvalRequired ? "LOCKED" : "NOT_APPLICABLE", attempt: 0 }),
		});
		await recordAuditEvent(env, user.id, missionId, "MISSION_CLASSIFIED", { clientRequestId, action, domain, targetPath: body.targetPath, risk: entry.risk });
		await recordEvent(env, user.id, missionId, "MISSION_CREATED", "CLASSIFIED", { requestedBy: user.id, traceId });
		await recordEvent(env, user.id, missionId, "CLASSIFIED", "CLASSIFIED", { action, domain, reason: classification.reason });
		traceEvent(root, "deterministic-classification", { action, domain, specialist: classification.specialist, reason: classification.reason });
		await updateMission(env, user.id, missionId, { state: "CONTEXT_READY" });
		await recordEvent(env, user.id, missionId, "CONTEXT_READY", "CONTEXT_READY", { targetFiles: context.targetFiles, includedItems: manifest });
		await recordEvent(env, user.id, missionId, "RISK_ANALYZED", "CONTEXT_READY", { risk: entry.risk, approvalRequired, approvalReason: entry.approvalRequirement.reason });
		traceEvent(root, "context-resolved", { targetFiles: context.targetFiles, includedItems: manifest.length, risk: entry.risk, approvalRequired });

		if (!modelEnabled) {
			await recordEvent(env, user.id, missionId, "COST_ESTIMATE_SKIPPED", "CONTEXT_READY", { estimatedCostUsd: null, reason: "No model provider was invoked." });
			await recordEvent(env, user.id, missionId, "MODEL_ROUTING_SKIPPED", "CONTEXT_READY", { profile: modelProfile, selectedModel: null, reason: "OpenRouter inference is not configured for this runtime." });
			await recordEvent(env, user.id, missionId, "PLANNING", "PLANNED", { specialist: "Architect", plan: plan.plan, mode: "DETERMINISTIC" });
			await updateMission(env, user.id, missionId, { state: "PLANNED" });
			await updateExecutionState(env, user.id, missionId, "PLANNED", "NOT_APPLICABLE");
			await recordEvent(env, user.id, missionId, "PLANNED", "PLANNED", { plan: plan.plan, mode: "DETERMINISTIC" });
			await recordAuditEvent(env, user.id, missionId, "MISSION_PLANNED", { specialist: "Architect", mode: "DETERMINISTIC", providerInvoked: false });
			root.update({ output: { state: "PLANNED", mode: "DETERMINISTIC" } });
			return await getMission(env, user.id, missionId, token);
		}

		const role: SpecialistRole = action === "PATCH_UI" ? "Projetista" : "Estrategista";
		await updateMission(env, user.id, missionId, { provider_status: "INVOKED", selected_model: requestedModelFor(env, modelProfile) });
		await recordEvent(env, user.id, missionId, "MODEL_ROUTED", "CONTEXT_READY", {
			role,
			profile: modelProfile,
			requestedModel: requestedModelFor(env, modelProfile),
			provider: "openrouter",
			reason: `Registry modelProfile ${modelProfile} for ${action} x ${domain} (${entry.risk} risk).`,
		});
		const specialistRequest = { missionId, role, action, domain, risk: entry.risk, modelProfile, goal: fullTask, contextManifest: manifest, approvalRequired };

		if (action !== "PATCH_UI") {
			await recordEvent(env, user.id, missionId, "PLANNING", "CONTEXT_READY", { specialist: role, mode: "MODEL" });
			const outcome = await invokeSpecialist(env, root, specialistRequest, { name: "rill_mission_plan", schema: MISSION_PLAN_SCHEMA, parse: parsePlanOutput });
			await recordModelOutcome(env, user.id, missionId, "CONTEXT_READY", role, outcome);
			const mode = outcome.ok ? "MODEL" : "DETERMINISTIC_FALLBACK";
			const steps = outcome.ok ? outcome.output.steps : plan.plan;
			await updateMission(env, user.id, missionId, { state: "PLANNED", plan: steps });
			await updateExecutionState(env, user.id, missionId, "PLANNED", "NOT_APPLICABLE");
			await recordEvent(env, user.id, missionId, "PLANNED", "PLANNED", {
				specialist: role,
				mode,
				plan: steps,
				...(outcome.ok ? { summary: outcome.output.summary, risks: outcome.output.risks, recommendedTests: outcome.output.recommendedTests } : { fallbackReason: outcome.code }),
			});
			await recordAuditEvent(env, user.id, missionId, "MISSION_PLANNED", { specialist: role, mode, providerInvoked: true, model: outcome.telemetry.usedModel ?? outcome.telemetry.requestedModel });
			root.update({ output: { state: "PLANNED", mode, steps: steps.length } });
			return await getMission(env, user.id, missionId, token);
		}

		await recordEvent(env, user.id, missionId, "PLANNING", "PLANNED", { specialist: "Architect", plan: plan.plan, mode: "DETERMINISTIC" });
		await updateMission(env, user.id, missionId, { state: "PLANNED" });
		await updateExecutionState(env, user.id, missionId, "PLANNED", "LOCKED");
		await recordEvent(env, user.id, missionId, "PLANNED", "PLANNED", { plan: plan.plan, mode: "DETERMINISTIC" });
		const outcome = await invokeSpecialist(env, root, specialistRequest, { name: "rill_patch_proposal", schema: PATCH_PROPOSAL_SCHEMA, parse: parseProposalOutput });
		await recordModelOutcome(env, user.id, missionId, "PLANNED", role, outcome);
		if (!outcome.ok) {
			await updateMission(env, user.id, missionId, { state: "FAILED" });
			await updateExecutionState(env, user.id, missionId, "FAILED", "LOCKED");
			await recordEvent(env, user.id, missionId, "FAILED", "FAILED", { stage: "PATCH_PROPOSAL", reason: outcome.code });
			await recordAuditEvent(env, user.id, missionId, "PROPOSAL_FAILED", { specialist: role, reason: outcome.code });
			root.update({ level: "WARNING", statusMessage: outcome.code, output: { state: "FAILED", reason: outcome.code } });
			return await getMission(env, user.id, missionId, token);
		}

		const proposal: BuilderProposalResult = { status: "PROPOSAL_CREATED", ...outcome.output };
		await recordEvent(env, user.id, missionId, "PROPOSAL_CREATED", "PLANNED", { specialist: role, ...outcome.output });
		const auditor = root.startObservation("auditor-tecnico", { input: { targetFiles: proposal.targetFiles, allowedPaths: context.targetFiles, maxChangedFiles: entry.maxChangedFiles } }, { asType: "evaluator" });
		const audit = auditBuilderProposal({ action, domain, proposal, allowedPaths: context.targetFiles, forbiddenPaths: entry.forbiddenPaths, maxChangedFiles: entry.maxChangedFiles });
		const extraFindings = proposalFindings(entry, proposal.targetFiles);
		const approvedForHumanReview = audit.approvedForHumanReview && extraFindings.length === 0;
		const auditStatus = approvedForHumanReview ? audit.status : audit.status === "BLOCKED" ? "BLOCKED" : "CHANGES_REQUIRED";
		const findings = [...extraFindings, ...audit.findings.filter((finding) => approvedForHumanReview || !finding.startsWith("Proposta validada"))];
		auditor.update({ output: { status: auditStatus, approvedForHumanReview, findings }, ...(approvedForHumanReview ? {} : { level: "WARNING" as const, statusMessage: auditStatus }) }).end();
		await updateMission(env, user.id, missionId, { state: "PROPOSAL_REVIEWED" });
		await updateExecutionState(env, user.id, missionId, "PROPOSAL_REVIEWED", "LOCKED");
		await recordEvent(env, user.id, missionId, "PROPOSAL_REVIEWED", "PROPOSAL_REVIEWED", { reviewer: "Auditor Técnico", mode: "DETERMINISTIC", status: auditStatus, approvedForHumanReview, findings });

		if (!approvedForHumanReview) {
			await updateMission(env, user.id, missionId, { state: "BLOCKED" });
			await updateExecutionState(env, user.id, missionId, "BLOCKED", "LOCKED");
			await recordEvent(env, user.id, missionId, "BLOCKED", "BLOCKED", { reason: "AUDITOR_REJECTED_PROPOSAL", findings });
			await recordAuditEvent(env, user.id, missionId, "PROPOSAL_BLOCKED", { reviewer: "Auditor Técnico", status: auditStatus, findings });
			root.update({ level: "WARNING", statusMessage: "AUDITOR_REJECTED_PROPOSAL", output: { state: "BLOCKED", findings } });
			return await getMission(env, user.id, missionId, token);
		}

		const hashedProposal = { missionId, action, domain, ...outcome.output };
		const proposalHash = await sha256Hex(canonicalJson(hashedProposal));
		await supabaseRest(env, "rill_proposal_versions", {
			method: "POST",
			headers: { Prefer: "return=minimal" },
			body: JSON.stringify({ mission_id: missionId, user_id: user.id, version: 1, proposal_hash: proposalHash, proposal: hashedProposal }),
		});
		const approvals = await supabaseRest<Array<{ approval_id: string }>>(env, "rill_approvals?select=approval_id", {
			method: "POST",
			headers: { Prefer: "return=representation" },
			body: JSON.stringify({ mission_id: missionId, user_id: user.id, decision: "PENDING", proposal_hash: proposalHash }),
		});
		const approvalId = approvals[0]?.approval_id ?? null;
		if (!approvalId) throw new Error("MISSION_PERSISTENCE_FAILED");
		if (!await updateMission(env, user.id, missionId, { state: "AWAITING_HUMAN_APPROVAL" }, "PROPOSAL_REVIEWED")) {
			root.update({ level: "WARNING", statusMessage: "MISSION_STATE_CHANGED" });
			return await getMission(env, user.id, missionId, token);
		}
		await updateExecutionState(env, user.id, missionId, "AWAITING_HUMAN_APPROVAL", "LOCKED");
		await recordEvent(env, user.id, missionId, "AWAITING_HUMAN_APPROVAL", "AWAITING_HUMAN_APPROVAL", { approvalId, proposalHash, proposalVersion: 1, traceId });
		await recordAuditEvent(env, user.id, missionId, "HITL_TICKET_CREATED", { approvalId, proposalHash, proposalVersion: 1 });
		traceEvent(root, "hitl-ticket-created", { approvalId, proposalHash, proposalVersion: 1 });
		root.update({ output: { state: "AWAITING_HUMAN_APPROVAL", proposalHash, targetFiles: proposal.targetFiles } });
		return await getMission(env, user.id, missionId, token);
	});
}

async function decideMission(request: Request, env: MissionRuntimeEnv, ctx: ExecutionContext | undefined, user: SupabaseUser, token: string, missionId: string): Promise<Response> {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "SUPABASE_SERVICE_ROLE_KEY_REQUIRED" }, 503);
	const parsed = await parseBody(request, 8_000);
	if ("response" in parsed) return parsed.response;
	const body = parsed.body as { decision?: unknown; justification?: unknown; proposalHash?: unknown } | null;
	const decision = body?.decision as HumanDecision;
	const justification = typeof body?.justification === "string" ? body.justification.trim() : "";
	if (!body || !HUMAN_DECISIONS.has(decision) || typeof body.proposalHash !== "string" || !/^[0-9a-f]{64}$/.test(body.proposalHash) || justification.length > 1_000) {
		return json({ error: "INVALID_REQUEST" }, 400);
	}
	if (decision !== "APPROVED" && !justification) return json({ error: "JUSTIFICATION_REQUIRED" }, 400);
	const proposalHash = body.proposalHash;

	const mission = await loadMission(env, user.id, missionId, token);
	if (!mission) return json({ error: "MISSION_NOT_FOUND" }, 404);
	if (mission.state !== "AWAITING_HUMAN_APPROVAL") return json({ error: "INVALID_MISSION_STATE", state: mission.state }, 409);
	const approvalQuery = new URLSearchParams({ select: "approval_id,proposal_hash", mission_id: `eq.${missionId}`, user_id: `eq.${user.id}`, decision: "eq.PENDING", order: "created_at.desc", limit: "1" });
	const [approval] = await supabaseRest<Array<{ approval_id: string; proposal_hash: string | null }>>(env, `rill_approvals?${approvalQuery}`, {}, token);
	if (!approval) return json({ error: "APPROVAL_TICKET_NOT_FOUND" }, 409);
	if (approval.proposal_hash !== proposalHash) return json({ error: "PROPOSAL_HASH_MISMATCH" }, 409);
	const proposalQuery = new URLSearchParams({ select: "proposal", mission_id: `eq.${missionId}`, user_id: `eq.${user.id}`, proposal_hash: `eq.${proposalHash}`, limit: "1" });
	const [version] = await supabaseRest<Array<{ proposal: Record<string, unknown> }>>(env, `rill_proposal_versions?${proposalQuery}`, {}, token);
	if (!version || await sha256Hex(canonicalJson(version.proposal)) !== proposalHash) return json({ error: "PROPOSAL_INTEGRITY_FAILED" }, 409);
	const createdQuery = new URLSearchParams({ select: "payload", mission_id: `eq.${missionId}`, user_id: `eq.${user.id}`, event_type: "eq.MISSION_CREATED", limit: "1" });
	const [created] = await supabaseRest<Array<{ payload: Record<string, unknown> }>>(env, `rill_workflow_events?${createdQuery}`, {}, token);
	const proposalTraceId = typeof created?.payload?.traceId === "string" ? created.payload.traceId : null;

	return await withMissionTrace(env, ctx, {
		traceName: "rill-mission-decision",
		userId: user.id,
		sessionId: missionId,
		tags: ["rill-web", "hitl", mission.action, mission.domain],
		metadata: { decision },
	}, { decision, proposalHash, hasJustification: Boolean(justification) }, async ({ root, traceId }) => {
		const terminalState = decision === "APPROVED" ? "BLOCKED" : decision;
		// The mission row is the single atomic gate: a concurrent cancel or second decision loses here.
		const transitioned = await updateMission(env, user.id, missionId, { state: terminalState }, "AWAITING_HUMAN_APPROVAL");
		if (!transitioned) {
			root.update({ level: "WARNING", statusMessage: "MISSION_STATE_CHANGED" });
			return json({ error: "MISSION_STATE_CHANGED" }, 409);
		}
		const updated = await supabaseRest<Array<{ approval_id: string }>>(env, `rill_approvals?approval_id=eq.${approval.approval_id}&decision=eq.PENDING&select=approval_id`, {
			method: "PATCH",
			headers: { Prefer: "return=representation" },
			body: JSON.stringify({ decision, decided_by: user.id, justification: justification || null, decided_at: new Date().toISOString() }),
		});
		if (!updated.length) throw new Error("MISSION_PERSISTENCE_FAILED");
		await updateExecutionState(env, user.id, missionId, terminalState, decision === "APPROVED" ? "EXECUTOR_NOT_CONFIGURED" : "LOCKED");
		await recordEvent(env, user.id, missionId, "HUMAN_DECISION_RECORDED", terminalState, { approvalId: approval.approval_id, decision, decidedBy: user.id, proposalHash, traceId });
		if (decision === "APPROVED") {
			await recordEvent(env, user.id, missionId, "BLOCKED", "BLOCKED", { reason: "EXECUTOR_NOT_CONFIGURED", detail: "The approved proposal was not applied: no safe executor is configured for this runtime." });
		} else {
			await recordEvent(env, user.id, missionId, terminalState, terminalState, { reason: decision === "REJECTED" ? "HUMAN_REJECTED" : "HUMAN_REQUESTED_CHANGES" });
		}
		await recordAuditEvent(env, user.id, missionId, "HUMAN_DECISION", { approvalId: approval.approval_id, decision, justification: justification || null, proposalHash, resultingState: terminalState });
		root.update({ output: { decision, state: terminalState } });
		if (proposalTraceId) {
			const scoreFlush = recordHumanDecisionScore(env, { traceId: proposalTraceId, decision, justification: justification || undefined });
			if (scoreFlush) ctx?.waitUntil(scoreFlush);
		}
		return await getMission(env, user.id, missionId, token);
	});
}

async function cancelMission(request: Request, env: MissionRuntimeEnv, ctx: ExecutionContext | undefined, user: SupabaseUser, token: string, missionId: string): Promise<Response> {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "SUPABASE_SERVICE_ROLE_KEY_REQUIRED" }, 503);
	const parsed = await parseBody(request, 4_000);
	if ("response" in parsed) return parsed.response;
	const body = parsed.body as { reason?: unknown } | null;
	const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
	const mission = await loadMission(env, user.id, missionId, token);
	if (!mission) return json({ error: "MISSION_NOT_FOUND" }, 404);
	if (TERMINAL_STATES.has(mission.state)) return json({ error: "MISSION_ALREADY_TERMINAL", state: mission.state }, 409);

	return await withMissionTrace(env, ctx, {
		traceName: "rill-mission-cancel",
		userId: user.id,
		sessionId: missionId,
		tags: ["rill-web", mission.action, mission.domain],
	}, { previousState: mission.state, hasReason: Boolean(reason) }, async ({ root }) => {
		const changed = await updateMission(env, user.id, missionId, { state: "CANCELED" }, mission.state);
		if (!changed) {
			root.update({ level: "WARNING", statusMessage: "MISSION_STATE_CHANGED" });
			return json({ error: "MISSION_STATE_CHANGED" }, 409);
		}
		await updateExecutionState(env, user.id, missionId, "CANCELED", "LOCKED");
		await recordEvent(env, user.id, missionId, "CANCELED", "CANCELED", { previousState: mission.state, canceledBy: user.id, reason: reason || null });
		await recordAuditEvent(env, user.id, missionId, "MISSION_CANCELED", { previousState: mission.state, reason: reason || null });
		root.update({ output: { state: "CANCELED", previousState: mission.state } });
		return await getMission(env, user.id, missionId, token);
	});
}

export async function handleMissionApi(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
	const runtimeEnv = env as MissionRuntimeEnv;
	if (!runtimeEnv.SUPABASE_URL || !runtimeEnv.SUPABASE_PUBLISHABLE_KEY) return json({ error: "SUPABASE_NOT_CONFIGURED" }, 503);
	const auth = await authenticate(request, runtimeEnv);
	if (!auth) return json({ error: "UNAUTHENTICATED" }, 401);
	const { user, token } = auth;

	try {
		const url = new URL(request.url);
		if (url.pathname === "/api/missions" && request.method === "GET") return await listMissions(runtimeEnv, user.id, token);
		if (url.pathname === "/api/missions" && request.method === "POST") return await createMission(request, runtimeEnv, ctx, user, token);
		const match = url.pathname.match(/^\/api\/missions\/([0-9a-f-]{36})(?:\/(decision|cancel))?$/i);
		if (match && !match[2] && request.method === "GET") return await getMission(runtimeEnv, user.id, match[1], token);
		if (match?.[2] === "decision" && request.method === "POST") return await decideMission(request, runtimeEnv, ctx, user, token, match[1]);
		if (match?.[2] === "cancel" && request.method === "POST") return await cancelMission(request, runtimeEnv, ctx, user, token, match[1]);
		return json({ error: "NOT_FOUND" }, 404);
	} catch (error) {
		const code = error instanceof Error ? error.message : "UNKNOWN";
		console.error(JSON.stringify({ message: "mission runtime request failed", error: code }));
		const safeCode = code === "SUPABASE_SERVICE_ROLE_KEY_REQUIRED" || code === "MISSION_PERSISTENCE_FAILED" ? code : "MISSION_RUNTIME_UNAVAILABLE";
		return json({ error: safeCode }, 503);
	}
}
