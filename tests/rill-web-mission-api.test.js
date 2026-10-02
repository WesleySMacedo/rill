import { createServer } from "node:http";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { handleMissionApi } from "../web/src/runtime/mission-api.ts";

const env = {
	SUPABASE_URL: "https://supabase.example.test",
	SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
};

const workspaceFiles = [
	"public/index.html",
	"AGENTS.md",
	"docs/product-baseline/UI_ANALYSIS.md",
	"docs/product-baseline/DOMAIN_KNOWLEDGE.md",
	".github/prompts/analyze-rill.prompt.md",
	"tests/engineering-registry.test.js",
	"tests/architect.worker.test.js",
].map((path) => ({ path, size: 100 }));

afterEach(() => vi.unstubAllGlobals());

describe("Rill mission API security boundary", () => {
	it("rejects mission reads without a Supabase bearer session before making requests", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);

		const response = await handleMissionApi(new Request("https://rill.test/api/missions"), env);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("fails closed when mission persistence has no server service-role secret", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "user-1" }), { status: 200 }));
		vi.stubGlobal("fetch", fetcher);
		const response = await handleMissionApi(new Request("https://rill.test/api/missions", {
			method: "POST",
			headers: { Authorization: "Bearer valid-session-jwt", "Content-Type": "application/json" },
			body: JSON.stringify({
				task: "Analyze the AuditQ UI",
				targetPath: "public/index.html",
				contextPaths: [],
				workspaceFiles,
				clientRequestId: "b38b3d99-8c55-4bb8-bb48-540d5a96e4b2",
			}),
		}), env);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "SUPABASE_SERVICE_ROLE_KEY_REQUIRED" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(String(fetcher.mock.calls[0][0])).toContain("/auth/v1/user");
	});

	it("blocks PATCH_UI before persistence when no proposal and executor runtime is configured", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "user-1" }), { status: 200 }));
		vi.stubGlobal("fetch", fetcher);
		const response = await handleMissionApi(new Request("https://rill.test/api/missions", {
			method: "POST",
			headers: { Authorization: "Bearer valid-session-jwt", "Content-Type": "application/json" },
			body: JSON.stringify({
				task: "Implement an AuditQ UI change",
				targetPath: "public/index.html",
				contextPaths: [],
				workspaceFiles,
				clientRequestId: "1b9a0bcb-a427-4670-9b76-55d8c6db0bd5",
			}),
		}), { ...env, SUPABASE_SERVICE_ROLE_KEY: "server-only-test-secret" });

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual(expect.objectContaining({ error: "PROPOSAL_RUNTIME_NOT_CONFIGURED" }));
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(String(fetcher.mock.calls[0][0])).toContain("/auth/v1/user");
	});

});

const runtimeEnv = {
	...env,
	SUPABASE_SERVICE_ROLE_KEY: "server-only-test-secret",
	OPENROUTER_API_KEY: "openrouter-test-secret",
	OPENROUTER_LOW_COST_MODEL: "qwen/qwen3.8-flash",
};
const bearer = ["Bearer", "user-session"].join(" ");

function createBackend(modelContent) {
	const tables = { rill_missions: [], rill_execution_state: [], rill_workflow_events: [], rill_audit_events: [], rill_approvals: [], rill_proposal_versions: [] };
	const modelRequests = [];
	const reserved = new Set(["select", "order", "limit", "on_conflict"]);
	const matches = (row, params) => [...params].every(([key, value]) => reserved.has(key) || (value.startsWith("eq.") && String(row[key]) === value.slice(3)));
	const fetcher = vi.fn(async (input, init = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1" });
		if (url.hostname === "openrouter.ai") {
			modelRequests.push(JSON.parse(init.body));
			return Response.json({ model: "qwen/qwen3.8-flash", provider: "Alibaba", choices: [{ message: { content: JSON.stringify(modelContent) } }], usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1100, cost: 0.0002 } });
		}
		const table = url.pathname.replace("/rest/v1/", "");
		const rows = tables[table];
		if (!rows) return new Response("unknown table", { status: 404 });
		const params = url.searchParams;
		if (method === "POST") {
			const row = { created_at: new Date(Date.now() + rows.length).toISOString(), ...JSON.parse(init.body) };
			if (table === "rill_approvals") row.approval_id = crypto.randomUUID();
			if (table === "rill_workflow_events") {
				if (rows.some((existing) => existing.mission_id === row.mission_id && existing.event_type === row.event_type)) return new Response(null, { status: 201 });
				row.event_id = rows.length + 1;
			}
			rows.push(row);
			return Response.json([row], { status: 201 });
		}
		const selected = rows.filter((row) => matches(row, params));
		if (method === "PATCH") {
			for (const row of selected) Object.assign(row, JSON.parse(init.body));
			return Response.json(selected);
		}
		const order = params.get("order");
		if (order?.endsWith(".desc")) selected.reverse();
		return Response.json(params.get("limit") ? selected.slice(0, Number(params.get("limit"))) : selected);
	});
	return { tables, modelRequests, fetcher };
}

