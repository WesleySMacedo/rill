import { authenticate, fetchSupabaseUser } from "./mission-api";

/**
 * Rill Agent control API.
 *
 * Pairing follows the OAuth device-authorization pattern: the Agent obtains a
 * device code + short user code, the signed-in user confirms the code in Rill Web,
 * and the Agent exchanges the device code once for a personal token bound to the
 * machine. Codes and tokens are only ever stored as sha256 hashes.
 */

type AgentEnv = Env & { SUPABASE_SERVICE_ROLE_KEY?: string; RILL_AGENT_DOWNLOAD_URL?: string };

interface PairingRow {
	pairing_id: string;
	machine_name: string;
	platform: string;
	agent_version: string;
	status: "PENDING" | "APPROVED" | "DENIED" | "CONSUMED";
	user_id: string | null;
	expires_at: string;
	created_at: string;
}

interface MachineRow {
	machine_id: string;
	user_id: string;
	machine_name: string;
	platform: string;
	agent_version: string;
	workspace_count: number;
	last_seen_at: string | null;
	revoked_at: string | null;
	created_at: string;
}

interface TokenRow {
	token_id: string;
	user_id: string;
	machine_id: string;
}

class AgentApiError extends Error {
	constructor(readonly code: string, message: string, readonly status: number) {
		super(message);
	}
}

const PAIRING_TTL_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 3;
const CONNECTED_WINDOW_MS = 90_000;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const TOKEN_PREFIX = "rill_pat_";
const MAX_BODY_BYTES = 16_384;

function ok(data: unknown, status = 200): Response {
	return Response.json({ ok: true, data }, { status, headers: { "Cache-Control": "no-store" } });
}

function fail(code: string, message: string, status: number): Response {
	return Response.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomSecret(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Unbiased user code (rejection sampling) formatted as XXXX-XXXX, without vowels to avoid words. */
export function generateUserCode(): string {
	const characters: string[] = [];
	const limit = 256 - (256 % USER_CODE_ALPHABET.length);
	while (characters.length < 8) {
		for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
			if (byte < limit && characters.length < 8) characters.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]!);
		}
	}
	return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

export function normalizeUserCode(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const compact = input.toUpperCase().replace(/[^A-Z]/g, "");
	if (compact.length !== 8 || [...compact].some((character) => !USER_CODE_ALPHABET.includes(character))) return null;
	return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

async function rest<T>(env: AgentEnv, path: string, init: RequestInit = {}): Promise<T> {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new AgentApiError("SUPABASE_SERVICE_ROLE_KEY_REQUIRED", "Agent persistence is not configured.", 503);
	const headers = new Headers(init.headers);
	headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY);
	headers.set("Authorization", `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
	headers.set("Content-Type", "application/json");
	const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, { ...init, headers });
	if (!response.ok) {
		console.error(JSON.stringify({ message: "supabase agent request failed", path: path.split("?")[0], status: response.status }));
		throw new AgentApiError("AGENT_PERSISTENCE_FAILED", "Agent persistence failed.", 503);
	}
	if (response.status === 204 || headers.get("Prefer")?.includes("return=minimal")) return undefined as T;
	return (await response.json()) as T;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) throw new AgentApiError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) throw new AgentApiError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
	try {
		const value = JSON.parse(text || "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		return value as Record<string, unknown>;
	} catch {
		throw new AgentApiError("INVALID_REQUEST", "Request body must be a JSON object.", 400);
	}
}

function boundedText(value: unknown, field: string, max: number): string {
	const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
	if (!text || text.length > max) throw new AgentApiError("INVALID_REQUEST", `${field} is required (max ${max} characters).`, 400);
	return text;
}

function appUrl(env: AgentEnv, request: Request): string {
	return (env.RILL_APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

async function requireUser(request: Request, env: AgentEnv) {
	const auth = await authenticate(request, env);
	if (!auth) throw new AgentApiError("UNAUTHORIZED", "Sign in to Rill first.", 401);
	return auth.user;
}

/** Resolves an Agent personal token. Revoked tokens and revoked machines are rejected. */
async function requireAgentToken(request: Request, env: AgentEnv): Promise<TokenRow> {
	const authorization = request.headers.get("Authorization") ?? "";
	const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
	if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) throw new AgentApiError("AGENT_TOKEN_INVALID", "Invalid Agent token.", 401);
	const rows = await rest<TokenRow[]>(
		env,
		`rill_personal_tokens?${new URLSearchParams({ token_hash: `eq.${await sha256Hex(token)}`, revoked_at: "is.null", select: "token_id,user_id,machine_id", limit: "1" })}`,
	);
	const row = rows[0];
	if (!row) throw new AgentApiError("AGENT_TOKEN_INVALID", "Invalid Agent token.", 401);
	const machines = await rest<Array<{ machine_id: string }>>(
		env,
		`rill_agent_machines?${new URLSearchParams({ machine_id: `eq.${row.machine_id}`, user_id: `eq.${row.user_id}`, revoked_at: "is.null", select: "machine_id" })}`,
	);
	if (!machines[0]) throw new AgentApiError("AGENT_TOKEN_INVALID", "This machine was revoked.", 401);
	return row;
}

async function lookupEmail(env: AgentEnv, userId: string): Promise<string | null> {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
	try {
		const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
			headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
		});
		if (!response.ok) return null;
		const user = (await response.json()) as { email?: string };
		return typeof user.email === "string" ? user.email : null;
	} catch {
		return null;
	}
}

async function createPairing(request: Request, env: AgentEnv, ctx: ExecutionContext): Promise<Response> {
	const body = await readJson(request);
	const machineName = boundedText(body.machineName, "machineName", 120);
	const platform = boundedText(body.platform, "platform", 60);
	const agentVersion = boundedText(body.agentVersion, "agentVersion", 40);
	const deviceCode = randomSecret(32);
	const userCode = generateUserCode();
	const expiresAt = new Date(Date.now() + PAIRING_TTL_SECONDS * 1000).toISOString();
	await rest(env, "rill_agent_pairings", {
		method: "POST",
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify({
			device_code_hash: await sha256Hex(deviceCode),
			user_code_hash: await sha256Hex(userCode),
			machine_name: machineName,
			platform,
			agent_version: agentVersion,
			expires_at: expiresAt,
		}),
	});
	const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	ctx.waitUntil(rest(env, `rill_agent_pairings?expires_at=lt.${encodeURIComponent(staleBefore)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => undefined));
	const verificationUri = `${appUrl(env, request)}/agent/pair`;
	return ok(
		{
			deviceCode,
			userCode,
			verificationUri,
			verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
			expiresIn: PAIRING_TTL_SECONDS,
			interval: POLL_INTERVAL_SECONDS,
		},
		201,
	);
}

