const readline = require("readline");

function routeName(path) {
	if (path === "/api/internal/rill/requests") return path;
	if (/^\/api\/internal\/rill\/executions\/[^/]+\/decision$/.test(path)) return "/api/internal/rill/executions/:executionId/decision";
	if (/^\/api\/internal\/rill\/executions\/[^/]+$/.test(path)) return "/api/internal/rill/executions/:executionId";
	return "UNKNOWN_ROUTE";
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

const tools = [
	{
		name: "rill_healthcheck",
		description: "Verify local Rill MCP configuration without calling the production Worker.",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
	},
	{
		name: "rill_create_request",
		description: "Create a Rill-governed engineering request. This is the only entrypoint for a new task.",
		inputSchema: { type: "object", additionalProperties: false, properties: { task: { type: "string" }, sourceClient: { type: "string", enum: ["cline", "continue", "copilot", "api"] } }, required: ["task"] },
	},
	{
		name: "rill_get_execution",
		description: "Get the minimized status of a Rill execution.",
		inputSchema: { type: "object", additionalProperties: false, properties: { executionId: { type: "string" } }, required: ["executionId"] },
	},
	{
		name: "rill_get_proposal",
		description: "Get the read-only proposal for a Rill execution.",
		inputSchema: { type: "object", additionalProperties: false, properties: { executionId: { type: "string" } }, required: ["executionId"] },
	},
	{
		name: "rill_get_report",
		description: "Get the minimized terminal report for a Rill execution.",
		inputSchema: { type: "object", additionalProperties: false, properties: { executionId: { type: "string" } }, required: ["executionId"] },
	},
];

function createMcpServer(options = {}) {
	const env = options.env ?? process.env;
	const baseUrl = env.RILL_BASE_URL?.replace(/\/$/, "");
	const clientId = env.RILL_MCP_CLIENT_ID;
	const clientSecret = env.RILL_MCP_CLIENT_SECRET;
	const timeoutMs = Number(env.RILL_HTTP_TIMEOUT_MS ?? 15000);
	const fetcher = options.fetcher ?? fetch;
	const writeDiagnostic = options.writeDiagnostic ?? ((event, metadata = {}) => process.stderr.write(`${JSON.stringify({ event, ...metadata })}\n`));

	function diagnostic(event, metadata = {}) {
		writeDiagnostic(event, metadata);
	}

	diagnostic("MCP_PROCESS_STARTED", {
		BASE_URL_PRESENT: Boolean(baseUrl),
		CLIENT_ID_PRESENT: Boolean(clientId),
		CLIENT_SECRET_PRESENT: Boolean(clientSecret),
		NODE_OPTIONS_PRESENT: Boolean(env.NODE_OPTIONS),
		HTTPS_PROXY_PRESENT: Boolean(env.HTTPS_PROXY || env.https_proxy),
		NO_PROXY_PRESENT: Boolean(env.NO_PROXY || env.no_proxy),
		CWD: process.cwd(),
	});

	async function callRill(path, method, body) {
		if (!baseUrl) throw new Error("RILL_BASE_URL_REQUIRED");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000);
		diagnostic("HTTP_REQUEST_STARTED", { method, route: routeName(path) });
		try {
			const response = await fetcher(`${baseUrl}${path}`, {
				method,
				headers: { "Content-Type": "application/json", ...(clientId && clientSecret ? { "X-Rill-Client-Id": clientId, "X-Rill-Client-Secret": clientSecret } : {}) },
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			diagnostic("HTTP_RESPONSE_RECEIVED", { status: response.status, route: routeName(path) });
			const payload = await response.json();
			diagnostic("HTTP_BODY_PARSED", { status: response.status, route: routeName(path) });
			return { status: response.status, payload };
		} finally {
			clearTimeout(timeout);
		}
	}

	async function handle(request) {
		if (request.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "rill-control-plane", version: "1.0.0" } };
		if (request.method === "tools/list") return { tools };
		if (request.method === "tools/call") {
			const args = request.params?.arguments ?? {};
			let result;
			diagnostic("TOOL_CALL_RECEIVED", { tool: request.params?.name ?? "UNKNOWN_TOOL" });
			if (request.params?.name === "rill_healthcheck") result = { status: 200, payload: { baseUrlPresent: Boolean(baseUrl), clientIdPresent: Boolean(clientId), clientSecretPresent: Boolean(clientSecret), timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000 } };
			else if (request.params?.name === "rill_create_request") result = await callRill("/api/internal/rill/requests", "POST", { task: args.task, sourceClient: args.sourceClient ?? "cline" });
			else if (request.params?.name === "rill_get_execution") result = await callRill(`/api/internal/rill/executions/${encodeURIComponent(args.executionId)}`, "GET");
			else if (request.params?.name === "rill_get_proposal") result = await callRill(`/api/internal/rill/executions/${encodeURIComponent(args.executionId)}/proposal`, "GET");
			else if (request.params?.name === "rill_get_report") result = await callRill(`/api/internal/rill/executions/${encodeURIComponent(args.executionId)}/report`, "GET");
			else throw new Error("TOOL_NOT_FOUND");
			diagnostic("JSONRPC_RESPONSE_WRITTEN", { id: request.id ?? null, tool: request.params?.name ?? "UNKNOWN_TOOL" });
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		}
		return undefined;
	}

	return { handle, tools, diagnostic };
}

function startStdioServer(server = createMcpServer()) {
	const input = readline.createInterface({ input: process.stdin, terminal: false });
	input.on("line", async (line) => {
		let request;
		try {
			request = JSON.parse(line);
			const result = await server.handle(request);
			if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
		} catch (error) {
			const message = error instanceof Error && error.name === "AbortError" ? "RILL_HTTP_TIMEOUT" : error instanceof Error ? error.message : "RILL_MCP_ERROR";
			server.diagnostic("TOOL_CALL_FAILED", { id: request?.id ?? null, message });
			send({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32000, message } });
		}
	});
}

if (require.main === module) startStdioServer();

module.exports = { createMcpServer, routeName, tools };
