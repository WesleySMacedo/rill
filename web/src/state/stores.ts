import { create } from "zustand";

type PermissionedFileHandle = FileSystemFileHandle & {
	queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
	requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
};

export type WorkspaceEntry = {
	name: string;
	path: string;
	depth: number;
	kind: "directory" | "file";
	size: number;
	handle?: FileSystemFileHandle;
};

export type OpenWorkspaceFile = {
	path: string;
	name: string;
	original: string;
	value: string;
	handle: FileSystemFileHandle;
};

interface MissionStoreState {
	activeMissionId: string | null;
	draft: string;
	setActiveMissionId: (id: string | null) => void;
	setDraft: (draft: string) => void;
}

interface WorkspaceStoreState {
	rootName: string | null;
	rootHandle: FileSystemDirectoryHandle | null;
	entries: WorkspaceEntry[];
	openFiles: OpenWorkspaceFile[];
	activePath: string | null;
	selectedContextPaths: string[];
	expandedDirectories: string[];
	showDiff: boolean;
	loading: boolean;
	error: string | null;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	setWorkspace: (handle: FileSystemDirectoryHandle, entries: WorkspaceEntry[]) => void;
	toggleContextPath: (path: string) => void;
	toggleDirectory: (path: string) => void;
	openFile: (path: string) => Promise<void>;
	setActivePath: (path: string) => void;
	setShowDiff: (show: boolean) => void;
	updateActiveFile: (value: string) => void;
	saveActiveFile: () => Promise<void>;
	closeFile: (path: string) => void;
}

interface RouterStoreState {
	profile: string | null;
	provider: string | null;
	model: string | null;
	status: "idle" | "not-configured" | "not-invoked" | "selected";
	confidence: number | null;
	setRoute: (route: Pick<RouterStoreState, "profile" | "provider" | "model" | "status" | "confidence">) => void;
}

interface GovernanceStoreState {
	missionState: string | null;
	risk: string | null;
	contextPaths: string[];
	approvalRequired: boolean;
	executionGate: "LOCKED" | "AUTHORIZED" | "NOT_APPLICABLE";
	setGovernance: (values: Partial<Omit<GovernanceStoreState, "setGovernance">>) => void;
}

interface ApprovalStoreState {
	approvalId: string | null;
	decision: "PENDING" | "APPROVED" | "REJECTED" | "REQUESTED_CHANGES" | null;
	justification: string;
	setApproval: (approval: Partial<Omit<ApprovalStoreState, "setApproval">>) => void;
}

interface ExecutionStoreState {
	state: string | null;
	gate: "LOCKED" | "AUTHORIZED" | "NOT_APPLICABLE";
	setExecution: (state: string | null, gate: ExecutionStoreState["gate"]) => void;
}

export const useMissionStore = create<MissionStoreState>((set) => ({
	activeMissionId: null,
	draft: "",
	setActiveMissionId: (activeMissionId) => set({ activeMissionId }),
	setDraft: (draft) => set({ draft }),
}));

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
	rootName: null,
	rootHandle: null,
	entries: [],
	openFiles: [],
	activePath: null,
	selectedContextPaths: [],
	expandedDirectories: [],
	showDiff: false,
	loading: false,
	error: null,
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error }),
	setWorkspace: (rootHandle, entries) => set({ rootHandle, rootName: rootHandle.name, entries, error: null }),
	toggleContextPath: (path) => set((state) => ({
		selectedContextPaths: state.selectedContextPaths.includes(path)
			? state.selectedContextPaths.filter((item) => item !== path)
			: [...state.selectedContextPaths, path],
	})),
	toggleDirectory: (path) => set((state) => ({
		expandedDirectories: state.expandedDirectories.includes(path)
			? state.expandedDirectories.filter((item) => item !== path)
			: [...state.expandedDirectories, path],
	})),
	openFile: async (path) => {
		const existing = get().openFiles.find((file) => file.path === path);
		if (existing) {
			set({ activePath: path, showDiff: false });
			return;
		}
		const entry = get().entries.find((item) => item.path === path && item.kind === "file");
		if (!entry?.handle) return;
		const file = await entry.handle.getFile();
		const value = await file.text();
		set((state) => ({
			openFiles: [...state.openFiles, { path, name: entry.name, original: value, value, handle: entry.handle! }],
			activePath: path,
			showDiff: false,
			error: null,
		}));
	},
	setActivePath: (activePath) => set({ activePath, showDiff: false }),
	setShowDiff: (showDiff) => set({ showDiff }),
	updateActiveFile: (value) => set((state) => ({
		openFiles: state.openFiles.map((file) => file.path === state.activePath ? { ...file, value } : file),
	})),
	saveActiveFile: async () => {
		const activeFile = get().openFiles.find((file) => file.path === get().activePath);
		if (!activeFile) return;
		const handle = activeFile.handle as PermissionedFileHandle;
		const permission = await handle.queryPermission({ mode: "readwrite" });
		const granted = permission === "granted" || await handle.requestPermission({ mode: "readwrite" }) === "granted";
		if (!granted) throw new Error("Workspace write permission was not granted.");
		const writable = await activeFile.handle.createWritable();
		await writable.write(activeFile.value);
		await writable.close();
		set((state) => ({ openFiles: state.openFiles.map((file) => file.path === activeFile.path ? { ...file, original: file.value } : file) }));
	},
	closeFile: (path) => set((state) => {
		const openFiles = state.openFiles.filter((file) => file.path !== path);
		const activePath = state.activePath === path ? openFiles.at(-1)?.path ?? null : state.activePath;
		return { openFiles, activePath, showDiff: false };
	}),
}));

export const useRouterStore = create<RouterStoreState>((set) => ({
	profile: null,
	provider: null,
	model: null,
	status: "idle",
	confidence: null,
	setRoute: (route) => set(route),
}));

export const useGovernanceStore = create<GovernanceStoreState>((set) => ({
	missionState: null,
	risk: null,
	contextPaths: [],
	approvalRequired: false,
	executionGate: "LOCKED",
	setGovernance: (values) => set(values),
}));

export const useApprovalStore = create<ApprovalStoreState>((set) => ({
	approvalId: null,
	decision: null,
	justification: "",
	setApproval: (approval) => set(approval),
}));

export const useExecutionStore = create<ExecutionStoreState>((set) => ({
	state: null,
	gate: "LOCKED",
	setExecution: (state, gate) => set({ state, gate }),
}));