async function pollPairing(request: Request, env: AgentEnv): Promise<Response> {
	const body = await readJson(request);
	const deviceCode = typeof body.deviceCode === "string" && body.deviceCode.length <= 200 ? body.deviceCode : "";
	if (!deviceCode) throw new AgentApiError("INVALID_REQUEST", "deviceCode is required.", 400);
	const deviceHash = await sha256Hex(deviceCode);
	const rows = await rest<PairingRow[]>(env, `rill_agent_pairings?${new URLSearchParams({ device_code_hash: `eq.${deviceHash}`, select: "*", limit: "1" })}`);
	const pairing = rows[0];
	if (!pairing) throw new AgentApiError("PAIRING_NOT_FOUND", "Unknown pairing.", 404);
	if (pairing.status === "CONSUMED") throw new AgentApiError("PAIRING_ALREADY_USED", "This pairing was already completed.", 409);
	if (pairing.status === "DENIED") return ok({ status: "DENIED" });
	if (pairing.status === "PENDING") {
		if (Date.parse(pairing.expires_at) <= Date.now()) return fail("PAIRING_EXPIRED", "The pairing code expired.", 410);
		return ok({ status: "PENDING" });
	}

	// APPROVED → CONSUMED is a compare-and-swap so a device code yields exactly one token.
	const claimed = await rest<Array<{ pairing_id: string }>>(
		env,
		`rill_agent_pairings?${new URLSearchParams({ pairing_id: `eq.${pairing.pairing_id}`, status: "eq.APPROVED", select: "pairing_id" })}`,
		{ method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "CONSUMED" }) },
	);
	if (!claimed[0] || !pairing.user_id) throw new AgentApiError("PAIRING_ALREADY_USED", "This pairing was already completed.", 409);

	const machines = await rest<MachineRow[]>(env, "rill_agent_machines", {
		method: "POST",
		headers: { Prefer: "return=representation" },
		body: JSON.stringify({
			user_id: pairing.user_id,
			machine_name: pairing.machine_name,
			platform: pairing.platform,
			agent_version: pairing.agent_version,
			last_seen_at: new Date().toISOString(),
		}),
	});
	const machine = machines[0];
	if (!machine) throw new AgentApiError("AGENT_PERSISTENCE_FAILED", "Agent persistence failed.", 503);
	const token = `${TOKEN_PREFIX}${randomSecret(32)}`;
	await rest(env, "rill_personal_tokens", {
		method: "POST",
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify({
			user_id: pairing.user_id,
			machine_id: machine.machine_id,
			token_hash: await sha256Hex(token),
			token_prefix: token.slice(0, TOKEN_PREFIX.length + 4),
		}),
	});
	return ok({ status: "APPROVED", token, machineId: machine.machine_id, userId: pairing.user_id, email: await lookupEmail(env, pairing.user_id) });
}

