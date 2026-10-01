import type { EngineeringRegistryEntry } from "../routing/engineering-registry-resolver";

export type ScopeValidationResult =
	| { status: "SCOPE_ALLOWED" }
	| { status: "PATH_FORBIDDEN"; path: string }
	| { status: "PATH_NOT_ALLOWED"; path: string }
	| { status: "EXTENSION_FORBIDDEN"; path: string }
	| { status: "MAX_CHANGED_FILES_EXCEEDED"; count: number; maximum: number }
	| { status: "PATH_TRAVERSAL_REJECTED"; path: string };

export interface ScopeChange {
	path: string;
	status?: "added" | "modified" | "deleted" | "renamed" | "untracked";
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function validateEngineeringScope(entry: EngineeringRegistryEntry, changes: Array<string | ScopeChange>): ScopeValidationResult {
	const normalized = changes.map((change) => typeof change === "string" ? { path: normalizePath(change) } : { ...change, path: normalizePath(change.path) });
	if (normalized.some(({ status }) => status === "deleted" || status === "renamed")) return { status: "PATH_NOT_ALLOWED", path: normalized.find(({ status }) => status === "deleted" || status === "renamed")?.path ?? "" };
	if (normalized.length > entry.maxChangedFiles) return { status: "MAX_CHANGED_FILES_EXCEEDED", count: normalized.length, maximum: entry.maxChangedFiles };
	const allowed = new Set(entry.allowedPaths);
	const forbidden = new Set(entry.forbiddenPaths);
	for (const change of normalized) {
		const path = change.path;
		if (path.startsWith("/") || path.includes("..")) return { status: "PATH_TRAVERSAL_REJECTED", path };
		if (forbidden.has(path) || [...forbidden].some((prefix) => prefix.endsWith("/") && path.startsWith(prefix))) return { status: "PATH_FORBIDDEN", path };
		if (!allowed.has(path)) return { status: "PATH_NOT_ALLOWED", path };
		const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
		if (!entry.allowedExtensions.includes(extension)) return { status: "EXTENSION_FORBIDDEN", path };
	}
	return { status: "SCOPE_ALLOWED" };
}