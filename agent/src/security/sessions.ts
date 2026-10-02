import { createHash, randomBytes } from "node:crypto";

export interface LocalSession {
	userId: string;
	email: string | null;
	origin: string | null;
	createdAt: number;
	expiresAt: number;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;

function hash(token: string): Buffer {
	return createHash("sha256").update(token).digest();
}

/**
 * Short-lived local session tokens handed to the Rill web app. They replace the
 * personal token in the browser, so the personal token never leaves the Agent.
 */
export class SessionManager {
	private readonly sessions = new Map<string, LocalSession>();

	constructor(private readonly ttlMs = DEFAULT_TTL_MS, private readonly now: () => number = Date.now) {}

	create(input: { userId: string; email: string | null; origin: string | null }): { token: string; expiresAt: string } {
		this.prune();
		if (this.sessions.size >= MAX_SESSIONS) {
			const oldest = [...this.sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
			if (oldest) this.sessions.delete(oldest[0]);
		}
		const token = `rill_ls_${randomBytes(32).toString("base64url")}`;
		const createdAt = this.now();
		const session: LocalSession = { ...input, createdAt, expiresAt: createdAt + this.ttlMs };
		this.sessions.set(hash(token).toString("hex"), session);
		return { token, expiresAt: new Date(session.expiresAt).toISOString() };
	}

	verify(token: string | null | undefined): LocalSession | null {
		if (!token || !token.startsWith("rill_ls_")) return null;
		const key = hash(token).toString("hex");
		const session = this.sessions.get(key);
		if (!session) return null;
		if (session.expiresAt <= this.now()) {
			this.sessions.delete(key);
			return null;
		}
		return session;
	}

	revoke(token: string): void {
		this.sessions.delete(hash(token).toString("hex"));
	}

	revokeAll(): void {
		this.sessions.clear();
	}

	private prune(): void {
		const now = this.now();
		for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
	}
}
