import type { RillExecution, RillExecutionState } from "../contracts/rill-execution.contract";

export interface RillPersistenceEnv {
	SUPABASE_URL?: string;
	SUPABASE_SERVICE_ROLE_KEY?: string;
}

function headers(env: RillPersistenceEnv): HeadersInit {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY_REQUIRED");
	return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" };
}

function endpoint(env: RillPersistenceEnv, path: string): string {
	if (!env.SUPABASE_URL) throw new Error("SUPABASE_URL_REQUIRED");
	return `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`;
}

export async function createRillExecution(env: RillPersistenceEnv, execution: RillExecution & { workflowInstanceId: string; idempotencyKey?: string; proposalHash?: string | null }): Promise<void> {
	const response = await fetch(endpoint(env, "rill_executions"), {
		method: "POST",
		headers: headers(env),
		body: JSON.stringify({ execution_id: execution.executionId, workflow_instance_id: execution.workflowInstanceId, requested_by: execution.requestedBy, human_user_id: execution.humanUserId ?? null, service_account_id: execution.serviceAccountId ?? null, source_client: execution.sourceClient, action: execution.action, domain: execution.domain, state: execution.state, trace_id: execution.traceId, session_id: execution.sessionId, idempotency_key: execution.idempotencyKey ?? null, proposal_hash: execution.proposalHash ?? null }),
	});
	if (!response.ok && response.status !== 409) throw new Error("RILL_EXECUTION_PERSISTENCE_FAILED");
}

export async function findRillExecutionByIdempotencyKey(env: RillPersistenceEnv, idempotencyKey: string): Promise<{ executionId: string; workflowInstanceId: string; state: RillExecutionState } | null> {
	const response = await fetch(endpoint(env, `rill_executions?select=execution_id,workflow_instance_id,state& idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`.replace("& ", "&")), { headers: headers(env) });
	if (!response.ok) throw new Error("RILL_EXECUTION_LOOKUP_FAILED");
	const rows = await response.json();
	return Array.isArray(rows) && rows[0] ? { executionId: rows[0].execution_id, workflowInstanceId: rows[0].workflow_instance_id, state: rows[0].state } : null;
}

export async function updateRillExecutionState(env: RillPersistenceEnv, executionId: string, state: RillExecutionState): Promise<void> {
	const response = await fetch(endpoint(env, `rill_executions?execution_id=eq.${encodeURIComponent(executionId)}`), {
		method: "PATCH",
		headers: headers(env),
		body: JSON.stringify({ state, updated_at: new Date().toISOString() }),
	});
	if (!response.ok) throw new Error("RILL_EXECUTION_STATE_PERSISTENCE_FAILED");
}

export async function createRillReviewTicket(env: RillPersistenceEnv, ticket: { executionId: string; reasonCode: string; summary: string; proposalHash?: string | null }): Promise<void> {
	const response = await fetch(endpoint(env, "rill_review_tickets"), {
		method: "POST",
		headers: headers(env),
		body: JSON.stringify({ execution_id: ticket.executionId, status: "PENDING", reason_code: ticket.reasonCode, summary: ticket.summary, proposal_hash: ticket.proposalHash ?? null }),
	});
	if (!response.ok && response.status !== 409) throw new Error("RILL_REVIEW_TICKET_PERSISTENCE_FAILED");
}

export async function persistRillDecision(env: RillPersistenceEnv, decision: { ticketId: string; executionId: string; reviewerId: string; decision: "APPROVED" | "REJECTED" | "REQUESTED_CHANGES"; justification: string; proposalHash?: string | null }): Promise<void> {
	const response = await fetch(endpoint(env, "rill_review_decisions"), {
		method: "POST",
		headers: headers(env),
		body: JSON.stringify({ ticket_id: decision.ticketId, execution_id: decision.executionId, reviewer_id: decision.reviewerId, decision: decision.decision, justification: decision.justification, proposal_hash: decision.proposalHash ?? null }),
	});
	if (!response.ok && response.status !== 409) throw new Error("RILL_REVIEW_DECISION_PERSISTENCE_FAILED");
}

export async function claimRillReviewTicket(env: RillPersistenceEnv, decision: { ticketId: string; executionId: string; reviewerId: string; decision: "APPROVED" | "REJECTED" | "REQUESTED_CHANGES"; justification: string; proposalHash?: string | null }): Promise<void> {
	const response = await fetch(endpoint(env, `rill_review_tickets?ticket_id=eq.${encodeURIComponent(decision.ticketId)}&execution_id=eq.${encodeURIComponent(decision.executionId)}&status=eq.PENDING`), {
		method: "PATCH",
		headers: { ...headers(env), Prefer: "return=representation" },
		body: JSON.stringify({ status: decision.decision, decided_at: new Date().toISOString() }),
	});
	if (!response.ok) throw new Error("RILL_REVIEW_TICKET_CLAIM_FAILED");
	const rows = await response.json();
	if (!Array.isArray(rows) || rows.length !== 1) throw new Error("RILL_REVIEW_TICKET_NOT_PENDING");
	await persistRillDecision(env, decision);
}
