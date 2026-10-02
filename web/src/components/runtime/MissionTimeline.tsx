import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
	AlertTriangle,
	ArrowRight,
	Ban,
	Check,
	CircleDashed,
	LoaderCircle,
	Radio,
	Send,
	ShieldCheck,
	SquareActivity,
	X,
} from "lucide-react";
import { cancelMission, createMission, getMission, listMissions, missionErrorMessage as errorMessage, subscribeToMission, TERMINAL_MISSION_STATES, type MissionEvent, type MissionRecord } from "../../runtime/client";
import { useMissionStore, useWorkspaceStore } from "../../state/stores";
import { workspaceFileManifest } from "../../workspace/file-system";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";

type EventTone = "reached" | "warning" | "failed";

const asText = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const asNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function describeEvent(event: MissionEvent): { detail: string; tone: EventTone } {
	const payload = event.payload ?? {};
	switch (event.event_type) {
		case "MISSION_CREATED": return { detail: "Mission record accepted", tone: "reached" };
		case "CLASSIFIED": return { detail: `Deterministic classification: ${asText(payload.action) ?? "—"} × ${asText(payload.domain) ?? "—"}`, tone: "reached" };
		case "CONTEXT_READY": return { detail: `Registry scope validated (${Array.isArray(payload.targetFiles) ? payload.targetFiles.length : 0} target file(s))`, tone: "reached" };
		case "RISK_ANALYZED": return { detail: `${asText(payload.risk) ?? "—"} risk · approval ${payload.approvalRequired ? "required" : "not required"}`, tone: "reached" };
		case "COST_ESTIMATE_SKIPPED": return { detail: "No provider call was made", tone: "reached" };
		case "MODEL_ROUTING_SKIPPED": return { detail: "Profile known; model runtime not configured", tone: "reached" };
		case "MODEL_ROUTED": return { detail: `${asText(payload.role) ?? "Specialist"} → ${asText(payload.profile) ?? "—"} · ${asText(payload.requestedModel) ?? "model unknown"}`, tone: "reached" };
		case "PLANNING": return { detail: payload.mode === "MODEL" ? `${asText(payload.specialist) ?? "Estrategista"} planning through the gateway` : "Deterministic Architect plan", tone: "reached" };
		case "PROMPT_RESOLVED": return { detail: payload.source === "langfuse" ? `Langfuse prompt ${asText(payload.name) ?? ""} v${asNumber(payload.version) ?? "?"} (${asText(payload.label) ?? "—"})` : "Local fallback prompt (Langfuse unavailable)", tone: payload.source === "langfuse" ? "reached" : "warning" };
		case "MODEL_COMPLETED": {
			const cost = asNumber(payload.reportedCostUsd) ?? asNumber(payload.estimatedCostUsd);
			return { detail: `${asText(payload.usedModel) ?? "model"} · ${asNumber(payload.totalTokens) ?? "?"} tokens${cost === null ? "" : ` · $${cost.toFixed(6)}`} · ${asNumber(payload.latencyMs) ?? "?"} ms`, tone: "reached" };
		}
		case "MODEL_INVOCATION_FAILED": return { detail: `Model call failed: ${asText(payload.code) ?? "UNKNOWN"}`, tone: "warning" };
		case "PLANNED": return { detail: payload.mode === "MODEL" ? asText(payload.summary) ?? "Plan persisted" : payload.mode === "DETERMINISTIC_FALLBACK" ? `Deterministic fallback plan (${asText(payload.fallbackReason) ?? "model unavailable"})` : "Read-only plan persisted", tone: payload.mode === "DETERMINISTIC_FALLBACK" ? "warning" : "reached" };
		case "PROPOSAL_CREATED": return { detail: asText(payload.summary) ?? "PATCH_PROPOSAL created (no diff applied)", tone: "reached" };
		case "PROPOSAL_REVIEWED": return { detail: `Auditor Técnico: ${asText(payload.status) ?? "—"}`, tone: payload.approvedForHumanReview ? "reached" : "warning" };
		case "AWAITING_HUMAN_APPROVAL": return { detail: `HITL ticket open · hash ${asText(payload.proposalHash)?.slice(0, 12) ?? "—"}…`, tone: "warning" };
		case "HUMAN_DECISION_RECORDED": return { detail: `Human decision: ${asText(payload.decision) ?? "—"}`, tone: payload.decision === "APPROVED" ? "reached" : "warning" };
		case "BLOCKED": return { detail: payload.reason === "EXECUTOR_NOT_CONFIGURED" ? "Approved, but no safe executor is configured. Nothing was applied." : `Blocked: ${asText(payload.reason) ?? "policy"}`, tone: "failed" };
		case "FAILED": return { detail: `Failed at ${asText(payload.stage) ?? "runtime"}: ${asText(payload.reason) ?? "UNKNOWN"}`, tone: "failed" };
		case "REJECTED": return { detail: "Proposal rejected by human reviewer", tone: "failed" };
		case "REQUESTED_CHANGES": return { detail: "Human reviewer requested changes", tone: "warning" };
		case "CANCELED": return { detail: `Canceled from ${asText(payload.previousState) ?? "—"}${asText(payload.reason) ? ` · ${asText(payload.reason)}` : ""}`, tone: "failed" };
		default: return { detail: event.state, tone: "reached" };
	}
}

