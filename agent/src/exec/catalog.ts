import { AgentError } from "../core/errors";

export interface CommandSpec {
	id: string;
	label: string;
	program: string;
	args: string[];
	/** Windows requires a shell to launch .cmd shims; arguments are fixed constants. */
	shell: boolean;
	timeoutMs: number;
	longRunning: boolean;
}

const MINUTE = 60_000;
const isWindows = process.platform === "win32";
const npmProgram = isWindows ? "npm.cmd" : "npm";

function npm(id: string, args: string[], options: { timeoutMs: number; longRunning?: boolean }): CommandSpec {
	return {
		id,
		label: `npm ${args.join(" ")}`,
		program: npmProgram,
		args,
		shell: isWindows,
		timeoutMs: options.timeoutMs,
		longRunning: options.longRunning ?? false,
	};
}

/**
 * The only commands the Agent can run on behalf of the browser. Free-form shell
 * input is intentionally unsupported: each entry is a fixed program + argv.
 */
export const COMMAND_CATALOG: Readonly<Record<string, CommandSpec>> = Object.freeze({
	"npm.install": npm("npm.install", ["install"], { timeoutMs: 15 * MINUTE }),
	"npm.test": npm("npm.test", ["test"], { timeoutMs: 15 * MINUTE }),
	"npm.build": npm("npm.build", ["run", "build"], { timeoutMs: 15 * MINUTE }),
	"npm.dev": npm("npm.dev", ["run", "dev"], { timeoutMs: 8 * 60 * MINUTE, longRunning: true }),
});

export function resolveCommand(id: unknown): CommandSpec {
	if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(COMMAND_CATALOG, id)) {
		throw new AgentError("COMMAND_NOT_ALLOWED", `Command is not in the Agent catalog. Allowed: ${Object.keys(COMMAND_CATALOG).join(", ")}.`, 403);
	}
	return COMMAND_CATALOG[id]!;
}
