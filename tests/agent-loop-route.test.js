import { describe, expect, it } from "vitest";
import worker from "../src/server.ts";

describe("protected Agent Loop route", () => {
	it("does not expose the validation result when disabled", async () => {
		const response = await worker.fetch(new Request("http://example.com/api/internal/agent-loop/validate"), {});
		expect(response.status).toBe(401);
	});
});
