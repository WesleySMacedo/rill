import type { RillExecution, RillExecutionState } from "../contracts/rill-execution.contract";

export interface RillExecutionRepository {
	create(execution: RillExecution): Promise<void>;
	updateState(executionId: string, state: RillExecutionState): Promise<void>;
	get(executionId: string): Promise<RillExecution | null>;
}

export class InMemoryRillExecutionRepository implements RillExecutionRepository {
	private readonly executions = new Map<string, RillExecution>();

	async create(execution: RillExecution): Promise<void> {
		this.executions.set(execution.executionId, { ...execution });
	}

	async updateState(executionId: string, state: RillExecutionState): Promise<void> {
		const execution = this.executions.get(executionId);
		if (!execution) throw new Error("EXECUTION_NOT_FOUND");
		this.executions.set(executionId, { ...execution, state });
	}

	async get(executionId: string): Promise<RillExecution | null> {
		const execution = this.executions.get(executionId);
		return execution ? { ...execution } : null;
	}
}
