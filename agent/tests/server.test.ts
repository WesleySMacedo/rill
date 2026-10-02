import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { runGit } from "../src/git/service";
import { TEST_ORIGIN, makeTempDir, startTestAgent } from "./helpers";

type Agent = Awaited<ReturnType<typeof startTestAgent>>;

function rawRequest(port: number, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = http.request({ host: "127.0.0.1", port, path: "/v1/health", method: "GET", headers }, (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		request.on("error", reject);
		request.end();
	});
}

describe("Rill Agent local API", () => {
	let agent: Agent;
	let root: string;
	let project: string;
	let token: string;
	let workspaceId: string;

	beforeAll(async () => {
		root = await makeTempDir();
		project = path.join(root, "work", "demo");
		await fs.mkdir(path.join(project, "src"), { recursive: true });
		await fs.writeFile(path.join(project, "src", "index.ts"), "export const answer = 42;\n");
		await fs.writeFile(path.join(project, ".env"), "SECRET=1\n");
		await fs.writeFile(
			path.join(project, "package.json"),
			JSON.stringify({ name: "demo", version: "1.0.0", private: true, scripts: { test: "node -e \"console.log('rill-test-ok')\"" } }, null, 2),
		);
		agent = await startTestAgent();
		token = await agent.login();
	});

	afterAll(async () => {
		await agent.close();
		await fs.rm(root, { recursive: true, force: true });
	});

	describe("transport security", () => {
		it("serves health without auth and reports pairing", async () => {
			const response = await agent.call("GET", "/v1/health");
			expect(response.status).toBe(200);
			expect(response.json).toMatchObject({ ok: true, data: { service: "rill-agent", paired: true, connected: true } });
			expect(response.headers.get("access-control-allow-origin")).toBe(TEST_ORIGIN);
		});

		it("rejects foreign Host headers (DNS rebinding)", async () => {
			expect(await rawRequest(agent.port, { host: "evil.example:7777" })).toBe(421);
			expect(await rawRequest(agent.port, { host: `localhost:${agent.port}` })).toBe(200);
		});

		it("rejects origins outside the allowlist", async () => {
			const response = await agent.call("GET", "/v1/health", { origin: "https://evil.example" });
			expect(response.status).toBe(403);
			expect(response.json?.error?.code).toBe("ORIGIN_NOT_ALLOWED");
		});

		it("answers private-network preflights for allowed origins", async () => {
			const response = await fetch(`${agent.base}/v1/workspaces`, {
				method: "OPTIONS",
				headers: { origin: TEST_ORIGIN, "access-control-request-method": "GET", "access-control-request-private-network": "true" },
			});
			expect(response.status).toBe(204);
			expect(response.headers.get("access-control-allow-private-network")).toBe("true");
		});

		it("requires a local session for protected routes", async () => {
			expect((await agent.call("GET", "/v1/workspaces")).status).toBe(401);
			expect((await agent.call("GET", "/v1/workspaces", { token: "rill_ls_forged" })).status).toBe(401);
		});

		it("refuses sessions for other Rill accounts or invalid tokens", async () => {
			const other = await agent.call("POST", "/v1/session", { body: { accessToken: "supabase-access-token-for-user-2" } });
			expect(other.status).toBe(403);
			expect(other.json?.error?.code).toBe("SESSION_USER_MISMATCH");
			const invalid = await agent.call("POST", "/v1/session", { body: { accessToken: "x".repeat(30) } });
			expect(invalid.status).toBe(403);
		});

		it("never returns the personal token to the browser", async () => {
			const response = await agent.call("POST", "/v1/session", { body: { accessToken: "supabase-access-token-for-user-1" } });
			expect(JSON.stringify(response.json)).not.toContain("rill_pat_");
			expect(response.json?.data.sessionToken).toMatch(/^rill_ls_/);
		});
	});

	describe("workspace approval", () => {
		it("denies exposure when the user declines", async () => {
			agent.prompter.nextWorkspace = null;
			const response = await agent.call("POST", "/v1/workspaces/requests", { token, body: {} });
			expect(response.status).toBe(403);
			expect(response.json?.error?.code).toBe("WORKSPACE_REQUEST_DENIED");
		});

		it("exposes a folder only after approval", async () => {
			agent.prompter.nextWorkspace = { rootPath: project, permissions: ["read", "write", "execute"] };
			const response = await agent.call("POST", "/v1/workspaces/requests", { token, body: { reason: "Open project" } });
			expect(response.status).toBe(201);
			workspaceId = response.json?.data.workspace.id;
			expect(response.json?.data.workspace).toMatchObject({ name: "demo", permissions: ["read", "write", "execute"] });
			const list = await agent.call("GET", "/v1/workspaces", { token });
			expect(list.json?.data.workspaces).toHaveLength(1);
		});

		it("rejects overlapping workspaces", async () => {
			agent.prompter.nextWorkspace = { rootPath: path.join(project, "src"), permissions: ["read"] };
			const response = await agent.call("POST", "/v1/workspaces/requests", { token, body: {} });
			expect(response.status).toBe(409);
			expect(response.json?.error?.code).toBe("WORKSPACE_OVERLAP");
		});
	});

	describe("files", () => {
		it("lists one directory level without .git and flags protected files", async () => {
			const response = await agent.call("GET", `/v1/workspaces/${workspaceId}/tree`, { token });
			expect(response.status).toBe(200);
			const entries = response.json?.data.entries as { name: string; type: string; protected: boolean }[];
			expect(entries[0]).toMatchObject({ name: "src", type: "directory" });
			expect(entries.find((entry) => entry.name === ".env")?.protected).toBe(true);
		});

		it("reads files with a content hash", async () => {
			const response = await agent.call("GET", `/v1/workspaces/${workspaceId}/files?path=src/index.ts`, { token });
			expect(response.status).toBe(200);
			expect(response.json?.data).toMatchObject({ path: "src/index.ts", encoding: "utf8", content: "export const answer = 42;\n" });
			expect(response.json?.data.sha256).toMatch(/^[a-f0-9]{64}$/);
		});

		it("blocks credentials and traversal", async () => {
			expect((await agent.call("GET", `/v1/workspaces/${workspaceId}/files?path=.env`, { token })).json?.error?.code).toBe("SENSITIVE_FILE");
			expect((await agent.call("GET", `/v1/workspaces/${workspaceId}/files?path=../../outside.txt`, { token })).status).toBe(403);
			expect((await agent.call("GET", `/v1/workspaces/unknown/files?path=src/index.ts`, { token })).status).toBe(404);
		});

		it("writes with optimistic concurrency", async () => {
			const read = await agent.call("GET", `/v1/workspaces/${workspaceId}/files?path=src/index.ts`, { token });
			const sha = read.json?.data.sha256;
			const write = await agent.call("PUT", `/v1/workspaces/${workspaceId}/files`, {
				token,
				body: { path: "src/index.ts", content: "export const answer = 43;\n", expectedSha256: sha },
			});
			expect(write.status).toBe(200);
			expect(await fs.readFile(path.join(project, "src", "index.ts"), "utf8")).toBe("export const answer = 43;\n");

			const stale = await agent.call("PUT", `/v1/workspaces/${workspaceId}/files`, { token, body: { path: "src/index.ts", content: "stale", expectedSha256: sha } });
			expect(stale.status).toBe(409);
			expect(stale.json?.error?.code).toBe("WRITE_CONFLICT");

			const created = await agent.call("PUT", `/v1/workspaces/${workspaceId}/files`, { token, body: { path: "src/new/util.ts", content: "export {};\n", expectedSha256: null } });
			expect(created.status).toBe(200);
			expect(created.json?.data.created).toBe(true);

			const secret = await agent.call("PUT", `/v1/workspaces/${workspaceId}/files`, { token, body: { path: ".env.local", content: "X=1", expectedSha256: null } });
			expect(secret.status).toBe(403);
			const files = await fs.readdir(path.join(project, "src"));
			expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
		});

		it("enforces read-only workspaces", async () => {
			const readOnly = path.join(root, "work", "readonly");
			await fs.mkdir(readOnly, { recursive: true });
			const workspace = await agent.workspaces.add(readOnly, ["read"]);
			const response = await agent.call("PUT", `/v1/workspaces/${workspace.id}/files`, { token, body: { path: "a.txt", content: "x", expectedSha256: null } });
			expect(response.status).toBe(403);
			expect(response.json?.error?.code).toBe("WORKSPACE_PERMISSION_DENIED");
			const command = await agent.call("POST", `/v1/workspaces/${workspace.id}/commands`, { token, body: { command: "npm.test" } });
			expect(command.json?.error?.code).toBe("WORKSPACE_PERMISSION_DENIED");
			await agent.workspaces.remove(workspace.id);
		});
	});

	describe("commands", () => {
		it("rejects commands outside the catalog", async () => {
			for (const command of ["rm -rf /", "npm.publish", "npm.test && calc", undefined]) {
				const response = await agent.call("POST", `/v1/workspaces/${workspaceId}/commands`, { token, body: { command } });
				expect(response.status).toBe(403);
				expect(response.json?.error?.code).toBe("COMMAND_NOT_ALLOWED");
			}
		});

		it("runs npm test and streams output over WebSocket", async () => {
			const socket = new WebSocket(`ws://127.0.0.1:${agent.port}/v1/events`, { headers: { origin: TEST_ORIGIN } });
			const events: { type: string; payload: any }[] = [];
			socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
			await new Promise<void>((resolve, reject) => {
				socket.once("open", () => {
					socket.send(JSON.stringify({ type: "auth", sessionToken: token }));
					resolve();
				});
				socket.once("error", reject);
			});
			await expect.poll(() => events.some((event) => event.type === "ready")).toBe(true);

			const response = await agent.call("POST", `/v1/workspaces/${workspaceId}/commands`, { token, body: { command: "npm.test" } });
			expect(response.status).toBe(202);
			const jobId = response.json?.data.job.id as string;
			const finished = await agent.jobs.wait(jobId);
			expect(finished.status).toBe("succeeded");
			expect(finished.exitCode).toBe(0);

			await expect.poll(() => events.some((event) => event.type === "job.exit" && event.payload.jobId === jobId)).toBe(true);
			const streamed = events.filter((event) => event.type === "job.output" && event.payload.jobId === jobId).map((event) => event.payload.data).join("");
			expect(streamed).toContain("rill-test-ok");

			const snapshot = await agent.call("GET", `/v1/jobs/${jobId}?since=0`, { token });
			expect(snapshot.json?.data.job.output.map((chunk: { data: string }) => chunk.data).join("")).toContain("rill-test-ok");
			socket.close();
		});

		it("closes unauthenticated sockets and refuses foreign origins", async () => {
			const unauthenticated = new WebSocket(`ws://127.0.0.1:${agent.port}/v1/events`, { headers: { origin: TEST_ORIGIN } });
			const code = await new Promise<number>((resolve) => {
				unauthenticated.once("open", () => unauthenticated.send(JSON.stringify({ type: "auth", sessionToken: "rill_ls_bad" })));
				unauthenticated.once("close", (closeCode) => resolve(closeCode));
			});
			expect(code).toBe(4401);

			const foreign = new WebSocket(`ws://127.0.0.1:${agent.port}/v1/events`, { headers: { origin: "https://evil.example" } });
			await expect(new Promise((resolve, reject) => {
				foreign.once("open", resolve);
				foreign.once("error", reject);
			})).rejects.toThrow(/403/);
		});
	});

	describe("git", () => {
		let remote: string;

		beforeAll(async () => {
			remote = path.join(root, "remote.git");
			await runGit(root, ["init", "--bare", remote]);
			await runGit(project, ["init", "-b", "main"]);
			await runGit(project, ["config", "user.email", "agent@example.com"]);
			await runGit(project, ["config", "user.name", "Rill Agent Test"]);
			await runGit(project, ["config", "commit.gpgsign", "false"]);
			await runGit(project, ["remote", "add", "origin", remote]);
			await fs.writeFile(path.join(project, ".gitignore"), "node_modules\n");
		});

		it("reports status with untracked files", async () => {
			const response = await agent.call("GET", `/v1/workspaces/${workspaceId}/git/status`, { token });
			expect(response.status).toBe(200);
			expect(response.json?.data.branch.head).toBe("main");
			const paths = (response.json?.data.files as { path: string; kind: string }[]).map((file) => file.path);
			expect(paths).toContain("src/index.ts");
			expect(paths).toContain(".env");
		});

		it("refuses to commit credentials", async () => {
			const response = await agent.call("POST", `/v1/workspaces/${workspaceId}/git/commit`, { token, body: { message: "everything", all: true } });
			expect(response.status).toBe(403);
			expect(response.json?.error?.code).toBe("SENSITIVE_FILE_IN_COMMIT");
		});

		it("commits explicit paths", async () => {
			const response = await agent.call("POST", `/v1/workspaces/${workspaceId}/git/commit`, {
				token,
				body: { message: "feat: initial demo", paths: ["src/index.ts", "src/new/util.ts", "package.json", ".gitignore"] },
			});
			expect(response.status).toBe(201);
			expect(response.json?.data.commit).toMatch(/^[a-f0-9]{40}$/);
			const log = await runGit(project, ["log", "--format=%s"]);
			expect(log.stdout.trim()).toBe("feat: initial demo");
			const status = await agent.call("GET", `/v1/workspaces/${workspaceId}/git/status`, { token });
			expect((status.json?.data.files as { path: string }[]).map((file) => file.path)).toEqual([".env"]);
		});

		it("creates and lists branches, rejecting unsafe names", async () => {
			const bad = await agent.call("POST", `/v1/workspaces/${workspaceId}/git/branches`, { token, body: { name: "--upload-pack=evil" } });
			expect(bad.json?.error?.code).toBe("INVALID_BRANCH_NAME");
			const created = await agent.call("POST", `/v1/workspaces/${workspaceId}/git/branches`, { token, body: { name: "feature/rill-agent" } });
			expect(created.status).toBe(201);
			const list = await agent.call("GET", `/v1/workspaces/${workspaceId}/git/branches`, { token });
			expect(list.json?.data.current).toBe("feature/rill-agent");
			expect((list.json?.data.branches as { name: string }[]).map((branch) => branch.name).sort()).toEqual(["feature/rill-agent", "main"]);
		});

		it("pushes only after native confirmation", async () => {
			agent.prompter.confirmAnswer = false;
			const denied = await agent.call("POST", `/v1/workspaces/${workspaceId}/git/push`, { token, body: {} });
			expect(denied.status).toBe(403);
			expect(denied.json?.error?.code).toBe("PUSH_DENIED");

			agent.prompter.confirmAnswer = true;
			const response = await agent.call("POST", `/v1/workspaces/${workspaceId}/git/push`, { token, body: {} });
			expect(response.status).toBe(202);
			const job = await agent.jobs.wait(response.json?.data.job.id);
			expect(job.output?.map((chunk) => chunk.data).join("")).toContain("feature/rill-agent");
			expect(job.status).toBe("succeeded");
			const remoteBranches = await runGit(root, [`--git-dir=${remote}`, "for-each-ref", "--format=%(refname)", "refs/heads"]);
			expect(remoteBranches.stdout).toContain("feature/rill-agent");
			expect(agent.prompter.confirmations.at(-1)?.message).toContain("feature/rill-agent");
		});
	});

	describe("pairing lifecycle", () => {
		it("invalidates sessions when the server revokes the machine", async () => {
			agent.rill.revoked = true;
			await agent.controller.heartbeat();
			expect(agent.controller.status()).toMatchObject({ state: "not_paired", paired: false });
			expect(await agent.vault.get()).toBeNull();
			const response = await agent.call("GET", "/v1/workspaces", { token });
			expect(response.status).toBe(401);
			expect(agent.controller.pairedUserId()).toBeNull();
		});
	});
});
