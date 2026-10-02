import { promises as fs } from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { TokenVault } from "../security/token-vault";

/**
 * Stores the personal token encrypted with the OS keystore (DPAPI on Windows).
 * If OS encryption is unavailable the token is refused rather than stored in clear text.
 */
export class SafeStorageTokenVault implements TokenVault {
	private cache: string | null | undefined;

	constructor(private readonly filePath: string) {}

	async get(): Promise<string | null> {
		if (this.cache !== undefined) return this.cache;
		try {
			const encrypted = await fs.readFile(this.filePath);
			this.cache = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(encrypted) : null;
		} catch {
			this.cache = null;
		}
		return this.cache;
	}

	async set(token: string): Promise<void> {
		if (!safeStorage.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; refusing to store the Rill token.");
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp`;
		await fs.writeFile(temporary, safeStorage.encryptString(token), { mode: 0o600 });
		await fs.rename(temporary, this.filePath);
		this.cache = token;
	}

	async clear(): Promise<void> {
		this.cache = null;
		await fs.rm(this.filePath, { force: true });
	}
}
