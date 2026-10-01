import type { ContextItem, ContextManifest } from "../contracts/context-manifest.contract";
import { resolveEngineeringAction, type EngineeringRegistry } from "./engineering-registry-resolver";

export interface ContextFileInfo {
	exists: boolean;
	size: number;
	empty?: boolean;
}

export interface ContextFileSystem {
	getFileInfo(path: string): ContextFileInfo;
}

export interface ContextResolutionInput {
	action: string;
	domain: string;
	task: string;
}

const pathPattern = /(?:^|\s)((?:public|tests|src\/rill|migrations)\/[A-Za-z0-9_./-]+|AGENTS\.md)/g;

function item(
	path: string,
	category: ContextItem["category"],
	priority: ContextItem["priority"],
	size: number,
	reason: string,
): ContextItem {
	return { path, category, priority, estimatedSize: size, reason };
}

function collectTargets(task: string): string[] {
	return [...task.matchAll(pathPattern)].map((match) => match[1]).filter((path, index, paths) => paths.indexOf(path) === index);
}

export function resolveContext(registry: EngineeringRegistry, input: ContextResolutionInput, fileSystem: ContextFileSystem): ContextManifest {
	const base = {
		action: input.action as ContextManifest["action"],
		domain: input.domain,
		task: input.task,
		targetFiles: [],
		allowedPaths: [],
		forbiddenPaths: [],
		domainContext: [],
		playbook: [],
		applicableTests: [],
		estimatedContextSize: 0,
		contextLimit: { maxFiles: 0, maxTokens: 0 },
		includedItems: [],
		excludedItems: [],
		exclusionReasons: [],
		policyResult: "REGISTRY_MATCH" as const,
	};
	if (!input.task.trim()) return { ...base, status: "CONTEXT_BLOCKED", exclusionReasons: ["TASK_REQUIRED"] };
	const resolution = resolveEngineeringAction(registry, input.action, input.domain);
	if (resolution.status !== "REGISTRY_MATCH") return { ...base, status: "CONTEXT_BLOCKED", exclusionReasons: [resolution.status] };
	const entry = resolution.entry;
	const targets = collectTargets(input.task);
	const targetItems: ContextItem[] = [];
	const excludedItems: ContextItem[] = [];
	for (const path of targets) {
		if (path.includes("..") || entry.forbiddenPaths.some((forbidden) => path === forbidden || (forbidden.endsWith("/") && path.startsWith(forbidden)))) {
			excludedItems.push(item(path, "TARGET", "FORBIDDEN", 0, "PATH_FORBIDDEN"));
			continue;
		}
		const info = fileSystem.getFileInfo(path);
		if (!info.exists) {
			excludedItems.push(item(path, "TARGET", "EXCLUDED", 0, "FILE_NOT_FOUND"));
			continue;
		}
		if (!entry.allowedPaths.includes(path)) {
			excludedItems.push(item(path, "TARGET", "EXCLUDED", info.size, "PATH_NOT_ALLOWED"));
			continue;
		}
		if (info.empty) {
			excludedItems.push(item(path, "TARGET", "EXCLUDED", info.size, "EMPTY_SCAFFOLDING"));
			continue;
		}
		targetItems.push(item(path, "TARGET", "REQUIRED", info.size, "EXPLICIT_TASK_TARGET"));
	}
	if (targets.length === 0) return { ...base, ...entry, targetFiles: [], allowedPaths: entry.allowedPaths, forbiddenPaths: entry.forbiddenPaths, contextLimit: entry.contextLimit, excludedItems: [item("<task>", "TARGET", "EXCLUDED", 0, "TARGET_REQUIRED")], exclusionReasons: ["CONTEXT_EXPANSION_REQUIRED"], status: "CONTEXT_EXPANSION_REQUIRED" };
	if (targetItems.length === 0) return { ...base, ...entry, targetFiles: [], allowedPaths: entry.allowedPaths, forbiddenPaths: entry.forbiddenPaths, contextLimit: entry.contextLimit, excludedItems, exclusionReasons: excludedItems.map(({ reason }) => reason), status: "CONTEXT_BLOCKED" };

	const includedItems = [...targetItems];
	const optionalPaths = [...(entry.domainContext ?? []), ...(entry.playbook ?? []), ...(entry.applicableTests ?? [])];
	for (const path of optionalPaths) {
		const info = fileSystem.getFileInfo(path);
		if (!info.exists || info.empty) {
			excludedItems.push(item(path, path.startsWith("tests/") ? "TEST" : path.startsWith(".github/") ? "PLAYBOOK" : "DOMAIN_CONTEXT", "EXCLUDED", info.size, info.empty ? "EMPTY_SCAFFOLDING" : "FILE_NOT_FOUND"));
			continue;
		}
		const category = path.startsWith("tests/") ? "TEST" : path.startsWith(".github/") ? "PLAYBOOK" : "DOMAIN_CONTEXT";
		includedItems.push(item(path, category, "HIGH", info.size, "DIRECT_CONTEXT_CATALOG"));
	}
	const total = includedItems.reduce((sum, current) => sum + current.estimatedSize, 0);
	const status = includedItems.length > entry.contextLimit.maxFiles || total > entry.contextLimit.maxTokens ? "CONTEXT_EXPANSION_REQUIRED" : "CONTEXT_READY";
	return {
		...base,
		...entry,
		targetFiles: targetItems.map(({ path }) => path),
		allowedPaths: entry.allowedPaths,
		forbiddenPaths: entry.forbiddenPaths,
		domainContext: includedItems.filter(({ category }) => category === "DOMAIN_CONTEXT").map(({ path }) => path),
		playbook: includedItems.filter(({ category }) => category === "PLAYBOOK").map(({ path }) => path),
		applicableTests: includedItems.filter(({ category }) => category === "TEST").map(({ path }) => path),
		estimatedContextSize: total,
		includedItems,
		excludedItems,
		exclusionReasons: excludedItems.map(({ reason }) => reason),
		status,
	};
}