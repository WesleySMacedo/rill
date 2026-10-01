import { describe, expect, it, vi } from "vitest";
import { sendLangfuseBatch, sendLangfuseTelemetry } from "../src/telemetry/langfuse.ts";
import { sanitizeTelemetryEvent } from "../src/security/telemetry-sanitizer.ts";

const event = {
	executionId: "execution-1",
	action: "PATCH_UI",
	domain: "AuditQ",
	role: "Architect",
	modelRequested: "configured-model",
	modelUsed: "effective-model",
	provider: "configured-provider",
	inputTokens: 10,
	outputTokens: 5,
	cachedInputTokens: null,
	reportedCost: null,
	latencyMs: 100,
	attempt: 1,
	validationResult: "PASSED",
	humanApproval: "PENDING",
	sanitizedErrorCode: null,
};

describe("Langfuse telemetry", () => {
	it("sends only the sanitized event", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		const result = await sendLangfuseTelemetry(event, { endpoint: "https://mock/langfuse", fetcher });
		expect(result.status).toBe("TELEMETRY_SENT");
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toHaveProperty("resourceSpans");
	});

	it("rejects PII and does not send it", async () => {
		const fetcher = vi.fn();
		const result = await sendLangfuseTelemetry({ ...event, role: "user@example.com" }, { endpoint: "https://mock/langfuse", fetcher });
		expect(result.status).toBe("TELEMETRY_REJECTED");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("continues as a local failure when Langfuse is unavailable", async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
		const result = await sendLangfuseTelemetry(event, { endpoint: "https://mock/langfuse", fetcher });
		expect(result.status).toBe("TELEMETRY_FAILED");
	});

	it("keeps unavailable cost as null", () => expect(sanitizeTelemetryEvent(event).reportedCost).toBeNull());

	it("uses Basic auth when runtime keys are injected", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		await sendLangfuseTelemetry(event, { endpoint: "https://mock/langfuse", publicKey: "public", secretKey: "secret", fetcher });
		expect(fetcher.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);
	});

	it("sends official batch payload and interprets per-event 207 results", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
		const result = await sendLangfuseBatch([{ id: "trace-1", type: "trace-create", body: { name: "test" } }, { id: "span-1", type: "span-create", body: { name: "span" } }], { endpoint: "https://mock/langfuse/api/public/ingestion", publicKey: "public", secretKey: "secret", fetcher });
		expect(result).toMatchObject({ httpStatus: 200, responseValid: true, eventsSent: 2, eventsAccepted: 2, eventsRejected: 0, rejectionCodes: [] });
		expect(JSON.parse(fetcher.mock.calls[0][1].body).resourceSpans).toHaveLength(1);
		expect(fetcher.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);
	});
});
