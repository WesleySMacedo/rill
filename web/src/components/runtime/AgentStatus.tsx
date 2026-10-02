import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Download, MonitorSmartphone, X } from "lucide-react";
import { AGENT_DOWNLOAD_PATH, AgentRequestError, detectAgent, openAgentSession, type AgentHealth } from "../../runtime/agent";
import { Button } from "../ui/button";

export type AgentConnectionStatus = "checking" | "missing" | "unpaired" | "disconnected" | "mismatch" | "connected";

const DISMISS_KEY = "rill.agent.required.dismissed";

export function useAgentConnection(userId: string) {
	const health = useQuery({
		queryKey: ["rill", "agent", "health"],
		queryFn: () => detectAgent(),
		refetchInterval: 10_000,
		retry: false,
	});
	const ready = Boolean(health.data?.paired && health.data.connected);
	const localSession = useQuery({
		queryKey: ["rill", "agent", "session", userId],
		queryFn: openAgentSession,
		enabled: ready,
		retry: false,
		staleTime: 6 * 60 * 60 * 1000,
		refetchOnWindowFocus: false,
	});
	return { status: deriveStatus(health.data, health.isPending, ready, localSession.data, localSession.error), health: health.data ?? null, session: localSession.data ?? null };
}

function deriveStatus(health: AgentHealth | null | undefined, pending: boolean, ready: boolean, session: unknown, error: unknown): AgentConnectionStatus {
	if (pending) return "checking";
	if (!health) return "missing";
	if (!health.paired) return "unpaired";
	if (!ready) return "disconnected";
	if (error instanceof AgentRequestError && error.code === "SESSION_USER_MISMATCH") return "mismatch";
	return session ? "connected" : error ? "disconnected" : "checking";
}

const LABELS: Record<AgentConnectionStatus, string> = {
	checking: "AGENT…",
	missing: "AGENT DISCONNECTED",
	unpaired: "AGENT NOT PAIRED",
	disconnected: "AGENT DISCONNECTED",
	mismatch: "AGENT: OTHER ACCOUNT",
	connected: "AGENT CONNECTED",
};

const TITLES: Record<AgentConnectionStatus, string> = {
	checking: "Looking for Rill Agent on this computer",
	missing: "Rill Agent was not found on http://localhost:7777",
	unpaired: "Rill Agent is running but not paired. Use “Pair with Rill…” in the tray menu.",
	disconnected: "Rill Agent is running but cannot reach Rill right now.",
	mismatch: "Rill Agent on this computer is paired with a different Rill account.",
	connected: "Rill Agent is connected and verified for this account.",
};

export function AgentStatusPill({ status, onOpen }: { status: AgentConnectionStatus; onOpen: () => void }) {
	return (
		<button className={`agent-status-pill agent-status-${status}`} onClick={onOpen} title={TITLES[status]} aria-label={TITLES[status]}>
			<i />
			{LABELS[status]}
		</button>
	);
}

/** Shows "Rill Agent Required" once per browser session when no Agent answers; reopenable from the pill. */
export function useAgentRequiredDialog(status: AgentConnectionStatus) {
	const [manualOpen, setManualOpen] = useState(false);
	const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === "1");
	const automatic = status === "missing" && !dismissed;
	return {
		open: manualOpen || automatic,
		show: () => setManualOpen(true),
		onOpenChange(next: boolean) {
			if (next) return setManualOpen(true);
			setManualOpen(false);
			sessionStorage.setItem(DISMISS_KEY, "1");
			setDismissed(true);
		},
	};
}

export function AgentRequiredDialog({ status, health, open, onOpenChange }: { status: AgentConnectionStatus; health: AgentHealth | null; open: boolean; onOpenChange: (open: boolean) => void }) {
	const installed = status !== "missing" && status !== "checking";
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="agent-dialog-overlay" />
				<Dialog.Content className="agent-dialog">
					<Dialog.Close className="agent-dialog-close" aria-label="Close"><X size={14} /></Dialog.Close>
					<div className="agent-dialog-icon"><MonitorSmartphone size={20} /></div>
					<Dialog.Title className="agent-dialog-title">{installed ? "Rill Agent" : "Rill Agent Required"}</Dialog.Title>
					<Dialog.Description className="agent-dialog-description">
						{installed
							? TITLES[status]
							: "Rill runs code, Git and terminal commands on your computer through the Rill Agent. It only touches folders you explicitly approve, and every action is authorized by Rill."}
					</Dialog.Description>
					{!installed && (
						<ol className="agent-dialog-steps">
							<li>Download and run <b>Rill-Agent-Setup.exe</b> (Windows).</li>
							<li>The Agent opens Rill to pair this computer — confirm the code.</li>
							<li>This status changes to <b>Connected</b> automatically.</li>
						</ol>
					)}
					{health && (
						<dl className="agent-dialog-facts">
							<dt>Version</dt><dd>{health.version}</dd>
							<dt>Platform</dt><dd>{health.platform}</dd>
							<dt>State</dt><dd>{health.state}</dd>
						</dl>
					)}
					<div className="agent-dialog-actions">
						{!installed && (
							<a className="rill-button rill-button-primary rill-button-default inline-flex items-center justify-center gap-2" href={AGENT_DOWNLOAD_PATH}>
								<Download size={14} />Download Rill Agent
							</a>
						)}
						<Dialog.Close asChild><Button variant="ghost">{installed ? "Close" : "Not now"}</Button></Dialog.Close>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
