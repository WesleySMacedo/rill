import { useMemo } from "react";
import {
	ChevronDown,
	ChevronRight,
	FileCode2,
	FileText,
	Folder,
	FolderOpen,
	FolderPlus,
	GitBranch,
	PanelLeftClose,
	Search,
	ShieldCheck,
	type LucideIcon,
} from "lucide-react";
import { useWorkspaceStore } from "../../state/stores";
import { pickWorkspaceDirectory } from "../../workspace/file-system";
import { Button } from "../ui/button";

function fileIcon(path: string): LucideIcon {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return ["ts", "tsx", "js", "jsx", "json", "css", "html", "md"].includes(extension ?? "") ? FileCode2 : FileText;
}

export function WorkspaceExplorer({ missionTargetPath, missionContextPaths = [] }: { missionTargetPath: string | null; missionContextPaths?: string[] }) {
	const rootName = useWorkspaceStore((state) => state.rootName);
	const entries = useWorkspaceStore((state) => state.entries);
	const openFiles = useWorkspaceStore((state) => state.openFiles);
	const activePath = useWorkspaceStore((state) => state.activePath);
	const selectedContextPaths = useWorkspaceStore((state) => state.selectedContextPaths);
	const expandedDirectories = useWorkspaceStore((state) => state.expandedDirectories);
	const loading = useWorkspaceStore((state) => state.loading);
	const error = useWorkspaceStore((state) => state.error);
	const openFile = useWorkspaceStore((state) => state.openFile);
	const toggleContextPath = useWorkspaceStore((state) => state.toggleContextPath);
	const toggleDirectory = useWorkspaceStore((state) => state.toggleDirectory);
	const setLoading = useWorkspaceStore((state) => state.setLoading);
	const setError = useWorkspaceStore((state) => state.setError);

	const visibleEntries = useMemo(() => entries.filter((entry) => {
		const parents = entry.path.split("/").slice(0, -1);
		let parent = "";
		for (const segment of parents) {
			parent = parent ? `${parent}/${segment}` : segment;
			if (!expandedDirectories.includes(parent)) return false;
		}
		return true;
	}), [entries, expandedDirectories]);
	const dirtyPaths = new Set(openFiles.filter((file) => file.original !== file.value).map((file) => file.path));

	async function chooseFolder() {
		setLoading(true);
		setError(null);
		try {
			await pickWorkspaceDirectory();
		} finally {
			setLoading(false);
		}
	}

	return (
		<aside className="runtime-explorer" aria-label="Workspace explorer">
			<header className="runtime-pane-header explorer-header">
				<div className="explorer-title"><img src="/assets/rill-logo-wh.svg" alt="Rill" /><span>Workspace</span></div>
				<Button variant="ghost" size="icon" title="Collapse workspace panel" aria-label="Collapse workspace panel"><PanelLeftClose size={15} /></Button>
			</header>
			<div className="explorer-root-row">
				<span className="explorer-root-name"><ChevronDown size={13} />{rootName ?? "NO WORKSPACE"}</span>
				<Button variant="ghost" size="icon" title="Open workspace folder" aria-label="Open workspace folder" onClick={chooseFolder} disabled={loading}><FolderPlus size={15} /></Button>
			</div>
			{rootName && <div className="explorer-toolbar"><button type="button" title="File explorer"><Folder size={13} /> EXPLORER</button><button type="button" title="Search workspace"><Search size={13} /></button></div>}
			{!rootName && <div className="workspace-picker-card">
				<div className="workspace-picker-mark"><FolderPlus size={20} /></div>
				<strong>{loading ? "Reading workspace…" : "Open a local workspace"}</strong>
				<p>Choose a repository folder. Rill reads file names and sizes to resolve scope; source contents stay in your browser until opened in the editor.</p>
				<Button variant="secondary" onClick={chooseFolder} disabled={loading}>{loading ? "Opening…" : "Choose folder"}</Button>
				{error && <span className="workspace-error">{error}</span>}
			</div>}
			{rootName && <>
				<div className="file-tree" role="tree" aria-label="Workspace files">
					{visibleEntries.map((entry) => {
						const expanded = expandedDirectories.includes(entry.path);
						const active = activePath === entry.path;
						const dirty = dirtyPaths.has(entry.path);
						const contextSelected = selectedContextPaths.includes(entry.path);
						const Icon = entry.kind === "directory" ? expanded ? FolderOpen : Folder : fileIcon(entry.path);
						const missionTarget = missionTargetPath === entry.path;
						const missionContext = missionContextPaths.includes(entry.path);
						return <div key={entry.path} className={`tree-row ${active ? "active" : ""} ${dirty ? "dirty" : ""} ${missionTarget ? "mission-target" : ""} ${missionContext ? "mission-context" : ""}`} style={{ "--tree-depth": entry.depth } as React.CSSProperties} role="treeitem" aria-expanded={entry.kind === "directory" ? expanded : undefined}>
							{entry.kind === "directory"
								? <button className="tree-main" onClick={() => toggleDirectory(entry.path)}><span className="tree-disclosure">{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span><Icon size={14} /><span className="tree-label">{entry.name}</span></button>
								: <button className="tree-main" onClick={() => { void openFile(entry.path); }}><span className="tree-disclosure tree-spacer" /><Icon size={14} /><span className="tree-label">{entry.name}</span>{dirty && <i className="dirty-dot" title="Unsaved changes" />}</button>}
							{entry.kind === "file" && <button className={`context-pick ${contextSelected ? "selected" : ""}`} aria-label={`${contextSelected ? "Remove" : "Add"} ${entry.path} ${contextSelected ? "from" : "to"} mission context`} title={contextSelected ? "Included in mission context" : "Add to mission context"} onClick={() => toggleContextPath(entry.path)}><ShieldCheck size={12} /></button>}
						</div>;
					})}
					{visibleEntries.length === 0 && <p className="empty-tree">No files in this folder.</p>}
				</div>
				<div className="explorer-context-footer"><span><ShieldCheck size={13} />MISSION CONTEXT</span><b>{selectedContextPaths.length} selected</b></div>
				{error && <div className="workspace-error explorer-error">{error}</div>}
			</>}
			<footer className="explorer-status"><span><GitBranch size={12} />LOCAL WORKSPACE</span><span>{rootName ? `${entries.filter((entry) => entry.kind === "file").length} FILES` : "NOT CONNECTED"}</span></footer>
		</aside>
	);
}