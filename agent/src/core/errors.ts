export class AgentError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "AgentError";
		this.code = code;
		this.status = status;
	}
}

export function isAgentError(value: unknown): value is AgentError {
	return value instanceof AgentError;
}
