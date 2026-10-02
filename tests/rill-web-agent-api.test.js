import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUserCode, handleAgentApi, normalizeUserCode } from "../web/src/runtime/agent-api.ts";

const SUPABASE = "https://supabase.example.test";
const env = {
	SUPABASE_URL: SUPABASE,
	SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
	SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
	RILL_APP_URL: "https://rill.example.test",
	RILL_AGENT_DOWNLOAD_URL: "https://github.com/WesleySMacedo/rill/releases/latest/download/Rill-Agent-Setup.exe",
};
const users = {
	"user-token-1": { id: "11111111-1111-4111-8111-111111111111", email: "one@example.test" },
	"user-token-2": { id: "22222222-2222-4222-8222-222222222222", email: "two@example.test" },
};
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

/** Minimal in-memory PostgREST + Supabase Auth double supporting the filters agent-api uses. */
function createFakeSupabase() {
	const tables = { rill_agent_pairings: [], rill_agent_machines: [], rill_personal_tokens: [] };
	const defaults = {
		rill_agent_pairings: () => ({ pairing_id: randomUUID(), status: "PENDING", user_id: null, decided_at: null, created_at: new Date().toISOString() }),
		rill_agent_machines: () => ({ machine_id: randomUUID(), workspace_count: 0, revoked_at: null, created_at: new Date().toISOString() }),
		rill_personal_tokens: () => ({ token_id: randomUUID(), revoked_at: null, last_used_at: null, created_at: new Date().toISOString() }),
	};
	const matches = (row, params) => {
		for (const [column, filter] of params) {
			if (["select", "limit", "order"].includes(column)) continue;
			const value = row[column] ?? null;
			if (filter === "is.null") { if (value !== null) return false; }
			else if (filter.startsWith("eq.")) { if (String(value) !== filter.slice(3)) return false; }
			else if (filter.startsWith("gt.")) { if (!(value !== null && Date.parse(value) > Date.parse(filter.slice(3)))) return false; }
			else if (filter.startsWith("lt.")) { if (!(value !== null && Date.parse(value) < Date.parse(filter.slice(3)))) return false; }
			else throw new Error(`unsupported filter ${column}=${filter}`);
		}
		return true;
	};
	const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

	const fetcher = vi.fn(async (input, init = {}) => {
		const url = new URL(String(input));
		const headers = new Headers(init.headers);
		const bearer = (headers.get("Authorization") ?? "").replace(/^Bearer /, "");
		if (url.pathname === "/auth/v1/user") {
			const user = users[bearer];
			return user ? json(user) : json({ message: "invalid" }, 401);
		}
		if (url.pathname.startsWith("/auth/v1/admin/users/")) {
			if (bearer !== env.SUPABASE_SERVICE_ROLE_KEY) return json({}, 403);
			const id = decodeURIComponent(url.pathname.split("/").pop());
			const user = Object.values(users).find((candidate) => candidate.id === id);
			return user ? json(user) : json({}, 404);
		}
		if (!url.pathname.startsWith("/rest/v1/")) return json({}, 404);
		if (bearer !== env.SUPABASE_SERVICE_ROLE_KEY || headers.get("apikey") !== env.SUPABASE_SERVICE_ROLE_KEY) return json({}, 401);
		const table = url.pathname.slice("/rest/v1/".length);
		const rows = tables[table];
		if (!rows) return json({}, 404);
		const params = [...url.searchParams.entries()];
		const method = (init.method ?? "GET").toUpperCase();
		const minimal = headers.get("Prefer")?.includes("return=minimal");
		if (method === "GET") return json(rows.filter((row) => matches(row, params)));
		if (method === "POST") {
			const row = { ...defaults[table](), ...JSON.parse(init.body) };
			rows.push(row);
			return minimal ? new Response(null, { status: 201 }) : json([row], 201);
		}
		if (method === "PATCH") {
			const patch = JSON.parse(init.body);
			const updated = rows.filter((row) => matches(row, params)).map((row) => Object.assign(row, patch));
			return minimal ? new Response(null, { status: 204 }) : json(updated);
		}
		if (method === "DELETE") {
			tables[table] = rows.filter((row) => !matches(row, params));
			return new Response(null, { status: 204 });
		}
		return json({}, 405);
	});
	return { tables, fetcher };
}

