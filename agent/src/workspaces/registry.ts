import path from "node:path";
import { randomBytes } from "node:crypto";
import { AgentError } from "../core/errors";
import type { AgentState, StateStore, WorkspacePermission, WorkspaceRecord } from "../core/state";
import { isWithin, validateWorkspaceRoot, type WorkspaceRootPolicy } from "../security/paths";

export interface PublicWorkspace {
	id: string;
	name: string;
	rootPath: string;
	permissions: WorkspacePermission[];
	approvedAt: string;
}

function normalizePermissions(permissions: WorkspacePermission[]): WorkspacePermission[] {
	const set = new Set<WorkspacePermission>(["read"]);
	for (const permission of permissions) set.add(permission);
	if (set.has("execute")) set.add("write");
	return (["read", "write", "execute"] as const).filter((permission) => set.has(permission));
}

/** Holds the folders the user explicitly approved. Nothing outside this list is reachable. */
export class WorkspaceRegistry {
	constructor(
		private readonly store: StateStore,
		private readonly rootPolicy: WorkspaceRootPolicy = {},
	) {}

	async list(): Promise<PublicWorkspace[]> {
		const state = await this.store.load();
		return state.workspaces.map((workspace) => ({ ...workspace }));
	}

	async get(id: string): Promise<WorkspaceRecord> {
		const state = await this.store.load();
		const workspace = state.workspaces.find((item) => item.id === id);
		if (!workspace) throw new AgentError("WORKSPACE_NOT_FOUND", "Workspace is not approved on this machine.", 404);
		return workspace;
	}

	async require(id: string, permission: WorkspacePermission): Promise<WorkspaceRecord> {
		const workspace = await this.get(id);
		if (!workspace.permissions.includes(permission)) {
			throw new AgentError("WORKSPACE_PERMISSION_DENIED", `The user did not grant "${permission}" permission for this workspace.`, 403);
		}
		const currentRoot = await validateWorkspaceRoot(workspace.rootPath, this.rootPolicy).catch(() => null);
		if (!currentRoot || path.relative(currentRoot, workspace.rootPath) !== "") {
			throw new AgentError("WORKSPACE_UNAVAILABLE", "The approved folder moved or is no longer available. Approve it again.", 409);
		}
		return workspace;
	}

	async add(rootPath: string, permissions: WorkspacePermission[]): Promise<PublicWorkspace> {
		const realRoot = await validateWorkspaceRoot(rootPath, this.rootPolicy);
		const state = await this.store.load();
		const overlapping = state.workspaces.find(
			(item) => path.relative(item.rootPath, realRoot) !== "" && (isWithin(item.rootPath, realRoot) || isWithin(realRoot, item.rootPath)),
		);
		if (overlapping) {
			throw new AgentError("WORKSPACE_OVERLAP", `This folder overlaps the approved workspace "${overlapping.name}". Remove it first.`, 409);
		}
		const existing = state.workspaces.find((item) => path.relative(item.rootPath, realRoot) === "");
		const record: WorkspaceRecord = {
			id: existing?.id ?? `ws_${randomBytes(9).toString("base64url")}`,
			name: path.basename(realRoot),
			rootPath: realRoot,
			permissions: normalizePermissions(permissions),
			approvedAt: new Date().toISOString(),
		};
		const next: AgentState = { ...state, workspaces: [...state.workspaces.filter((item) => item.id !== record.id), record] };
		await this.store.save(next);
		return { ...record };
	}

	async remove(id: string): Promise<void> {
		const state = await this.store.load();
		if (!state.workspaces.some((item) => item.id === id)) throw new AgentError("WORKSPACE_NOT_FOUND", "Workspace is not approved on this machine.", 404);
		await this.store.save({ ...state, workspaces: state.workspaces.filter((item) => item.id !== id) });
	}
}
