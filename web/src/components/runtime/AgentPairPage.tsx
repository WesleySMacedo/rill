import { useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, MonitorSmartphone, ShieldAlert, XCircle } from "lucide-react";
import { AgentRequestError, confirmAgentPairing, lookupAgentPairing } from "../../runtime/agent";
import { Button } from "../ui/button";

function leave() {
	window.history.replaceState(null, "", "/");
	window.dispatchEvent(new PopStateEvent("popstate"));
}

function errorMessage(error: unknown): string {
	if (error instanceof AgentRequestError) return error.message;
	return "Could not reach Rill. Try again.";
}

/** Device-code confirmation: the signed-in user explicitly approves the machine shown by the Agent. */
export function AgentPairPage({ session }: { session: Session }) {
	const initialCode = new URLSearchParams(window.location.search).get("code") ?? "";
	const [input, setInput] = useState(initialCode);
	const [code, setCode] = useState(initialCode);
	const lookup = useQuery({ queryKey: ["rill", "agent", "pairing", code], queryFn: () => lookupAgentPairing(code), enabled: code.length > 0, retry: false });
	const decide = useMutation({ mutationFn: (decision: "APPROVE" | "DENY") => confirmAgentPairing(code, decision) });

	return (
		<main className="agent-pair-screen">
			<section className="agent-pair-card">
				<img src="/assets/rill-logo-wh.svg" alt="Rill" className="agent-pair-logo" />
				<h1>Pair Rill Agent</h1>
				<p className="agent-pair-account">Signed in as <b>{session.user.email ?? session.user.id}</b></p>

				{decide.data ? (
					<div className={`agent-pair-result ${decide.data.status === "APPROVED" ? "approved" : "denied"}`}>
						{decide.data.status === "APPROVED" ? <CheckCircle2 size={22} /> : <XCircle size={22} />}
						<p>{decide.data.status === "APPROVED" ? <><b>{decide.data.machineName}</b> is now paired. The Agent connects automatically — you can close this tab.</> : <>Pairing for <b>{decide.data.machineName}</b> was denied. No access was granted.</>}</p>
						<Button variant="secondary" onClick={leave}>Back to Rill</Button>
					</div>
				) : (
					<>
						<form
							className="agent-pair-form"
							onSubmit={(event) => {
								event.preventDefault();
								setCode(input.trim());
							}}
						>
							<label htmlFor="agent-pair-code">Code shown by Rill Agent</label>
							<div>
								<input id="agent-pair-code" value={input} onChange={(event) => setInput(event.target.value)} placeholder="XXXX-XXXX" autoComplete="off" spellCheck={false} maxLength={12} />
								<Button type="submit" variant="secondary" disabled={!input.trim() || lookup.isFetching}>Check</Button>
							</div>
						</form>

						{lookup.isFetching && <p className="agent-pair-muted">Checking code…</p>}
						{lookup.error && <p className="agent-pair-error"><ShieldAlert size={14} />{errorMessage(lookup.error)}</p>}

						{lookup.data && (
							<div className="agent-pair-request">
								<div className="agent-pair-machine"><MonitorSmartphone size={18} /><div><b>{lookup.data.machineName}</b><span>{lookup.data.platform} · Rill Agent {lookup.data.agentVersion}</span></div></div>
								<p className="agent-pair-code">{lookup.data.userCode}</p>
								<p className="agent-pair-warning">Only approve if this code matches the one displayed by Rill Agent on <b>your</b> computer. Approving lets this machine act for your Rill account; projects are still exposed only with your approval on that computer.</p>
								{decide.error && <p className="agent-pair-error"><ShieldAlert size={14} />{errorMessage(decide.error)}</p>}
								<div className="agent-pair-actions">
									<Button variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate("DENY")}>Deny</Button>
									<Button variant="primary" disabled={decide.isPending} onClick={() => decide.mutate("APPROVE")}>Approve this computer</Button>
								</div>
							</div>
						)}
						<button className="agent-pair-cancel" onClick={leave}>Cancel</button>
					</>
				)}
			</section>
		</main>
	);
}
