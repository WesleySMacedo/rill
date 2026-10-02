import { execFile } from "node:child_process";
import { AgentError } from "../core/errors";
import { childEnvironment, type JobManager, type JobSnapshot } from "../exec/jobs";
import { isSensitiveFile, normalizeRelativePath } from "../security/paths";

const GIT_TIMEOUT_MS = 2 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;
const MAX_COMMIT_MESSAGE = 5000;
const MAX_COMMIT_PATHS = 500;

export const GIT_ENV: Record<string, string> = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_OPTIONAL_LOCKS: "0",
	LC_ALL: "C",
};

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export function runGit(cwd: string, args: string[], { timeoutMs = GIT_TIMEOUT_MS, input }: { timeoutMs?: number; input?: string } = {}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			args,
			{ cwd, env: childEnvironment(GIT_ENV), timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT") return reject(new AgentError("GIT_NOT_INSTALLED", "Git is not installed or not on PATH.", 500));
					if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new AgentError("GIT_OUTPUT_TOO_LARGE", "Git output exceeded the Agent limit.", 500));
				}
				if (error && (error as { killed?: boolean }).killed) return reject(new AgentError("GIT_TIMEOUT", "Git command timed out.", 504));
				const exitCode = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
				resolve({ stdout, stderr, exitCode });
			},
		);
		if (input !== undefined) child.stdin?.end(input);
	});
}

function gitFailure(code: string, result: GitResult, fallback: string, status = 409): AgentError {
	const message = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-6).join("\n") || fallback;
	return new AgentError(code, message, status);
}

async function assertRepository(cwd: string): Promise<void> {
	const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
		throw new AgentError("NOT_A_GIT_REPOSITORY", "This workspace is not a Git repository.", 409);
	}
}

export type FileChangeKind = "changed" | "renamed" | "unmerged" | "untracked";

export interface GitFileStatus {
	path: string;
	originalPath: string | null;
	kind: FileChangeKind;
	index: string;
	worktree: string;
}

export interface GitStatus {
	branch: { head: string | null; oid: string | null; upstream: string | null; ahead: number; behind: number; detached: boolean };
	files: GitFileStatus[];
	clean: boolean;
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parsePorcelainV2(output: string): GitStatus {
	const branch: GitStatus["branch"] = { head: null, oid: null, upstream: null, ahead: 0, behind: 0, detached: false };
	const files: GitFileStatus[] = [];
	const records = output.split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith("# ")) {
			const [, key, ...rest] = record.split(" ");
			const value = rest.join(" ");
			if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
			if (key === "branch.head") {
				branch.detached = value === "(detached)";
				branch.head = branch.detached ? null : value;
			}
			if (key === "branch.upstream") branch.upstream = value;
			if (key === "branch.ab") {
				const match = /^\+(\d+) -(\d+)$/.exec(value);
				if (match) {
					branch.ahead = Number(match[1]);
					branch.behind = Number(match[2]);
				}
			}
			continue;
		}
		const type = record[0];
		if (type === "1") {
			const parts = record.split(" ");
			files.push({ path: parts.slice(8).join(" "), originalPath: null, kind: "changed", index: parts[1]![0]!, worktree: parts[1]![1]! });
		} else if (type === "2") {
			const parts = record.split(" ");
			files.push({ path: parts.slice(9).join(" "), originalPath: records[index + 1] ?? null, kind: "renamed", index: parts[1]![0]!, worktree: parts[1]![1]! });
			index += 1;
		} else if (type === "u") {
			const parts = record.split(" ");
			files.push({ path: parts.slice(10).join(" "), originalPath: null, kind: "unmerged", index: parts[1]![0]!, worktree: parts[1]![1]! });
		} else if (type === "?") {
			files.push({ path: record.slice(2), originalPath: null, kind: "untracked", index: "?", worktree: "?" });
		}
	}
	return { branch, files, clean: files.length === 0 };
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
	await assertRepository(cwd);
	const result = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
	if (result.exitCode !== 0) throw gitFailure("GIT_FAILED", result, "git status failed.");
	return parsePorcelainV2(result.stdout);
}

export interface GitBranch {
	name: string;
	oid: string;
	current: boolean;
	upstream: string | null;
}

export async function gitBranches(cwd: string): Promise<{ current: string | null; branches: GitBranch[] }> {
	await assertRepository(cwd);
	const result = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)", "refs/heads"]);
	if (result.exitCode !== 0) throw gitFailure("GIT_FAILED", result, "git for-each-ref failed.");
	const branches = result.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			const [name = "", oid = "", head = "", upstream = ""] = line.split("\0");
			return { name, oid, current: head === "*", upstream: upstream || null };
		});
	return { current: branches.find((branch) => branch.current)?.name ?? null, branches };
}

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(\/|$))[A-Za-z0-9._\/-]{1,200}(?<![./])$/;

