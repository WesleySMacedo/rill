export type EngineeringAction = "PLAN_CHANGE" | "PATCH_UI" | "VALIDATE_CHANGE";

export interface EngineeringRegistryEntry {
	action: EngineeringAction;
	domain: string;
	risk: string;
	profile: string;
	modelProfile?: "LOW_COST" | "HIGH_CONFIDENCE";
	allowedPaths: string[];
	forbiddenPaths: string[];
	allowedExtensions: string[];
	maxChangedFiles: number;
	approvalRequirement: { required: boolean; reason: string };
	contextLimit: { maxFiles: number; maxTokens: number };
	validations: string[];
	domainContext?: string[];
	playbook?: string[];
	applicableTests?: string[];
}

export interface EngineeringRegistry {
	version: string;
	entries: EngineeringRegistryEntry[];
}

export type RegistryResolution =
	| { status: "REGISTRY_MATCH"; entry: EngineeringRegistryEntry }
	| { status: "UNKNOWN_ACTION"; action: string }
	| { status: "UNKNOWN_DOMAIN"; domain: string }
	| { status: "COMBINATION_NOT_ALLOWED"; action: string; domain: string }
	| { status: "REGISTRY_INVALID"; errors: string[] };

const actions = new Set(["PLAN_CHANGE", "PATCH_UI", "VALIDATE_CHANGE"]);

export function resolveEngineeringAction(registry: EngineeringRegistry, action: string, domain: string): RegistryResolution {
	if (!actions.has(action)) return { status: "UNKNOWN_ACTION", action };
	if (domain !== "AuditQ") return { status: "UNKNOWN_DOMAIN", domain };
	const entry = registry.entries.find((candidate) => candidate.action === action && candidate.domain === domain);
	return entry ? { status: "REGISTRY_MATCH", entry } : { status: "COMBINATION_NOT_ALLOWED", action, domain };
}