/** Stores the Rill personal token. Implementations must never expose it outside the Agent process. */
export interface TokenVault {
	get(): Promise<string | null>;
	set(token: string): Promise<void>;
	clear(): Promise<void>;
}

export class MemoryTokenVault implements TokenVault {
	constructor(private token: string | null = null) {}

	async get(): Promise<string | null> {
		return this.token;
	}

	async set(token: string): Promise<void> {
		this.token = token;
	}

	async clear(): Promise<void> {
		this.token = null;
	}
}
