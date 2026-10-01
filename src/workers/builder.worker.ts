import type { BuilderApplyInput, BuilderApplyResult, BuilderProposalInput, BuilderProposalResult } from "../contracts/execution.contract";
import { assertExecutorGate, type ExecutorGateInput } from "../security/gated-executor";

export function createBuilderProposal(input: BuilderProposalInput): BuilderProposalResult {
	const invalidTargets = (input.plan ?? []).filter((item) => item.includes(".."));
	if (invalidTargets.length > 0) {
		return {
			status: "BLOCKED_BY_SCOPE",
			summary: "Proposta bloqueada por conter caminhos inválidos ou fora de escopo.",
			targetFiles: [],
			proposedChanges: [],
			acceptanceCriteria: [],
			risks: ["Tentativa de acesso a caminho proibido (scope violation)."],
			testsRecommended: [],
		};
	}

	const targets = input.allowedPaths.slice(0, input.maxChangedFiles);
	return {
		status: "PROPOSAL_CREATED",
		summary: `PATCH_PROPOSAL para ${input.action} no domínio ${input.domain}.`,
		targetFiles: targets,
		proposedChanges: [`Review ${targets.join(", ")} contra o baseline autorizado.`],
		acceptanceCriteria: ["Todos os testes e validações registradas devem passar."],
		risks: ["Requer aprovação humana explícita do Diretor da Obra antes de aplicar."],
		testsRecommended: ["tests/engineering-registry.test.js", "tests/architect.worker.test.js"],
	};
}

export function applyBuilderChanges(
	input: BuilderApplyInput,
	fileWriter?: (path: string, content: string) => void,
): BuilderApplyResult {
	if (!input.humanApproved) {
		return {
			status: "BLOCKED_NO_APPROVAL",
			filesChanged: [],
			changesReversible: true,
		};
	}

	const unallowed = input.proposal.targetFiles.filter((path) => !input.allowedPaths.includes(path));
	if (unallowed.length > 0) {
		return {
			status: "BLOCKED_BY_SCOPE",
			filesChanged: [],
			changesReversible: true,
		};
	}

	const changed: string[] = [];
	for (const path of input.proposal.targetFiles) {
		if (fileWriter) {
			fileWriter(path, "");
		}
		changed.push(path);
	}

	return {
		status: "APPLIED",
		filesChanged: changed,
		changesReversible: true,
	};
}

export async function applyApprovedBuilderChanges(
	input: BuilderApplyInput & ExecutorGateInput,
	fileWriter?: (path: string, content: string) => void,
): Promise<BuilderApplyResult> {
	try {
		await assertExecutorGate(input);
	} catch {
		return { status: "BLOCKED_NO_APPROVAL", filesChanged: [], changesReversible: true };
	}
	return applyBuilderChanges(input, fileWriter);
}
