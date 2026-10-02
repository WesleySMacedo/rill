import { AgentError } from "../core/errors";

export interface MachineInfo {
	machineName: string;
	platform: string;
	agentVersion: string;
}

export interface PairingStart {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
}

export type PairingPoll =
	| { status: "PENDING" | "DENIED" | "EXPIRED" }
	| { status: "APPROVED"; token: string; machineId: string; userId: string; email: string | null };

export interface RillIdentity {
	machineId: string;
	userId: string;
	email: string | null;
}

export interface RillClient {
	startPairing(machine: MachineInfo): Promise<PairingStart>;
	pollPairing(deviceCode: string): Promise<PairingPoll>;
	heartbeat(token: string, machine: MachineInfo & { workspaceCount: number }): Promise<RillIdentity>;
	verifySession(token: string, accessToken: string): Promise<RillIdentity>;
}

type Envelope<T> = { ok?: boolean; data?: T; error?: { code?: string; message?: string } } & Record<string, unknown>;

/** Talks to the Rill Worker. The personal token is only ever sent to the configured Rill origin. */
export class HttpRillClient implements RillClient {
	constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

	private async request<T>(path: string, init: { method: string; body?: unknown; token?: string }): Promise<{ status: number; body: Envelope<T> }> {
		const headers: Record<string, string> = { accept: "application/json" };
		if (init.body !== undefined) headers["content-type"] = "application/json";
		if (init.token) headers.authorization = `Bearer ${init.token}`;
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: init.method,
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
				signal: AbortSignal.timeout(15_000),
				redirect: "error",
			});
		} catch (error) {
			throw new AgentError("RILL_UNREACHABLE", `Could not reach Rill: ${(error as Error).message}`, 503);
		}
		const body = (await response.json().catch(() => ({}))) as Envelope<T>;
		return { status: response.status, body };
	}

	private static fail(status: number, body: Envelope<unknown>, fallback: string): AgentError {
		if (status === 401) return new AgentError("RILL_UNAUTHORIZED", body.error?.message ?? "Rill rejected the credentials.", 401);
		return new AgentError(body.error?.code ?? "RILL_REQUEST_FAILED", body.error?.message ?? fallback, status >= 500 ? 502 : status);
	}

	async startPairing(machine: MachineInfo): Promise<PairingStart> {
		const { status, body } = await this.request<PairingStart>("/api/agent/pairings", { method: "POST", body: machine });
		if (status !== 201 || !body.data) throw HttpRillClient.fail(status, body, "Could not start pairing.");
		return body.data;
	}

	async pollPairing(deviceCode: string): Promise<PairingPoll> {
		const { status, body } = await this.request<PairingPoll>("/api/agent/pairings/poll", { method: "POST", body: { deviceCode } });
		if (status === 410) return { status: "EXPIRED" };
		if (status !== 200 || !body.data) throw HttpRillClient.fail(status, body, "Could not check pairing status.");
		return body.data;
	}

	async heartbeat(token: string, machine: MachineInfo & { workspaceCount: number }): Promise<RillIdentity> {
		const { status, body } = await this.request<RillIdentity>("/api/agent/heartbeat", { method: "POST", body: machine, token });
		if (status !== 200 || !body.data) throw HttpRillClient.fail(status, body, "Heartbeat failed.");
		return body.data;
	}

	async verifySession(token: string, accessToken: string): Promise<RillIdentity> {
		const { status, body } = await this.request<RillIdentity>("/api/agent/sessions/verify", { method: "POST", body: { accessToken }, token });
		if (status === 403) throw new AgentError(body.error?.code ?? "SESSION_INVALID", body.error?.message ?? "The Rill session could not be verified.", 403);
		if (status !== 200 || !body.data) throw HttpRillClient.fail(status, body, "Could not verify the Rill session.");
		return body.data;
	}
}
