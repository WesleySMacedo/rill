import { describe, expect, it, vi } from "vitest";
import { assertValidTransition, canTransition, isTerminalState } from "../src/contracts/rill-transition.contract.ts";
import { assertExecutorGate, hashProposal } from "../src/security/gated-executor.ts";
import { authenticateServiceAccount } from "../src/security/service-account-auth.ts";

const proposal = {
	status: "PROPOSAL_CREATED",
	summary: "Proposal",
	targetFiles: ["public/index.html"],
	proposedChanges: ["Change UI"],
	acceptanceCriteria: ["Tests pass"],
	risks: [],
	testsRecommended: [],
};

describe("Rill production contracts", () => {
	it("rejects invalid state transitions and accepts approved execution", () => {
		expect(canTransition("COMPLETED", "EXECUTING")).toBe(false);
		expect(() => assertValidTransition("AWAITING_HUMAN_APPROVAL", "EXECUTING")).toThrow("HUMAN_APPROVAL_REQUIRED");
		expect(() => assertValidTransition("AWAITING_HUMAN_APPROVAL", "EXECUTING", "APPROVED")).not.toThrow();
		expect(isTerminalState("COMPLETED")).toBe(true);
	});

	it("requires the approved proposal hash before execution", async () => {
		const proposalHash = await hashProposal(proposal);
		await expect(assertExecutorGate({ proposal, approvedProposalHash: proposalHash, ticketStatus: "APPROVED", executionState: "EXECUTING" })).resolves.toBeUndefined();
		await expect(assertExecutorGate({ proposal: { ...proposal, summary: "Changed" }, approvedProposalHash: proposalHash, ticketStatus: "APPROVED", executionState: "EXECUTING" })).rejects.toThrow("PROPOSAL_HASH_MISMATCH");
	});

	it("authenticates a persisted service account without exposing its secret", async () => {
		const secret = "service-secret";
		const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const fetcher = vi.fn().mockImplementation(async (url, init) => {
			if (String(url).includes("rill_service_accounts") && init?.method === "PATCH") return new Response(null, { status: 204 });
			return new Response(JSON.stringify([{ client_id: "rill-mcp-production", secret_hash: digest, active: true, environment: "production", scopes: ["rill:request:create"] }]), { status: 200 });
		});
		vi.stubGlobal("fetch", fetcher);
		const principal = await authenticateServiceAccount(new Request("https://example.test", { headers: { "X-Rill-Client-Id": "rill-mcp-production", "X-Rill-Client-Secret": secret } }), { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "server-only", RUNTIME_ENVIRONMENT: "production" }, "rill:request:create");
		expect(principal).toEqual({ type: "service_account", clientId: "rill-mcp-production", scopes: ["rill:request:create"], environment: "production" });
		expect(fetcher).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expect.stringContaining(secret) }));
		vi.unstubAllGlobals();
	});
});
