import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { AgentError } from "../core/errors";

export type JobStatus = "running" | "succeeded" | "failed" | "canceled" | "timed_out";
export type OutputStream = "stdout" | "stderr" | "system";

export interface JobRequest {
	workspaceId: string;
	commandId: string;
	label: string;
	cwd: string;
	program: string;
	args: string[];
	shell: boolean;
	timeoutMs: number;
	longRunning: boolean;
	env?: Record<string, string>;
}

export interface OutputChunk {
	seq: number;
	stream: OutputStream;
	data: string;
	at: string;
}

export interface JobSnapshot {
	id: string;
	workspaceId: string;
	commandId: string;
	label: string;
	status: JobStatus;
	exitCode: number | null;
	startedAt: string;
	endedAt: string | null;
	durationMs: number | null;
	outputTruncated: boolean;
	output?: OutputChunk[];
}

export interface JobOutputEvent {
	jobId: string;
	workspaceId: string;
	seq: number;
	stream: OutputStream;
	data: string;
}

export interface JobExitEvent {
	jobId: string;
	workspaceId: string;
	status: JobStatus;
	exitCode: number | null;
	durationMs: number;
}

interface JobRecord {
	snapshot: JobSnapshot;
	child: ChildProcess;
	chunks: OutputChunk[];
	bufferedBytes: number;
	seq: number;
	timer: NodeJS.Timeout;
	cancelReason: "canceled" | "timed_out" | null;
	done: Promise<JobSnapshot>;
}

const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_CONCURRENT_JOBS = 4;
const MAX_FINISHED_JOBS = 50;
const STRIPPED_ENV_PREFIXES = ["ELECTRON_", "RILL_"];

export function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (STRIPPED_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) continue;
		env[key] = value;
	}
	return { ...env, ...extra };
}

export function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		killer.on("error", () => child.kill());
	} else {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
	}
}

/** Runs catalog commands as streamed jobs with timeouts, bounded output and tree kill. */
export class JobManager extends EventEmitter {
	private readonly jobs = new Map<string, JobRecord>();

	start(request: JobRequest): JobSnapshot {
		const running = [...this.jobs.values()].filter((job) => job.snapshot.status === "running");
		if (running.length >= MAX_CONCURRENT_JOBS) throw new AgentError("TOO_MANY_JOBS", "Too many commands are running. Wait or cancel one.", 429);
		if (request.longRunning && running.some((job) => job.snapshot.workspaceId === request.workspaceId && job.snapshot.commandId === request.commandId)) {
			throw new AgentError("JOB_ALREADY_RUNNING", `"${request.label}" is already running for this workspace.`, 409);
		}

		const id = `job_${randomBytes(9).toString("base64url")}`;
		const startedAt = Date.now();
		// With a shell, Node only concatenates argv; catalog args are constants, so join them explicitly.
		const child = spawn(request.shell ? [request.program, ...request.args].join(" ") : request.program, request.shell ? [] : request.args, {
			cwd: request.cwd,
			env: childEnvironment(request.env),
			shell: request.shell,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		let resolveDone!: (snapshot: JobSnapshot) => void;
		const done = new Promise<JobSnapshot>((resolve) => {
			resolveDone = resolve;
		});
		const record: JobRecord = {
			snapshot: {
				id,
				workspaceId: request.workspaceId,
				commandId: request.commandId,
				label: request.label,
				status: "running",
				exitCode: null,
				startedAt: new Date(startedAt).toISOString(),
				endedAt: null,
				durationMs: null,
				outputTruncated: false,
			},
			child,
			chunks: [],
			bufferedBytes: 0,
			seq: 0,
			timer: setTimeout(() => this.stop(id, "timed_out"), request.timeoutMs),
			cancelReason: null,
			done,
		};
		this.jobs.set(id, record);
		this.prune();

		const push = (stream: OutputStream, data: string) => {
			if (!data) return;
			record.seq += 1;
			const chunk: OutputChunk = { seq: record.seq, stream, data, at: new Date().toISOString() };
			record.chunks.push(chunk);
			record.bufferedBytes += Buffer.byteLength(data);
			while (record.bufferedBytes > MAX_BUFFERED_BYTES && record.chunks.length > 1) {
				const removed = record.chunks.shift()!;
				record.bufferedBytes -= Buffer.byteLength(removed.data);
				record.snapshot.outputTruncated = true;
			}
			this.emit("output", { jobId: id, workspaceId: request.workspaceId, seq: chunk.seq, stream, data } satisfies JobOutputEvent);
		};

		push("system", `$ ${request.label}\n`);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (data: string) => push("stdout", data));
		child.stderr?.on("data", (data: string) => push("stderr", data));

		let finished = false;
		const finish = (exitCode: number | null, errorMessage?: string) => {
			if (finished) return;
			finished = true;
			clearTimeout(record.timer);
			if (errorMessage) push("system", `${errorMessage}\n`);
			const endedAt = Date.now();
			const status: JobStatus = record.cancelReason ?? (exitCode === 0 ? "succeeded" : "failed");
			Object.assign(record.snapshot, {
				status,
				exitCode,
				endedAt: new Date(endedAt).toISOString(),
				durationMs: endedAt - startedAt,
			});
			push("system", `\n[${status}${exitCode === null ? "" : ` · exit ${exitCode}`}]\n`);
			this.emit("exit", { jobId: id, workspaceId: request.workspaceId, status, exitCode, durationMs: endedAt - startedAt } satisfies JobExitEvent);
			resolveDone(this.snapshot(id, 0)!);
		};
		child.on("error", (error) => finish(null, `Failed to start: ${error.message}`));
		child.on("close", (code) => finish(code));

		return this.snapshot(id)!;
	}

	snapshot(id: string, sinceSeq?: number): JobSnapshot | null {
		const record = this.jobs.get(id);
		if (!record) return null;
		const snapshot: JobSnapshot = { ...record.snapshot };
		if (sinceSeq !== undefined) snapshot.output = record.chunks.filter((chunk) => chunk.seq > sinceSeq);
		return snapshot;
	}

	list(workspaceId?: string): JobSnapshot[] {
		return [...this.jobs.values()]
			.filter((job) => !workspaceId || job.snapshot.workspaceId === workspaceId)
			.map((job) => ({ ...job.snapshot }))
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}

	wait(id: string): Promise<JobSnapshot> {
		const record = this.jobs.get(id);
		if (!record) return Promise.reject(new AgentError("JOB_NOT_FOUND", "Job not found.", 404));
		return record.done;
	}

	cancel(id: string): JobSnapshot {
		const record = this.jobs.get(id);
		if (!record) throw new AgentError("JOB_NOT_FOUND", "Job not found.", 404);
		if (record.snapshot.status === "running") this.stop(id, "canceled");
		return { ...record.snapshot };
	}

	cancelAll(): void {
		for (const [id, record] of this.jobs) if (record.snapshot.status === "running") this.stop(id, "canceled");
	}

	private stop(id: string, reason: "canceled" | "timed_out"): void {
		const record = this.jobs.get(id);
		if (!record || record.snapshot.status !== "running" || record.cancelReason) return;
		record.cancelReason = reason;
		killProcessTree(record.child);
	}

	private prune(): void {
		const finished = [...this.jobs.entries()].filter(([, job]) => job.snapshot.status !== "running");
		const excess = finished.length - MAX_FINISHED_JOBS;
		if (excess <= 0) return;
		finished
			.sort((a, b) => a[1].snapshot.startedAt.localeCompare(b[1].snapshot.startedAt))
			.slice(0, excess)
			.forEach(([id]) => this.jobs.delete(id));
	}
}
