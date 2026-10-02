import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../supabase";

export interface MissionRecord {
	id: string;
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
	context_manifest?: { targetFiles?: string[]; estimatedContextSize?: number; includedItems?: Array<{ path: string; category: string; reason: string }> };
	plan?: string[];
	created_at: string;
}

export interface MissionEvent {
	event_id: string;
	mission_id: string;
	event_type: string;
	state: string;
	payload: Record<string, unknown>;
	created_at: string;
}

export type HumanDecision = "APPROVED" | "REJECTED" | "REQUESTED_CHANGES";

export interface ApprovalRecord {
	approval_id: string;
	mission_id: string;
	decision: "PENDING" | HumanDecision;
	decided_by: string | null;
	justification: string | null;
	proposal_hash: string | null;
	created_at: string;
	decided_at: string | null;
}

export interface PatchProposal {
	missionId: string;
	action: string;
	domain: string;
	summary: string;
	targetFiles: string[];
	proposedChanges: string[];
	acceptanceCriteria: string[];
	risks: string[];
	testsRecommended: string[];
}

export interface ProposalVersionRecord {
	proposal_version_id: string;
	version: number;
	proposal_hash: string;
	proposal: PatchProposal;
	created_at: string;
}

export interface MissionDetails {
	mission: MissionRecord;
	events: MissionEvent[];
	auditEvents: Array<{ audit_event_id: string; event_type: string; actor_id: string | null; details: Record<string, unknown>; created_at: string }>;
	approval: ApprovalRecord | null;
	proposal: ProposalVersionRecord | null;
}

export const TERMINAL_MISSION_STATES = new Set(["COMPLETED", "BLOCKED", "FAILED", "REJECTED", "REQUESTED_CHANGES", "CANCELED"]);

export interface CreateMissionPayload {
	task: string;
	targetPath: string;
	contextPaths: string[];
	workspaceFiles: Array<{ path: string; size: number }>;
	clientRequestId: string;
}

const ERROR_MESSAGES: Record<string, string> = {
	SUPABASE_NOT_CONFIGURED: "Supabase is not configured for the Worker.",
	UNAUTHENTICATED: "Your session is no longer valid. Sign in again.",
	SUPABASE_SERVICE_ROLE_KEY_REQUIRED: "Mission writes are disabled until the Cloudflare SUPABASE_SERVICE_ROLE_KEY secret is configured.",
	MISSION_PERSISTENCE_FAILED: "Mission persistence is unavailable. Apply the Rill Supabase migration and verify the Worker Supabase configuration.",
	MISSION_RUNTIME_UNAVAILABLE: "The mission runtime is unavailable. Check Worker logs and Supabase connectivity.",
	PROPOSAL_RUNTIME_NOT_CONFIGURED: "The OpenRouter model runtime is not configured. No proposal, approval ticket, or mutation was started.",
	CONTEXT_NOT_READY: "The Context Resolver rejected the requested scope. Select an allowed target file.",
	REGISTRY_POLICY_REJECTED: "The Engineering Registry does not authorize this action for the resolved domain.",
	PLANNING_BLOCKED: "Planning was blocked by policy.",
	WORKSPACE_TARGET_MISSING: "The target file is not present in the opened workspace.",
	INVALID_CONTEXT_PATHS: "One or more selected context files are not present in the workspace (max 6).",
	JUSTIFICATION_REQUIRED: "A justification is required to reject or request changes.",
	PROPOSAL_HASH_MISMATCH: "The proposal changed since it was displayed. Reload the mission before deciding.",
	PROPOSAL_INTEGRITY_FAILED: "The stored proposal failed its integrity check. The decision was not recorded.",
	APPROVAL_TICKET_NOT_FOUND: "No pending approval ticket exists for this mission.",
	INVALID_MISSION_STATE: "The mission is no longer awaiting a human decision.",
	MISSION_STATE_CHANGED: "The mission state changed concurrently. Reload and try again.",
	MISSION_ALREADY_TERMINAL: "The mission is already in a terminal state.",
	MISSION_NOT_FOUND: "Mission not found.",
	REQUEST_TOO_LARGE: "The request is too large.",
	INVALID_REQUEST: "The request is invalid.",
};

export function missionErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) return "Mission request failed.";
	return ERROR_MESSAGES[error.message] ?? error.message;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
	if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
	const { data: { session }, error: sessionError } = await supabase.auth.getSession();
	if (sessionError || !session?.access_token) throw new Error("AUTHENTICATION_REQUIRED");
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${session.access_token}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const response = await fetch(path, { ...init, headers, cache: "no-store" });
	const payload = await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
	if (!response.ok) throw new Error(payload.error ?? `MISSION_API_${response.status}`);
	return payload;
}

export function listMissions(): Promise<{ missions: MissionRecord[] }> {
	return apiRequest("/api/missions");
}

export function createMission(payload: CreateMissionPayload): Promise<MissionDetails> {
	return apiRequest("/api/missions", { method: "POST", body: JSON.stringify(payload) });
}

export function getMission(missionId: string): Promise<MissionDetails> {
	return apiRequest(`/api/missions/${encodeURIComponent(missionId)}`);
}

export function decideMission(missionId: string, payload: { decision: HumanDecision; justification: string; proposalHash: string }): Promise<MissionDetails> {
	return apiRequest(`/api/missions/${encodeURIComponent(missionId)}/decision`, { method: "POST", body: JSON.stringify(payload) });
}

export function cancelMission(missionId: string, reason: string): Promise<MissionDetails> {
	return apiRequest(`/api/missions/${encodeURIComponent(missionId)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
}

export function subscribeToMission(missionId: string, onChange: () => void): (() => void) | null {
	const client = supabase;
	if (!client) return null;
	const channel: RealtimeChannel = client
		.channel(`rill-mission-${missionId}`)
		.on("postgres_changes", {
			event: "*",
			schema: "public",
			table: "rill_workflow_events",
			filter: `mission_id=eq.${missionId}`,
		}, onChange)
		.on("postgres_changes", {
			event: "UPDATE",
			schema: "public",
			table: "rill_missions",
			filter: `id=eq.${missionId}`,
		}, onChange)
		.subscribe();
	return () => { void client.removeChannel(channel); };
}