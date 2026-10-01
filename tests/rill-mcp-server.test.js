import { describe, expect, it } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { createMcpServer } = require("../src/cli/mcp-server.cjs");

function createServer(fetcher, env = {}) {
	const diagnostics = [];
	const server = createMcpServer({
		env: { RILL_BASE_URL: "https://example.test", RILL_MCP_CLIENT_ID: "rill-mcp-test", RILL_MCP_CLIENT_SECRET: "secret-redacted", ...env },
		fetcher,
		writeDiagnostic: (event, metadata = {}) => diagnostics.push({ event, ...metadata }),
	});
	return { server, diagnostics };
}

describe("Rill MCP server", () => {
	it("returns a tool response within five seconds", async () => {
		let requestReceived = false;
		const { server, diagnostics } = createServer(async (_url, init) => {
			requestReceived = true;
			expect(init.headers["X-Rill-Client-Id"]).toBe("rill-mcp-test");
			expect(init.headers["X-Rill-Client-Secret"]).toBe("secret-redacted");
			return new Response(JSON.stringify({ executionId: "rill-test", workflowState: "CLASSIFIED" }), { status: 202, headers: { "Content-Type": "application/json" } });
		});

		const startedAt = Date.now();
		const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		const tools = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		const result = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rill_create_request", arguments: { task: "Analise a UI da página Audit Q em public/index.html", sourceClient: "cline" } } });

		expect(Date.now() - startedAt).toBeLessThan(5000);
		expect(init.serverInfo.name).toBe("rill-control-plane");
		expect(tools.tools.map(({ name }) => name)).toEqual(expect.arrayContaining(["rill_healthcheck", "rill_create_request", "rill_get_execution", "rill_get_proposal", "rill_get_report"]));
		expect(tools.tools.map(({ name }) => name)).not.toContain("rill_submit_decision");
		expect(result.content[0].type).toBe("text");
		expect(JSON.parse(result.content[0].text)).toEqual({ status: 202, payload: { executionId: "rill-test", workflowState: "CLASSIFIED" } });
		expect(requestReceived).toBe(true);
		expect(diagnostics.map(({ event }) => event)).toEqual(expect.arrayContaining(["MCP_PROCESS_STARTED", "TOOL_CALL_RECEIVED", "HTTP_REQUEST_STARTED", "HTTP_RESPONSE_RECEIVED", "HTTP_BODY_PARSED", "JSONRPC_RESPONSE_WRITTEN"]));
		expect(JSON.stringify(diagnostics)).not.toContain("secret-redacted");
	});

	it("fails fast when the Rill HTTP request times out", async () => {
		const { server } = createServer((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))), { RILL_HTTP_TIMEOUT_MS: "10" });
		await expect(server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "rill_create_request", arguments: { task: "Analise a UI da página Audit Q em public/index.html", sourceClient: "cline" } } })).rejects.toMatchObject({ name: "AbortError" });
	});

	it("reports local health without calling production", async () => {
		let called = false;
		const { server } = createServer(async () => { called = true; return new Response("{}"); });
		const result = await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rill_healthcheck", arguments: {} } });
		expect(JSON.parse(result.content[0].text)).toEqual({ status: 200, payload: { baseUrlPresent: true, clientIdPresent: true, clientSecretPresent: true, timeoutMs: 15000 } });
		expect(called).toBe(false);
	});
});
