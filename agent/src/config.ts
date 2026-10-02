export const AGENT_VERSION = "0.1.0";
export const AGENT_PORT = 7777;
export const AGENT_HOSTS = ["127.0.0.1", "::1"] as const;

export const DEFAULT_RILL_APP_URL = "https://rill.wesleysmacedo.com";

export const PRODUCTION_ORIGINS = [
	"https://rill.wesleysmacedo.com",
	"https://rill-web.runai-systems-llc.workers.dev",
];

export interface AgentConfig {
	rillAppUrl: string;
	port: number;
	allowedOrigins: string[];
}

function parseList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * Production origins are fixed. Extra origins (for local web development) are only
 * accepted from RILL_AGENT_DEV_ORIGINS and must point to a loopback host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
	const devOrigins = parseList(env.RILL_AGENT_DEV_ORIGINS).filter((origin) => {
		try {
			const url = new URL(origin);
			return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
		} catch {
			return false;
		}
	});
	const rillAppUrl = (env.RILL_APP_URL ?? DEFAULT_RILL_APP_URL).replace(/\/+$/, "");
	const appUrl = new URL(rillAppUrl);
	const loopback = appUrl.hostname === "localhost" || appUrl.hostname === "127.0.0.1";
	if (appUrl.protocol !== "https:" && !(appUrl.protocol === "http:" && loopback)) {
		throw new Error("RILL_APP_URL must use https (http is only allowed for loopback development).");
	}
	const appOrigin = appUrl.origin;
	return {
		rillAppUrl,
		port: AGENT_PORT,
		allowedOrigins: Array.from(new Set([...PRODUCTION_ORIGINS, appOrigin, ...devOrigins])),
	};
}
