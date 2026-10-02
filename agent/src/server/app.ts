import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { AGENT_VERSION } from "../config";
import type { AgentController } from "../core/agent";
import { AgentError, isAgentError } from "../core/errors";
import type { UserPrompter } from "../core/prompter";
import type { WorkspacePermission } from "../core/state";
import { resolveCommand } from "../exec/catalog";
import type { JobExitEvent, JobManager, JobOutputEvent } from "../exec/jobs";
import { listDirectory, readWorkspaceFile, writeWorkspaceFile } from "../files/service";
import { gitBranches, gitCommit, gitCreateBranch, gitPush, gitStatus } from "../git/service";
import type { LocalSession, SessionManager } from "../security/sessions";
import type { WorkspaceRegistry } from "../workspaces/registry";

export interface AgentServerDeps {
	controller: AgentController;
	sessions: SessionManager;
	workspaces: WorkspaceRegistry;
	jobs: JobManager;
	prompter: UserPrompter;
	allowedOrigins: string[];
	port: number;
}

type AuthedRequest = Request & { session?: LocalSession };

const WS_AUTH_TIMEOUT_MS = 5000;
const WS_PATH = "/v1/events";

function ok(res: Response, data: unknown, status = 200): void {
	res.status(status).json({ ok: true, data });
}

function fail(res: Response, error: AgentError): void {
	res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } });
}

function bearer(header: string | undefined): string | null {
	const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
	return match?.[1] ?? null;
}

