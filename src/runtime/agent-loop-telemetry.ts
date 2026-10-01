import type { LangfuseOptions } from "../telemetry/langfuse";

export interface AgentLoopTelemetryContext {
	traceId: string;
	sessionId: string;
	executionId: string;
	action: string;
	domain: string;
	modelProfile: string | null;
}

export interface AgentLoopGeneration {
	model: string | null;
	provider: string | null;
	modelProfile?: string | null;
	catalogVersion?: string | null;
	routerVersion?: string | null;
	promptVersion?: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens?: number | null;
	reportedCost: number | null;
	estimatedCost?: number | null;
	latencyMs: number | null;
	attempt: number;
	retryCount?: number;
	fallbackUsed: boolean;
	totalCostKnown?: boolean;
	reviewerOutcome?: string | null;
	status?: "OK" | "ERROR";
	errorCategory?: string | null;
	structuredOutputValid?: boolean;
}

export interface AgentLoopTelemetry {
	readonly kind: "noop" | "langfuse";
	start(context: AgentLoopTelemetryContext): Promise<void>;
	span(name: string, metadata: Record<string, unknown>): Promise<void>;
	generation(name: string, generation: AgentLoopGeneration): Promise<void>;
	updateGeneration(metadata: Partial<AgentLoopGeneration>): Promise<void>;
	memoryProposal(metadata: { area: string; status: string; evidence: string }): Promise<void>;
	flush(): Promise<void>;
}

const forbiddenPatterns = [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/, /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/, /\bBearer\s+[A-Za-z0-9._-]+\b/i, /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]/i, /-----BEGIN .*PRIVATE KEY-----/];
const safeString = (value: unknown): string | null => typeof value === "string" && value.length <= 200 && !forbiddenPatterns.some((pattern) => pattern.test(value)) ? value : null;
const safeNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const safeBoolean = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [
		key,
		typeof value === "number" ? safeNumber(value) : typeof value === "boolean" ? safeBoolean(value) : Array.isArray(value) ? value.slice(0, 20).map(safeString) : safeString(value),
	]));
}

function createId(prefix: string): string {
	return crypto.randomUUID().replaceAll("-", "");
}

function attribute(key: string, value: unknown): Record<string, unknown> {
	if (typeof value === "boolean") return { key, value: { boolValue: value } };
	if (typeof value === "number") return { key, value: { doubleValue: value } };
	return { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value ?? null) } };
}

export interface LangfuseAgentLoopTelemetryOptions extends LangfuseOptions {
	traceId?: string;
	sessionId?: string;
	executionId?: string;
}

export class NoopAgentLoopTelemetry implements AgentLoopTelemetry {
	readonly kind = "noop" as const;
	async start(): Promise<void> {}
	async span(): Promise<void> {}
	async generation(): Promise<void> {}
	async updateGeneration(): Promise<void> {}
	async memoryProposal(): Promise<void> {}
	async flush(): Promise<void> {}
}

export class LangfuseAgentLoopTelemetry implements AgentLoopTelemetry {
	readonly kind = "langfuse" as const;
	private readonly events: Array<Record<string, unknown>> = [];
	private context: AgentLoopTelemetryContext | null = null;
	private readonly options: LangfuseAgentLoopTelemetryOptions;

	constructor(options: LangfuseAgentLoopTelemetryOptions) {
		this.options = options;
	}

	async start(context: AgentLoopTelemetryContext): Promise<void> {
		this.context = {
			...context,
			traceId: context.traceId || this.options.traceId || createId("trace"),
			sessionId: context.sessionId || this.options.sessionId || createId("session"),
		};
		this.events.push({ type: "trace", ...this.context });
	}

	async span(name: string, metadata: Record<string, unknown>): Promise<void> {
		if (!this.context) return;
		this.events.push({ type: "span", traceId: this.context.traceId, sessionId: this.context.sessionId, name: safeString(name), metadata: sanitizeMetadata(metadata) });
	}

