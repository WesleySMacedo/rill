import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { GatewayChatMessage } from "../../../src/contracts/gateway.contract";

export interface LangfuseRuntimeEnv {
	LANGFUSE_PUBLIC_KEY?: string;
	LANGFUSE_SECRET_KEY?: string;
	LANGFUSE_BASE_URL?: string;
	LANGFUSE_TRACING_ENVIRONMENT?: string;
	LANGFUSE_PROMPT_NAME?: string;
	LANGFUSE_PROMPT_LABEL?: string;
}

export const MISSION_PROMPT_NAME = "rill-mission-intelligence";
export const MISSION_PROMPT_LABEL = "production";
export const LOCAL_PROMPT_VERSION = "local-fallback-v1";

export interface MissionPromptVariables {
	goal: string;
	action: string;
	domain: string;
	risk: string;
	context_manifest: string;
	approval_required: string;
}

/**
 * Local copy of the managed chat prompt. Used when Langfuse is not configured,
 * the prompt does not exist yet, or the fetch fails. Keep in sync with the
 * `production` version in Langfuse.
 */
export const LOCAL_MISSION_PROMPT: GatewayChatMessage[] = [
	{
		role: "system",
		content: [
			"You are a specialist inside Rill, the AI control plane of M4QNA One. Rill has already classified this mission deterministically and resolved the authorized context. You hold no authority: you cannot approve, apply, execute, or widen scope.",
			"",
			"<role_by_action>",
			"- PLAN_CHANGE or VALIDATE_CHANGE: act as the Estrategista (Planner) and produce a read-only plan.",
			"- PATCH_UI: act as the Projetista (Builder) and produce a PATCH_PROPOSAL only. It will be audited deterministically and then decided by a human (Diretor da Obra). Do not write code or diffs.",
			"</role_by_action>",
			"",
			"<rules>",
			"1. Use only the files listed in the authorized context manifest. You have not seen their contents, so do not state facts about them; record assumptions as risks instead. Rill forbids filling gaps with generic knowledge.",
			"2. When proposing target files, choose only manifest paths with category TARGET and keep the list minimal. Paths outside the manifest are rejected by the Auditor.",
			"3. Never include credentials, personal data, CPF, CNPJ, banking or fiscal identifiers.",
			"4. Do not change financial, fiscal, or marketplace rules; those belong to the business domain, not to this mission.",
			"5. Write natural-language fields in Brazilian Portuguese. Return only JSON matching the response schema supplied with the request, with no preamble.",
			"</rules>",
		].join("\n"),
	},
	{
		role: "user",
		content: [
			"<mission>",
			"<goal>{{goal}}</goal>",
			"<action>{{action}}</action>",
			"<domain>{{domain}}</domain>",
			"<risk>{{risk}}</risk>",
			"<approval_required>{{approval_required}}</approval_required>",
			"</mission>",
			"<authorized_context_manifest>",
			"{{context_manifest}}",
			"</authorized_context_manifest>",
		].join("\n"),
	},
];

export interface ResolvedMissionPrompt {
	messages: GatewayChatMessage[];
	name: string;
	label: string;
	source: "langfuse" | "local-fallback";
	version: number | null;
	isFallback: boolean;
	/** Link payload for Langfuse generations; only set for real managed prompts. */
	link: { name: string; version: number; isFallback: false } | null;
}

