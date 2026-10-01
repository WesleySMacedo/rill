import type { ReviewerAuditInput, ReviewerAuditResult, ReviewerPostExecutionInput, ReviewerPostExecutionResult } from "../contracts/execution.contract";

export function auditBuilderProposal(input: ReviewerAuditInput): ReviewerAuditResult {
	const findings: string[] = [];

	if (input.proposal.status === "BLOCKED_BY_SCOPE") {
		return {
			status: "BLOCKED",
			findings: ["Proposta de alteração bloqueada por violação de escopo."],
			approvedForHumanReview: false,
		};
	}

	if (input.proposal.targetFiles.length > input.maxChangedFiles) {
		findings.push(`Proposta excede o limite máximo de ${input.maxChangedFiles} arquivos.`);
	}

	for (const path of input.proposal.targetFiles) {
		if (input.forbiddenPaths.includes(path)) {
			findings.push(`Caminho proibido detectado na proposta: ${path}`);
		}
		if (!input.allowedPaths.includes(path)) {
			findings.push(`Caminho não autorizado na lista de alvos: ${path}`);
		}
	}

	if (findings.length > 0) {
		return {
			status: "CHANGES_REQUIRED",
			findings,
			approvedForHumanReview: false,
		};
	}

	findings.push("Proposta validada pelo Auditor Técnico. Pronto para revisão do Diretor da Obra.");
	return {
		status: "APPROVED_WITH_NOTES",
		findings,
		approvedForHumanReview: true,
	};
}

export function auditPostExecution(input: ReviewerPostExecutionInput): ReviewerPostExecutionResult {
	const findings: string[] = [];

	for (const path of input.filesChanged) {
		if (!input.allowedPaths.includes(path)) {
			findings.push(`Arquivo alterado fora dos caminhos permitidos: ${path}`);
		}
	}

	if (input.testResults && input.testResults.failed > 0) {
		findings.push(`Suíte de testes apresentou ${input.testResults.failed} falha(s).`);
	}

	if (findings.length > 0) {
		return {
			status: "FAILED",
			findings,
		};
	}

	return {
		status: "PASSED",
		findings: ["Auditoria pós-execução aprovada sem regressões."],
	};
}