async function findPendingPairing(env: AgentEnv, userCode: string): Promise<PairingRow | null> {
	const rows = await rest<PairingRow[]>(
		env,
		`rill_agent_pairings?${new URLSearchParams({ user_code_hash: `eq.${await sha256Hex(userCode)}`, select: "pairing_id,machine_name,platform,agent_version,status,user_id,expires_at,created_at", limit: "1" })}`,
	);
	return rows[0] ?? null;
}

async function lookupPairing(request: Request, env: AgentEnv): Promise<Response> {
	await requireUser(request, env);
	const userCode = normalizeUserCode(new URL(request.url).searchParams.get("code"));
	if (!userCode) throw new AgentApiError("INVALID_CODE", "Enter the 8-letter code shown by Rill Agent.", 400);
	const pairing = await findPendingPairing(env, userCode);
	if (!pairing || pairing.status !== "PENDING") throw new AgentApiError("PAIRING_NOT_FOUND", "This code is not waiting for approval.", 404);
	if (Date.parse(pairing.expires_at) <= Date.now()) throw new AgentApiError("PAIRING_EXPIRED", "The pairing code expired. Start pairing again from the Agent.", 410);
	return ok({ userCode, machineName: pairing.machine_name, platform: pairing.platform, agentVersion: pairing.agent_version, expiresAt: pairing.expires_at, requestedAt: pairing.created_at });
}

async function confirmPairing(request: Request, env: AgentEnv): Promise<Response> {
	const user = await requireUser(request, env);
	const body = await readJson(request);
	const userCode = normalizeUserCode(body.userCode);
	if (!userCode) throw new AgentApiError("INVALID_CODE", "Enter the 8-letter code shown by Rill Agent.", 400);
	if (body.decision !== "APPROVE" && body.decision !== "DENY") throw new AgentApiError("INVALID_REQUEST", "decision must be APPROVE or DENY.", 400);
	const status = body.decision === "APPROVE" ? "APPROVED" : "DENIED";
	const rows = await rest<Array<{ pairing_id: string; machine_name: string }>>(
		env,
		`rill_agent_pairings?${new URLSearchParams({
			user_code_hash: `eq.${await sha256Hex(userCode)}`,
			status: "eq.PENDING",
			expires_at: `gt.${new Date().toISOString()}`,
			select: "pairing_id,machine_name",
		})}`,
		{ method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status, user_id: user.id, decided_at: new Date().toISOString() }) },
	);
	if (!rows[0]) throw new AgentApiError("PAIRING_NOT_FOUND", "This code is not waiting for approval or has expired.", 404);
	return ok({ status, machineName: rows[0].machine_name });
}

async function heartbeat(request: Request, env: AgentEnv): Promise<Response> {
	const token = await requireAgentToken(request, env);
	const body = await readJson(request);
	const now = new Date().toISOString();
	const patch: Record<string, unknown> = { last_seen_at: now };
	if (typeof body.agentVersion === "string" && body.agentVersion.length <= 40) patch.agent_version = body.agentVersion;
	if (typeof body.machineName === "string" && body.machineName.trim() && body.machineName.length <= 120) patch.machine_name = body.machineName.trim();
	if (typeof body.workspaceCount === "number" && Number.isInteger(body.workspaceCount) && body.workspaceCount >= 0 && body.workspaceCount < 10_000) patch.workspace_count = body.workspaceCount;
	await rest(env, `rill_agent_machines?${new URLSearchParams({ machine_id: `eq.${token.machine_id}`, user_id: `eq.${token.user_id}` })}`, {
		method: "PATCH",
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify(patch),
	});
	await rest(env, `rill_personal_tokens?${new URLSearchParams({ token_id: `eq.${token.token_id}` })}`, {
		method: "PATCH",
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify({ last_used_at: now }),
	});
	return ok({ machineId: token.machine_id, userId: token.user_id, email: null });
}

