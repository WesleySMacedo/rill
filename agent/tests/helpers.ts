import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentController } from "../src/core/agent";
import type { ConfirmationRequest, UserPrompter, WorkspaceApproval } from "../src/core/prompter";
import { MemoryStateStore } from "../src/core/state";
import { JobManager } from "../src/exec/jobs";
import type { MachineInfo, PairingPoll, PairingStart, RillClient, RillIdentity } from "../src/rill/client";
import { SessionManager } from "../src/security/sessions";
import { MemoryTokenVault } from "../src/security/token-vault";
import { startAgentServer } from "../src/server/app";
import { WorkspaceRegistry } from "../src/workspaces/registry";
import { AgentError } from "../src/core/errors";

export const TEST_ORIGIN = "https://rill.wesleysmacedo.com";
export const USER_ID = "user-1";
export const VALID_ACCESS_TOKEN = "supabase-access-token-for-user-1";

export async function makeTempDir(prefix = "rill-agent-"): Promise<string> {
	return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

export class FakeRillClient implements RillClient {
	revoked = false;
	pollResults: PairingPoll[] = [];
	heartbeats = 0;
	readonly identity: RillIdentity = { machineId: "machine-1", userId: USER_ID, email: "dev@example.com" };

	async startPairing(_machine: MachineInfo): Promise<PairingStart> {
		return {
			deviceCode: "device-code",
			userCode: "BCDF-GHJK",
			verificationUri: `${TEST_ORIGIN}/agent/pair`,
			verificationUriComplete: `${TEST_ORIGIN}/agent/pair?code=BCDF-GHJK`,
			expiresIn: 600,
			interval: 1,
		};
	}

	async pollPairing(): Promise<PairingPoll> {
		return this.pollResults.shift() ?? { status: "PENDING" };
	}

	async heartbeat(token: string): Promise<RillIdentity> {
		this.heartbeats += 1;
		if (this.revoked || token !== "rill_pat_test") throw new AgentError("RILL_UNAUTHORIZED", "revoked", 401);
		return this.identity;
	}

	async verifySession(token: string, accessToken: string): Promise<RillIdentity> {
		if (this.revoked || token !== "rill_pat_test") throw new AgentError("RILL_UNAUTHORIZED", "revoked", 401);
		if (accessToken === "supabase-access-token-for-user-2") return { ...this.identity, userId: "user-2" };
		if (accessToken !== VALID_ACCESS_TOKEN) throw new AgentError("SESSION_INVALID", "bad access token", 403);
		return this.identity;
	}
}

export class FakePrompter implements UserPrompter {
	nextWorkspace: WorkspaceApproval | null = null;
	confirmAnswer = false;
	confirmations: ConfirmationRequest[] = [];

	async approveWorkspace(): Promise<WorkspaceApproval | null> {
		const approval = this.nextWorkspace;
		this.nextWorkspace = null;
		return approval;
	}

	async confirm(request: ConfirmationRequest): Promise<boolean> {
		this.confirmations.push(request);
		return this.confirmAnswer;
	}
}

export async function startTestAgent({ paired = true } = {}) {
	const store = new MemoryStateStore();
	const vault = new MemoryTokenVault();
	const rill = new FakeRillClient();
	const prompter = new FakePrompter();
	const workspaces = new WorkspaceRegistry(store, { protectedRoots: [] });
	const jobs = new JobManager();
	const sessions = new SessionManager();
	const controller = new AgentController({
		store,
		vault,
		rill,
		machine: { machineName: "test", platform: "test", agentVersion: "0.0.0" },
		workspaceCount: async () => (await workspaces.list()).length,
	});
	if (paired) await controller.completePairing("rill_pat_test", rill.identity);
	const port = await freePort();
	const server = await startAgentServer(
		{ controller, sessions, workspaces, jobs, prompter, allowedOrigins: [TEST_ORIGIN], port },
		{ hosts: ["127.0.0.1"] },
	);
	const base = `http://127.0.0.1:${port}`;

	async function call(method: string, pathname: string, options: { body?: unknown; token?: string | null; origin?: string | null; host?: string } = {}) {
		const headers: Record<string, string> = {};
		if (options.body !== undefined) headers["content-type"] = "application/json";
		if (options.token) headers.authorization = `Bearer ${options.token}`;
		const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
		if (origin) headers.origin = origin;
		if (options.host) headers.host = options.host;
		const response = await fetch(`${base}${pathname}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
		const json = (await response.json().catch(() => null)) as { ok: boolean; data?: any; error?: { code: string; message: string } } | null;
		return { status: response.status, headers: response.headers, json };
	}

	async function login(): Promise<string> {
		const response = await call("POST", "/v1/session", { body: { accessToken: VALID_ACCESS_TOKEN } });
		if (response.status !== 201) throw new Error(`login failed: ${JSON.stringify(response.json)}`);
		return response.json!.data.sessionToken as string;
	}

	return {
		store,
		vault,
		rill,
		prompter,
		workspaces,
		jobs,
		sessions,
		controller,
		server,
		port,
		base,
		call,
		login,
		async close() {
			controller.stop();
			jobs.cancelAll();
			await server.close();
		},
	};
}
