import { EventEmitter } from "node:events";
import { AgentError } from "./errors";
import type { StateStore } from "./state";
import type { TokenVault } from "../security/token-vault";
import type { MachineInfo, PairingStart, RillClient, RillIdentity } from "../rill/client";

export type ConnectionState = "not_paired" | "pairing" | "connected" | "disconnected";

export interface AgentStatus {
	state: ConnectionState;
	paired: boolean;
	connected: boolean;
	machineId: string | null;
	userEmail: string | null;
	lastHeartbeatAt: string | null;
	lastError: string | null;
	pairing: { userCode: string; verificationUri: string; expiresAt: string } | null;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Owns the relationship with Rill Web: pairing (device code flow), the personal
 * token lifecycle and the heartbeat that drives Connected / Disconnected.
 */
export class AgentController extends EventEmitter {
	private state: ConnectionState = "not_paired";
	private machineId: string | null = null;
	private userId: string | null = null;
	private userEmail: string | null = null;
	private lastHeartbeatAt: string | null = null;
	private lastError: string | null = null;
	private pairing: (PairingStart & { expiresAt: number }) | null = null;
	private pairingTimer: NodeJS.Timeout | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private stopped = false;

	constructor(
		private readonly deps: {
			store: StateStore;
			vault: TokenVault;
			rill: RillClient;
			machine: MachineInfo;
			heartbeatIntervalMs?: number;
			workspaceCount: () => Promise<number>;
		},
	) {
		super();
	}

	async start(): Promise<void> {
		const persisted = await this.deps.store.load();
		this.machineId = persisted.machineId;
		this.userId = persisted.userId;
		this.userEmail = persisted.userEmail;
		const token = await this.deps.vault.get();
		if (token && persisted.userId) {
			this.setState("disconnected");
			await this.heartbeat();
			this.scheduleHeartbeat();
		} else {
			this.setState("not_paired");
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.pairingTimer) clearTimeout(this.pairingTimer);
		this.heartbeatTimer = null;
		this.pairingTimer = null;
	}

	status(): AgentStatus {
		return {
			state: this.state,
			paired: this.userId !== null && this.state !== "not_paired" && this.state !== "pairing",
			connected: this.state === "connected",
			machineId: this.machineId,
			userEmail: this.userEmail,
			lastHeartbeatAt: this.lastHeartbeatAt,
			lastError: this.lastError,
			pairing: this.pairing
				? { userCode: this.pairing.userCode, verificationUri: this.pairing.verificationUri, expiresAt: new Date(this.pairing.expiresAt).toISOString() }
				: null,
		};
	}

	pairedUserId(): string | null {
		return this.state === "not_paired" || this.state === "pairing" ? null : this.userId;
	}

	async token(): Promise<string | null> {
		return this.deps.vault.get();
	}

	/** Starts the device-code flow and returns the URL the user must open in Rill Web. */
	async startPairing(): Promise<PairingStart> {
		if (this.pairing && this.pairing.expiresAt > Date.now()) return this.pairing;
		const pairing = await this.deps.rill.startPairing(this.deps.machine);
		this.pairing = { ...pairing, expiresAt: Date.now() + pairing.expiresIn * 1000 };
		this.lastError = null;
		this.setState("pairing");
		this.schedulePoll(pairing.interval);
		return pairing;
	}

	cancelPairing(): void {
		if (this.pairingTimer) clearTimeout(this.pairingTimer);
		this.pairingTimer = null;
		this.pairing = null;
		this.setState(this.userId ? "disconnected" : "not_paired");
	}

	private schedulePoll(intervalSeconds: number): void {
		if (this.pairingTimer) clearTimeout(this.pairingTimer);
		if (this.stopped) return;
		this.pairingTimer = setTimeout(() => void this.poll(intervalSeconds), Math.max(1, intervalSeconds) * 1000);
	}

