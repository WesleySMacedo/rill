import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentError } from "../core/errors";

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const MAX_RELATIVE_PATH_LENGTH = 1024;

/**
 * Validates a client-supplied workspace-relative path and returns it in normalized
 * POSIX form. An empty string (or ".") addresses the workspace root.
 */
export function normalizeRelativePath(input: unknown, { allowRoot = false } = {}): string {
	if (typeof input !== "string") throw new AgentError("INVALID_PATH", "Path must be a string.");
	if (input.length > MAX_RELATIVE_PATH_LENGTH) throw new AgentError("INVALID_PATH", "Path is too long.");
	if (input.includes("\0")) throw new AgentError("INVALID_PATH", "Path contains a NUL byte.");
	const unified = input.replace(/\\/g, "/").trim();
	if (unified === "" || unified === ".") {
		if (allowRoot) return "";
		throw new AgentError("INVALID_PATH", "A file path is required.");
	}
	if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified) || unified.startsWith("//")) {
		throw new AgentError("PATH_OUTSIDE_WORKSPACE", "Absolute paths are not allowed.", 403);
	}
	const segments = unified.split("/").filter((segment) => segment !== "" && segment !== ".");
	for (const segment of segments) {
		if (segment === "..") throw new AgentError("PATH_OUTSIDE_WORKSPACE", "Parent traversal is not allowed.", 403);
		if (segment.includes(":")) throw new AgentError("INVALID_PATH", "Alternate data streams and drive specifiers are not allowed.");
		if (/[<>"|?*\x00-\x1f]/.test(segment)) throw new AgentError("INVALID_PATH", "Path contains characters that are invalid on Windows.");
		if (/[. ]$/.test(segment)) throw new AgentError("INVALID_PATH", "Path segments cannot end with a dot or space.");
		if (RESERVED_DEVICE_NAMES.test(segment)) throw new AgentError("INVALID_PATH", "Reserved device names are not allowed.");
		if (segment.toLowerCase() === ".git") throw new AgentError("PROTECTED_PATH", "The .git directory is managed through Git operations only.", 403);
	}
	if (segments.length === 0) {
		if (allowRoot) return "";
		throw new AgentError("INVALID_PATH", "A file path is required.");
	}
	return segments.join("/");
}

const SENSITIVE_PATTERNS: RegExp[] = [
	/^\.env(\..+)?$/i,
	/^\.dev\.vars(\..+)?$/i,
	/\.(pem|key|p12|pfx|keystore|jks|ppk)$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/^\.npmrc$/i,
	/^\.yarnrc(\.yml)?$/i,
	/^\.netrc$/i,
	/^_netrc$/i,
	/^\.git-credentials$/i,
	/^\.pgpass$/i,
	/^credentials(\.json)?$/i,
];
const SENSITIVE_ALLOWED_SUFFIX = /\.(example|sample|template)$/i;

/** Files that commonly hold credentials are never readable or writable through the Agent. */
export function isSensitiveFile(relativePath: string): boolean {
	const name = relativePath.split("/").pop() ?? "";
	if (SENSITIVE_ALLOWED_SUFFIX.test(name)) return false;
	return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathOrNull(target: string): Promise<string | null> {
	try {
		return await fs.realpath(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/**
 * Resolves a normalized relative path against a workspace realpath. Symlinks and
 * junctions are followed and the final location must stay inside the workspace.
 * For paths that do not exist yet, the nearest existing ancestor is checked.
 */
export async function resolveInsideWorkspace(rootRealPath: string, relativePath: string): Promise<{ absolutePath: string; exists: boolean }> {
	const candidate = path.resolve(rootRealPath, ...relativePath.split("/").filter(Boolean));
	if (!isWithin(rootRealPath, candidate)) throw new AgentError("PATH_OUTSIDE_WORKSPACE", "Path escapes the workspace.", 403);
	const real = await realpathOrNull(candidate);
	if (real) {
		if (!isWithin(rootRealPath, real)) throw new AgentError("PATH_OUTSIDE_WORKSPACE", "Path resolves outside the workspace.", 403);
		return { absolutePath: real, exists: true };
	}
	let ancestor = path.dirname(candidate);
	while (isWithin(rootRealPath, ancestor)) {
		const ancestorReal = await realpathOrNull(ancestor);
		if (ancestorReal) {
			if (!isWithin(rootRealPath, ancestorReal)) throw new AgentError("PATH_OUTSIDE_WORKSPACE", "Path resolves outside the workspace.", 403);
			return { absolutePath: path.join(ancestorReal, path.relative(ancestor, candidate)), exists: false };
		}
		if (ancestor === rootRealPath) break;
		ancestor = path.dirname(ancestor);
	}
	throw new AgentError("PATH_OUTSIDE_WORKSPACE", "Path escapes the workspace.", 403);
}

function protectedRoots(): string[] {
	const roots = [
		process.env.SystemRoot,
		process.env.windir,
		process.env.ProgramFiles,
		process.env["ProgramFiles(x86)"],
		process.env.ProgramData,
		process.env.APPDATA,
		process.env.LOCALAPPDATA,
	];
	if (process.platform !== "win32") roots.push("/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/sbin", "/sys", "/usr", "/var", "/System", "/Library");
	return roots.filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
}

export interface WorkspaceRootPolicy {
	homeDir?: string;
	protectedRoots?: string[];
}

/**
 * A workspace root must be an existing project folder: not a drive root, not the
 * user's home folder, not a network share and not inside a system location.
 */
export async function validateWorkspaceRoot(input: string, policy: WorkspaceRootPolicy = {}): Promise<string> {
	const homeDir = policy.homeDir ?? os.homedir();
	const blockedRoots = policy.protectedRoots ?? protectedRoots();
	if (!input || !path.isAbsolute(input)) throw new AgentError("INVALID_WORKSPACE", "Workspace path must be absolute.");
	if (input.startsWith("\\\\") || input.startsWith("//")) throw new AgentError("INVALID_WORKSPACE", "Network shares cannot be exposed as workspaces.");
	const real = await realpathOrNull(input);
	if (!real) throw new AgentError("INVALID_WORKSPACE", "Workspace folder does not exist.", 404);
	const stat = await fs.stat(real);
	if (!stat.isDirectory()) throw new AgentError("INVALID_WORKSPACE", "Workspace must be a folder.");
	const parsed = path.parse(real);
	const depth = path.relative(parsed.root, real).split(path.sep).filter(Boolean).length;
	if (depth < 2) throw new AgentError("INVALID_WORKSPACE", "Drive roots and top-level folders cannot be exposed.");
	const home = path.resolve(homeDir);
	if (path.relative(home, real) === "" || isWithin(real, home)) throw new AgentError("INVALID_WORKSPACE", "The home folder (or a folder containing it) cannot be exposed.");
	for (const root of blockedRoots.map((value) => path.resolve(value))) {
		if (isWithin(root, real) || isWithin(real, root)) throw new AgentError("INVALID_WORKSPACE", "System folders cannot be exposed.");
	}
	return real;
}
