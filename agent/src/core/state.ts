import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type WorkspacePermission = "read" | "write" | "execute";

export interface WorkspaceRecord {
	id: string;
	name: string;
	rootPath: string;
	permissions: WorkspacePermission[];
	approvedAt: string;
}

export interface AgentState {
	version: 1;
	machineId: string | null;
	userId: string | null;
	userEmail: string | null;
	workspaces: WorkspaceRecord[];
}

export function emptyState(): AgentState {
	return { version: 1, machineId: null, userId: null, userEmail: null, workspaces: [] };
}

export interface StateStore {
	load(): Promise<AgentState>;
	save(state: AgentState): Promise<void>;
}

export class MemoryStateStore implements StateStore {
	private state: AgentState;

	constructor(initial: AgentState = emptyState()) {
		this.state = structuredClone(initial);
	}

	async load(): Promise<AgentState> {
		return structuredClone(this.state);
	}

	async save(state: AgentState): Promise<void> {
		this.state = structuredClone(state);
	}
}

function sanitizeState(value: unknown): AgentState {
	const state = emptyState();
	if (!value || typeof value !== "object") return state;
	const record = value as Partial<AgentState>;
	state.machineId = typeof record.machineId === "string" ? record.machineId : null;
	state.userId = typeof record.userId === "string" ? record.userId : null;
	state.userEmail = typeof record.userEmail === "string" ? record.userEmail : null;
	if (Array.isArray(record.workspaces)) {
		state.workspaces = record.workspaces.filter(
			(item): item is WorkspaceRecord =>
				Boolean(item) &&
				typeof item.id === "string" &&
				typeof item.rootPath === "string" &&
				typeof item.name === "string" &&
				Array.isArray(item.permissions),
		).map((item) => ({
			...item,
			permissions: item.permissions.filter((permission) => permission === "read" || permission === "write" || permission === "execute"),
		}));
	}
	return state;
}

/** Persists non-secret Agent state. Secrets live in the TokenVault, never here. */
export class JsonStateStore implements StateStore {
	constructor(private readonly filePath: string) {}

	async load(): Promise<AgentState> {
		try {
			return sanitizeState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
			throw error;
		}
	}

	async save(state: AgentState): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
		await fs.writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
		await fs.rename(temporary, this.filePath);
	}
}