export function allowedHosts(port: number): Set<string> {
	return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

/** Wraps async handlers so rejections reach the error middleware with a structured body. */
function route(handler: (req: AuthedRequest, res: Response) => Promise<void> | void) {
	return (req: Request, res: Response, next: NextFunction) => {
		Promise.resolve(handler(req as AuthedRequest, res)).catch(next);
	};
}

export function createAgentApp(deps: AgentServerDeps): express.Express {
	const app = express();
	const hosts = allowedHosts(deps.port);
	const origins = new Set(deps.allowedOrigins);

	app.disable("x-powered-by");
	app.set("trust proxy", false);
	app.set("etag", false);

	// Anti DNS-rebinding: only loopback host names addressed to our port are served.
	app.use((req, res, next) => {
		if (!hosts.has((req.headers.host ?? "").toLowerCase())) return fail(res, new AgentError("HOST_NOT_ALLOWED", "Invalid Host header.", 421));
		next();
	});

	app.use((req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		const origin = req.headers.origin;
		if (origin !== undefined) {
			if (!origins.has(origin)) return fail(res, new AgentError("ORIGIN_NOT_ALLOWED", "This origin may not use the Rill Agent.", 403));
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
			res.setHeader("Access-Control-Max-Age", "600");
		}
		if (req.method === "OPTIONS") {
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
			if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
			res.status(204).end();
			return;
		}
		next();
	});

	app.use(express.json({ limit: "3mb", strict: true }));

	const requireSession = (req: Request, res: Response, next: NextFunction) => {
		const session = deps.sessions.verify(bearer(req.headers.authorization));
		if (!session) return fail(res, new AgentError("UNAUTHORIZED", "A valid Agent session is required.", 401));
		if (deps.controller.pairedUserId() !== session.userId) {
			return fail(res, new AgentError("AGENT_NOT_PAIRED", "The Agent is not paired with this account anymore.", 409));
		}
		(req as AuthedRequest).session = session;
		next();
	};

	const param = (req: Request, name: string): string => {
		const value = req.params[name];
		return typeof value === "string" ? value : "";
	};

	const workspaceFor = (permission: WorkspacePermission) => async (req: Request) => deps.workspaces.require(param(req, "id"), permission);

	app.get("/v1/health", (_req, res) => {
		const status = deps.controller.status();
		ok(res, { service: "rill-agent", version: AGENT_VERSION, platform: process.platform, paired: status.paired, connected: status.connected, state: status.state });
	});

	app.post(
		"/v1/session",
		route(async (req, res) => {
			const accessToken = req.body?.accessToken;
			if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 8192) {
				throw new AgentError("INVALID_REQUEST", "accessToken is required.");
			}
			const identity = await deps.controller.verifyBrowserUser(accessToken);
			const session = deps.sessions.create({ userId: identity.userId, email: identity.email, origin: req.headers.origin ?? null });
			ok(res, { sessionToken: session.token, expiresAt: session.expiresAt, machineId: identity.machineId, agent: deps.controller.status() }, 201);
		}),
	);

	app.delete("/v1/session", (req, res) => {
		const token = bearer(req.headers.authorization);
		if (token) deps.sessions.revoke(token);
		ok(res, { revoked: true });
	});

	app.get("/v1/status", requireSession, (_req, res) => ok(res, deps.controller.status()));

	app.get("/v1/workspaces", requireSession, route(async (_req, res) => ok(res, { workspaces: await deps.workspaces.list() })));

	app.post(
		"/v1/workspaces/requests",
		requireSession,
		route(async (req, res) => {
			const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : undefined;
			const approval = await deps.prompter.approveWorkspace({ requestedBy: req.session?.origin ?? "Rill", reason });
			if (!approval) throw new AgentError("WORKSPACE_REQUEST_DENIED", "The user did not approve exposing a folder.", 403);
			ok(res, { workspace: await deps.workspaces.add(approval.rootPath, approval.permissions) }, 201);
		}),
	);

	app.delete(
		"/v1/workspaces/:id",
		requireSession,
		route(async (req, res) => {
			await deps.workspaces.remove(param(req, "id"));
			ok(res, { removed: true });
		}),
	);

	app.get(
		"/v1/workspaces/:id/tree",
		requireSession,
		route(async (req, res) => ok(res, await listDirectory(await workspaceFor("read")(req), req.query.path ?? ""))),
	);

	app.get(
		"/v1/workspaces/:id/files",
		requireSession,
		route(async (req, res) => ok(res, await readWorkspaceFile(await workspaceFor("read")(req), req.query.path))),
	);

	app.put(
		"/v1/workspaces/:id/files",
		requireSession,
		route(async (req, res) => {
			const body = req.body ?? {};
			ok(res, await writeWorkspaceFile(await workspaceFor("write")(req), { path: body.path, content: body.content, encoding: body.encoding, expectedSha256: body.expectedSha256 }));
		}),
	);

	app.post(
		"/v1/workspaces/:id/commands",
		requireSession,
		route(async (req, res) => {
			const command = resolveCommand(req.body?.command);
			const workspace = await workspaceFor("execute")(req);
			const job = deps.jobs.start({ ...command, workspaceId: workspace.id, commandId: command.id, cwd: workspace.rootPath });
			ok(res, { job }, 202);
		}),
	);

	app.get("/v1/jobs", requireSession, (req, res) => ok(res, { jobs: deps.jobs.list(typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined) }));

	app.get("/v1/jobs/:id", requireSession, (req, res) => {
		const since = Number(req.query.since ?? 0);
		const job = deps.jobs.snapshot(param(req, "id"), Number.isFinite(since) && since >= 0 ? since : 0);
		if (!job) return fail(res, new AgentError("JOB_NOT_FOUND", "Job not found.", 404));
		ok(res, { job });
	});

	app.post("/v1/jobs/:id/cancel", requireSession, (req, res) => ok(res, { job: deps.jobs.cancel(param(req, "id")) }));

	app.get(
		"/v1/workspaces/:id/git/status",
		requireSession,
		route(async (req, res) => ok(res, await gitStatus((await workspaceFor("read")(req)).rootPath))),
	);

	app.get(
		"/v1/workspaces/:id/git/branches",
		requireSession,
		route(async (req, res) => ok(res, await gitBranches((await workspaceFor("read")(req)).rootPath))),
	);

	app.post(
		"/v1/workspaces/:id/git/branches",
		requireSession,
		route(async (req, res) => ok(res, await gitCreateBranch((await workspaceFor("write")(req)).rootPath, req.body ?? {}), 201)),
	);

	app.post(
		"/v1/workspaces/:id/git/commit",
		requireSession,
		route(async (req, res) => ok(res, await gitCommit((await workspaceFor("write")(req)).rootPath, req.body ?? {}), 201)),
	);

	app.post(
		"/v1/workspaces/:id/git/push",
		requireSession,
		route(async (req, res) => {
			const workspace = await workspaceFor("execute")(req);
			const status = await gitStatus(workspace.rootPath);
			const approved = await deps.prompter.confirm({
				title: "Rill Agent — Push to remote",
				message: `Push branch "${status.branch.head ?? "(detached)"}" of "${workspace.name}" to its remote?`,
				detail: `${status.branch.ahead} commit(s) ahead${status.branch.upstream ? ` of ${status.branch.upstream}` : " (no upstream yet: origin will be used)"}. Requested by ${req.session?.origin ?? "Rill"}.`,
				confirmLabel: "Push",
			});
			if (!approved) throw new AgentError("PUSH_DENIED", "The user did not approve the push.", 403);
			ok(res, { job: await gitPush(workspace.rootPath, workspace.id, deps.jobs, req.body ?? {}) }, 202);
		}),
	);

	app.use((_req, res) => fail(res, new AgentError("NOT_FOUND", "Route not found.", 404)));

	app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
		if (isAgentError(error)) return fail(res, error);
		const typed = error as { type?: string; status?: number };
		if (typed?.type === "entity.too.large") return fail(res, new AgentError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413));
		if (typed?.type === "entity.parse.failed") return fail(res, new AgentError("INVALID_JSON", "Request body must be valid JSON.", 400));
		console.error("[rill-agent] unexpected error", error);
		fail(res, new AgentError("INTERNAL_ERROR", "Unexpected Agent error.", 500));
	});

	return app;
}

