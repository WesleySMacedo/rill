/**
 * Rill deterministic classification entrypoint (Zero LLM).
 * Any agent or model MUST invoke this script instead of reasoning about
 * classification itself. Output is the ONLY valid classification result.
 */
const fs = require("fs");
const path = require("path");

function loadRegistry() {
	const registryPath = path.resolve(process.cwd(), "engineering-registry.json");
	return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

const domainKeywords = [{ domain: "AuditQ", patterns: [/audit\s*q/i, /auditq/i] }];

const actionKeywords = [
	{ action: "VALIDATE_CHANGE", patterns: [/valid[ae]/i, /revise a mudan[cç]a/i, /verifique os testes/i] },
	{ action: "PATCH_UI", patterns: [/implemente/i, /corrija/i, /altere/i, /modifique/i, /crie/i, /patch/i, /componente/i] },
	{ action: "PLAN_CHANGE", patterns: [/analise/i, /analyz/i, /verifique/i, /revise/i, /plan/i] },
];

function detectDomain(request) {
	for (const { domain, patterns } of domainKeywords) {
		if (patterns.some((pattern) => pattern.test(request))) return domain;
	}
	return null;
}

function detectAction(request) {
	for (const { action, patterns } of actionKeywords) {
		if (patterns.some((pattern) => pattern.test(request))) return action;
	}
	return null;
}

function contextLevel(maxFiles) {
	if (maxFiles <= 3) return "L0";
	if (maxFiles <= 10) return "L1";
	if (maxFiles <= 30) return "L2";
	return "L3";
}

function specialistForAction(action) {
	if (action === "PLAN_CHANGE") return "Estrategista (Architect Worker)";
	if (action === "PATCH_UI") return "Projetista (Builder Worker)";
	if (action === "VALIDATE_CHANGE") return "Auditor Técnico (Reviewer Worker)";
	return "NONE";
}

function classify(request, registry) {
	if (!request || !request.trim()) {
		return { CLASSIFICATION: "INVALID_REQUEST", ACTION: "NONE", DOMAIN: "NONE", SPECIALIST: "NONE", CONTEXT_LEVEL: "NONE", STATUS: "BLOCKED", REASON: "Empty request" };
	}

	const domain = detectDomain(request);
	const action = detectAction(request);

	if (!domain) {
		return { CLASSIFICATION: "UNKNOWN_DOMAIN", ACTION: action ?? "NONE", DOMAIN: "NONE", SPECIALIST: "NONE", CONTEXT_LEVEL: "NONE", STATUS: "BLOCKED", REASON: "No registered domain matched the request" };
	}
	if (!action) {
		return { CLASSIFICATION: "UNKNOWN_ACTION", ACTION: "NONE", DOMAIN: domain, SPECIALIST: "NONE", CONTEXT_LEVEL: "NONE", STATUS: "BLOCKED", REASON: "No registered action matched the request" };
	}

	const resolvedRegistry = registry ?? loadRegistry();
	const entry = resolvedRegistry.entries.find((candidate) => candidate.action === action && candidate.domain === domain);
	if (!entry) {
		return { CLASSIFICATION: "COMBINATION_NOT_ALLOWED", ACTION: action, DOMAIN: domain, SPECIALIST: "NONE", CONTEXT_LEVEL: "NONE", STATUS: "BLOCKED", REASON: `${action} x ${domain} is not registered in engineering-registry.json` };
	}

	return {
		CLASSIFICATION: "REGISTRY_MATCH",
		ACTION: action,
		DOMAIN: domain,
		SPECIALIST: specialistForAction(action),
		CONTEXT_LEVEL: contextLevel(entry.contextLimit.maxFiles),
		STATUS: "ALLOWED",
		REASON: entry.approvalRequirement.reason,
	};
}

function formatResult(result) {
	return Object.entries(result)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
}

if (require.main === module) {
	const request = process.argv.slice(2).join(" ");
	console.log(formatResult(classify(request)));
}

module.exports = { classify, formatResult };
