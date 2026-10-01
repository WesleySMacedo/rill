import type { EngineeringRegistry } from "./engineering-registry-resolver";

export interface RegistryValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateEngineeringRegistry(
	registry: unknown,
	fileExists: (path: string) => boolean,
): RegistryValidationResult {
	const errors: string[] = [];
	if (!registry || typeof registry !== "object") return { valid: false, errors: ["REGISTRY_INVALID"] };
	const candidate = registry as Partial<EngineeringRegistry>;
	if (typeof candidate.version !== "string" || !candidate.version) errors.push("version is required");
	if (!Array.isArray(candidate.entries) || candidate.entries.length === 0) return { valid: false, errors: [...errors, "entries are required"] };
	const combinations = new Set<string>();
	for (const entry of candidate.entries) {
		if (!entry || typeof entry !== "object") {
			errors.push("entry must be an object");
			continue;
		}
		const value = entry as EngineeringRegistry["entries"][number];
		const combination = `${value.action}:${value.domain}`;
		if (combinations.has(combination)) errors.push(`duplicate combination: ${combination}`);
		combinations.add(combination);
		if (!["PLAN_CHANGE", "PATCH_UI", "VALIDATE_CHANGE"].includes(value.action)) errors.push(`unknown action: ${value.action}`);
		if (value.domain !== "AuditQ") errors.push(`unknown domain: ${value.domain}`);
		if (!["LOW_COST", "HIGH_CONFIDENCE"].includes(value.modelProfile ?? "")) errors.push(`${combination} requires a valid modelProfile`);
		if (!Array.isArray(value.allowedPaths) || value.allowedPaths.length === 0) errors.push(`${combination} requires allowedPaths`);
		if (!Array.isArray(value.forbiddenPaths) || !Array.isArray(value.allowedExtensions)) errors.push(`${combination} requires path and extension rules`);
		if (!Number.isInteger(value.maxChangedFiles) || value.maxChangedFiles < 1) errors.push(`${combination} requires a positive maxChangedFiles`);
		if (!value.approvalRequirement || typeof value.approvalRequirement.required !== "boolean") errors.push(`${combination} requires approvalRequirement`);
		if (!value.contextLimit || !Number.isInteger(value.contextLimit.maxFiles) || !Number.isInteger(value.contextLimit.maxTokens)) errors.push(`${combination} requires contextLimit`);
		if (!Array.isArray(value.validations) || value.validations.length === 0) errors.push(`${combination} requires validations`);
		const allowed = new Set(value.allowedPaths ?? []);
		const extensions = new Set(value.allowedExtensions ?? []);
		for (const path of value.allowedPaths ?? []) {
			if (path.startsWith("/") || path.includes("..")) errors.push(`invalid allowed path: ${path}`);
			if (!fileExists(path)) errors.push(`missing allowed path: ${path}`);
			const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
			if (!extensions.has(extension)) errors.push(`extension is not allowed: ${path}`);
		}
		for (const path of [...(value.domainContext ?? []), ...(value.playbook ?? []), ...(value.applicableTests ?? [])]) {
			if (path.startsWith("/") || path.includes("..")) errors.push(`invalid context path: ${path}`);
			if (!fileExists(path)) errors.push(`missing context path: ${path}`);
		}
		for (const path of value.forbiddenPaths ?? []) if (allowed.has(path)) errors.push(`path is both allowed and forbidden: ${path}`);
	}
	return { valid: errors.length === 0, errors };
}