import { useWorkspaceStore, type WorkspaceEntry } from "../state/stores";
import registry from "../../../engineering-registry.json";

const ignoredNames = new Set([".git", "node_modules", "dist", "coverage", ".wrangler"]);
const maxEntries = 2_000;
const maxDepth = 8;
const maxFileBytes = 2_000_000;

type DirectoryPickerWindow = Window & {
	showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

type DirectoryWithEntries = FileSystemDirectoryHandle & {
	entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

export async function pickWorkspaceDirectory(): Promise<void> {
	const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
	if (!picker) throw new Error("Folder access is unavailable in this browser. Use a current Chromium browser over HTTPS or localhost.");

	const store = useWorkspaceStore.getState();
	store.setLoading(true);
	store.setError(null);
	try {
		const root = await picker({ mode: "readwrite" });
		const entries: WorkspaceEntry[] = [];
		await walkDirectory(root, "", 0, entries);
		entries.sort((left, right) => {
			if (left.depth !== right.depth) return left.depth - right.depth;
			if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
			return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
		});
		useWorkspaceStore.getState().setWorkspace(root, entries);
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return;
		store.setError(error instanceof Error ? error.message : "Could not open this folder.");
	} finally {
		useWorkspaceStore.getState().setLoading(false);
	}
}

async function walkDirectory(directory: FileSystemDirectoryHandle, parentPath: string, depth: number, entries: WorkspaceEntry[]): Promise<void> {
	if (depth > maxDepth || entries.length >= maxEntries) return;
	for await (const [name, handle] of (directory as DirectoryWithEntries).entries()) {
		if (ignoredNames.has(name) || name.startsWith(".")) continue;
		const path = parentPath ? `${parentPath}/${name}` : name;
		if (handle.kind === "directory") {
			entries.push({ name, path, depth, kind: "directory", size: 0 });
			await walkDirectory(handle as FileSystemDirectoryHandle, path, depth + 1, entries);
			continue;
		}
		const fileHandle = handle as FileSystemFileHandle;
		const file = await fileHandle.getFile();
		if (file.size > maxFileBytes) continue;
		entries.push({ name, path, depth, kind: "file", size: file.size, handle: fileHandle });
		if (entries.length >= maxEntries) return;
	}
}

export function workspaceFileManifest(): Array<{ path: string; size: number }> {
	const registeredPaths = new Set<string>(["AGENTS.md"]);
	for (const entry of registry.entries) {
		for (const path of [...entry.allowedPaths, ...entry.domainContext, ...entry.playbook, ...entry.applicableTests]) {
			registeredPaths.add(path);
		}
	}
	return useWorkspaceStore.getState().entries
		.filter((entry) => entry.kind === "file" && registeredPaths.has(entry.path))
		.map(({ path, size }) => ({ path, size }));
}

export function isWorkspaceFolderPickerAvailable(): boolean {
	return typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
}