import { describe, expect, it } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { classify } = require("../src/classification/classify.cjs");
const registry = require("../engineering-registry.json");

describe("Rill deterministic classify entrypoint", () => {
	it("classifies a PLAN_CHANGE x AuditQ request", () => {
		const result = classify("Analise a UI da página Audit Q", registry);
		expect(result.CLASSIFICATION).toBe("REGISTRY_MATCH");
		expect(result.ACTION).toBe("PLAN_CHANGE");
		expect(result.DOMAIN).toBe("AuditQ");
		expect(result.SPECIALIST).toBe("Estrategista (Architect Worker)");
		expect(result.STATUS).toBe("ALLOWED");
	});

	it("classifies a PATCH_UI x AuditQ request", () => {
		const result = classify("Implemente uma correção na UI do Audit Q", registry);
		expect(result.ACTION).toBe("PATCH_UI");
		expect(result.DOMAIN).toBe("AuditQ");
		expect(result.STATUS).toBe("ALLOWED");
	});

	it("blocks unknown domains without guessing", () => {
		const result = classify("Crie um componente de botão em React para a tela de login", registry);
		expect(result.CLASSIFICATION).toBe("UNKNOWN_DOMAIN");
		expect(result.STATUS).toBe("BLOCKED");
	});

	it("blocks empty requests", () => {
		const result = classify("", registry);
		expect(result.CLASSIFICATION).toBe("INVALID_REQUEST");
		expect(result.STATUS).toBe("BLOCKED");
	});
});