function createRequest(task, clientRequestId) {
	return new Request("https://rill.test/api/missions", {
		method: "POST",
		headers: { Authorization: bearer, "Content-Type": "application/json" },
		body: JSON.stringify({ task, targetPath: "public/index.html", contextPaths: [], workspaceFiles, clientRequestId }),
	});
}

function missionRequest(id, operation, body) {
	return new Request(`https://rill.test/api/missions/${id}/${operation}`, {
		method: "POST",
		headers: { Authorization: bearer, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

const proposalOutput = {
	summary: "Ajustar o espaçamento do cabeçalho da página Audit Q.",
	targetFiles: ["public/index.html"],
	proposedChanges: ["Aumentar o espaçamento vertical do cabeçalho."],
	acceptanceCriteria: ["O cabeçalho mantém o layout em telas pequenas."],
	risks: ["Regressão visual em telas estreitas."],
	testsRecommended: ["tests/engineering-registry.test.js"],
};

async function createAwaitingMission() {
	const backend = createBackend(proposalOutput);
	vi.stubGlobal("fetch", backend.fetcher);
	const response = await handleMissionApi(createRequest("Implement an AuditQ UI change", "6a1f6c55-5d8f-4f4b-9d0a-3e1a5d2b7c11"), runtimeEnv);
	return { backend, response, payload: await response.json() };
}

describe("Rill mission API with model runtime", () => {
	it("plans PLAN_CHANGE missions with the Estrategista through the gateway and records model telemetry", async () => {
		const backend = createBackend({ summary: "Plano de análise.", steps: ["Ler public/index.html", "Listar inconsistências visuais"], risks: ["Contexto limitado"], recommendedTests: ["tests/engineering-registry.test.js"] });
		vi.stubGlobal("fetch", backend.fetcher);

		const response = await handleMissionApi(createRequest("Analyze the AuditQ UI", "0c6f8c2e-3f9a-4a53-9a43-2f0f3f9b6a01"), runtimeEnv);
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.mission.state).toBe("PLANNED");
		expect(payload.mission.action).toBe("PLAN_CHANGE");
		expect(payload.mission.provider_status).toBe("COMPLETED");
		expect(payload.mission.plan).toEqual(["Ler public/index.html", "Listar inconsistências visuais"]);
		const eventTypes = payload.events.map((event) => event.event_type);
		expect(eventTypes).toEqual(expect.arrayContaining(["MODEL_ROUTED", "PROMPT_RESOLVED", "MODEL_COMPLETED", "PLANNED"]));
		expect(payload.events.find((event) => event.event_type === "PROMPT_RESOLVED").payload).toEqual(expect.objectContaining({ source: "local-fallback", name: "rill-mission-intelligence", label: "production" }));
		expect(payload.events.find((event) => event.event_type === "MODEL_COMPLETED").payload).toEqual(expect.objectContaining({ usedModel: "qwen/qwen3.8-flash", totalTokens: 1100, reportedCostUsd: 0.0002 }));
		expect(backend.modelRequests).toHaveLength(1);
		expect(backend.modelRequests[0].model).toBe("qwen/qwen3.8-flash");
		expect(backend.modelRequests[0].response_format.json_schema.name).toBe("rill_mission_plan");
		expect(backend.modelRequests[0].messages.map((message) => message.role)).toEqual(["system", "user"]);
		expect(JSON.stringify(backend.modelRequests[0].messages)).not.toContain("{{");
		expect(backend.tables.rill_approvals).toHaveLength(0);
	});

	it("falls back to the deterministic plan when the model output is invalid", async () => {
		const backend = createBackend({ unexpected: true });
		vi.stubGlobal("fetch", backend.fetcher);

		const response = await handleMissionApi(createRequest("Analyze the AuditQ UI", "0c6f8c2e-3f9a-4a53-9a43-2f0f3f9b6a02"), runtimeEnv);
		const payload = await response.json();

		expect(payload.mission.state).toBe("PLANNED");
		expect(payload.mission.provider_status).toBe("FAILED");
		expect(payload.events.map((event) => event.event_type)).toContain("MODEL_INVOCATION_FAILED");
		expect(payload.events.find((event) => event.event_type === "PLANNED").payload.mode).toBe("DETERMINISTIC_FALLBACK");
	});

	it("routes PATCH_UI through Projetista and Auditor into a hashed HITL ticket without mutating files", async () => {
		const { backend, response, payload } = await createAwaitingMission();

		expect(response.status).toBe(200);
		expect(payload.mission.state).toBe("AWAITING_HUMAN_APPROVAL");
		expect(payload.approval).toEqual(expect.objectContaining({ decision: "PENDING", proposal_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }));
		expect(payload.proposal.proposal_hash).toBe(payload.approval.proposal_hash);
		expect(payload.proposal.proposal.targetFiles).toEqual(["public/index.html"]);
		const eventTypes = payload.events.map((event) => event.event_type);
		expect(eventTypes).toEqual(expect.arrayContaining(["PLANNED", "PROPOSAL_CREATED", "PROPOSAL_REVIEWED", "AWAITING_HUMAN_APPROVAL"]));
		expect(backend.modelRequests[0].response_format.json_schema.name).toBe("rill_patch_proposal");
		expect(backend.tables.rill_execution_state[0].execution_gate).toBe("LOCKED");
	});

	it("blocks PATCH_UI proposals that target files outside the resolved context", async () => {
		const backend = createBackend({ ...proposalOutput, targetFiles: ["src/server.ts"] });
		vi.stubGlobal("fetch", backend.fetcher);

		const response = await handleMissionApi(createRequest("Implement an AuditQ UI change", "6a1f6c55-5d8f-4f4b-9d0a-3e1a5d2b7c12"), runtimeEnv);
		const payload = await response.json();

		expect(payload.mission.state).toBe("BLOCKED");
		expect(payload.approval).toBeNull();
		expect(backend.tables.rill_approvals).toHaveLength(0);
		expect(payload.events.find((event) => event.event_type === "BLOCKED").payload.reason).toBe("AUDITOR_REJECTED_PROPOSAL");
	});

	it("rejects decisions with a mismatched proposal hash and keeps the ticket pending", async () => {
		const { backend, payload } = await createAwaitingMission();

		const response = await handleMissionApi(missionRequest(payload.mission.id, "decision", { decision: "APPROVED", proposalHash: "0".repeat(64) }), runtimeEnv);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "PROPOSAL_HASH_MISMATCH" });
		expect(backend.tables.rill_approvals[0].decision).toBe("PENDING");
		expect(backend.tables.rill_missions[0].state).toBe("AWAITING_HUMAN_APPROVAL");
	});

	it("requires a justification for rejections", async () => {
		const { payload } = await createAwaitingMission();

		const response = await handleMissionApi(missionRequest(payload.mission.id, "decision", { decision: "REJECTED", proposalHash: payload.approval.proposal_hash }), runtimeEnv);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "JUSTIFICATION_REQUIRED" });
	});

	it("records an approval and stops at BLOCKED because no executor is configured", async () => {
		const { backend, payload } = await createAwaitingMission();

		const response = await handleMissionApi(missionRequest(payload.mission.id, "decision", { decision: "APPROVED", justification: "Escopo correto.", proposalHash: payload.approval.proposal_hash }), runtimeEnv);
		const decided = await response.json();

		expect(response.status).toBe(200);
		expect(decided.mission.state).toBe("BLOCKED");
		expect(decided.approval).toEqual(expect.objectContaining({ decision: "APPROVED", decided_by: "user-1" }));
		expect(backend.tables.rill_execution_state[0].execution_gate).toBe("EXECUTOR_NOT_CONFIGURED");
		expect(decided.events.find((event) => event.event_type === "BLOCKED").payload.reason).toBe("EXECUTOR_NOT_CONFIGURED");
		expect(decided.auditEvents.map((event) => event.event_type)).toContain("HUMAN_DECISION");

		const second = await handleMissionApi(missionRequest(payload.mission.id, "decision", { decision: "REJECTED", justification: "Tarde demais.", proposalHash: payload.approval.proposal_hash }), runtimeEnv);
		expect(second.status).toBe(409);
		expect(backend.tables.rill_approvals[0].decision).toBe("APPROVED");
	});

	it("cancels non-terminal missions and refuses to cancel terminal missions", async () => {
		const { backend, payload } = await createAwaitingMission();

		const response = await handleMissionApi(missionRequest(payload.mission.id, "cancel", { reason: "Prioridade alterada." }), runtimeEnv);
		const canceled = await response.json();

		expect(response.status).toBe(200);
		expect(canceled.mission.state).toBe("CANCELED");
		expect(canceled.events.find((event) => event.event_type === "CANCELED").payload).toEqual(expect.objectContaining({ previousState: "AWAITING_HUMAN_APPROVAL" }));

		const decision = await handleMissionApi(missionRequest(payload.mission.id, "decision", { decision: "APPROVED", proposalHash: payload.approval.proposal_hash }), runtimeEnv);
		expect(decision.status).toBe(409);
		const again = await handleMissionApi(missionRequest(payload.mission.id, "cancel", {}), runtimeEnv);
		expect(again.status).toBe(409);
		expect(backend.tables.rill_approvals[0].decision).toBe("PENDING");
	});
});