export async function gitCreateBranch(cwd: string, input: { name: unknown; checkout?: unknown }): Promise<{ name: string; checkedOut: boolean }> {
	if (typeof input.name !== "string" || !BRANCH_NAME.test(input.name)) {
		throw new AgentError("INVALID_BRANCH_NAME", "Branch names may contain letters, numbers, '.', '_', '/', '-' and cannot start with '-'.");
	}
	await assertRepository(cwd);
	const validation = await runGit(cwd, ["check-ref-format", "--branch", input.name]);
	if (validation.exitCode !== 0) throw new AgentError("INVALID_BRANCH_NAME", "Git rejected the branch name.");
	const checkout = input.checkout !== false;
	const result = await runGit(cwd, checkout ? ["switch", "-c", input.name] : ["branch", input.name]);
	if (result.exitCode !== 0) throw gitFailure("GIT_BRANCH_FAILED", result, "Could not create the branch.");
	return { name: input.name, checkedOut: checkout };
}

export interface CommitInput {
	message: unknown;
	paths?: unknown;
	all?: unknown;
}

/**
 * Commits either an explicit list of workspace paths or every change. Files that
 * look like credentials block the commit instead of being pushed to a remote later.
 */
export async function gitCommit(cwd: string, input: CommitInput): Promise<{ commit: string; branch: string | null; files: string[] }> {
	if (typeof input.message !== "string" || !input.message.trim()) throw new AgentError("INVALID_COMMIT", "A commit message is required.");
	if (input.message.length > MAX_COMMIT_MESSAGE) throw new AgentError("INVALID_COMMIT", "Commit message is too long.");
	const all = input.all === true;
	if (!all && !Array.isArray(input.paths)) throw new AgentError("INVALID_COMMIT", "Provide paths[] or all: true.");
	if (!all && (input.paths as unknown[]).length === 0) throw new AgentError("INVALID_COMMIT", "paths[] cannot be empty.");
	if (!all && (input.paths as unknown[]).length > MAX_COMMIT_PATHS) throw new AgentError("INVALID_COMMIT", "Too many paths in one commit.");

	const status = await gitStatus(cwd);
	const changed = new Set(status.files.flatMap((file) => [file.path, file.originalPath].filter((value): value is string => Boolean(value))));
	let paths: string[];
	if (all) {
		paths = status.files.map((file) => file.path);
		if (paths.length === 0) throw new AgentError("NOTHING_TO_COMMIT", "There are no changes to commit.", 409);
	} else {
		paths = (input.paths as unknown[]).map((item) => normalizeRelativePath(item));
		const unknownPath = paths.find((item) => !changed.has(item));
		if (unknownPath) throw new AgentError("PATH_NOT_CHANGED", `"${unknownPath}" has no changes to commit.`, 409);
	}
	const sensitive = paths.filter((item) => isSensitiveFile(item));
	if (sensitive.length > 0) {
		throw new AgentError("SENSITIVE_FILE_IN_COMMIT", `Refusing to commit files that may contain credentials: ${sensitive.join(", ")}.`, 403);
	}

	const add = await runGit(cwd, all ? ["add", "--all"] : ["add", "--all", "--", ...paths]);
	if (add.exitCode !== 0) throw gitFailure("GIT_ADD_FAILED", add, "git add failed.");
	const commit = await runGit(cwd, ["commit", "--file=-", ...(all ? [] : ["--", ...paths])], { input: input.message });
	if (commit.exitCode !== 0) throw gitFailure("GIT_COMMIT_FAILED", commit, "git commit failed.");
	const head = await runGit(cwd, ["rev-parse", "HEAD"]);
	const branch = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
	return { commit: head.stdout.trim(), branch: branch.stdout.trim() || null, files: paths };
}

/** Pushes the current branch. Force pushes are not supported by design. */
export async function gitPush(cwd: string, workspaceId: string, jobs: JobManager, input: { setUpstream?: unknown }): Promise<JobSnapshot> {
	const status = await gitStatus(cwd);
	if (!status.branch.head) throw new AgentError("DETACHED_HEAD", "Check out a branch before pushing.", 409);
	const setUpstream = input.setUpstream === true || !status.branch.upstream;
	return jobs.start({
		workspaceId,
		commandId: "git.push",
		label: setUpstream ? `git push --set-upstream origin ${status.branch.head}` : "git push",
		cwd,
		program: "git",
		args: setUpstream ? ["push", "--set-upstream", "origin", "HEAD"] : ["push"],
		shell: false,
		timeoutMs: PUSH_TIMEOUT_MS,
		longRunning: false,
		env: GIT_ENV,
	});
}
