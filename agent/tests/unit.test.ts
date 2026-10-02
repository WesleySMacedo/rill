import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "../src/core/agent";
import { MemoryStateStore } from "../src/core/state";
import { parsePorcelainV2 } from "../src/git/service";
import { MemoryTokenVault } from "../src/security/token-vault";
import { SessionManager } from "../src/security/sessions";
import { loadConfig } from "../src/config";
import { FakeRillClient } from "./helpers";

describe("parsePorcelainV2", () => {
	it("parses branch headers and every entry type", () => {
		const output = [
			"# branch.oid 1234567890abcdef1234567890abcdef12345678",
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 aaa bbb src/file with space.ts",
			"2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts",
			"src/old.ts",
			"u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts",
			"? untracked.txt",
			"",
		].join("\0");
		const status = parsePorcelainV2(output);
		expect(status.branch).toEqual({ head: "main", oid: "1234567890abcdef1234567890abcdef12345678", upstream: "origin/main", ahead: 2, behind: 1, detached: false });
		expect(status.files).toEqual([
			{ path: "src/file with space.ts", originalPath: null, kind: "changed", index: ".", worktree: "M" },
			{ path: "src/new.ts", originalPath: "src/old.ts", kind: "renamed", index: "R", worktree: "." },
			{ path: "conflict.ts", originalPath: null, kind: "unmerged", index: "U", worktree: "U" },
			{ path: "untracked.txt", originalPath: null, kind: "untracked", index: "?", worktree: "?" },
		]);
	});

	it("handles detached heads and initial commits", () => {
		const status = parsePorcelainV2(["# branch.oid (initial)", "# branch.head (detached)", ""].join("\0"));
		expect(status.branch).toMatchObject({ head: null, oid: null, detached: true });
		expect(status.clean).toBe(true);
	});
});

describe("AgentController pairing", () => {
	afterEach(() => vi.useRealTimers());

	it("completes the device-code flow and persists identity without the token in state", async () => {
		vi.useFakeTimers();
		const store = new MemoryStateStore();
		const vault = new MemoryTokenVault();
		const rill = new FakeRillClient();
		rill.pollResults = [{ status: "PENDING" }, { status: "APPROVED", token: "rill_pat_test", machineId: "machine-1", userId: "user-1", email: "dev@example.com" }];
		const controller = new AgentController({ store, vault, rill, machine: { machineName: "pc", platform: "win32-x64", agentVersion: "0.1.0" }, workspaceCount: async () => 0 });
		await controller.start();
		expect(controller.status().state).toBe("not_paired");

		const pairing = await controller.startPairing();
		expect(pairing.userCode).toBe("BCDF-GHJK");
		expect(controller.status()).toMatchObject({ state: "pairing", pairing: { userCode: "BCDF-GHJK" } });

		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(controller.status()).toMatchObject({ state: "connected", paired: true, userEmail: "dev@example.com" });
		expect(await vault.get()).toBe("rill_pat_test");
		const state = await store.load();
		expect(state).toMatchObject({ machineId: "machine-1", userId: "user-1" });
		expect(JSON.stringify(state)).not.toContain("rill_pat_");
		controller.stop();
	});

	it("returns to not paired when pairing is denied", async () => {
		vi.useFakeTimers();
		const rill = new FakeRillClient();
		rill.pollResults = [{ status: "DENIED" }];
		const controller = new AgentController({ store: new MemoryStateStore(), vault: new MemoryTokenVault(), rill, machine: { machineName: "pc", platform: "x", agentVersion: "0" }, workspaceCount: async () => 0 });
		await controller.startPairing();
		await vi.advanceTimersByTimeAsync(1000);
		expect(controller.status()).toMatchObject({ state: "not_paired", lastError: "Pairing was denied in Rill." });
		controller.stop();
	});

	it("reconnects on start with a stored token", async () => {
		const store = new MemoryStateStore({ version: 1, machineId: "machine-1", userId: "user-1", userEmail: null, workspaces: [] });
		const rill = new FakeRillClient();
		const controller = new AgentController({ store, vault: new MemoryTokenVault("rill_pat_test"), rill, machine: { machineName: "pc", platform: "x", agentVersion: "0" }, workspaceCount: async () => 0 });
		await controller.start();
		expect(controller.status()).toMatchObject({ state: "connected", userEmail: "dev@example.com" });
		expect(rill.heartbeats).toBe(1);
		controller.stop();
	});
});

describe("SessionManager", () => {
	it("expires sessions", () => {
		let now = 0;
		const sessions = new SessionManager(1000, () => now);
		const { token } = sessions.create({ userId: "u", email: null, origin: null });
		expect(sessions.verify(token)?.userId).toBe("u");
		now = 1001;
		expect(sessions.verify(token)).toBeNull();
	});
});

describe("loadConfig", () => {
	it("only accepts loopback dev origins and https app URLs", () => {
		const config = loadConfig({ RILL_AGENT_DEV_ORIGINS: "http://localhost:5173, https://evil.example, http://192.168.0.2:5173" });
		expect(config.allowedOrigins).toContain("http://localhost:5173");
		expect(config.allowedOrigins).not.toContain("https://evil.example");
		expect(config.allowedOrigins).not.toContain("http://192.168.0.2:5173");
		expect(() => loadConfig({ RILL_APP_URL: "http://evil.example" })).toThrow();
	});
});