function displayEvent(event: MissionEvent): string {
	return event.event_type.replaceAll("_", " ");
}

function queueTone(state: string): string {
	if (state === "PLANNED" || state === "COMPLETED") return "planned";
	if (state === "AWAITING_HUMAN_APPROVAL" || state === "REQUESTED_CHANGES") return "awaiting";
	if (state === "BLOCKED" || state === "FAILED" || state === "REJECTED") return "blocked";
	if (state === "CANCELED") return "canceled";
	return "";
}

export function MissionTimeline() {
	const queryClient = useQueryClient();
	const draft = useMissionStore((state) => state.draft);
	const setDraft = useMissionStore((state) => state.setDraft);
	const activeMissionId = useMissionStore((state) => state.activeMissionId);
	const setActiveMissionId = useMissionStore((state) => state.setActiveMissionId);
	const entries = useWorkspaceStore((state) => state.entries);
	const selectedContextPaths = useWorkspaceStore((state) => state.selectedContextPaths);
	const activePath = useWorkspaceStore((state) => state.activePath);
	const [targetPath, setTargetPath] = useState("");
	const [requestError, setRequestError] = useState<string | null>(null);

	const missionList = useQuery({
		queryKey: ["rill", "missions"],
		queryFn: listMissions,
		refetchInterval: 15_000,
	});
	const mission = useQuery({
		queryKey: ["rill", "mission", activeMissionId],
		queryFn: () => getMission(activeMissionId!),
		enabled: Boolean(activeMissionId),
		refetchInterval: (query) => query.state.data?.mission.state === "AWAITING_HUMAN_APPROVAL" ? 4_000 : false,
	});

	useEffect(() => {
		const latestMissionId = missionList.data?.missions[0]?.id;
		if (!activeMissionId && latestMissionId) setActiveMissionId(latestMissionId);
	}, [activeMissionId, missionList.data?.missions, setActiveMissionId]);

	useEffect(() => {
		if (!activeMissionId) return;
		const unsubscribe = subscribeToMission(activeMissionId, () => {
			void queryClient.invalidateQueries({ queryKey: ["rill", "mission", activeMissionId] });
			void queryClient.invalidateQueries({ queryKey: ["rill", "missions"] });
		});
		return unsubscribe ?? undefined;
	}, [activeMissionId, queryClient]);

	useEffect(() => {
		if (selectedContextPaths.length === 1) setTargetPath(selectedContextPaths[0]);
		else if (!selectedContextPaths.length && activePath) setTargetPath(activePath);
	}, [activePath, selectedContextPaths]);

	const create = useMutation({
		mutationFn: createMission,
		onSuccess: async (result) => {
			setActiveMissionId(result.mission.id);
			setRequestError(null);
			setDraft("");
			await queryClient.invalidateQueries({ queryKey: ["rill", "missions"] });
		},
		onError: (error) => setRequestError(errorMessage(error)),
	});
	const cancel = useMutation({
		mutationFn: (missionId: string) => cancelMission(missionId, "Canceled by the mission owner from the runtime console."),
		onSuccess: async (result) => {
			setRequestError(null);
			queryClient.setQueryData(["rill", "mission", result.mission.id], result);
			await queryClient.invalidateQueries({ queryKey: ["rill", "missions"] });
		},
		onError: (error) => setRequestError(errorMessage(error)),
	});

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setRequestError(null);
		if (!draft.trim()) return;
		if (!targetPath) {
			setRequestError("Select an explicit target file in the workspace first.");
			return;
		}
		create.mutate({
			task: draft.trim(),
			targetPath,
			contextPaths: selectedContextPaths.filter((path) => path !== targetPath),
			workspaceFiles: workspaceFileManifest(),
			clientRequestId: crypto.randomUUID(),
		});
	}

	const details = mission.data;
	const events = details?.events ?? [];
	const missionState = details?.mission.state ?? null;
	const isTerminal = missionState ? TERMINAL_MISSION_STATES.has(missionState) : false;
	const planSteps = details?.mission.plan ?? [];

	return (
		<section className="mission-runtime-pane" aria-label="Mission intelligence runtime">
			<header className="runtime-pane-header mission-runtime-header">
				<div><span className="runtime-kicker">CONTROL PLANE / MISSION</span><h1>Mission runtime</h1></div>
				<Badge className="runtime-live-badge"><i />AUTHENTICATED</Badge>
			</header>
			<div className="mission-runtime-body">
				<div className="mission-intake-heading"><div><span className="runtime-kicker">GOAL INTAKE</span><h2>What should Rill govern?</h2></div><span className="intake-mode"><ShieldCheck size={12} />POLICY FIRST</span></div>
				<form className="mission-intake" onSubmit={submit}>
					<textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Describe an engineering goal…" rows={2} maxLength={1800} aria-label="Mission goal" />
					<div className="mission-intake-controls">
						<label className="target-select-label" htmlFor="mission-target">TARGET</label>
						<select id="mission-target" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} disabled={!entries.length}>
							<option value="">Select explicit file…</option>
							{entries.filter((entry) => entry.kind === "file").map((entry) => <option key={entry.path} value={entry.path}>{entry.path}</option>)}
						</select>
						<Button variant="primary" size="small" type="submit" disabled={!draft.trim() || !targetPath || create.isPending}><span>{create.isPending ? "Analyzing…" : "Create mission"}</span>{create.isPending ? <LoaderCircle size={14} className="spin" /> : <Send size={13} />}</Button>
					</div>
				</form>
				{requestError && <div className="runtime-error" role="alert"><AlertTriangle size={14} /><span>{requestError}</span><button onClick={() => setRequestError(null)} aria-label="Dismiss error"><X size={13} /></button></div>}
				{missionList.isError && <div className="runtime-setup-notice"><AlertTriangle size={14} /><span>{errorMessage(missionList.error)}</span></div>}

				<div className="mission-list-heading"><span className="runtime-kicker">MISSION QUEUE</span><span>{missionList.data?.missions.length ?? 0} persisted</span></div>
				{missionList.data?.missions.length ? <div className="mission-queue">{missionList.data.missions.map((item) => <MissionQueueItem key={item.id} mission={item} selected={item.id === activeMissionId} onSelect={() => setActiveMissionId(item.id)} />)}</div> : <div className="mission-queue-empty"><SquareActivity size={17} /><span>No persisted missions yet.</span></div>}

				{details && <div className="active-mission-runtime">
					<div className="active-mission-title"><div><span className="runtime-kicker">ACTIVE MISSION</span><h2>{details.mission.action} <span>/</span> {details.mission.domain}</h2></div><Badge className={`mission-state-badge ${queueTone(details.mission.state)}`}>{details.mission.state}</Badge></div>
					<div className="mission-identity-row"><span>{details.mission.id}</span><span>{details.mission.risk} RISK</span><span>{details.mission.model_profile}</span><span>{details.mission.target_path}</span></div>
					{!isTerminal && <div className="mission-controls">
						<span>{details.mission.state === "AWAITING_HUMAN_APPROVAL" ? "Decide in the control plane, or cancel the mission." : "Mission is not terminal and can be canceled."}</span>
						<Button variant="secondary" size="small" disabled={cancel.isPending} onClick={() => { if (window.confirm("Cancel this mission? This is terminal and cannot be resumed.")) cancel.mutate(details.mission.id); }}>{cancel.isPending ? <LoaderCircle size={12} className="spin" /> : <Ban size={12} />}<span>Cancel mission</span></Button>
					</div>}
					<ol className="event-timeline" aria-label="Persisted mission events">
						{events.map((event, index) => {
							const { detail, tone } = describeEvent(event);
							return <motion.li key={event.event_id} className={`timeline-event ${tone}`} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(index * 0.035, 0.25) }}>
								<span className="timeline-node">{tone === "failed" ? <X size={11} /> : tone === "warning" ? <AlertTriangle size={10} /> : <Check size={11} />}</span>
								<div className="timeline-event-copy"><b>{displayEvent(event)}</b><span title={detail}>{detail}</span></div>
								<span className="timeline-time">{new Date(event.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
							</motion.li>;
						})}
						{!isTerminal && <li className="timeline-event active">
							<span className="timeline-node">{details.mission.state === "AWAITING_HUMAN_APPROVAL" ? <CircleDashed size={12} /> : <LoaderCircle size={12} className="spin" />}</span>
							<div className="timeline-event-copy"><b>{details.mission.state === "AWAITING_HUMAN_APPROVAL" ? "HUMAN DECISION" : details.mission.state === "PLANNED" ? "READ-ONLY PLAN READY" : "IN PROGRESS"}</b><span>{details.mission.state === "AWAITING_HUMAN_APPROVAL" ? "Waiting for APPROVED, REJECTED or REQUESTED_CHANGES" : details.mission.state === "PLANNED" ? "No mutation is authorized for this read-only mission" : "Awaiting the next governed state"}</span></div>
							<span className="timeline-time">—</span>
						</li>}
					</ol>
					{planSteps.length > 0 && <div className="mission-plan">
						<span className="runtime-kicker">PLAN · {planSteps.length} STEP(S)</span>
						<ol>{planSteps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>
					</div>}
				</div>}
			</div>
			<footer className="runtime-pane-footer"><Radio size={12} /><span>Supabase Realtime + periodic sync</span><span className="footer-live-dot" /></footer>
		</section>
	);
}

function MissionQueueItem({ mission, selected, onSelect }: { mission: MissionRecord; selected: boolean; onSelect: () => void }) {
	return <button className={`mission-queue-item ${selected ? "selected" : ""}`} onClick={onSelect}>
		<span className={`queue-state-mark ${queueTone(mission.state)}`} />
		<span className="queue-item-main"><b>{mission.action} <i>/</i> {mission.domain}</b><small>{mission.target_path}</small></span>
		<span className="queue-item-state">{mission.state}</span>
		<ArrowRight size={13} />
	</button>;
}