	async generation(name: string, generation: AgentLoopGeneration): Promise<void> {
		if (!this.context) return;
		this.events.push({ type: "generation", traceId: this.context.traceId, sessionId: this.context.sessionId, name: safeString(name), generation: { ...generation, model: safeString(generation.model), provider: safeString(generation.provider), inputTokens: safeNumber(generation.inputTokens), outputTokens: safeNumber(generation.outputTokens), reportedCost: safeNumber(generation.reportedCost), latencyMs: safeNumber(generation.latencyMs) } });
	}

	async updateGeneration(metadata: Partial<AgentLoopGeneration>): Promise<void> {
		const generation = [...this.events].reverse().find((event) => event.type === "generation");
		if (generation && generation.generation && typeof generation.generation === "object") generation.generation = { ...generation.generation, ...sanitizeMetadata(metadata) };
	}

	async memoryProposal(metadata: { area: string; status: string; evidence: string }): Promise<void> {
		if (!this.context) return;
		this.events.push({ type: "memory_proposal", traceId: this.context.traceId, sessionId: this.context.sessionId, metadata: sanitizeMetadata(metadata) });
	}

	async flush(): Promise<void> {
		if (!this.options.endpoint || this.options.enabled === false || this.events.length === 0) return;
		const traceId = this.context?.traceId ?? createId("trace");
		const now = Date.now();
		const spans = this.events.map((event, index) => {
			const spanId = createId("span").slice(0, 16);
			const isGeneration = event.type === "generation";
			const metadata = isGeneration ? (event.generation ?? {}) : (event.metadata ?? {});
			const attributes = [
				attribute("langfuse.trace.name", `${this.context?.action ?? "agent-loop"}:${this.context?.domain ?? "unknown"}`),
				attribute("langfuse.session.id", this.context?.sessionId ?? ""),
				attribute("langfuse.environment", "production"),
				attribute("langfuse.observation.type", isGeneration ? "generation" : "span"),
				...Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => attribute(`langfuse.observation.metadata.${key}`, value)),
			];
			if (isGeneration && event.generation?.model) attributes.push(attribute("gen_ai.request.model", event.generation.model));
			return { traceId, spanId, name: safeString(event.name) ?? event.type, kind: 1, startTimeUnixNano: String((now + index) * 1_000_000), endTimeUnixNano: String((now + index + 1) * 1_000_000), attributes, status: { code: event.generation?.status === "ERROR" ? 2 : 1 } };
		});
		const payload = JSON.stringify({ resourceSpans: [{ resource: { attributes: [attribute("service.name", "m4qna-commerce")] }, scopeSpans: [{ scope: { name: "m4qna-one" }, spans }] }] });
		try {
			const endpoint = this.options.endpoint.replace(/\/api\/public\/ingestion$/, "/api/public/otel/v1/traces");
			const response = await (this.options.fetcher ?? fetch)(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "x-langfuse-ingestion-version": "4", ...(this.options.publicKey && this.options.secretKey ? { Authorization: `Basic ${btoa(`${this.options.publicKey}:${this.options.secretKey}`)}` } : {}), ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) }, body: payload });
			if (!response.ok) return;
		} catch {
			// Telemetry is best effort and never blocks the Agent Loop.
		}
	}
}

export interface LangfuseRuntimeEnv {
	LANGFUSE_PUBLIC_KEY?: string;
	LANGFUSE_SECRET_KEY?: string;
	LANGFUSE_BASE_URL?: string;
	fetcher?: typeof fetch;
}

export function createAgentLoopTelemetry(env: LangfuseRuntimeEnv): AgentLoopTelemetry {
	const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
	const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
	const baseUrl = env.LANGFUSE_BASE_URL?.trim();
	if (!publicKey || !secretKey || !baseUrl) return new NoopAgentLoopTelemetry();
	return new LangfuseAgentLoopTelemetry({
		enabled: true,
		endpoint: `${baseUrl.replace(/\/$/, "")}/api/public/ingestion`,
		publicKey,
		secretKey,
		fetcher: env.fetcher,
	});
}