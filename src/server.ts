import { runAgentLoopValidationEntrypoint } from "./runtime/agent-loop-entrypoint";
import { createRillRequest } from "./runtime/rill-request-entrypoint";
import { authenticateServiceAccount } from "./security/service-account-auth";
import { claimRillReviewTicket, createRillExecution, findRillExecutionByIdempotencyKey } from "./infrastructure/rill-persistence";
import { RillExecutionWorkflow } from "./workflows/rill-execution.workflow";
import registry from "../engineering-registry.json" with { type: "json" };

export * from "./index";

const jsonResponse = (payload: unknown, status = 200) =>
	new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});

export default {
	async fetch(request: Request, env: any) {
		const { pathname } = new URL(request.url);

		if (pathname === "/api/internal/agent-loop/validate" && request.method === "GET") {
			if (!env.AGENT_LOOP_RUNTIME_ENABLED || env.AGENT_LOOP_RUNTIME_ENABLED === "false") {
				return jsonResponse({ error: "Agent Loop runtime disabled" }, 401);
			}
			const fileSystem = {
				getFileInfo(path: string) {
					return { exists: true, size: 1 };
				},
			};
			const result = await runAgentLoopValidationEntrypoint(env, { registry, fileSystem });
			return jsonResponse(result);
		}

		if (pathname === "/api/internal/rill/requests" && request.method === "POST") {
			const body = await request.json().catch(() => ({})) as any;
			const fileSystem = {
				getFileInfo(path: string) {
					return { exists: true, size: 1 };
				},
			};
			const result = createRillRequest(body, { registry, fileSystem });
			return jsonResponse(result, result.status === "READY" ? 202 : 400);
		}

		return jsonResponse({ error: "Not Found" }, 404);
	},
};
