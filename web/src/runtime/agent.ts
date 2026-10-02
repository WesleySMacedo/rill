import { supabase } from "../supabase";

/** The Rill Agent only ever listens on loopback; the browser never receives the Agent's personal token. */
export const AGENT_LOCAL_URL = "http://localhost:7777";
export const AGENT_DOWNLOAD_PATH = "/api/agent/download";

export interface AgentHealth {
	service: "rill-agent";
	version: string;
	platform: string;
	paired: boolean;
	connected: boolean;
	state: "not_paired" | "pairing" | "connected" | "disconnected";
}

export interface AgentLocalSession {
	sessionToken: string;
	expiresAt: string;
	machineId: string;
}

export interface AgentMachine {
	machineId: string;
	machineName: string;
	platform: string;
	agentVersion: string;
	workspaceCount: number;
	lastSeenAt: string | null;
	connected: boolean;
	createdAt: string;
}

export interface AgentPairingRequest {
	userCode: string;
	machineName: string;
	platform: string;
	agentVersion: string;
	expiresAt: string;
	requestedAt: string;
}

export class AgentRequestError extends Error {
	constructor(readonly code: string, message: string, readonly status: number) {
		super(message);
	}
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

async function unwrap<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => null)) as Envelope<T> | null;
	if (body?.ok) return body.data;
	throw new AgentRequestError(body && !body.ok ? body.error.code : "AGENT_REQUEST_FAILED", body && !body.ok ? body.error.message : `Request failed (${response.status}).`, response.status);
}

async function accessToken(): Promise<string> {
	if (!supabase) throw new AgentRequestError("AUTHENTICATION_REQUIRED", "Sign in to Rill first.", 401);
	const { data: { session } } = await supabase.auth.getSession();
	if (!session?.access_token) throw new AgentRequestError("AUTHENTICATION_REQUIRED", "Sign in to Rill first.", 401);
	return session.access_token;
}

async function rillAgentApi<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${await accessToken()}`);
	if (init.body) headers.set("Content-Type", "application/json");
	return unwrap<T>(await fetch(path, { ...init, headers }));
}

/** Returns null when no Agent answers on loopback (not installed, not running, or blocked by the browser). */
export async function detectAgent(timeoutMs = 1500): Promise<AgentHealth | null> {
	try {
		const response = await fetch(`${AGENT_LOCAL_URL}/v1/health`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
		const health = await unwrap<AgentHealth>(response);
		return health.service === "rill-agent" ? health : null;
	} catch {
		return null;
	}
}

/** Exchanges the Supabase session for a short-lived local session; the Agent verifies it with the Rill Worker. */
export async function openAgentSession(): Promise<AgentLocalSession> {
	const response = await fetch(`${AGENT_LOCAL_URL}/v1/session`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ accessToken: await accessToken() }),
		signal: AbortSignal.timeout(10_000),
	});
	return unwrap<AgentLocalSession>(response);
}

export async function closeAgentSession(sessionToken: string): Promise<void> {
	await fetch(`${AGENT_LOCAL_URL}/v1/session`, { method: "DELETE", headers: { Authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(3_000) }).catch(() => undefined);
}

export function lookupAgentPairing(userCode: string): Promise<AgentPairingRequest> {
	return rillAgentApi(`/api/agent/pairings/lookup?code=${encodeURIComponent(userCode)}`);
}

export function confirmAgentPairing(userCode: string, decision: "APPROVE" | "DENY"): Promise<{ status: "APPROVED" | "DENIED"; machineName: string }> {
	return rillAgentApi("/api/agent/pairings/confirm", { method: "POST", body: JSON.stringify({ userCode, decision }) });
}

export function listAgentMachines(): Promise<{ machines: AgentMachine[] }> {
	return rillAgentApi("/api/agent/machines");
}

export function revokeAgentMachine(machineId: string): Promise<{ revoked: boolean }> {
	return rillAgentApi(`/api/agent/machines/${encodeURIComponent(machineId)}`, { method: "DELETE" });
}
