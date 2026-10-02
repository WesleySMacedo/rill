import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Notification, app, dialog, shell } from "electron";
import { AGENT_VERSION, loadConfig } from "../config";
import { AgentController } from "../core/agent";
import { JsonStateStore } from "../core/state";
import { JobManager } from "../exec/jobs";
import { HttpRillClient } from "../rill/client";
import { SessionManager } from "../security/sessions";
import { startAgentServer, type RunningAgentServer } from "../server/app";
import { WorkspaceRegistry } from "../workspaces/registry";
import { DialogPrompter } from "./prompter";
import { SafeStorageTokenVault } from "./token-vault";
import { AgentTray, START_HIDDEN_ARG as HIDDEN_ARG } from "./tray";


app.setAppUserModelId("com.wesleysmacedo.rill.agent");

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	void bootstrap();
}

async function bootstrap(): Promise<void> {
	// Tray app: closing helper windows must never quit the process.
	app.on("window-all-closed", () => undefined);
	await app.whenReady();

	const config = loadConfig();
	const userData = app.getPath("userData");
	const store = new JsonStateStore(path.join(userData, "agent-state.json"));
	const vault = new SafeStorageTokenVault(path.join(userData, "agent-token.bin"));
	const workspaces = new WorkspaceRegistry(store);
	const jobs = new JobManager();
	const sessions = new SessionManager();
	const prompter = new DialogPrompter();
	const controller = new AgentController({
		store,
		vault,
		rill: new HttpRillClient(config.rillAppUrl),
		machine: { machineName: os.hostname(), platform: `${process.platform}-${process.arch}`, agentVersion: AGENT_VERSION },
		workspaceCount: async () => (await workspaces.list()).length,
	});

	let server: RunningAgentServer;
	try {
		server = await startAgentServer({ controller, sessions, workspaces, jobs, prompter, allowedOrigins: config.allowedOrigins, port: config.port });
	} catch (error) {
		const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
		dialog.showErrorBox(
			"Rill Agent",
			busy ? `Port ${config.port} is already in use. Close the program using it and start Rill Agent again.` : `Rill Agent could not start: ${(error as Error).message}`,
		);
		app.exit(1);
		return;
	}

	const openPairing = async () => {
		try {
			const pairing = await controller.startPairing();
			const target = new URL(pairing.verificationUriComplete);
			// Only ever open the configured Rill origin, never a URL chosen by the server.
			if (target.origin !== new URL(config.rillAppUrl).origin) throw new Error("Unexpected pairing URL.");
			await shell.openExternal(target.toString());
		} catch (error) {
			dialog.showErrorBox("Rill Agent — pairing", (error as Error).message);
		}
	};

	const tray = new AgentTray(controller, () => workspaces.list(), {
		pair: () => void openPairing(),
		addWorkspace: async () => {
			try {
				const approval = await prompter.approveWorkspace({ requestedBy: "Rill Agent tray menu" });
				if (approval) await workspaces.add(approval.rootPath, approval.permissions);
			} catch (error) {
				dialog.showErrorBox("Rill Agent", (error as Error).message);
			}
			await tray.refresh();
		},
		removeWorkspace: async (id) => {
			await workspaces.remove(id).catch(() => undefined);
			await tray.refresh();
		},
		openRill: () => void shell.openExternal(config.rillAppUrl),
		unpair: async () => {
			const confirmed = await prompter.confirm({
				title: "Rill Agent",
				message: "Unpair this machine from Rill?",
				detail: "The local token is deleted. Revoke the machine in Rill to invalidate it on the server too.",
				confirmLabel: "Unpair",
			});
			if (confirmed) await controller.unpair();
		},
		toggleStartAtLogin: (enabled) => {
			app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] });
			void tray.refresh();
		},
		quit: () => app.quit(),
	});

	controller.on("paired", (identity: { email: string | null }) => {
		if (Notification.isSupported()) {
			new Notification({ title: "Rill Agent connected", body: identity.email ? `Paired with ${identity.email}.` : "This machine is paired with Rill." }).show();
		}
	});

	app.on("second-instance", () => void tray.refresh().then(() => (controller.status().paired ? undefined : openPairing())));

	app.on("before-quit", () => {
		controller.stop();
		jobs.cancelAll();
		void server.close();
		tray.destroy();
	});

	const installMarker = path.join(userData, ".installed");
	if (app.isPackaged && !existsSync(installMarker)) {
		app.setLoginItemSettings({ openAtLogin: true, args: [HIDDEN_ARG] });
		mkdirSync(userData, { recursive: true });
		writeFileSync(installMarker, new Date().toISOString());
	}

	await controller.start();
	await tray.refresh();

	if (!controller.status().paired && !process.argv.includes(HIDDEN_ARG)) await openPairing();
}