/** Lets the local Agent confirm that the browser user is the user who paired the machine. */
async function verifySession(request: Request, env: AgentEnv): Promise<Response> {
	const token = await requireAgentToken(request, env);
	const body = await readJson(request);
	const accessToken = typeof body.accessToken === "string" && body.accessToken.length <= 8192 ? body.accessToken : "";
	const user = accessToken ? await fetchSupabaseUser(env, accessToken) : null;
	if (!user) throw new AgentApiError("SESSION_INVALID", "The Rill session is invalid or expired.", 403);
	if (user.id !== token.user_id) throw new AgentApiError("SESSION_USER_MISMATCH", "This Agent is paired with a different Rill account.", 403);
	await rest(env, `rill_agent_machines?${new URLSearchParams({ machine_id: `eq.${token.machine_id}` })}`, {
		method: "PATCH",
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
	});
	return ok({ machineId: token.machine_id, userId: user.id, email: user.email ?? null });
}

async function listMachines(request: Request, env: AgentEnv): Promise<Response> {
	const user = await requireUser(request, env);
	const rows = await rest<MachineRow[]>(
		env,
		`rill_agent_machines?${new URLSearchParams({ user_id: `eq.${user.id}`, revoked_at: "is.null", select: "*", order: "created_at.desc" })}`,
	);
	const now = Date.now();
	return ok({
		machines: rows.map((row) => ({
			machineId: row.machine_id,
			machineName: row.machine_name,
			platform: row.platform,
			agentVersion: row.agent_version,
			workspaceCount: row.workspace_count,
			lastSeenAt: row.last_seen_at,
			connected: row.last_seen_at !== null && now - Date.parse(row.last_seen_at) < CONNECTED_WINDOW_MS,
			createdAt: row.created_at,
		})),
	});
}

async function revokeMachine(request: Request, env: AgentEnv, machineId: string): Promise<Response> {
	const user = await requireUser(request, env);
	if (!/^[0-9a-f-]{36}$/i.test(machineId)) throw new AgentApiError("MACHINE_NOT_FOUND", "Machine not found.", 404);
	const now = new Date().toISOString();
	const rows = await rest<Array<{ machine_id: string }>>(
		env,
		`rill_agent_machines?${new URLSearchParams({ machine_id: `eq.${machineId}`, user_id: `eq.${user.id}`, revoked_at: "is.null", select: "machine_id" })}`,
		{ method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ revoked_at: now }) },
	);
	if (!rows[0]) throw new AgentApiError("MACHINE_NOT_FOUND", "Machine not found.", 404);
	await rest(env, `rill_personal_tokens?${new URLSearchParams({ machine_id: `eq.${machineId}`, user_id: `eq.${user.id}`, revoked_at: "is.null" })}`, {
		method: "PATCH",
		headers: { Prefer: "return=minimal" },
		body: JSON.stringify({ revoked_at: now }),
	});
	return ok({ revoked: true });
}

function download(env: AgentEnv): Response {
	const target = env.RILL_AGENT_DOWNLOAD_URL;
	if (!target || !/^https:\/\//.test(target)) return fail("AGENT_DOWNLOAD_NOT_CONFIGURED", "The Rill Agent installer is not published yet.", 503);
	return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
}

export async function handleAgentApi(request: Request, env: AgentEnv, ctx: ExecutionContext): Promise<Response> {
	const { pathname } = new URL(request.url);
	const method = request.method.toUpperCase();
	try {
		if (pathname === "/api/agent/download" && method === "GET") return download(env);
		if (pathname === "/api/agent/pairings" && method === "POST") return await createPairing(request, env, ctx);
		if (pathname === "/api/agent/pairings/poll" && method === "POST") return await pollPairing(request, env);
		if (pathname === "/api/agent/pairings/lookup" && method === "GET") return await lookupPairing(request, env);
		if (pathname === "/api/agent/pairings/confirm" && method === "POST") return await confirmPairing(request, env);
		if (pathname === "/api/agent/heartbeat" && method === "POST") return await heartbeat(request, env);
		if (pathname === "/api/agent/sessions/verify" && method === "POST") return await verifySession(request, env);
		if (pathname === "/api/agent/machines" && method === "GET") return await listMachines(request, env);
		const machineMatch = /^\/api\/agent\/machines\/([^/]+)$/.exec(pathname);
		if (machineMatch && method === "DELETE") return await revokeMachine(request, env, decodeURIComponent(machineMatch[1]!));
		return fail("NOT_FOUND", "Route not found.", 404);
	} catch (error) {
		if (error instanceof AgentApiError) return fail(error.code, error.message, error.status);
		console.error(JSON.stringify({ message: "agent api failure", path: pathname, error: error instanceof Error ? error.message : "unknown" }));
		return fail("AGENT_API_FAILED", "Unexpected Agent API failure.", 500);
	}
}
