import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { AgentError } from "../core/errors";
import type { WorkspaceRecord } from "../core/state";
import { isSensitiveFile, normalizeRelativePath, resolveInsideWorkspace } from "../security/paths";

export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 2000;

export interface TreeEntry {
	name: string;
	path: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number | null;
	modifiedAt: string | null;
	protected: boolean;
}

export interface FileContent {
	path: string;
	encoding: "utf8" | "base64";
	content: string;
	size: number;
	sha256: string;
	modifiedAt: string;
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
	return sample.includes(0);
}

function assertNotSensitive(relativePath: string): void {
	if (isSensitiveFile(relativePath)) {
		throw new AgentError("SENSITIVE_FILE", "This file may contain credentials and is never exposed by the Agent.", 403);
	}
}

/** Directory listing is one level at a time, like an editor explorer expanding a folder. */
export async function listDirectory(workspace: WorkspaceRecord, rawPath: unknown): Promise<{ path: string; entries: TreeEntry[]; truncated: boolean }> {
	const relativePath = normalizeRelativePath(rawPath ?? "", { allowRoot: true });
	const { absolutePath, exists } = await resolveInsideWorkspace(workspace.rootPath, relativePath);
	if (!exists) throw new AgentError("NOT_FOUND", "Folder not found.", 404);
	const stat = await fs.stat(absolutePath);
	if (!stat.isDirectory()) throw new AgentError("NOT_A_DIRECTORY", "Path is not a folder.");
	const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
	const entries: TreeEntry[] = [];
	let truncated = false;
	for (const dirent of dirents) {
		if (dirent.name.toLowerCase() === ".git") continue;
		if (entries.length >= MAX_TREE_ENTRIES) {
			truncated = true;
			break;
		}
		const entryPath = relativePath ? `${relativePath}/${dirent.name}` : dirent.name;
		const type: TreeEntry["type"] = dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : dirent.isSymbolicLink() ? "symlink" : "other";
		let size: number | null = null;
		let modifiedAt: string | null = null;
		try {
			const entryStat = await fs.lstat(path.join(absolutePath, dirent.name));
			size = type === "file" ? entryStat.size : null;
			modifiedAt = entryStat.mtime.toISOString();
		} catch {
			// Entry disappeared between readdir and lstat; keep it without metadata.
		}
		entries.push({ name: dirent.name, path: entryPath, type, size, modifiedAt, protected: type === "file" && isSensitiveFile(entryPath) });
	}
	entries.sort((a, b) => {
		if ((a.type === "directory") !== (b.type === "directory")) return a.type === "directory" ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});
	return { path: relativePath, entries, truncated };
}

export async function readWorkspaceFile(workspace: WorkspaceRecord, rawPath: unknown): Promise<FileContent> {
	const relativePath = normalizeRelativePath(rawPath);
	assertNotSensitive(relativePath);
	const { absolutePath, exists } = await resolveInsideWorkspace(workspace.rootPath, relativePath);
	if (!exists) throw new AgentError("NOT_FOUND", "File not found.", 404);
	const stat = await fs.stat(absolutePath);
	if (!stat.isFile()) throw new AgentError("NOT_A_FILE", "Path is not a file.");
	if (stat.size > MAX_READ_BYTES) throw new AgentError("FILE_TOO_LARGE", `Files larger than ${MAX_READ_BYTES} bytes cannot be opened.`, 413);
	const buffer = await fs.readFile(absolutePath);
	const binary = looksBinary(buffer);
	return {
		path: relativePath,
		encoding: binary ? "base64" : "utf8",
		content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
		size: buffer.length,
		sha256: sha256(buffer),
		modifiedAt: stat.mtime.toISOString(),
	};
}

export interface WriteFileInput {
	path: unknown;
	content: unknown;
	encoding?: unknown;
	/** sha256 of the version the client edited; null means "create, must not exist". */
	expectedSha256: unknown;
}

/**
 * Optimistic-concurrency write: the caller must prove which version it edited, so
 * changes made on disk by another tool are never silently overwritten.
 */
export async function writeWorkspaceFile(workspace: WorkspaceRecord, input: WriteFileInput): Promise<{ path: string; sha256: string; size: number; created: boolean }> {
	const relativePath = normalizeRelativePath(input.path);
	assertNotSensitive(relativePath);
	if (typeof input.content !== "string") throw new AgentError("INVALID_CONTENT", "content must be a string.");
	const encoding = input.encoding === undefined ? "utf8" : input.encoding;
	if (encoding !== "utf8" && encoding !== "base64") throw new AgentError("INVALID_CONTENT", "encoding must be utf8 or base64.");
	if (input.expectedSha256 !== null && (typeof input.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSha256))) {
		throw new AgentError("INVALID_CONTENT", "expectedSha256 must be a sha256 hex string or null for new files.");
	}
	const buffer = Buffer.from(input.content, encoding);
	if (buffer.length > MAX_WRITE_BYTES) throw new AgentError("FILE_TOO_LARGE", `Files larger than ${MAX_WRITE_BYTES} bytes cannot be written.`, 413);

	const { absolutePath, exists } = await resolveInsideWorkspace(workspace.rootPath, relativePath);
	if (exists) {
		const stat = await fs.stat(absolutePath);
		if (!stat.isFile()) throw new AgentError("NOT_A_FILE", "Path is not a file.");
		const current = sha256(await fs.readFile(absolutePath));
		if (input.expectedSha256 !== current) {
			throw new AgentError("WRITE_CONFLICT", "The file changed on disk since it was read. Reload it before saving.", 409);
		}
	} else if (input.expectedSha256 !== null) {
		throw new AgentError("WRITE_CONFLICT", "The file no longer exists on disk.", 409);
	}

	const directory = path.dirname(absolutePath);
	await fs.mkdir(directory, { recursive: true });
	const recheck = await resolveInsideWorkspace(workspace.rootPath, relativePath);
	if (path.relative(recheck.absolutePath, absolutePath) !== "") throw new AgentError("PATH_OUTSIDE_WORKSPACE", "Path changed during write.", 403);

	const temporary = path.join(directory, `.rill-${randomBytes(6).toString("hex")}.tmp`);
	await fs.writeFile(temporary, buffer, { flag: "wx" });
	try {
		await fs.rename(temporary, absolutePath);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
	return { path: relativePath, sha256: sha256(buffer), size: buffer.length, created: !exists };
}
