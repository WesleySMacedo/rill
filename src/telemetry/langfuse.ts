import { sanitizeTelemetryEvent } from "../security/telemetry-sanitizer";
import type { LangfuseTelemetryEvent, TelemetryResult } from "../contracts/telemetry.contract";

export interface LangfuseOptions {
	enabled?: boolean;
	endpoint?: string;
	apiKey?: string;
	publicKey?: string;
	secretKey?: string;
	timeoutMs?: number;
	fetcher?: typeof fetch;
}

export interface LangfuseIngestionResult {
	status: "TELEMETRY_SENT" | "TELEMETRY_FAILED";
	httpStatus: number | null;
	responseValid: boolean;
	eventsSent: number;
	eventsAccepted: number;
	eventsRejected: number;
	rejectionCodes: string[];
}

export async function sendLangfuseBatch(events: Array<Record<string, unknown>>, options: LangfuseOptions = {}): Promise<LangfuseIngestionResult> {
	if (options.enabled === false || !options.endpoint) return { status: "TELEMETRY_FAILED", httpStatus: null, responseValid: false, eventsSent: events.length, eventsAccepted: 0, eventsRejected: events.length, rejectionCodes: ["TELEMETRY_DISABLED"] };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
	try {
		const authorization = options.publicKey && options.secretKey ? `Basic ${btoa(`${options.publicKey}:${options.secretKey}`)}` : undefined;
		const trace = events.find((event) => event.type === "trace-create");
		const traceId = String(trace?.body?.id ?? trace?.id ?? crypto.randomUUID()).replaceAll("-", "").slice(0, 32);
		const now = Date.now();
		const spans = events.filter((event) => event.type !== "trace-create").map((event, index) => ({ traceId, spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16), name: String(event.body?.name ?? event.type), kind: 1, startTimeUnixNano: String((now + index) * 1_000_000), endTimeUnixNano: String((now + index + 1) * 1_000_000), attributes: [{ key: "langfuse.trace.name", value: { stringValue: String(trace?.body?.name ?? "langfuse-ingestion-validation") } }, { key: "langfuse.observation.type", value: { stringValue: event.type === "generation-create" ? "generation" : "span" } }, { key: "langfuse.environment", value: { stringValue: "production" } }], status: { code: 1 } }));
		const payload = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "m4qna-commerce" } }] }, scopeSpans: [{ scope: { name: "m4qna-one" }, spans }] }] };
		const endpoint = options.endpoint.replace(/\/api\/public\/ingestion$/, "/api/public/otel/v1/traces");
		const response = await (options.fetcher ?? fetch)(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "x-langfuse-ingestion-version": "4", ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(payload), signal: controller.signal });
		let body: any = null;
		try { body = await response.json(); } catch { body = null; }
		const rejectedSpans = Number(body?.partialSuccess?.rejectedSpans ?? body?.partial_success?.rejectedSpans ?? 0);
		const successes = response.status === 200 ? events.length - rejectedSpans : 0;
		const rejected = rejectedSpans;
		const errors = rejected;
		const rejectionCodes = rejected > 0 ? [`HTTP_${response.status}`] : [];
		return { status: response.ok && errors === 0 ? "TELEMETRY_SENT" : "TELEMETRY_FAILED", httpStatus: response.status, responseValid: response.status === 200, eventsSent: events.length, eventsAccepted: successes, eventsRejected: Math.max(0, errors), rejectionCodes };
	} catch {
		return { status: "TELEMETRY_FAILED", httpStatus: null, responseValid: false, eventsSent: events.length, eventsAccepted: 0, eventsRejected: events.length, rejectionCodes: ["INGESTION_REQUEST_FAILED"] };
	} finally { clearTimeout(timeout); }
}

export async function sendLangfuseTelemetry(event: LangfuseTelemetryEvent, options: LangfuseOptions = {}): Promise<TelemetryResult> {
	if (options.enabled === false || !options.endpoint) return { status: "TELEMETRY_DISABLED", errorCode: "TELEMETRY_DISABLED" };
	let sanitized: LangfuseTelemetryEvent;
	try {
		sanitized = sanitizeTelemetryEvent(event);
	} catch {
		return { status: "TELEMETRY_REJECTED", errorCode: "TELEMETRY_INVALID" };
	}
	const traceId = crypto.randomUUID();
	const result = await sendLangfuseBatch([
		{ id: traceId, type: "trace-create", timestamp: new Date().toISOString(), body: { id: traceId, name: `${sanitized.action}:${sanitized.domain}`, timestamp: new Date().toISOString() } },
		{ id: crypto.randomUUID(), type: "generation-create", timestamp: new Date().toISOString(), body: { name: "gateway-generation", model: sanitized.modelUsed, inputTokens: sanitized.inputTokens, outputTokens: sanitized.outputTokens, reportedCost: sanitized.reportedCost, metadata: sanitized } },
	], options);
	return result.status === "TELEMETRY_SENT" ? { status: "TELEMETRY_SENT" } : { status: "TELEMETRY_FAILED", errorCode: "TELEMETRY_HTTP_ERROR" };
}
