import { describe, expect, it } from "vitest";
import { resolveContext } from "../src/routing/context-resolver.ts";

const entry = {
	action: "PATCH_UI",
	domain: "AuditQ",
	risk: "MEDIUM",
	profile: "UI_PATCH",
	allowedPaths: ["public/index.html"],
	forbiddenPaths: ["migrations/"],
	allowedExtensions: [".html"],
	maxChangedFiles: 1,
	approvalRequirement: { required: true, reason: "approval" },
	contextLimit: { maxFiles: 7, maxTokens: 1000 },
	validations: ["scope"],
	domainContext: ["AGENTS.md"],
	playbook: [],
	applicableTests: ["tests/engineering-registry.test.js"],
};
const registry = { version: "1.0.0", entries: [entry] };
const files = new Map([
	["public/index.html", { exists: true, size: 100 }],
	["AGENTS.md", { exists: true, size: 100 }],
	[".github/instructions/rill.instructions.md", { exists: true, size: 100 }],
	[".github/prompts/analyze-rill.prompt.md", { exists: true, size: 100 }],
	["tests/engineering-registry.test.js", { exists: true, size: 100 }],
	["tests/architect.worker.test.js", { exists: true, size: 100 }],
]);
const fileSystem = { getFileInfo: (path) => files.get(path) ?? { exists: false, size: 0 } };

describe("Context Resolver", () => {
	it("resolves an explicit AuditQ target without LLM", () => {
		const result = resolveContext(registry, { action: "PATCH_UI", domain: "AuditQ", task: "Atualizar public/index.html" }, fileSystem);
		expect(result.status).toBe("CONTEXT_READY");
		expect(result.targetFiles).toEqual(["public/index.html"]);
		expect(result.applicableTests).toContain("tests/engineering-registry.test.js");
	});

	it("requires expansion when no target is present", () => {
		const result = resolveContext(registry, { action: "PATCH_UI", domain: "AuditQ", task: "Atualizar a interface" }, fileSystem);
		expect(result.status).toBe("CONTEXT_EXPANSION_REQUIRED");
	});

	it("blocks a forbidden target", () => {
		const result = resolveContext(registry, { action: "PATCH_UI", domain: "AuditQ", task: "Alterar migrations/001.sql" }, fileSystem);
		expect(result.status).toBe("CONTEXT_BLOCKED");
		expect(result.exclusionReasons).toContain("PATH_FORBIDDEN");
	});

	it("excludes empty scaffolding without treating it as context", () => {
		files.set("public/index.html", { exists: true, size: 0, empty: true });
		const result = resolveContext(registry, { action: "PATCH_UI", domain: "AuditQ", task: "Atualizar public/index.html" }, fileSystem);
		expect(result.status).toBe("CONTEXT_BLOCKED");
		expect(result.exclusionReasons).toContain("EMPTY_SCAFFOLDING");
	});

	it("requires expansion when the file budget is exceeded", () => {
		files.set("public/index.html", { exists: true, size: 100 });
		const result = resolveContext({ ...registry, entries: [{ ...entry, contextLimit: { maxFiles: 1, maxTokens: 1000 }, applicableTests: ["tests/engineering-registry.test.js"] }] }, { action: "PATCH_UI", domain: "AuditQ", task: "Atualizar public/index.html" }, fileSystem);
		expect(result.status).toBe("CONTEXT_EXPANSION_REQUIRED");
	});
});
