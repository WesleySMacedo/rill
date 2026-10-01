import type { EngineeringAction, EngineeringRegistryEntry } from "../routing/engineering-registry-resolver";

export type ContextManifestStatus = "CONTEXT_READY" | "CONTEXT_EXPANSION_REQUIRED" | "CONTEXT_BLOCKED" | "CONTEXT_INVALID";
export type ContextItemPriority = "REQUIRED" | "HIGH" | "OPTIONAL" | "EXCLUDED" | "FORBIDDEN";

export interface ContextItem {
	path: string;
	category: "TARGET" | "DOMAIN_CONTEXT" | "PLAYBOOK" | "TEST" | "REGISTRY" | "DEPENDENCY";
	priority: ContextItemPriority;
	estimatedSize: number;
	reason: string;
}

export interface ContextManifest {
	action: EngineeringAction;
	domain: string;
	task: string;
	targetFiles: string[];
	allowedPaths: string[];
	forbiddenPaths: string[];
	domainContext: string[];
	playbook: string[];
	applicableTests: string[];
	estimatedContextSize: number;
	contextLimit: EngineeringRegistryEntry["contextLimit"];
	includedItems: ContextItem[];
	excludedItems: ContextItem[];
	exclusionReasons: string[];
	policyResult: "REGISTRY_MATCH";
	status: ContextManifestStatus;
}