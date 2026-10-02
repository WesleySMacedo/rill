import { lazy, Suspense, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQuery } from "@tanstack/react-query";
import { Menu, PanelRightClose, Radio, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { closeAgentSession } from "../../runtime/agent";
import { getMission } from "../../runtime/client";
import { useMissionStore } from "../../state/stores";
import { supabase } from "../../supabase";
import { Button } from "../ui/button";
import { AgentRequiredDialog, AgentStatusPill, useAgentConnection, useAgentRequiredDialog } from "./AgentStatus";
import { ControlPlanePanel } from "./ControlPlanePanel";
import { MissionTimeline } from "./MissionTimeline";
import { WorkspaceExplorer } from "./WorkspaceExplorer";

const CodeEditorPanel = lazy(() => import("./CodeEditorPanel").then((module) => ({ default: module.CodeEditorPanel })));

export function MissionWorkspace({ session }: { session: Session }) {
	const activeMissionId = useMissionStore((state) => state.activeMissionId);
	const [explorerOpen, setExplorerOpen] = useState(true);
	const [controlPlaneOpen, setControlPlaneOpen] = useState(true);
	const [mobilePane, setMobilePane] = useState<"workspace" | "mission" | "control">("mission");
	const activeMission = useQuery({
		queryKey: ["rill", "mission", activeMissionId],
		queryFn: () => getMission(activeMissionId!),
		enabled: Boolean(activeMissionId),
		refetchInterval: 15_000,
	});

	const agent = useAgentConnection(session.user.id);
	const agentDialog = useAgentRequiredDialog(agent.status);

	async function signOut() {
		if (agent.session) await closeAgentSession(agent.session.sessionToken);
		await supabase?.auth.signOut({ scope: "local" });
	}

	return (
		<div className="runtime-shell">
			<header className="runtime-topbar">
				<div className="runtime-topbar-brand"><button className="runtime-icon-button mobile-nav-trigger" onClick={() => setMobilePane(mobilePane === "workspace" ? "mission" : "workspace")} aria-label="Toggle workspace pane"><Menu size={16} /></button><img src="/assets/rill-logo-wh.svg" alt="Rill" /><b>Rill</b><span className="topbar-divider" /><span className="runtime-context-label">MISSION INTELLIGENCE</span></div>
				<div className="runtime-topbar-center"><span className="workspace-breadcrumb">{activeMission.data?.mission.domain ?? "Workspace"}</span><span className="breadcrumb-separator">/</span><span>{activeMission.data?.mission.action ?? "New mission"}</span></div>
				<div className="runtime-topbar-actions"><AgentStatusPill status={agent.status} onOpen={agentDialog.show} /><span className="runtime-session-indicator"><i />SESSION ACTIVE</span><button className="runtime-icon-button" title="Search workspace" aria-label="Search workspace"><Search size={15} /></button><button className="runtime-icon-button" title="Runtime settings" aria-label="Runtime settings"><SlidersHorizontal size={15} /></button><span className="runtime-user-avatar" title={session.user.email ?? "Signed in"}>{(session.user.email ?? "R").slice(0, 1).toUpperCase()}</span><Button variant="ghost" size="small" onClick={signOut}>Sign out</Button></div>
			</header>
			<div className={`runtime-workbench ${!explorerOpen ? "explorer-collapsed" : ""} ${!controlPlaneOpen ? "control-collapsed" : ""}`}>
				<div className={`runtime-left ${mobilePane === "workspace" ? "mobile-active" : ""}`}>
					<WorkspaceExplorer missionTargetPath={activeMission.data?.mission.target_path ?? null} missionContextPaths={activeMission.data?.mission.context_manifest?.targetFiles ?? []} />
				</div>
				<main className={`runtime-center ${mobilePane === "mission" ? "mobile-active" : ""}`}>
					<div className="runtime-center-toolbar"><div><span className="center-indicator"><i /></span><span>MISSION INTELLIGENCE</span><span className="toolbar-separator">/</span><span>{activeMission.data?.mission.state ?? "READY"}</span></div><div className="runtime-center-tools"><span className="realtime-indicator"><Radio size={12} />REALTIME</span><button className="runtime-icon-button" onClick={() => setExplorerOpen(!explorerOpen)} title={explorerOpen ? "Hide workspace pane" : "Show workspace pane"}><Menu size={14} /></button><button className="runtime-icon-button" onClick={() => setControlPlaneOpen(!controlPlaneOpen)} title={controlPlaneOpen ? "Hide control plane" : "Show control plane"}><PanelRightClose size={14} /></button></div></div>
					<div className="runtime-center-content">
						<div className="runtime-editor-region"><Suspense fallback={<div className="editor-welcome"><span>Loading Monaco…</span></div>}><CodeEditorPanel /></Suspense></div>
						<div className="runtime-mission-region"><MissionTimeline /></div>
					</div>
					<div className="runtime-mobile-tabs"><button className={mobilePane === "workspace" ? "active" : ""} onClick={() => setMobilePane("workspace")}>Workspace</button><button className={mobilePane === "mission" ? "active" : ""} onClick={() => setMobilePane("mission")}>Mission</button><button className={mobilePane === "control" ? "active" : ""} onClick={() => setMobilePane("control")}>Control</button></div>
				</main>
				<div className={`runtime-right ${mobilePane === "control" ? "mobile-active" : ""}`}>
					<ControlPlanePanel details={activeMission.data ?? null} />
				</div>
			</div>
			<footer className="runtime-statusbar"><span><span className="statusbar-health" /><b>RILL RUNTIME</b><i>/</i>{activeMission.data ? activeMission.data.mission.state : "AWAITING MISSION"}</span><span><ShieldCheck size={11} />AUTHORITY: CONTROL PLANE</span></footer>
			<AgentRequiredDialog status={agent.status} health={agent.health} open={agentDialog.open} onOpenChange={agentDialog.onOpenChange} />
		</div>
	);
}
