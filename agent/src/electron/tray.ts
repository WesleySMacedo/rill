import path from "node:path";
import { Menu, Tray, app, nativeImage, shell, type MenuItemConstructorOptions } from "electron";
import type { AgentController, AgentStatus } from "../core/agent";
import type { PublicWorkspace } from "../workspaces/registry";

export interface TrayActions {
	pair(): void;
	addWorkspace(): void;
	removeWorkspace(id: string): void;
	openRill(): void;
	unpair(): void;
	toggleStartAtLogin(enabled: boolean): void;
	quit(): void;
}

const assetsDir = path.join(__dirname, "..", "..", "assets");
export const START_HIDDEN_ARG = "--hidden";

function icon(name: string) {
	return nativeImage.createFromPath(path.join(assetsDir, name)).resize({ width: 16, height: 16 });
}

function label(status: AgentStatus): string {
	switch (status.state) {
		case "connected":
			return "Connected";
		case "disconnected":
			return "Disconnected";
		case "pairing":
			return "Waiting for approval in Rill";
		default:
			return "Not paired";
	}
}

function permissionsLabel(workspace: PublicWorkspace): string {
	if (workspace.permissions.includes("execute")) return "read, write, commands";
	if (workspace.permissions.includes("write")) return "read, write";
	return "read only";
}

export class AgentTray {
	private readonly tray: Tray;

	constructor(
		private readonly controller: AgentController,
		private readonly listWorkspaces: () => Promise<PublicWorkspace[]>,
		private readonly actions: TrayActions,
	) {
		this.tray = new Tray(icon("tray-disconnected.png"));
		this.tray.on("click", () => this.tray.popUpContextMenu());
		controller.on("status", () => void this.refresh());
	}

	async refresh(): Promise<void> {
		const status = this.controller.status();
		const workspaces = await this.listWorkspaces().catch(() => [] as PublicWorkspace[]);
		this.tray.setImage(icon(status.state === "connected" ? "tray-connected.png" : status.state === "pairing" ? "tray-attention.png" : "tray-disconnected.png"));
		this.tray.setToolTip(`Rill Agent — ${label(status)}${status.userEmail ? ` (${status.userEmail})` : ""}`);

		const projectItems: MenuItemConstructorOptions[] = workspaces.length
			? workspaces.map((workspace) => ({
					label: `${workspace.name} — ${permissionsLabel(workspace)}`,
					submenu: [
						{ label: "Open folder", click: () => void shell.openPath(workspace.rootPath) },
						{ label: "Stop exposing", click: () => this.actions.removeWorkspace(workspace.id) },
					],
				}))
			: [{ label: "No projects exposed", enabled: false }];

		const template: MenuItemConstructorOptions[] = [
			{ label: `Rill Agent — ${label(status)}`, enabled: false },
			...(status.userEmail ? [{ label: status.userEmail, enabled: false } as MenuItemConstructorOptions] : []),
			...(status.pairing ? [{ label: `Pairing code: ${status.pairing.userCode}`, enabled: false } as MenuItemConstructorOptions] : []),
			...(status.lastError ? [{ label: status.lastError.slice(0, 80), enabled: false } as MenuItemConstructorOptions] : []),
			{ type: "separator" },
			...(!status.paired ? [{ label: status.pairing ? "Open pairing page…" : "Pair with Rill…", click: () => this.actions.pair() } as MenuItemConstructorOptions] : []),
			{ label: "Add project folder…", enabled: status.paired, click: () => this.actions.addWorkspace() },
			{ label: "Projects", submenu: projectItems },
			{ type: "separator" },
			{ label: "Open Rill", click: () => this.actions.openRill() },
			{
				label: "Start at login",
				type: "checkbox",
				checked: app.getLoginItemSettings({ args: [START_HIDDEN_ARG] }).openAtLogin,
				click: (item) => this.actions.toggleStartAtLogin(item.checked),
			},
			...(status.paired ? [{ label: "Unpair this machine", click: () => this.actions.unpair() } as MenuItemConstructorOptions] : []),
			{ type: "separator" },
			{ label: "Quit Rill Agent", click: () => this.actions.quit() },
		];
		this.tray.setContextMenu(Menu.buildFromTemplate(template));
	}

	destroy(): void {
		this.tray.destroy();
	}
}
