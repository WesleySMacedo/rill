import { describe, expect, it } from "vitest";
import { resolveEngineeringAction } from "../src/routing/engineering-registry-resolver.ts";
import { validateEngineeringRegistry } from "../src/routing/engineering-registry-validator.ts";
import { validateEngineeringScope } from "../src/security/engineering-scope-validator.ts";

const entry = {
	action: "PATCH_UI",
	domain: "AuditQ",
	risk: "MEDIUM",
	profile: "UI_PATCH",
	modelProfile: "LOW_COST",
	allowedPaths: ["public/index.html"],
	forbiddenPaths: ["migrations/"],
	allowedExtensions: [".html"],
	maxChangedFiles: 1,
	approvalRequirement: { required: true, reason: "approval" },
	contextLimit: { maxFiles: 1, maxTokens: 100 },
	validations: ["scope"],
	domainContext: [],
	playbook: [],
	applicableTests: [],
};
const registry = { version: "1.0.0", entries: [entry] };

describe("engineering registry", () => {
	it("rejects an unknown action", () => expect(resolveEngineeringAction(registry, "UNKNOWN", "AuditQ").status).toBe("UNKNOWN_ACTION"));
	it("rejects an unknown domain", () => expect(resolveEngineeringAction(registry, "PATCH_UI", "Unknown").status).toBe("UNKNOWN_DOMAIN"));
	it("rejects a prohibited combination", () => expect(resolveEngineeringAction(registry, "PLAN_CHANGE", "AuditQ").status).toBe("COMBINATION_NOT_ALLOWED"));
	it("rejects a forbidden path", () => expect(validateEngineeringScope(entry, ["migrations/001.sql"]).status).toBe("PATH_FORBIDDEN"));
	it("rejects a forbidden extension", () => expect(validateEngineeringScope({ ...entry, allowedPaths: ["public/index.js"] }, ["public/index.js"]).status).toBe("EXTENSION_FORBIDDEN"));
	it("rejects an exceeded file limit", () => expect(validateEngineeringScope({ ...entry, allowedPaths: ["public/index.html", "public/app.js"] }, ["public/index.html", "public/app.js"]).status).toBe("MAX_CHANGED_FILES_EXCEEDED"));
	it("rejects an invalid registry", () => expect(validateEngineeringRegistry({ version: "1", entries: [{ ...entry, allowedPaths: ["missing.html"] }] }, () => false).valid).toBe(false));
	it("normalizes Windows paths and blocks deletion", () => expect(validateEngineeringScope(entry, [{ path: "public\\index.html", status: "modified" }]).status).toBe("SCOPE_ALLOWED"));
	it("blocks deleted paths", () => expect(validateEngineeringScope(entry, [{ path: "public/index.html", status: "deleted" }]).status).toBe("PATH_NOT_ALLOWED"));
});