function call(method, path, { body, token } = {}) {
	const headers = new Headers();
	if (body !== undefined) headers.set("Content-Type", "application/json");
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return handleAgentApi(new Request(`https://rill.example.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
}

const machine = { machineName: "WESLEY-PC", platform: "win32-x64", agentVersion: "0.1.0" };

async function startPairing() {
	const response = await call("POST", "/api/agent/pairings", { body: machine });
	expect(response.status).toBe(201);
	return (await response.json()).data;
}

async function pairAs(userToken) {
	const pairing = await startPairing();
	const confirm = await call("POST", "/api/agent/pairings/confirm", { token: userToken, body: { userCode: pairing.userCode, decision: "APPROVE" } });
	expect(confirm.status).toBe(200);
	const poll = await call("POST", "/api/agent/pairings/poll", { body: { deviceCode: pairing.deviceCode } });
	expect(poll.status).toBe(200);
	return { pairing, result: (await poll.json()).data };
}

let fake;
beforeEach(() => {
	fake = createFakeSupabase();
	vi.stubGlobal("fetch", fake.fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("Rill Agent user codes", () => {
	it("generates unambiguous XXXX-XXXX codes and normalizes user input", () => {
		for (let index = 0; index < 50; index += 1) expect(generateUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
		expect(normalizeUserCode(" bcdf ghjk ")).toBe("BCDF-GHJK");
		expect(normalizeUserCode("BCDF-GHJA")).toBeNull();
		expect(normalizeUserCode("BCD")).toBeNull();
		expect(normalizeUserCode(42)).toBeNull();
	});
});

describe("Rill Agent pairing (device authorization)", () => {
	it("pairs a machine end to end and stores only hashes", async () => {
		const pairing = await startPairing();
		expect(pairing.verificationUri).toBe("https://rill.example.test/agent/pair");
		expect(pairing.verificationUriComplete).toBe(`https://rill.example.test/agent/pair?code=${pairing.userCode}`);
		expect(pairing.interval).toBeGreaterThan(0);

		const pending = await call("POST", "/api/agent/pairings/poll", { body: { deviceCode: pairing.deviceCode } });
		expect((await pending.json()).data).toEqual({ status: "PENDING" });

		const lookup = await call("GET", `/api/agent/pairings/lookup?code=${pairing.userCode.toLowerCase()}`, { token: "user-token-1" });
		expect(lookup.status).toBe(200);
		expect((await lookup.json()).data).toMatchObject({ userCode: pairing.userCode, machineName: "WESLEY-PC", platform: "win32-x64" });

		const confirm = await call("POST", "/api/agent/pairings/confirm", { token: "user-token-1", body: { userCode: pairing.userCode, decision: "APPROVE" } });
		expect((await confirm.json()).data).toEqual({ status: "APPROVED", machineName: "WESLEY-PC" });

		const approved = await call("POST", "/api/agent/pairings/poll", { body: { deviceCode: pairing.deviceCode } });
		const data = (await approved.json()).data;
		expect(data).toMatchObject({ status: "APPROVED", userId: users["user-token-1"].id, email: "one@example.test" });
		expect(data.token).toMatch(/^rill_pat_[A-Za-z0-9_-]{40,}$/);

		const serialized = JSON.stringify(fake.tables);
		expect(serialized).not.toContain(pairing.deviceCode);
		expect(serialized).not.toContain(pairing.userCode);
		expect(serialized).not.toContain(data.token);
		expect(fake.tables.rill_personal_tokens[0]).toMatchObject({ machine_id: data.machineId, user_id: data.userId, token_prefix: data.token.slice(0, 13) });

		const replay = await call("POST", "/api/agent/pairings/poll", { body: { deviceCode: pairing.deviceCode } });
		expect(replay.status).toBe(409);
		expect((await replay.json()).error.code).toBe("PAIRING_ALREADY_USED");
		expect(fake.tables.rill_personal_tokens).toHaveLength(1);
	});

	it("requires a signed-in user to look up or confirm a code", async () => {
		const pairing = await startPairing();
		expect((await call("GET", `/api/agent/pairings/lookup?code=${pairing.userCode}`)).status).toBe(401);
		const confirm = await call("POST", "/api/agent/pairings/confirm", { token: "forged", body: { userCode: pairing.userCode, decision: "APPROVE" } });
		expect(confirm.status).toBe(401);
		expect(fake.tables.rill_agent_pairings[0].status).toBe("PENDING");
	});

	it("reports denial to the Agent without issuing a token", async () => {
		const pairing = await startPairing();
		await call("POST", "/api/agent/pairings/confirm", { token: "user-token-1", body: { userCode: pairing.userCode, decision: "DENY" } });
		const poll = await call("POST", "/api/agent/pairings/poll", { body: { deviceCode: pairing.deviceCode } });
		expect((await poll.json()).data).toEqual({ status: "DENIED" });
		expect(fake.tables.rill_personal_tokens).toHaveLength(0);
	});

	it("expires pending codes for both the Agent and the browser", async () => {
		const pairing = await startPairing();
		fake.tables.rill_agent_pairings[0].expires_at = new Date(Date.now() - 1000).toISOString();
		const poll = await call("POST", "/api/agent/pairings/poll", { body: { deviceCode: pairing.deviceCode } });
		expect(poll.status).toBe(410);
		expect((await poll.json()).error.code).toBe("PAIRING_EXPIRED");
		expect((await call("GET", `/api/agent/pairings/lookup?code=${pairing.userCode}`, { token: "user-token-1" })).status).toBe(410);
		const confirm = await call("POST", "/api/agent/pairings/confirm", { token: "user-token-1", body: { userCode: pairing.userCode, decision: "APPROVE" } });
		expect(confirm.status).toBe(404);
	});

	it("rejects malformed pairing input", async () => {
		expect((await call("POST", "/api/agent/pairings", { body: { machineName: "", platform: "win32", agentVersion: "0.1.0" } })).status).toBe(400);
		expect((await call("POST", "/api/agent/pairings/poll", { body: {} })).status).toBe(400);
		expect((await call("POST", "/api/agent/pairings/poll", { body: { deviceCode: "unknown" } })).status).toBe(404);
		const badDecision = await call("POST", "/api/agent/pairings/confirm", { token: "user-token-1", body: { userCode: "BCDF-GHJK", decision: "MAYBE" } });
		expect(badDecision.status).toBe(400);
	});
});

