import path from "node:path";
import { BrowserWindow, dialog } from "electron";
import type { ConfirmationRequest, UserPrompter, WorkspaceApproval } from "../core/prompter";
import type { WorkspacePermission } from "../core/state";

/**
 * Dialogs are parented to a tiny always-on-top window so they appear above the
 * browser that triggered them instead of hiding behind it.
 */
async function withForegroundParent<T>(task: (parent: BrowserWindow) => Promise<T>): Promise<T> {
	const parent = new BrowserWindow({
		width: 1,
		height: 1,
		x: 0,
		y: 0,
		show: false,
		frame: false,
		transparent: true,
		skipTaskbar: true,
		alwaysOnTop: true,
		focusable: true,
		webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	parent.showInactive();
	parent.focus();
	try {
		return await task(parent);
	} finally {
		parent.destroy();
	}
}

const PERMISSION_CHOICES: { label: string; permissions: WorkspacePermission[] }[] = [
	{ label: "Read only", permissions: ["read"] },
	{ label: "Read and write", permissions: ["read", "write"] },
	{ label: "Read, write and run commands", permissions: ["read", "write", "execute"] },
];

export class DialogPrompter implements UserPrompter {
	private queue: Promise<unknown> = Promise.resolve();

	/** Only one native dialog at a time; concurrent requests wait their turn. */
	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	approveWorkspace(request: { requestedBy: string; suggestedPath?: string; reason?: string }): Promise<WorkspaceApproval | null> {
		return this.serialize(() =>
			withForegroundParent(async (parent) => {
				const picked = await dialog.showOpenDialog(parent, {
					title: "Rill Agent — choose a project folder to expose",
					defaultPath: request.suggestedPath,
					properties: ["openDirectory", "dontAddToRecent"],
					buttonLabel: "Select folder",
				});
				const rootPath = picked.filePaths[0];
				if (picked.canceled || !rootPath) return null;
				const answer = await dialog.showMessageBox(parent, {
					type: "warning",
					title: "Rill Agent — approve project access",
					message: `Allow Rill to access "${path.basename(rootPath)}"?`,
					detail: [
						rootPath,
						"",
						`Requested by: ${request.requestedBy}`,
						request.reason ? `Reason: ${request.reason}` : null,
						"",
						"Rill will only reach files inside this folder. Credential files (.env, keys) and the .git folder are never exposed.",
						"\"Run commands\" allows npm install / test / build / dev and git push (each push is confirmed again).",
					]
						.filter((line) => line !== null)
						.join("\n"),
					buttons: ["Deny", ...PERMISSION_CHOICES.map((choice) => choice.label)],
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				});
				if (answer.response === 0) return null;
				const choice = PERMISSION_CHOICES[answer.response - 1];
				return choice ? { rootPath, permissions: choice.permissions } : null;
			}),
		);
	}

	confirm(request: ConfirmationRequest): Promise<boolean> {
		return this.serialize(() =>
			withForegroundParent(async (parent) => {
				const answer = await dialog.showMessageBox(parent, {
					type: "question",
					title: request.title,
					message: request.message,
					detail: request.detail,
					buttons: ["Cancel", request.confirmLabel],
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				});
				return answer.response === 1;
			}),
		);
	}
}
