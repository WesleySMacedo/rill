import { handleAgentApi } from "./src/runtime/agent-api";
import { handleMissionApi } from "./src/runtime/mission-api";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/health") {
			return Response.json({ status: "ok", service: "rill-web" });
		}
		if (pathname === "/api/agent" || pathname.startsWith("/api/agent/")) return handleAgentApi(request, env, ctx);
		if (pathname.startsWith("/api/")) return handleMissionApi(request, env, ctx);

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;