export interface RunningAgentServer {
	port: number;
	servers: http.Server[];
	broadcast(type: string, payload: unknown): void;
	close(): Promise<void>;
}

/** Starts HTTP + WebSocket on loopback only. Both IPv4 and IPv6 loopback are bound when available. */
export async function startAgentServer(deps: AgentServerDeps, options: { hosts?: string[] } = {}): Promise<RunningAgentServer> {
	const app = createAgentApp(deps);
	const hosts = allowedHosts(deps.port);
	const origins = new Set(deps.allowedOrigins);
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	const clients = new Set<WebSocket>();

	const broadcast = (type: string, payload: unknown) => {
		const message = JSON.stringify({ type, payload });
		for (const client of clients) if (client.readyState === client.OPEN) client.send(message);
	};

	wss.on("connection", (socket: WebSocket) => {
		let session: LocalSession | null = null;
		const timer = setTimeout(() => socket.close(4401, "Authentication timeout"), WS_AUTH_TIMEOUT_MS);
		socket.on("message", (raw) => {
			let message: { type?: unknown; sessionToken?: unknown };
			try {
				message = JSON.parse(raw.toString());
			} catch {
				socket.close(4400, "Invalid message");
				return;
			}
			if (!session) {
				const candidate = message.type === "auth" && typeof message.sessionToken === "string" ? deps.sessions.verify(message.sessionToken) : null;
				if (!candidate || deps.controller.pairedUserId() !== candidate.userId) {
					socket.close(4401, "Unauthorized");
					return;
				}
				session = candidate;
				clearTimeout(timer);
				clients.add(socket);
				socket.send(JSON.stringify({ type: "ready", payload: { agent: deps.controller.status() } }));
				return;
			}
			if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", payload: { at: new Date().toISOString() } }));
		});
		socket.on("close", () => {
			clearTimeout(timer);
			clients.delete(socket);
		});
		socket.on("error", () => socket.terminate());
	});

	const onOutput = (event: JobOutputEvent) => broadcast("job.output", event);
	const onExit = (event: JobExitEvent) => broadcast("job.exit", event);
	const onStatus = (status: unknown) => broadcast("agent.status", status);
	const onUnpaired = () => {
		deps.sessions.revokeAll();
		for (const client of clients) client.close(4409, "Agent unpaired");
	};
	deps.jobs.on("output", onOutput);
	deps.jobs.on("exit", onExit);
	deps.controller.on("status", onStatus);
	deps.controller.on("unpaired", onUnpaired);

	const servers: http.Server[] = [];
	const bindHosts = options.hosts ?? ["127.0.0.1", "::1"];
	let boundPort = deps.port;
	for (const [index, host] of bindHosts.entries()) {
		const server = http.createServer(app);
		server.on("upgrade", (req, socket, head) => {
			const origin = req.headers.origin;
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname !== WS_PATH || !hosts.has((req.headers.host ?? "").toLowerCase()) || (origin !== undefined && !origins.has(origin))) {
				socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(index === 0 ? deps.port : boundPort, host, () => {
					server.off("error", reject);
					resolve();
				});
			});
			if (index === 0) boundPort = (server.address() as AddressInfo).port;
			servers.push(server);
		} catch (error) {
			if (index === 0) throw error;
			// Secondary loopback (usually IPv6) is optional.
		}
	}

	return {
		port: boundPort,
		servers,
		broadcast,
		close: async () => {
			deps.jobs.off("output", onOutput);
			deps.jobs.off("exit", onExit);
			deps.controller.off("status", onStatus);
			deps.controller.off("unpaired", onUnpaired);
			for (const client of clients) client.terminate();
			wss.close();
			await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		},
	};
}
