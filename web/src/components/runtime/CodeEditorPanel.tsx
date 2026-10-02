import { useMemo, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { AlertTriangle, Columns2, FileCode2, Save, X } from "lucide-react";
import { useWorkspaceStore } from "../../state/stores";
import { Button } from "../ui/button";

function languageForPath(path: string): string {
	const extension = path.split(".").at(-1)?.toLowerCase();
	const languages: Record<string, string> = {
		ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
		json: "json", jsonc: "json", css: "css", html: "html", md: "markdown",
		sql: "sql", yaml: "yaml", yml: "yaml", sh: "shell", py: "python",
	};
	return languages[extension ?? ""] ?? "plaintext";
}

function configureMonaco(editor: Parameters<OnMount>[0], monaco: Parameters<OnMount>[1]) {
	monaco.editor.defineTheme("rill-charcoal", {
		base: "vs-dark",
		inherit: true,
		rules: [
			{ token: "comment", foreground: "788580", fontStyle: "italic" },
			{ token: "keyword", foreground: "9dd8b3" },
			{ token: "string", foreground: "d8c28f" },
			{ token: "number", foreground: "9dc9e8" },
		],
		colors: {
			"editor.background": "#131618",
			"editor.foreground": "#d8dfdc",
			"editorLineNumber.foreground": "#515c5e",
			"editorLineNumber.activeForeground": "#a8c1b0",
			"editorCursor.foreground": "#a7e8c1",
			"editor.selectionBackground": "#31503e66",
			"editor.lineHighlightBackground": "#1a1f20",
			"editorIndentGuide.background1": "#282f30",
			"editorIndentGuide.activeBackground1": "#465550",
			"editorWidget.background": "#1c2122",
			"editorWidget.border": "#303839",
		},
	});
	monaco.editor.setTheme("rill-charcoal");
	editor.updateOptions({ padding: { top: 14 }, scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 } });
}

export function CodeEditorPanel() {
	const openFiles = useWorkspaceStore((state) => state.openFiles);
	const activePath = useWorkspaceStore((state) => state.activePath);
	const showDiff = useWorkspaceStore((state) => state.showDiff);
	const setActivePath = useWorkspaceStore((state) => state.setActivePath);
	const setShowDiff = useWorkspaceStore((state) => state.setShowDiff);
	const updateActiveFile = useWorkspaceStore((state) => state.updateActiveFile);
	const saveActiveFile = useWorkspaceStore((state) => state.saveActiveFile);
	const closeFile = useWorkspaceStore((state) => state.closeFile);
	const [saveError, setSaveError] = useState<string | null>(null);
	const activeFile = openFiles.find((file) => file.path === activePath) ?? null;
	const dirtyPaths = useMemo(() => new Set(openFiles.filter((file) => file.value !== file.original).map((file) => file.path)), [openFiles]);

	async function save() {
		setSaveError(null);
		try {
			await saveActiveFile();
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Could not save the file.");
		}
	}

	return (
		<section className="runtime-editor" aria-label="Workspace editor">
			<div className="editor-tabs">
				<div className="editor-tab-strip">
					{openFiles.length === 0 && <span className="editor-empty-tab">EDITOR</span>}
					{openFiles.map((file) => <div key={file.path} className={`editor-tab ${activePath === file.path ? "active" : ""}`}>
						<button onClick={() => setActivePath(file.path)} title={file.path}><FileCode2 size={13} /><span>{file.name}</span>{dirtyPaths.has(file.path) && <i className="dirty-dot" />}</button>
						<button className="editor-tab-close" onClick={() => closeFile(file.path)} aria-label={`Close ${file.name}`}><X size={12} /></button>
					</div>)}
				</div>
				<div className="editor-actions">
					{activeFile && <>
						<Button variant={showDiff ? "primary" : "ghost"} size="small" onClick={() => setShowDiff(!showDiff)} title="Toggle local diff"><Columns2 size={13} /><span>Diff</span></Button>
						<Button variant="secondary" size="small" onClick={save} disabled={!dirtyPaths.has(activeFile.path)} title="Save to selected local workspace"><Save size={13} /><span>Save</span></Button>
					</>}
				</div>
			</div>
			{activeFile ? <>
				<div className="editor-breadcrumb"><span>workspace</span><span>/</span><span>{activeFile.path}</span>{showDiff && <span className="readonly-review"><AlertTriangle size={11} />LOCAL DIFF · REVIEW ONLY</span>}</div>
				<div className="monaco-surface">
					{showDiff
						? <DiffEditor height="100%" language={languageForPath(activeFile.path)} original={activeFile.original} modified={activeFile.value} theme="rill-charcoal" options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true, fontFamily: "DM Mono, monospace", fontSize: 12, lineNumbers: "on", scrollBeyondLastLine: false, originalEditable: false, renderOverviewRuler: true, padding: { top: 14 } }} />
						: <Editor height="100%" path={activeFile.path} language={languageForPath(activeFile.path)} value={activeFile.value} theme="rill-charcoal" onChange={(value) => updateActiveFile(value ?? "")} onMount={configureMonaco} options={{ automaticLayout: true, minimap: { enabled: false }, fontFamily: "DM Mono, monospace", fontSize: 12, lineNumbers: "on", scrollBeyondLastLine: false, wordWrap: "off", tabSize: 2, renderWhitespace: "selection", padding: { top: 14 }, guides: { indentation: true } }} />}
				</div>
				<div className="editor-status"><span>{languageForPath(activeFile.path).toUpperCase()}</span><span>{dirtyPaths.has(activeFile.path) ? "UNSAVED LOCAL CHANGE" : "LOCAL FILE"}</span><span>{activeFile.value.split("\n").length} LINES</span></div>
				{saveError && <div className="editor-error" role="status">{saveError}</div>}
			</> : <div className="editor-welcome"><FileCode2 size={24} /><span>Open a file from the workspace explorer.</span><small>Changes stay local until you explicitly save.</small></div>}
		</section>
	);
}