describe("Rill Agent personal token", () => {
	it("authenticates heartbeats and updates machine presence", async () => {
		const { result } = await pairAs("user-token-1");
		const response = await call("POST", "/api/agent/heartbeat", { token: result.token, body: { agentVersion: "0.1.1", workspaceCount: 3 } });
		expect(response.status).toBe(200);
		expect((await response.json()).data).toEqual({ machineId: result.machineId, userId: result.userId, email: null });
		expect(fake.tables.rill_agent_machines[0]).toMatchObject({ agent_version: "0.1.1", workspace_count: 3 });

		const machines = await call("GET", "/api/agent/machines", { token: "user-token-1" });
		expect((await machines.json()).data.machines).toEqual([expect.objectContaining({ machineId: result.machineId, connected: true, workspaceCount: 3 })]);
		const otherUser = await call("GET", "/api/agent/machines", { token: "user-token-2" });
		expect((await otherUser.json()).data.machines).toEqual([]);
	});

	it("rejects tokens that were not issued by pairing", async () => {
		await pairAs("user-token-1");
		expect((await call("POST", "/api/agent/heartbeat", { body: {} })).status).toBe(401);
		const forged = await call("POST", "/api/agent/heartbeat", { token: "rill_pat_forged", body: {} });
		expect(forged.status).toBe(401);
		expect((await forged.json()).error.code).toBe("AGENT_TOKEN_INVALID");
		expect((await call("POST", "/api/agent/heartbeat", { token: "user-token-1", body: {} })).status).toBe(401);
	});

	it("verifies that the browser session belongs to the paired user", async () => {
		const { result } = await pairAs("user-token-1");
		const same = await call("POST", "/api/agent/sessions/verify", { token: result.token, body: { accessToken: "user-token-1" } });
		expect((await same.json()).data).toEqual({ machineId: result.machineId, userId: result.userId, email: "one@example.test" });

		const other = await call("POST", "/api/agent/sessions/verify", { token: result.token, body: { accessToken: "user-token-2" } });
		expect(other.status).toBe(403);
		expect((await other.json()).error.code).toBe("SESSION_USER_MISMATCH");

		const invalid = await call("POST", "/api/agent/sessions/verify", { token: result.token, body: { accessToken: "expired" } });
		expect(invalid.status).toBe(403);
		expect((await invalid.json()).error.code).toBe("SESSION_INVALID");
	});

	it("revokes a machine and its tokens only for the owner", async () => {
		const { result } = await pairAs("user-token-1");
		const notOwner = await call("DELETE", `/api/agent/machines/${result.machineId}`, { token: "user-token-2" });
		expect(notOwner.status).toBe(404);
		expect((await call("POST", "/api/agent/heartbeat", { token: result.token, body: {} })).status).toBe(200);

		const revoke = await call("DELETE", `/api/agent/machines/${result.machineId}`, { token: "user-token-1" });
		expect((await revoke.json()).data).toEqual({ revoked: true });
		expect(fake.tables.rill_personal_tokens[0].revoked_at).not.toBeNull();
		expect((await call("POST", "/api/agent/heartbeat", { token: result.token, body: {} })).status).toBe(401);
		const machines = await call("GET", "/api/agent/machines", { token: "user-token-1" });
		expect((await machines.json()).data.machines).toEqual([]);
	});
});

describe("Rill Agent download and configuration", () => {
	it("redirects to the published installer", async () => {
		const response = await call("GET", "/api/agent/download");
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(env.RILL_AGENT_DOWNLOAD_URL);
	});

	it("fails closed without a download URL or service-role secret", async () => {
		const noDownload = await handleAgentApi(new Request("https://rill.example.test/api/agent/download"), { ...env, RILL_AGENT_DOWNLOAD_URL: "" }, ctx);
		expect(noDownload.status).toBe(503);
		const noSecret = await handleAgentApi(new Request("https://rill.example.test/api/agent/pairings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(machine),
		}), { ...env, SUPABASE_SERVICE_ROLE_KEY: undefined }, ctx);
		expect(noSecret.status).toBe(503);
		expect((await noSecret.json()).error.code).toBe("SUPABASE_SERVICE_ROLE_KEY_REQUIRED");
		expect((await call("GET", "/api/agent/unknown")).status).toBe(404);
	});
});
