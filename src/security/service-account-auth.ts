function configured(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

async function digest(value: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalText(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return difference === 0;
}

export interface RillServicePrincipal {
	type: "service_account";
	clientId: string;
	scopes: string[];
	environment: string;
}

export interface ServiceAccountEnv {
	SUPABASE_URL?: string;
	SUPABASE_SERVICE_ROLE_KEY?: string;
	RUNTIME_ENVIRONMENT?: string;
}

export async function authenticateServiceAccount(request: Request, env: ServiceAccountEnv, requiredScope: string): Promise<RillServicePrincipal | null> {
	const clientId = request.headers.get("X-Rill-Client-Id");
	const clientSecret = request.headers.get("X-Rill-Client-Secret");
	if (!clientId && !clientSecret) return null;
	if (!clientId || !clientSecret || !configured(env.SUPABASE_URL) || !configured(env.SUPABASE_SERVICE_ROLE_KEY)) throw new Error("SERVICE_ACCOUNT_UNAUTHORIZED");

	const hash = await digest(clientSecret);
	const query = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rill_service_accounts`);
	query.searchParams.set("select", "client_id,secret_hash,active,environment,scopes,expires_at,revoked_at");
	query.searchParams.set("client_id", `eq.${encodeURIComponent(clientId)}`);
	const response = await fetch(query, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
	if (!response.ok) throw new Error("SERVICE_ACCOUNT_STORE_UNAVAILABLE");
	const records = await response.json();
	const record = Array.isArray(records) ? records[0] : null;
	const environment = env.RUNTIME_ENVIRONMENT ?? "production";
	const scopes = Array.isArray(record?.scopes) ? record.scopes.map(String) : [];
	const expired = record?.expires_at && new Date(record.expires_at).getTime() <= Date.now();
	if (!record || !record.active || record.revoked_at || expired || record.environment !== environment || !equalText(String(record.secret_hash), hash) || !scopes.includes(requiredScope)) throw new Error("SERVICE_ACCOUNT_UNAUTHORIZED");

	await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rill_service_accounts?client_id=eq.${encodeURIComponent(clientId)}`, {
		method: "PATCH",
		headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
		body: JSON.stringify({ last_used_at: new Date().toISOString() }),
	});
	return { type: "service_account", clientId, scopes, environment };
}
