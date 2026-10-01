import type { ArchitectExecutionInput, ArchitectExecutionResult } from "../contracts/execution.contract";

const supportedActions = new Set(["DISCOVER_CONTEXT", "PLAN_CHANGE", "PATCH_UI", "VALIDATE_CHANGE"]);

export function runArchitect(input: ArchitectExecutionInput): ArchitectExecutionResult {
	if (!supportedActions.has(input.action) || !input.domain.trim() || !input.task.trim()) {
		return {
			decision: "BLOCKED_BY_POLICY",
			action: input.action,
			domain: input.domain,
			plan: [],
			reason: "Ação, domínio e tarefa são obrigatórios e devem estar autorizados.",
		};
	}

	return {
		decision: "ALLOWED",
		action: input.action,
		domain: input.domain,
		plan: [
			`Validar o escopo autorizado em ${input.allowedPaths.length} caminho(s).`,
			`Analisar a solicitação ${input.action} no domínio ${input.domain}.`,
			"Produzir uma proposta sem modificar dados ou arquivos.",
		],
	};
}
