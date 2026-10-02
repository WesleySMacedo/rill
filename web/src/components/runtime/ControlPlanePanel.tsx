import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, ArrowRight, DollarSign, FileCheck2, Gauge, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles, Workflow } from "lucide-react";
import { decideMission, missionErrorMessage, TERMINAL_MISSION_STATES, type HumanDecision, type MissionDetails, type MissionEvent } from "../../runtime/client";
import { useApprovalStore, useExecutionStore, useGovernanceStore, useRouterStore } from "../../state/stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

function InspectorRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
	return <div className="inspector-row"><span>{label}</span><b className={tone ?? ""} title={value}>{value}</b></div>;
}

function latestEvent(events: MissionEvent[], type: string): Record<string, unknown> | null {
	for (let index = events.length - 1; index >= 0; index -= 1) if (events[index].event_type === type) return events[index].payload ?? {};
	return null;
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function BulletList({ label, items }: { label: string; items: string[] }) {
	if (!items.length) return null;
	return <div className="proposal-section"><div className="candidate-list-label">{label}</div><ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>;
}

export function ControlPlanePanel({ details }: { details: MissionDetails | null }) {
	const queryClient = useQueryClient();
	const mission = details?.mission;
	const events = useMemo(() => details?.events ?? [], [details?.events]);
	const approval = details?.approval ?? null;
	const proposal = details?.proposal?.proposal ?? null;
	const canDecide = Boolean(mission?.approval_required && mission.state === "AWAITING_HUMAN_APPROVAL" && approval?.decision === "PENDING" && approval.proposal_hash);
	const contextPaths = useMemo(() => mission?.context_manifest?.targetFiles ?? [], [mission?.context_manifest?.targetFiles]);
	const includedItems = mission?.context_manifest?.includedItems ?? [];
	const modelRouted = latestEvent(events, "MODEL_ROUTED");
	const modelCompleted = latestEvent(events, "MODEL_COMPLETED");
	const modelFailed = latestEvent(events, "MODEL_INVOCATION_FAILED");
	const promptResolved = latestEvent(events, "PROMPT_RESOLVED");
	const review = latestEvent(events, "PROPOSAL_REVIEWED");
	const traceId = text(latestEvent(events, "MISSION_CREATED")?.traceId);
	const modelTelemetry = modelCompleted ?? modelFailed;
	const reportedCost = num(modelTelemetry?.reportedCostUsd);
	const estimatedCost = num(modelTelemetry?.estimatedCostUsd) ?? mission?.estimated_cost_usd ?? null;
	const executionGate = mission?.state === "BLOCKED" && approval?.decision === "APPROVED" ? "EXECUTOR NOT CONFIGURED" : mission?.approval_required ? "LOCKED" : "NOT APPLICABLE";

	const [justification, setJustification] = useState("");
	const [decisionError, setDecisionError] = useState<string | null>(null);
	const setGovernance = useGovernanceStore((state) => state.setGovernance);
	const setRoute = useRouterStore((state) => state.setRoute);
	const setApproval = useApprovalStore((state) => state.setApproval);
	const setExecution = useExecutionStore((state) => state.setExecution);

	useEffect(() => {
		setJustification("");
		setDecisionError(null);
	}, [mission?.id]);

	useEffect(() => {
		const invoked = Boolean(modelRouted);
		setGovernance({
			missionState: mission?.state ?? null,
			risk: mission?.risk ?? null,
			contextPaths,
			approvalRequired: mission?.approval_required ?? false,
			executionGate: mission ? (mission.approval_required ? "LOCKED" : "NOT_APPLICABLE") : "LOCKED",
		});
		setRoute({
			profile: mission?.model_profile ?? null,
			provider: invoked ? "openrouter" : null,
			model: mission?.selected_model ?? null,
			status: invoked ? "selected" : mission ? "not-invoked" : "idle",
			confidence: null,
		});
		setApproval({ approvalId: approval?.approval_id ?? null, decision: approval?.decision ?? null });
		setExecution(mission?.state ?? null, mission ? (mission.approval_required ? "LOCKED" : "NOT_APPLICABLE") : "LOCKED");
	}, [mission, approval, contextPaths, modelRouted, setApproval, setExecution, setGovernance, setRoute]);

	const decide = useMutation({
		mutationFn: (decision: HumanDecision) => decideMission(mission!.id, { decision, justification: justification.trim(), proposalHash: approval!.proposal_hash! }),
		onSuccess: async (result) => {
			setDecisionError(null);
			setJustification("");
			setApproval({ justification: "" });
			queryClient.setQueryData(["rill", "mission", result.mission.id], result);
			await queryClient.invalidateQueries({ queryKey: ["rill", "missions"] });
		},
		onError: (error) => setDecisionError(missionErrorMessage(error)),
	});

	function submitDecision(decision: HumanDecision) {
		setDecisionError(null);
		if (decision !== "APPROVED" && !justification.trim()) {
			setDecisionError(missionErrorMessage(new Error("JUSTIFICATION_REQUIRED")));
			return;
		}
		decide.mutate(decision);
	}

	const approvalState = canDecide ? "AWAITING HUMAN" : approval && approval.decision !== "PENDING" ? approval.decision.replaceAll("_", " ") : mission?.approval_required ? "LOCKED" : "NOT REQUIRED";
	const approvalExplanation = canDecide
		? "The Auditor Técnico cleared this proposal for human review. Only APPROVED can advance, and execution remains locked because no safe executor is configured."
		: approval && approval.decision !== "PENDING"
			? `Decision ${approval.decision} recorded${approval.decided_at ? ` at ${new Date(approval.decided_at).toLocaleString()}` : ""}.${approval.justification ? ` Justification: ${approval.justification}` : ""}`
			: mission?.approval_required
				? mission && TERMINAL_MISSION_STATES.has(mission.state) ? "The mission ended before a human decision was possible." : "No pending approval ticket is available yet."
				: "The current policy does not require approval for this read-only mission.";

	return (
		<aside className="control-plane-pane" aria-label="Control plane runtime">
			<header className="runtime-pane-header control-plane-header"><div><span className="runtime-kicker">RILL / POLICY</span><h2>Control plane</h2></div><Badge className="authority-badge"><ShieldCheck size={11} />AUTHORITY</Badge></header>
			<div className="control-plane-body">
				<InspectorCard icon={ShieldCheck} title="Authority" state="RILL CONTROLLED" tone="green">
					<InspectorRow label="Decision source" value="Engineering Registry" />
					<InspectorRow label="Client authority" value="None" />
				</InspectorCard>
				<InspectorCard icon={FileCheck2} title="Registry & policy" state={mission ? "MATCHED" : "WAITING"} tone={mission ? "green" : undefined}>
					<InspectorRow label="Domain" value={mission?.domain ?? "—"} />
					<InspectorRow label="Action" value={mission?.action ?? "—"} />
					<InspectorRow label="Risk" value={mission?.risk ?? "Not analyzed"} tone={mission?.risk === "LOW" ? "green" : mission?.risk === "MEDIUM" ? "amber" : undefined} />
				</InspectorCard>
				<InspectorCard icon={Activity} title="Context" state={mission ? "RESOLVED" : "NO MISSION"} tone={mission ? "green" : undefined}>
					<InspectorRow label="Targets" value={contextPaths.length ? `${contextPaths.length} file(s)` : "—"} />
					<InspectorRow label="Included items" value={includedItems.length ? `${includedItems.length}` : "—"} />
					{contextPaths.map((path) => <div className="context-path" key={path} title={path}>{path}</div>)}
				</InspectorCard>
				<InspectorCard icon={Workflow} title="Workflow state" state={mission?.state ?? "IDLE"} tone={mission ? "blue" : undefined}>
					<InspectorRow label="Persisted state" value={mission?.state ?? "—"} />
					<InspectorRow label="Events" value={mission ? `${events.length}` : "—"} />
					<InspectorRow label="Durable instance" value="Not started" />
				</InspectorCard>
				{proposal && <InspectorCard icon={Sparkles} title="Patch proposal" state={`V${details?.proposal?.version ?? 1} · NO DIFF`} tone="blue">
					<p className="inspector-explanation">{proposal.summary}</p>
					<InspectorRow label="Proposal hash" value={`${details!.proposal!.proposal_hash.slice(0, 16)}…`} />
					{proposal.targetFiles.map((path) => <div className="context-path" key={path} title={path}>{path}</div>)}
					<BulletList label="PROPOSED CHANGES" items={proposal.proposedChanges} />
					<BulletList label="ACCEPTANCE CRITERIA" items={proposal.acceptanceCriteria} />
					<BulletList label="RISKS" items={proposal.risks} />
					<BulletList label="TESTS RECOMMENDED" items={proposal.testsRecommended} />
				</InspectorCard>}
				{review && <InspectorCard icon={ShieldCheck} title="Auditor Técnico" state={text(review.status) ?? "REVIEWED"} tone={review.approvedForHumanReview ? "green" : "amber"}>
					<InspectorRow label="Mode" value={text(review.mode) ?? "DETERMINISTIC"} />
					<InspectorRow label="Cleared for human review" value={review.approvedForHumanReview ? "Yes" : "No"} tone={review.approvedForHumanReview ? "green" : "amber"} />
					<BulletList label="FINDINGS" items={strings(review.findings)} />
				</InspectorCard>}
				<InspectorCard icon={LockKeyhole} title="Approval & execution gate" state={approvalState} tone={canDecide ? "amber" : approval?.decision === "APPROVED" ? "green" : mission?.approval_required ? "amber" : "green"}>
					<p className="inspector-explanation">{approvalExplanation}</p>
					{canDecide && <>
						<textarea className="decision-justification" value={justification} onChange={(event) => setJustification(event.target.value)} maxLength={1000} rows={3} placeholder="Justification (required to reject or request changes)…" aria-label="Decision justification" disabled={decide.isPending} />
						<div className="approval-actions">
							<Button variant="primary" size="small" disabled={decide.isPending} onClick={() => submitDecision("APPROVED")} title={`Approves proposal hash ${approval!.proposal_hash}`}>{decide.isPending && decide.variables === "APPROVED" ? <LoaderCircle size={12} className="spin" /> : null}<span>Approve</span></Button>
							<Button variant="secondary" size="small" disabled={decide.isPending} onClick={() => submitDecision("REJECTED")}>Reject</Button>
						</div>
						<Button variant="ghost" size="small" className="request-changes-button" disabled={decide.isPending} onClick={() => submitDecision("REQUESTED_CHANGES")}>Request changes <ArrowRight size={12} /></Button>
					</>}
					{decisionError && <div className="runtime-error" role="alert"><AlertTriangle size={13} /><span>{decisionError}</span></div>}
					<InspectorRow label="Execution gate" value={executionGate} tone="amber" />
				</InspectorCard>
				<InspectorCard icon={Gauge} title="Model router" state={modelCompleted ? "COMPLETED" : modelFailed ? "FAILED" : modelRouted ? "ROUTED" : "NOT ROUTED"} tone={modelCompleted ? "green" : modelFailed ? "amber" : undefined}>
					<InspectorRow label="Policy profile" value={mission?.model_profile ?? "—"} />
					<InspectorRow label="Specialist" value={text(modelRouted?.role) ?? "—"} />
					<InspectorRow label="Requested model" value={text(modelRouted?.requestedModel) ?? "Not invoked"} />
					<InspectorRow label="Effective model" value={text(modelTelemetry?.usedModel) ?? "—"} />
					<InspectorRow label="Provider" value={modelRouted ? `OpenRouter${text(modelTelemetry?.provider) ? ` · ${text(modelTelemetry?.provider)}` : ""}` : "Not invoked"} />
					<InspectorRow label="Prompt" value={promptResolved ? (promptResolved.source === "langfuse" ? `${text(promptResolved.name)} v${num(promptResolved.version) ?? "?"}` : "Local fallback") : "—"} tone={promptResolved?.source === "langfuse" ? "green" : promptResolved ? "amber" : undefined} />
					{modelFailed && <InspectorRow label="Failure" value={text(modelFailed.code) ?? "UNKNOWN"} tone="amber" />}
					{modelRouted ? <p className="inspector-footnote">{text(modelRouted.reason)}</p> : <p className="inspector-footnote">No model provider was invoked for this mission.</p>}
				</InspectorCard>
				<InspectorCard icon={DollarSign} title="Cost & tokens" state={reportedCost !== null ? "REPORTED" : estimatedCost !== null ? "ESTIMATED" : "UNKNOWN"} tone={reportedCost !== null ? "green" : "amber"}>
					<InspectorRow label="Reported cost" value={reportedCost === null ? "—" : `$${reportedCost.toFixed(6)}`} />
					<InspectorRow label="Estimated ceiling" value={estimatedCost === null ? "Unknown" : `$${estimatedCost.toFixed(6)}`} />
					<InspectorRow label="Input / output tokens" value={modelTelemetry ? `${num(modelTelemetry.inputTokens) ?? "?"} / ${num(modelTelemetry.outputTokens) ?? "?"}` : "Not invoked"} />
					<InspectorRow label="Latency" value={num(modelTelemetry?.latencyMs) === null ? "—" : `${num(modelTelemetry?.latencyMs)} ms`} />
				</InspectorCard>
				<InspectorCard icon={FileCheck2} title="Audit trail" state={details ? `${details.auditEvents.length} EVENTS` : "EMPTY"} tone={details ? "blue" : undefined}>
					<InspectorRow label="Last audit event" value={details?.auditEvents.at(-1)?.event_type ?? "None"} />
					<InspectorRow label="Langfuse trace" value={traceId ?? "Not emitted"} tone={traceId ? "green" : undefined} />
					<InspectorRow label="Event source" value="Supabase audit ledger" />
				</InspectorCard>
				<div className="execution-lock-note"><AlertTriangle size={13} /><span>Execution stays locked until an approved proposal and safe executor are available.</span></div>
			</div>
		</aside>
	);
}

function InspectorCard({ icon: Icon, title, state, tone, children }: {
	icon: typeof ShieldCheck;
	title: string;
	state: string;
	tone?: string;
	children: React.ReactNode;
}) {
	return <section className="inspector-card"><header><span className="inspector-card-icon"><Icon size={14} /></span><b>{title}</b><span className={`inspector-state ${tone ?? ""}`}>{state}</span></header><div className="inspector-card-content">{children}</div></section>;
}