const sensitivePatterns: Array<[RegExp, string]> = [
	[/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
	[/\b(?:sk-or-v1|sk-lf|sb_secret)[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]"],
	[/\b[^\s@"]+@[^\s@"]+\.[^\s@"]+\b/g, "[REDACTED_EMAIL]"],
	[/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "[REDACTED_CPF]"],
	[/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, "[REDACTED_CNPJ]"],
];

export function maskTelemetry(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return sensitivePatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
	if (depth > 8 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => maskTelemetry(item, depth + 1));
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskTelemetry(item, depth + 1)]));
}

function credentials(env: LangfuseRuntimeEnv): { publicKey: string; secretKey: string; baseUrl: string } | null {
	const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
	const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
	if (!publicKey || !secretKey) return null;
	return { publicKey, secretKey, baseUrl: (env.LANGFUSE_BASE_URL?.trim() || "https://us.cloud.langfuse.com").replace(/\/$/, "") };
}

let contextManagerRegistered = false;
let tracingState: { key: string; processor: LangfuseSpanProcessor } | null = null;
let clientState: { key: string; client: LangfuseClient } | null = null;

/**
 * Lazily wires an isolated OTel tracer provider that exports only Langfuse spans.
 * Returns the processor so the caller can flush it with `ctx.waitUntil`.
 */
export function ensureLangfuseTracing(env: LangfuseRuntimeEnv): LangfuseSpanProcessor | null {
	const creds = credentials(env);
	if (!creds) {
		if (tracingState) {
			setLangfuseTracerProvider(null);
			tracingState = null;
		}
		return null;
	}
	const key = `${creds.baseUrl}|${creds.publicKey}`;
	if (tracingState?.key === key) return tracingState.processor;
	if (!contextManagerRegistered) {
		contextManagerRegistered = context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
	}
	const processor = new LangfuseSpanProcessor({
		...creds,
		exportMode: "immediate",
		environment: env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || "production",
		release: "rill-web",
		mask: ({ data }) => maskTelemetry(data),
	});
	setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));
	tracingState = { key, processor };
	return processor;
}

function langfuseClient(env: LangfuseRuntimeEnv): LangfuseClient | null {
	const creds = credentials(env);
	if (!creds) return null;
	const key = `${creds.baseUrl}|${creds.publicKey}`;
	if (clientState?.key !== key) clientState = { key, client: new LangfuseClient(creds) };
	return clientState.client;
}

function compileLocal(messages: GatewayChatMessage[], variables: MissionPromptVariables): GatewayChatMessage[] {
	return messages.map(({ role, content }) => ({
		role,
		content: content.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, name: string) => (name in variables ? variables[name as keyof MissionPromptVariables] : match)),
	}));
}

function validCompiled(value: unknown): GatewayChatMessage[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const messages: GatewayChatMessage[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const { role, content } = item as Record<string, unknown>;
		if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) return null;
		if (/\{\{\s*[a-z_]+\s*\}\}/.test(content)) return null;
		messages.push({ role, content });
	}
	return messages;
}

/** Fetches the managed chat prompt by label; never throws, falls back to the local prompt. */
export async function resolveMissionPrompt(env: LangfuseRuntimeEnv, variables: MissionPromptVariables): Promise<ResolvedMissionPrompt> {
	const name = env.LANGFUSE_PROMPT_NAME?.trim() || MISSION_PROMPT_NAME;
	const label = env.LANGFUSE_PROMPT_LABEL?.trim() || MISSION_PROMPT_LABEL;
	const local: ResolvedMissionPrompt = { messages: compileLocal(LOCAL_MISSION_PROMPT, variables), name, label, source: "local-fallback", version: null, isFallback: true, link: null };
	const client = langfuseClient(env);
	if (!client) return local;
	try {
		const prompt = await client.prompt.get(name, { type: "chat", label, cacheTtlSeconds: 300, fetchTimeoutMs: 3_000, maxRetries: 1, fallback: LOCAL_MISSION_PROMPT });
		if (prompt.isFallback) return local;
		const messages = validCompiled(prompt.compile({ ...variables }));
		if (!messages) return local;
		return { messages, name: prompt.name, label, source: "langfuse", version: prompt.version, isFallback: false, link: { name: prompt.name, version: prompt.version, isFallback: false } };
	} catch {
		return local;
	}
}

/**
 * Attaches the human HITL decision to the trace that produced the proposal.
 * Returns a promise to be passed to `ctx.waitUntil`; never rejects.
 */
export function recordHumanDecisionScore(env: LangfuseRuntimeEnv, params: { traceId: string; observationId?: string; decision: string; justification?: string }): Promise<void> | null {
	const client = langfuseClient(env);
	if (!client || !/^[0-9a-f]{32}$/.test(params.traceId)) return null;
	client.score.create({
		traceId: params.traceId,
		...(params.observationId ? { observationId: params.observationId } : {}),
		name: "human-approval-decision",
		value: params.decision,
		dataType: "CATEGORICAL",
		...(params.justification ? { comment: String(maskTelemetry(params.justification)).slice(0, 500) } : {}),
		environment: env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || "production",
	});
	return client.score.flush().catch(() => undefined);
}
