import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSensitiveFile, normalizeRelativePath, resolveInsideWorkspace, validateWorkspaceRoot } from "../src/security/paths";
import { makeTempDir } from "./helpers";

describe("normalizeRelativePath", () => {
	it("normalizes separators and dot segments", () => {
		expect(normalizeRelativePath("src\\app/./index.ts")).toBe("src/app/index.ts");
		expect(normalizeRelativePath("", { allowRoot: true })).toBe("");
	});

	it.each([
		["../secret.txt", "PATH_OUTSIDE_WORKSPACE"],
		["src/../../x", "PATH_OUTSIDE_WORKSPACE"],
		["/etc/passwd", "PATH_OUTSIDE_WORKSPACE"],
		["C:/Windows/win.ini", "PATH_OUTSIDE_WORKSPACE"],
		["\\\\server\\share\\x", "PATH_OUTSIDE_WORKSPACE"],
		["file.txt:stream", "INVALID_PATH"],
		["src/con.txt", "INVALID_PATH"],
		["src/NUL", "INVALID_PATH"],
		["name. ", "INVALID_PATH"],
		["a\0b", "INVALID_PATH"],
		[".git/config", "PROTECTED_PATH"],
		["sub/.GIT/hooks/pre-commit", "PROTECTED_PATH"],
	])("rejects %s", (input, code) => {
		expect(() => normalizeRelativePath(input)).toThrow(expect.objectContaining({ code }));
	});

	it("requires a path unless the root is allowed", () => {
		expect(() => normalizeRelativePath("")).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
		expect(() => normalizeRelativePath(42)).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
	});
});

describe("isSensitiveFile", () => {
	it.each([".env", ".env.local", "config/.env.production", ".dev.vars", "certs/server.pem", "id_rsa", "id_ed25519.pub", ".npmrc", ".git-credentials", "keys/app.pfx"])(
		"blocks %s",
		(file) => expect(isSensitiveFile(file)).toBe(true),
	);
	it.each([".env.example", ".env.sample", "src/env.ts", "README.md", "keyboard.ts", "package.json"])("allows %s", (file) => expect(isSensitiveFile(file)).toBe(false));
});

describe("workspace containment", () => {
	let root: string;
	let outside: string;
	let workspace: string;

	beforeAll(async () => {
		root = await makeTempDir();
		workspace = path.join(root, "projects", "app");
		outside = path.join(root, "outside");
		await fs.mkdir(path.join(workspace, "src"), { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "secret.txt"), "secret");
		await fs.symlink(outside, path.join(workspace, "escape"), "junction");
	});

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("resolves existing and new files inside the workspace", async () => {
		await expect(resolveInsideWorkspace(workspace, "src")).resolves.toMatchObject({ exists: true });
		await expect(resolveInsideWorkspace(workspace, "src/new/file.ts")).resolves.toMatchObject({ exists: false, absolutePath: path.join(workspace, "src", "new", "file.ts") });
	});

	it("rejects junctions/symlinks that point outside", async () => {
		await expect(resolveInsideWorkspace(workspace, "escape/secret.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
		await expect(resolveInsideWorkspace(workspace, "escape/new.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
	});

	it("validates workspace roots", async () => {
		await expect(validateWorkspaceRoot(workspace, { protectedRoots: [] })).resolves.toBe(workspace);
		await expect(validateWorkspaceRoot("relative/path", { protectedRoots: [] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
		await expect(validateWorkspaceRoot(path.parse(workspace).root, { protectedRoots: [] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
		await expect(validateWorkspaceRoot(path.join(root, "missing"), { protectedRoots: [] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
		await expect(validateWorkspaceRoot(path.join(root, "projects"), { homeDir: workspace, protectedRoots: [] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
		await expect(validateWorkspaceRoot(workspace, { protectedRoots: [root] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
		await expect(validateWorkspaceRoot("\\\\server\\share\\project", { protectedRoots: [] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
	});
});