describe("Rill mission API Langfuse integration", () => {
	it("uses the managed Langfuse prompt, links it to the generation and exports the OTLP trace via waitUntil", async () => {
		// In Node the OTLP exporter uses node:http (Workers bundles the fetch transport), so capture it with a local server.
		const otlpBodies = [];
		const server = createServer((request, response) => {
			let received = "";
			request.on("data", (chunk) => { received += chunk; });
			request.on("end", () => {
				if (request.url === "/api/public/otel/v1/traces") otlpBodies.push(received);
				response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			});
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const langfuseBaseUrl = `http://127.0.0.1:${server.address().port}`;
		onTestFinished(() => new Promise((resolve) => server.close(resolve)));
		const backend = createBackend({ summary: "Plano.", steps: ["Ler public/index.html"], risks: [], recommendedTests: [] });
		const fetcher = vi.fn(async (input, init = {}) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname.startsWith("/api/public/v2/prompts/")) {
				return Response.json({
					name: "rill-mission-intelligence", version: 3, type: "chat", labels: ["production"], tags: [], config: {},
					prompt: [{ role: "system", content: "Managed system prompt for {{action}} in {{domain}}." }, { role: "user", content: "Goal: {{goal}} Risk: {{risk}} Approval: {{approval_required}} Context: {{context_manifest}}" }],
				});
			}
			return backend.fetcher(input, init);
		});
		vi.stubGlobal("fetch", fetcher);
		const pending = [];
		const ctx = { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} };

		const response = await handleMissionApi(createRequest("Analyze the AuditQ UI", "0c6f8c2e-3f9a-4a53-9a43-2f0f3f9b6a09"), {
			...runtimeEnv,
			LANGFUSE_BASE_URL: langfuseBaseUrl,
			LANGFUSE_PUBLIC_KEY: "pk-lf-test",
			LANGFUSE_SECRET_KEY: "langfuse-test-secret",
		}, ctx);
		await Promise.all(pending);
		const payload = await response.json();

		expect(payload.mission.state).toBe("PLANNED");
		expect(payload.events.find((event) => event.event_type === "PROMPT_RESOLVED").payload).toEqual(expect.objectContaining({ source: "langfuse", version: 3 }));
		expect(backend.modelRequests[0].messages[0].content).toBe("Managed system prompt for PLAN_CHANGE in AuditQ.");
		const traceId = payload.events.find((event) => event.event_type === "MISSION_CREATED").payload.traceId;
		expect(traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(pending.length).toBeGreaterThan(0);
		expect(otlpBodies.length).toBeGreaterThan(0);
		const exported = otlpBodies.join("\n");
		expect(exported).toContain("rill-mission-create");
		expect(exported).toContain("estrategista-generation");
		expect(exported).toContain("gateway-input-guardrail");
		expect(exported).toContain(traceId);
		expect(exported).not.toContain("openrouter-test-secret");
		expect(exported).not.toContain("server-only-test-secret");
	}, 15_000);
});