	private async poll(intervalSeconds: number): Promise<void> {
		const pairing = this.pairing;
		if (!pairing) return;
		if (pairing.expiresAt <= Date.now()) {
			this.pairing = null;
			this.lastError = "Pairing code expired. Start pairing again.";
			this.setState("not_paired");
			return;
		}
		try {
			const result = await this.deps.rill.pollPairing(pairing.deviceCode);
			if (result.status === "PENDING") return this.schedulePoll(intervalSeconds);
			this.pairing = null;
			if (result.status === "APPROVED") {
				await this.completePairing(result.token, { machineId: result.machineId, userId: result.userId, email: result.email });
				return;
			}
			this.lastError = result.status === "DENIED" ? "Pairing was denied in Rill." : "Pairing code expired. Start pairing again.";
			this.setState("not_paired");
		} catch (error) {
			this.lastError = (error as Error).message;
			this.emitStatus();
			this.schedulePoll(intervalSeconds * 2);
		}
	}

	async completePairing(token: string, identity: RillIdentity): Promise<void> {
		await this.deps.vault.set(token);
		const persisted = await this.deps.store.load();
		await this.deps.store.save({ ...persisted, machineId: identity.machineId, userId: identity.userId, userEmail: identity.email });
		this.machineId = identity.machineId;
		this.userId = identity.userId;
		this.userEmail = identity.email;
		this.lastError = null;
		this.lastHeartbeatAt = new Date().toISOString();
		this.setState("connected");
		this.scheduleHeartbeat();
		this.emit("paired", identity);
	}

	/** Forgets the personal token locally. Revocation on the server is done from Rill Web. */
	async unpair(reason: string | null = null): Promise<void> {
		await this.deps.vault.clear();
		const persisted = await this.deps.store.load();
		await this.deps.store.save({ ...persisted, machineId: null, userId: null, userEmail: null });
		this.machineId = null;
		this.userId = null;
		this.userEmail = null;
		this.lastError = reason;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		this.setState("not_paired");
		this.emit("unpaired");
	}

	async heartbeat(): Promise<void> {
		const token = await this.deps.vault.get();
		if (!token) return;
		try {
			const identity = await this.deps.rill.heartbeat(token, { ...this.deps.machine, workspaceCount: await this.deps.workspaceCount() });
			this.machineId = identity.machineId;
			this.userEmail = identity.email ?? this.userEmail;
			this.lastHeartbeatAt = new Date().toISOString();
			this.lastError = null;
			this.setState("connected");
		} catch (error) {
			if (error instanceof AgentError && error.code === "RILL_UNAUTHORIZED") {
				await this.unpair("This machine was disconnected from Rill. Pair again.");
				return;
			}
			this.lastError = (error as Error).message;
			this.setState("disconnected");
		}
	}

	/** Exchanges a Rill Web access token for a check that the browser user owns this Agent. */
	async verifyBrowserUser(accessToken: string): Promise<RillIdentity> {
		const token = await this.deps.vault.get();
		const userId = this.pairedUserId();
		if (!token || !userId) throw new AgentError("AGENT_NOT_PAIRED", "Pair this Agent with Rill before connecting.", 409);
		try {
			const identity = await this.deps.rill.verifySession(token, accessToken);
			if (identity.userId !== userId) throw new AgentError("SESSION_USER_MISMATCH", "This Agent is paired with a different Rill account.", 403);
			if (this.state !== "connected") {
				this.lastHeartbeatAt = new Date().toISOString();
				this.setState("connected");
			}
			return identity;
		} catch (error) {
			if (error instanceof AgentError && error.code === "RILL_UNAUTHORIZED") {
				await this.unpair("This machine was disconnected from Rill. Pair again.");
				throw new AgentError("AGENT_NOT_PAIRED", "This Agent's pairing was revoked. Pair again.", 409);
			}
			throw error;
		}
	}

	private scheduleHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.stopped) return;
		this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
		this.heartbeatTimer.unref?.();
	}

	private setState(state: ConnectionState): void {
		const changed = this.state !== state;
		this.state = state;
		if (changed) this.emitStatus();
	}

	private emitStatus(): void {
		this.emit("status", this.status());
	}
}
